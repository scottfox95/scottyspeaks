#!/bin/bash
# SS2 diagnostics — double-click this file on the Mac that feels slow.
# Needs nothing installed.

cd "$(dirname "$0")"
echo "SS2 diagnostics"
echo "=================================================="

echo
echo "── Machine ───────────────────────────────────────"
sysctl -n machdep.cpu.brand_string 2>/dev/null | sed 's/^/Chip     : /'
echo "Memory   : $(( $(sysctl -n hw.memsize 2>/dev/null) / 1073741824 )) GB"
echo "macOS    : $(sw_vers -productVersion)"

echo
echo "── Power (most common cause of unexpected slowness) ──"
if pmset -g 2>/dev/null | grep -qi "lowpowermode.*1"; then
  echo "Low Power Mode : ON   <-- TURN THIS OFF (System Settings > Battery)"
else
  echo "Low Power Mode : off"
fi
if pmset -g ps 2>/dev/null | grep -q "AC Power"; then
  echo "Power source   : AC (plugged in)"
else
  echo "Power source   : BATTERY  <-- plug in for full speed"
fi
LIMIT=$(pmset -g therm 2>/dev/null | grep -o "CPU_Speed_Limit = [0-9]*" | grep -o "[0-9]*$")
if [ -n "$LIMIT" ] && [ "$LIMIT" != "100" ]; then
  echo "Thermal        : CPU limited to ${LIMIT}%  <-- throttling"
else
  echo "Thermal        : normal"
fi

echo
echo "── Models downloaded ─────────────────────────────"
CACHE="$HOME/.cache/scottyspeaks"
if [ ! -d "$CACHE" ]; then
  echo "NOTHING DOWNLOADED. This is the problem -> see FIX below."
else
  for d in models parakeet-models parakeet-coreml-models whisper-models; do
    if [ -d "$CACHE/$d" ]; then
      printf "%-17s: %s  [%s]\n" "$d" "$(du -sh "$CACHE/$d" 2>/dev/null | cut -f1)" "$(ls "$CACHE/$d" 2>/dev/null | tr '\n' ' ')"
    else
      printf "%-17s: MISSING\n" "$d"
    fi
  done
fi

echo
echo "Expected on a healthy machine:"
echo "  models                : ~2.5G  [Qwen3-4B-Instruct-2507-Q4_K_M.gguf]"
echo "  parakeet-coreml-models: ~0.5G  [parakeet-tdt-0.6b-v3]   <-- Neural Engine (fastest)"
echo "  parakeet-models       : ~0.6G  [parakeet-tdt-0.6b-v3]   <-- CPU fallback"
echo "(parakeet-coreml-models downloads itself on first use; until it finishes,"
echo " dictation is served by the CPU copy, so nothing is broken while you wait.)"

echo
echo "── Running now ───────────────────────────────────"
pgrep -f "SS2.app/Contents/MacOS" >/dev/null && echo "SS2 app       : running" || echo "SS2 app       : NOT running"
pgrep -f "llama-server"           >/dev/null && echo "AI polish     : running (warm)" || echo "AI polish     : NOT running  <-- polish is off or model missing"
if pgrep -f "parakeet-coreml" >/dev/null; then
  echo "Transcription : Parakeet on the Neural Engine (fastest — expected)"
elif pgrep -f "sherpa-onnx" >/dev/null; then
  echo "Transcription : Parakeet on CPU (works, ~3x slower than the Neural Engine)"
else
  echo "Transcription : Parakeet NOT running (using Whisper or nothing)"
fi

echo
echo "── Live AI speed test ────────────────────────────"
PORT=""
for p in $(seq 8200 8220); do
  if curl -s -m 1 "http://127.0.0.1:$p/health" 2>/dev/null | grep -q ok; then PORT=$p; break; fi
done
if [ -z "$PORT" ]; then
  echo "AI server not reachable — open SS2, wait ~20s, run this again."
