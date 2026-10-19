# SS2 update assessment (October 19, 2026)

**Headline: ready to try on the Studio.** Every check in the repo passes on the imported updates, nothing is half-built, and a signed build is already packaged and waiting. One flaky test was fixed. Two things to know before shipping to the laptops:

1. GitHub already has a release called **0.3.9** (published October 14) that was built from the old September 10 code. The laptop updater only installs a *different* version number, so the new build has to be **0.3.10**. The version in this branch is set to 0.3.10 so that `npm run publish` cannot collide with it.
2. The new "who said what" labels in Call notes only appear when a call is transcribed on this Mac with **Parakeet on the Neural Engine**. The first transcription downloads about 190 MB of model files, so it needs internet once.

## Where the updates came from

Your checkout at `~/Projects/Personal/ScottySpeaks` had 44 changed files and 11 new ones that were never committed (last touched September 24). They were copied as-is into this branch on top of the September 14 commit you were working from, and committed in one piece ("import: Scott's uncommitted SS2 updates") so the whole diff is reviewable in the PR. Your checkout was not touched.

## What is in the updates

| Feature | What it does | Finished? |
|---|---|---|
| **Speaker labels for local calls** | After a call is transcribed on this Mac, the transcript is split into paragraphs per speaker. The person on your microphone is labelled "Microphone"; everyone else is "Speaker 1, 2…" and can be renamed. A new native helper (`call-diarizer`) runs once per transcription, so the model only uses memory while it works. | Yes. Code, native build, packaging and 6 unit tests are all wired up. Not verified with a real call by me (see "Try it"). |
| **Search your dictation history** | The Dictation view has a search box (⌘F focuses it). It searches everything you ever dictated, including the original wording before you edited an entry, and loads older entries 50 at a time with a "Load older dictations" button. Clear error message with "Try again" if the database is unreachable. | Yes. 4 unit tests. |
| **Call notes workspace** | Search box over calls and notes; call list shows a preview and recorded length; "Record a call" button; "Mark moment", "Action item" and "Use meeting outline" buttons inside notes; "Add to notes" under any transcript line; the Stop button no longer waits on a pending save; the last opened call is remembered; narrow windows get a back button. | Yes. 3 unit tests plus a full Electron UI run. |
| **Sidebar tidy-up** | Two groups ("Workspace" and "Make it yours"), remembers the view you were on, ⌘1 / ⌘2 / ⌘3 jump between Dictation, Call notes and Notes. The old Support menu is gone. | Yes. |
| **Recording start/stop reliability** | A quick press-and-release while the microphone is still opening now cancels cleanly instead of showing a "Recording Error" or leaving the microphone open. Silence-detection resources are always released. | Yes. 7 unit tests. |
| **Faster, correct app context for polish** | Dictation polish reuses the app name captured when recording started instead of looking it up again, so switching windows mid-dictation can no longer change the tone, and recording starts slightly sooner. | Yes. 3 unit tests. |
| **UI languages load on demand** | English is built in; the other nine languages load as small separate files when selected, so startup parses less. | Yes. New Electron locale test covers all ten languages. |
| **All new text in all languages** | Every new label exists in all ten language files. | Yes. The i18n check passes. |
| **Developer preview page** | `npm run preview:workspace` renders the Dictation and Call notes screens in a browser with sample data for design review. Not shipped in the app. | Yes. |

Plain-language notes on the speaker labels, since that is the risky one:

- Only the local Parakeet engine on the Neural Engine provides word timings, which the labels need. Whisper, Parakeet on CPU, and cloud (OpenRouter) transcripts look exactly as before.
- Labelling is best-effort. If the helper fails for any reason, you still get the normal unlabelled transcript and a warning in the debug log.
- Microphone and call audio are still mixed before labelling (there is no echo cancellation), so with speakers instead of headphones the far side can bleed into your microphone. The code handles that by comparing loudness per track; if it is ambiguous, nobody gets the "Microphone" label and everyone stays numbered.
- Your own notes in CLAUDE.md say this measured 98.75% agreement with the cloud transcript on a real 22-minute two-person call.

