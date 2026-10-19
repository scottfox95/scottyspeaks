from pathlib import Path
import sys, json, hashlib, shutil, datetime, sqlite3
root=Path('/Users/scottfox/Library/Application Support/scotty-speaks')
ledger=Path('/Users/scottfox/Projects/Coding Projects/ScottySpeaks/.superpowers/titlebar-0.3.3')
def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
 return h.hexdigest()
def history_count():
 con=sqlite3.connect(str(root/'transcriptions.db'))
 try: return con.execute('SELECT COUNT(*) FROM transcriptions').fetchone()[0]
 finally: con.close()
if sys.argv[1]=='backup':
 stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
 target=root.parent/'SS2 App Backups.noindex'/('data-before-0.3.3-'+stamp)
 shutil.copytree(root,target,symlinks=True)
 files={str(p.relative_to(root)):digest(p) for p in root.rglob('*') if p.is_file() and not p.is_symlink()}
 assert all(digest(target/p)==h for p,h in files.items()), 'Backup mismatch'
 persistent={p:h for p,h in files.items() if p.startswith(('call-notes/','call-agents/')) and '/runtime/' not in p}
 data={'backup':str(target),'files':len(files),'persistent':persistent,'historyCount':history_count()}
 (ledger/'preservation.json').write_text(json.dumps(data,indent=2)+'\n')
 print(json.dumps({'backup':str(target),'verifiedFiles':len(files),'persistentFiles':len(persistent),'historyCount':data['historyCount']}))
elif sys.argv[1]=='verify':
 data=json.loads((ledger/'preservation.json').read_text())
 assert all((root/p).is_file() and digest(root/p)==h for p,h in data['persistent'].items()), 'Persistent call data changed'
 assert history_count()==data['historyCount'], 'History count changed'
 print(json.dumps({'persistentFilesUnchanged':len(data['persistent']),'historyCountUnchanged':True}))