else
  START=$(python3 -c "import time;print(int(time.time()*1000))")
  OUT=$(curl -s -m 120 "http://127.0.0.1:$PORT/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"system","content":"Rewrite the dictation as clean text. Output only the text."},{"role":"user","content":"so um i think we should probably ship it today and follow up tomorrow"}],"max_tokens":128,"temperature":0.2,"stream":false}')
  END=$(python3 -c "import time;print(int(time.time()*1000))")
  echo "Round-trip: $((END-START)) ms   (healthy = under ~3500 ms)"
  echo "$OUT" | python3 -c "import sys,json; print('Output:', json.load(sys.stdin)['choices'][0]['message']['content'].strip())" 2>/dev/null
fi

echo
echo "── Did AI polish actually run? (decisive) ────────"
DB="$HOME/Library/Application Support/scotty-speaks/transcriptions.db"
if [ ! -f "$DB" ]; then
  echo "No history database yet."
else
  TOTAL=$(sqlite3 "$DB" "SELECT COUNT(*) FROM (SELECT id FROM transcriptions ORDER BY id DESC LIMIT 20);" 2>/dev/null)
  POLISHED=$(sqlite3 "$DB" "SELECT COUNT(*) FROM (SELECT raw_text FROM transcriptions ORDER BY id DESC LIMIT 20) WHERE raw_text IS NOT NULL;" 2>/dev/null)
  echo "Of your last $TOTAL dictations, $POLISHED were AI-polished."
  if [ "$POLISHED" = "0" ]; then
    echo "  -> POLISH IS NOT RUNNING. That explains missing punctuation,"
    echo "     quotes and structure. See FIX B below."
  else
    echo "  -> Polish is running. (Very short phrases skip it by design:"
    echo "     under 8 words with no list/formatting cues paste instantly.)"
  fi
  echo
  echo "Most recent dictation stored:"
  sqlite3 "$DB" "SELECT '  ' || substr(replace(text, char(10), ' '), 1, 90) FROM transcriptions ORDER BY id DESC LIMIT 1;" 2>/dev/null
fi

echo
echo "── Which engines are selected ────────────────────"
LS="$HOME/Library/Application Support/scotty-speaks/Local Storage/leveldb"
BLOB=$(cat "$LS"/*.log "$LS"/*.ldb 2>/dev/null | strings 2>/dev/null)
echo "$BLOB" | grep -q "parakeet-tdt-0.6b-v3" && echo "  Parakeet referenced in settings (fast path)"
echo "$BLOB" | grep -q "qwen3-4b-instruct-2507" && echo "  Qwen3 4B Instruct referenced (correct polish model)"
echo "$BLOB" | grep -q "qwen3-8b" && echo "  Note: Qwen3 8B seen in settings history (may be stale; that model is slow)"
echo "  (check Settings > Transcription and Settings > AI for what's active)"

echo
echo "── FIX B: polish not running ─────────────────────"
echo "  1. SS2 > Settings > AI: confirm 'Qwen3 4B Instruct 2507' is SELECTED"
echo "     and shows as downloaded (not just present in the list)."
echo "  2. Confirm the 'polish my dictation' toggle is ON."
echo "  3. Quit SS2 fully, reopen, wait 20 seconds, then dictate a long"
echo "     sentence (10+ words) and run this again."
echo

echo "── FIX: if models are MISSING ────────────────────"
echo "Restoring settings from another Mac marks onboarding complete, so the"
echo "app never prompts to download the models. Download them manually:"
echo
echo "  1. Open SS2 > Settings > Transcription"
echo "     -> pick NVIDIA Parakeet, click Download (~0.6 GB)"
echo "  2. Settings > AI (or Reasoning)"
echo "     -> pick Qwen3 4B Instruct 2507, click Download (~2.5 GB)"
echo "  3. Quit and reopen SS2, then run this again."
echo
read -n 1 -s -r -p "Press any key to close..."
echo