## Added after the Studio try-out: "sounds like" words (October 19)

You asked for a way to teach the app names it keeps mishearing ("Aravo" comes out as "bravo" or "a rather"; "Echad" similarly). The honest limit: the speech model cannot learn a pronunciation from a recording. What works is fixing the text after recognition, deterministically, and that is what was built:

- **Each dictionary word can have "sounds like" aliases.** "Aravo: bravo, a rather". Any time the recognizer produces one of those, it is replaced with the right spelling in every dictation, long or short, before the polish step runs.
- **Learned automatically.** Edit a dictation in History (or in the target app with auto-learn on) and replace a mishearing with a dictionary word, and the alias is saved for next time. Two- and three-word mishearings count ("six point tombs" to "Six Points Homes").
- **Teach it.** In Dictionary, hover a word and click the microphone icon. Say the word, stop, repeat about three times. Each take shows what was heard; anything wrong becomes an alias when you press Save. You can also type aliases by hand in the same dialog.
- **Manage.** A "Sounds like" list under the dictionary shows every alias with an x to remove it. Removing a dictionary word removes its aliases.
- **Caveat, shown in the UI:** an alias is always replaced, even when you mean it literally. If "bravo" is on Aravo's list, you can no longer dictate the word "bravo".

Not covered: call-notes transcripts (the words there carry timestamps that would drift) and the live streaming cloud transcription path, which is caught at paste time instead of before polish.

To try it: add "Aravo" and "Echad" to the dictionary if they are not there, click the mic next to each, say the name three times, save. Then dictate a sentence with the name in it.

## What I fixed

1. **Flaky Electron test, not an app bug.** `npm run test:workspace-ui` failed about one run in three with "Unobscured meetings.resume". The test clicked a call in the list and immediately hit-tested the next button; while the call opens, every button is briefly disabled, so a single sample could fail. A screenshot from a failing run showed a clean screen with nothing covering the button. The test now waits until the button is enabled and unobscured. 8 of 8 runs pass afterwards.
2. **Transcript smoke test noise.** That test renders the real control panel, whose Dictation view now calls the new history search. The test's fake backend now answers it, so the run stays free of "No handler registered" errors.
3. **Version set to 0.3.10** (see headline) and release notes added at `docs/releases/0.3.10.md`.

## Checks run

| Check | Result |
|---|---|
| `npm test` (Node unit tests) | 235 pass, 0 fail, 0 skipped (run after the native helpers were built) |
| `npm run typecheck` | Pass |
| `npm run i18n:check` | Pass, all ten languages consistent |
| `npm run lint` | 0 errors, 26 warnings (pre-existing style warnings) |
| `npm run build:renderer` | Pass |
| `npm run compile:native` | Pass. Built the new `call-diarizer-darwin-arm64` (18 MB, arm64) alongside the existing helpers |
| `npm run test:workspace-ui` | Pass (8/8 after the fix; 3/6 before) |
| `npm run test:locales-ui` | Pass |
| `npm run test:meetings-ui` | Pass |
| `npm run test:transcript-ui` | Pass |
| `npm run pack` | Pass. Signed with "ScottySpeaks Local Signing", signature verifies, `call-diarizer` is inside the app bundle |

Not checked, because it needs a person and a microphone: dictating into a real app, recording a real call, and the quality of the speaker labels. The repo's own acceptance rule says the same.

## Things to know or do later (not built)

- **Verify speaker labels on a real call** before relying on them. Two people, headphones, a minute of talk, transcribe locally.
- **Whisper and CPU-Parakeet calls stay unlabelled.** Giving them labels would need word timings from those engines; that is a separate project.
- **No echo cancellation yet.** On speakers, expect occasional far-side words attributed to "Microphone".
- **Node 26 cannot install this project's dependencies** (the SQLite module fails to compile). Node 22 works and is installed via Homebrew (`/opt/homebrew/opt/node@22`). Your existing checkout already has its dependencies, so you are not blocked, but a fresh clone would be. Adding an `.nvmrc` or `engines` field would make that explicit.
- **26 lint warnings** are style-only and were there before.
- **Your checkout still holds the uncommitted copy of these changes.** After the PR is merged you can park it with `git stash push -u -m "pre-assess copy"` and `git pull`; or leave it, nothing depends on it.

