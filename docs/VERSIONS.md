# SS2 version map (November 3, 2026)

Snapshot taken from the Mac Studio. Refresh it before each publish.

## What's where

| Where | Version | Notes |
|---|---|---|
| GitHub Release `v0.3.11` (Latest, Oct 19) | 0.3.11 | What `SS2-Update.command` installs today. Includes call auto-stop/trim (PR #2) and "sounds like" aliases (PR #1) |
| Older releases | 0.3.9, 0.3.8 … 0.3.4, 0.1.8 … 0.1.2 | 0.3.10 and 0.2.x were never published as releases |
| `main` | 0.3.12 | v0.3.11 + **one** commit: screen recording (PR #3, merged Oct 21). Never published |
| PR #4 (draft, `worktree-ss2-sleep-hex`) | on top of 0.3.12 | Keeps call/screen recordings alive through display sleep, plus a Hex study doc. Waiting on a real capture test |
| This PR (`worktree-ss2-digits-slash`) | on top of tag v0.3.11 | Spoken numbers → digits, spoken "slash" → `/`. Merges cleanly into `main` too |
| Other remote branches | — | All already merged into `main` (nothing ahead of it) |
| Mac Studio `/Applications/SS2.app` | 0.3.11 | Studio checkout sits on `feat/local-call-diarization` with local edits to `CLAUDE.md` and `electron-builder.json` |
| Personal laptop (M5) | 0.3.11 | Scott: "this is what I want to work from, it's working best" |
| Work laptop | not reported | Updates only via `SS2-Update.command` |

So the Studio and the M5 run **the same code**. Whatever makes the M5 better is per-machine data, not a different build (see below).

## What `main` has since v0.3.11

Only PR #3, screen recording (Screen recordings page, ⌘4; native `screen-recorder` helper; 28 files, +1,851 lines). It doesn't touch dictation, polish or transcription.

**Recommendation: include it.** It's additive and isolated from dictation. Two cautions: it needs a Screen & System Audio Recording grant per Mac (the Studio still has none, so it's untested end to end there), and PR #4's sleep fix is the follow-up that makes long recordings reliable. If Scott wants zero risk, publish from `v0.3.11` + this PR instead; this branch is built on the tag so either works.

## Why one Mac can work better on the same version

All of this lives in the Mac's user data (`~/Library/Application Support/scotty-speaks/`), not the app:

| Setting | Where it's stored | Effect |
|---|---|---|
| Custom dictionary + "sounds like" aliases (Teach it) | `transcriptions.db` | Names the recognizer gets right/wrong |
| Learned examples (History edits) | `transcriptions.db` (`style_examples`) | Few-shot style hints for polish |
| Style profiles and their instructions | `transcriptions.db` | Per-app tone and formatting |
| Polish model, editing style (Balanced/Verbatim), language, hotkeys | Local Storage | The code default is Qwen3-4B; a Mac may have Granite or another model selected |
| Transcription engine (Parakeet/Whisper, CoreML vs CPU, cloud provider) and API keys | `.env` + Local Storage | Accuracy and speed |
| Pedal mapping | `pedal-config.json` | Pedal behaviour |
| Downloaded models | `~/.cache/scottyspeaks` | Which models are available at all (not exported; they re-download) |

The mic matters too: a better microphone on the M5 improves accuracy with identical settings.

## Copying the M5's settings to another Mac

1. On the M5, quit SS2, then from a checkout: `npm run settings:export` → `~/Desktop/ss2-settings-<date>.tar.gz` (~100 KB). It contains the `.env` with API keys, so move it by AirDrop or USB, not email or chat.
2. On the other Mac, quit SS2, then `npm run settings:import -- <archive>`. The existing data is moved to `scotty-speaks-backup-<ts>` first, so it's reversible.
3. The work laptop has no checkout; the same archive can be unpacked into `~/Library/Application Support/scotty-speaks/` by hand (SS2 quit) after backing that folder up. Note that this copies personal history and keys onto a work machine; Scott decides.

If the M5 has no checkout, check first: `ls -d ~/Projects/*/ScottySpeaks ~/Projects/ScottySpeaks 2>/dev/null`. Without one, the export can be made by hand: quit SS2 and zip `Local Storage`, `transcriptions.db`, `pedal-config.json` and `.env` from `~/Library/Application Support/scotty-speaks/`.

## Steps for Scott on the M5 (only if it has a checkout)

To be sure no unpushed code is hiding there:
- `git status` and `git branch --show-current`
- `git fetch origin && git log --oneline origin/main..HEAD`
- If anything shows up: `git switch -c laptop-$(date +%Y%m%d) && git add -A && git commit -m "M5 work" && git push -u origin HEAD` (check no `.env` is staged first), then tell Echad the branch.

## How each Mac updates today

- **A Mac with the repo:** `npm run publish` bumps the version, builds, signs, installs, publishes a GitHub Release and writes `SS2-Update.command` to the Desktop.
- **Every other Mac:** double-click `SS2-Update.command`. It installs the **latest published release** only, so nobody gets 0.3.12 or this fix until it's published.

## One version everywhere (after review)

1. Scott picks: v0.3.11 + this PR, or `main` (screen recording) + this PR.
2. Merge, `npm run publish` on one Mac → 0.3.13.
3. `SS2-Update.command` on each other Mac, then optionally import the M5's settings.