## Try it on the Studio

Everything is already built in the worktree, so the first try is two commands. Quit SS2 first (the installer stops it if you forget, but quitting is cleaner).

```sh
cd ~/Projects/Personal/ScottySpeaks/.claude/worktrees/ss2-assess-updates
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run install:local
open /Applications/SS2.app
```

`install:local` checks the signature, moves the current app to `~/Library/Application Support/SS2 App Backups.noindex/<timestamp>/SS2.app`, and swaps in the new one. Your history, settings, models and keys stay where they are. If `dist/mac-arm64/SS2.app` is missing (for example after a `git clean`), run `npm run pack` first; it takes about three minutes.

What to try, in order:

1. Settings should show version **0.3.10**. Hotkey, pedal, dictionary and history should all still be there.
2. Dictate a sentence into Notes or a document. It should paste as before. Then press and release the hotkey very quickly a few times: no "Recording Error" should appear.
3. Open the control panel. The sidebar has two groups; ⌘1, ⌘2, ⌘3 switch views. Quit and reopen: it should land on the view you left.
4. Dictation view: type a word from an old dictation into the search box. Press ⌘F to focus it, Escape to clear. Click "Load older dictations" at the bottom. Edit an entry with the pencil and save; a "Learned" badge should appear.
5. Call notes: make sure Call note settings say "On this Mac" with the Parakeet engine, and that Settings → Transcription → Parakeet is set to "Neural Engine". Click "Record a call", talk with someone (or play a video) for a minute, press "Mark moment" while recording, then Stop. Click "Transcribe audio". The first time waits roughly 30 seconds for the 190 MB model download; afterwards a 20-minute call takes a few seconds. The transcript should show "Microphone" paragraphs for you and "Speaker 1" for the other voice. Click the speaker name to rename it. Try "Add to notes" under a line, and the call search box.
6. Switch the UI language in Settings to Spanish and back. Labels should change without a restart.

To go back to the previous build:

```sh
ls ~/Library/Application\ Support/SS2\ App\ Backups.noindex/
# quit SS2, then (use the folder name you see above):
rm -rf /Applications/SS2.app
ditto ~/Library/Application\ Support/SS2\ App\ Backups.noindex/<timestamp>/SS2.app /Applications/SS2.app
```

## Update the laptops

Do this only after you are happy on the Studio.

1. Merge the PR into `feat/local-call-diarization` on GitHub. The release points at the commit it was built from, so that commit must exist on GitHub; the PR branch already does.
2. From the same worktree directory (with Node 22 on the PATH as above) run:

   ```sh
   npm run publish -- none
   ```

   `-- none` keeps the version at 0.3.10. (Plain `npm run publish` would bump to 0.3.11, which also works; both are newer than the 0.3.9 the laptops have.) This rebuilds, signs, installs 0.3.10 on the Studio again, uploads `SS2-0.3.10.zip` as a GitHub release, and rewrites `~/Desktop/SS2-Update.command`. It needs the `gh` command logged in, which it is on the Studio.
3. On each laptop, double-click **SS2-Update.command**. It downloads about 170 MB, replaces `/Applications/SS2.app`, clears quarantine, checks the signature and relaunches. If a laptop never received that file, copy it once from the Studio's Desktop (AirDrop is fine); it updates itself from then on.
4. On the work laptop, the usual admin approval for installing apps may apply, and the first call transcription will download the 190 MB model there too.

Nothing in this branch has been installed on the Studio, and nothing has been published. The PR is a draft against `feat/local-call-diarization` (your working branch; it did not exist on GitHub, so it was pushed at the exact commit you were on, September 14). `main` is months behind and is not the right base.
