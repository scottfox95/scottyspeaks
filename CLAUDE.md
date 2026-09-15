# ScottySpeaks Studio operating context

This repository is **ScottySpeaks (SS2)**, Scott's customized OpenWhispr-derived desktop dictation application. On the Mac Studio, `/Users/scott/Projects/ScottySpeaks` is the short Moshi alias for this checkout. Do not declare the Studio migration accepted from builds or automated tests alone: `/Applications/SS2.app` must complete first-launch macOS Microphone and Accessibility permission prompts, record a real spoken phrase, and paste the resulting text into a disposable document. System-audio/call capture is a separate later acceptance step.

# OpenWhispr Technical Reference for AI Assistants

This document provides comprehensive technical details about the OpenWhispr project architecture for AI assistants working on the codebase.

## Project Overview

OpenWhispr is an Electron-based desktop dictation application that uses whisper.cpp for speech-to-text transcription. It supports both local (privacy-focused) and cloud (OpenAI API) processing modes.

## Architecture Overview

### Core Technologies
- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Vite
- **Desktop Framework**: Electron 36 with context isolation
- **Database**: better-sqlite3 for local transcription history
- **UI Components**: shadcn/ui with Radix primitives
- **Speech Processing**: whisper.cpp + NVIDIA Parakeet (via sherpa-onnx) + OpenAI API
- **Audio Processing**: FFmpeg (bundled via ffmpeg-static)

### Key Architectural Decisions

1. **Dual Window Architecture**:
   - Main Window: Minimal overlay for dictation (draggable, always on top)
   - Control Panel: Full settings interface (normal window)
   - Both use same React codebase with URL-based routing

2. **Process Separation**:
   - Main Process: Electron main, IPC handlers, database operations
   - Renderer Process: React app with context isolation
   - Preload Script: Secure bridge between processes

3. **Audio Pipeline**:
   - MediaRecorder API → Blob → ArrayBuffer → IPC → File → whisper.cpp
   - Automatic cleanup of temporary files after processing

## File Structure and Responsibilities

### Main Process Files

- **main.js**: Application entry point, initializes all managers
- **preload.js**: Exposes safe IPC methods to renderer via window.api

### Native Resources (resources/)

- **windows-key-listener.c**: C source for Windows low-level keyboard hook (Push-to-Talk)
- **globe-listener.swift**: Swift source for macOS Globe/Fn key detection
- **bin/**: Directory for compiled native binaries (whisper-cpp, nircmd, key listeners)

### Helper Modules (src/helpers/)

- **audioManager.js**: Handles audio device management
- **clipboard.js**: Cross-platform clipboard operations
  - macOS: AppleScript-based paste with accessibility permission check
  - Windows: PowerShell SendKeys with nircmd.exe fallback
  - Linux: Native XTest binary + compositor-aware fallbacks (xdotool, wtype, ydotool)
- **database.js**: SQLite operations for transcription history
- **debugLogger.js**: Debug logging system with file output
- **devServerManager.js**: Vite dev server integration
- **dragManager.js**: Window dragging functionality
- **environment.js**: Environment variable and OpenAI API management
- **hotkeyManager.js**: Global hotkey registration and management
  - Handles platform-specific defaults (GLOBE on macOS, backtick on Windows/Linux)
  - Auto-fallback to F8/F9 if default hotkey is unavailable
  - Notifies renderer via IPC when hotkey registration fails
  - Integrates with GnomeShortcutManager for GNOME Wayland support
- **gnomeShortcut.js**: GNOME Wayland global shortcut integration
  - Uses D-Bus service to receive hotkey toggle commands
  - Registers shortcuts via gsettings (visible in GNOME Settings → Keyboard → Shortcuts)
  - Converts Electron hotkey format to GNOME keysym format
  - Only active on Linux + Wayland + GNOME desktop
- **ipcHandlers.js**: Centralized IPC handler registration
- **windowsKeyManager.js**: Windows Push-to-Talk support with native key listener
  - Spawns native `windows-key-listener.exe` binary for low-level keyboard hooks
  - Supports compound hotkeys (e.g., `Ctrl+Shift+F11`, `CommandOrControl+Space`)
  - Emits `key-down` and `key-up` events for push-to-talk functionality
  - Graceful fallback if binary unavailable
- **menuManager.js**: Application menu management
- **tray.js**: System tray icon and menu
- **whisper.js**: Local whisper.cpp integration and model management
- **parakeet.js**: NVIDIA Parakeet model management via sherpa-onnx
- **parakeetServer.js**: sherpa-onnx CLI wrapper for transcription
- **windowConfig.js**: Centralized window configuration
- **windowManager.js**: Window creation and lifecycle management

### React Components (src/components/)

- **App.jsx**: Main dictation interface with recording states
- **ControlPanel.tsx**: Settings, history, model management UI
- **OnboardingFlow.tsx**: 8-step first-time setup wizard
- **SettingsPage.tsx**: Comprehensive settings interface
- **WhisperModelPicker.tsx**: Model selection and download UI
- **ui/**: Reusable UI components (buttons, cards, inputs, etc.)

### React Hooks (src/hooks/)

- **useAudioRecording.js**: MediaRecorder API wrapper with error handling
- **useClipboard.ts**: Clipboard operations hook
- **useDialogs.ts**: Electron dialog integration
- **useHotkey.js**: Hotkey state management
- **useLocalStorage.ts**: Type-safe localStorage wrapper
- **usePermissions.ts**: System permission checks and settings access
  - `openMicPrivacySettings()`: Opens OS microphone privacy settings
  - `openSoundInputSettings()`: Opens OS sound input device settings
  - `openAccessibilitySettings()`: Opens OS accessibility settings (macOS only)
- **useSettings.ts**: Application settings management
- **useWhisper.ts**: Whisper binary availability check

### Services

- **ReasoningService.ts**: AI processing for agent-addressed commands
  - Detects when user addresses their named agent
  - Routes to appropriate AI provider (OpenAI/Anthropic/Gemini)
  - Removes agent name from final output
  - Supports GPT-5, Claude 4.6 (Opus/Sonnet/Haiku), and Gemini 3.1 Pro / 3 Flash models

### whisper.cpp Integration

- **whisper.js**: Native binary wrapper for local transcription
  - Bundled binaries in `resources/bin/whisper-cpp-{platform}-{arch}`
  - Falls back to system installation (`brew install whisper-cpp`)
  - GGML model downloads from HuggingFace
  - Models stored in `~/.cache/openwhispr/whisper-models/`

### NVIDIA Parakeet Integration (via sherpa-onnx)

- **parakeet.js**: Model management for NVIDIA Parakeet ASR models
  - Uses sherpa-onnx runtime for cross-platform ONNX inference
  - Bundled binaries in `resources/bin/sherpa-onnx-{platform}-{arch}`
  - INT8 quantized models for efficient CPU inference
  - Models stored in `~/.cache/openwhispr/parakeet-models/`
  - Server pre-warming on startup when `LOCAL_TRANSCRIPTION_PROVIDER=nvidia` is set
  - Provider preference persisted to `.env` via `saveAllKeysToEnvFile()` on server start/stop

- **Available Models**:
  - `parakeet-tdt-0.6b-v3`: Multilingual (25 languages), ~680MB

- **Download URLs**: Models from sherpa-onnx ASR models release on GitHub

### Build Scripts (scripts/)

- **download-whisper-cpp.js**: Downloads whisper.cpp binaries from GitHub releases
- **download-llama-server.js**: Downloads llama.cpp server for local LLM inference
- **download-nircmd.js**: Downloads nircmd.exe for Windows clipboard operations
- **download-windows-key-listener.js**: Downloads prebuilt Windows key listener binary
- **download-sherpa-onnx.js**: Downloads sherpa-onnx binaries for Parakeet support
- **build-globe-listener.js**: Compiles macOS Globe key listener from Swift source
- **build-windows-key-listener.js**: Compiles Windows key listener (for local development)
- **run-electron.js**: Development script to launch Electron with proper environment
- **lib/download-utils.js**: Shared utilities for downloading and extracting files
  - `fetchLatestRelease(repo, options)`: Fetches latest release from GitHub API
  - `downloadFile(url, dest)`: Downloads file with progress and retry logic
  - `extractZip(zipPath, destDir)`: Cross-platform zip extraction
  - `parseArgs()`: Parses CLI arguments for platform/arch targeting
  - Supports `GITHUB_TOKEN` for authenticated requests (higher rate limits)

## Key Implementation Details

### 1. FFmpeg Integration

FFmpeg is bundled with the app and doesn't require system installation:
```javascript
// FFmpeg is unpacked from ASAR to app.asar.unpacked/node_modules/ffmpeg-static/
```

### 2. Audio Recording Flow

1. User presses hotkey → MediaRecorder starts
2. Audio chunks collected in array
3. User presses hotkey again → Recording stops
4. Blob created from chunks → Converted to ArrayBuffer
5. Sent via IPC
6. Main process writes to temporary file
7. whisper.cpp processes file → Result sent back
8. Temporary file deleted

### 3. Local Whisper Models (GGML format)

Models stored in `~/.cache/openwhispr/whisper-models/`:
- tiny: ~75MB (fastest, lowest quality)
- base: ~142MB (recommended balance)
- small: ~466MB (better quality)
- medium: ~1.5GB (high quality)
- large: ~3GB (best quality)
- turbo: ~1.6GB (fast with good quality)

### 4. Database Schema

```sql
CREATE TABLE transcriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  original_text TEXT NOT NULL,
  processed_text TEXT,
  is_processed BOOLEAN DEFAULT 0,
  processing_method TEXT DEFAULT 'none',
  agent_name TEXT,
  error TEXT
);
```

### 5. Settings Storage

Settings stored in localStorage with these keys:
- `whisperModel`: Selected Whisper model
- `useLocalWhisper`: Boolean for local vs cloud
- `openaiApiKey`: Encrypted API key
- `anthropicApiKey`: Encrypted API key
- `geminiApiKey`: Encrypted API key
- `language`: Selected language code
- `agentName`: User's custom agent name
- `reasoningModel`: Selected AI model for processing
- `reasoningProvider`: AI provider (openai/anthropic/gemini/local)
- `hotkey`: Custom hotkey configuration
- `hasCompletedOnboarding`: Onboarding completion flag
- `customDictionary`: JSON array of words/phrases for improved transcription accuracy

Environment variables persisted to `.env` (via `saveAllKeysToEnvFile()`):
- `LOCAL_TRANSCRIPTION_PROVIDER`: Transcription engine (`nvidia` for Parakeet)
- `PARAKEET_MODEL`: Selected Parakeet model name (e.g., `parakeet-tdt-0.6b-v3`)

### 6. Language Support

58 languages supported (see src/utils/languages.ts):
- Each language has a two-letter code and label
- "auto" for automatic detection
- Passed to whisper.cpp via -l parameter

### 7. Agent Naming System

- User names their agent during onboarding (step 6/8)
- Name stored in localStorage and database
- ReasoningService detects "Hey [AgentName]" patterns
- AI processes command and removes agent reference from output
- Supports multiple AI providers (all models defined in `src/models/modelRegistryData.json`):
  - **OpenAI** (Responses API):
    - GPT-5.2 (`gpt-5.2`) - Latest flagship reasoning model
    - GPT-5 Mini (`gpt-5-mini`) - Fast and cost-efficient
    - GPT-5 Nano (`gpt-5-nano`) - Ultra-fast, low latency
    - GPT-4.1 Series (`gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano`) - Strong baseline with 1M context
  - **Anthropic** (Via IPC bridge to avoid CORS):
    - Claude Sonnet 4.6 (`claude-sonnet-4-6`) - Balanced performance
    - Claude Haiku 4.5 (`claude-haiku-4-5`) - Fast with near-frontier intelligence
    - Claude Opus 4.6 (`claude-opus-4-6`) - Most capable Claude model
  - **Google Gemini** (Direct API integration):
    - Gemini 3.1 Pro (`gemini-3.1-pro-preview`) - Most capable Gemini model
    - Gemini 3 Flash (`gemini-3-flash-preview`) - Ultra-fast, high-capability next-gen model
    - Gemini 2.5 Flash Lite (`gemini-2.5-flash-lite`) - Lowest latency and cost
  - **Local**: GGUF models via llama.cpp (Qwen, Llama, Mistral, GPT-OSS)

### 8. Model Registry Architecture

All AI model definitions are centralized in `src/models/modelRegistryData.json` as the single source of truth:

```json
{
  "cloudProviders": [...],   // OpenAI, Anthropic, Gemini API models
  "localProviders": [...]    // GGUF models with download URLs
}
```

**Key files:**
- `src/models/modelRegistryData.json` - Single source of truth for all models
- `src/models/ModelRegistry.ts` - TypeScript wrapper with helper methods
- `src/config/aiProvidersConfig.ts` - Derives AI_MODES from registry
- `src/utils/languages.ts` - Derives REASONING_PROVIDERS from registry
- `src/helpers/modelManagerBridge.js` - Handles local model downloads

**Local model features:**
- Each model has `hfRepo` for direct HuggingFace download URLs
- `promptTemplate` defines the chat format (ChatML, Llama, Mistral)
- Download URLs constructed as: `{baseUrl}/{hfRepo}/resolve/main/{fileName}`

### 9. API Integrations and Updates

**OpenAI Responses API (September 2025)**:
- Migrated from Chat Completions to new Responses API
- Endpoint: `https://api.openai.com/v1/responses`
- Simplified request format with `input` array instead of `messages`
- New response format with `output` array containing typed items
- Automatic handling of GPT-5 and o-series model requirements
- No temperature parameter for newer models (GPT-5, o-series)

**Anthropic Integration**:
- Routes through IPC handler to avoid CORS issues in renderer process
- Uses main process for API calls with proper error handling
- Model IDs use alias format (e.g., `claude-sonnet-4-6` not date-suffixed versions)

**Gemini Integration**:
- Direct API calls from renderer process
- Increased token limits for Gemini 3.1 Pro (2000 minimum)
- Proper handling of thinking process in responses
- Error handling for MAX_TOKENS finish reason

**API Key Persistence**:
- All API keys now properly persist to `.env` file
- Keys stored in environment variables and reloaded on app start
- Centralized `saveAllKeysToEnvFile()` method ensures consistency

### 10. System Settings Integration

The app can open OS-level settings for microphone permissions, sound input selection, and accessibility:

**IPC Handlers** (in `ipcHandlers.js`):
- `open-microphone-settings`: Opens microphone privacy settings
- `open-sound-input-settings`: Opens sound/audio input device settings
- `open-accessibility-settings`: Opens accessibility privacy settings (macOS only)

**Platform-specific URLs**:
| Platform | Microphone Privacy | Sound Input | Accessibility |
|----------|-------------------|-------------|---------------|
| macOS | `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone` | `x-apple.systempreferences:com.apple.preference.sound?input` | `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` |
| Windows | `ms-settings:privacy-microphone` | `ms-settings:sound` | N/A |
| Linux | Manual (no URL scheme) | Manual (e.g., pavucontrol) | N/A |

**UI Component** (`MicPermissionWarning.tsx`):
- Shows platform-appropriate buttons and messages
- Linux only shows "Open Sound Settings" (no separate privacy settings)
- macOS/Windows show both sound and privacy buttons

### 11. Debug Mode

Enable with `--log-level=debug` or `OPENWHISPR_LOG_LEVEL=debug` (can be set in `.env`):
- Logs saved to platform-specific app data directory
- Comprehensive logging of audio pipeline
- FFmpeg path resolution details
- Audio level analysis
- Complete reasoning pipeline debugging with stage-by-stage logging

### 12. Windows Push-to-Talk

Native Windows support for true push-to-talk functionality using low-level keyboard hooks:

**Architecture**:
- `resources/windows-key-listener.c`: Native C program using Windows `SetWindowsHookEx` for keyboard hooks
- `src/helpers/windowsKeyManager.js`: Node.js wrapper that spawns and manages the native binary
- Binary outputs `KEY_DOWN` and `KEY_UP` to stdout when target key is pressed/released

**Compound Hotkey Support**:
- Parses hotkey strings like `CommandOrControl+Shift+F11`
- Maps modifiers: `CommandOrControl`/`Ctrl` → VK_CONTROL, `Alt`/`Option` → VK_MENU, `Shift` → VK_SHIFT
- Verifies all required modifiers are held before emitting key events

**Binary Distribution**:
- Prebuilt binary downloaded from GitHub releases (`windows-key-listener-v*` tags)
- Download script: `scripts/download-windows-key-listener.js`
- CI workflow: `.github/workflows/build-windows-key-listener.yml`
- Fallback to tap mode if binary unavailable

**IPC Events**:
- `windows-key-listener:key-down`: Fired when hotkey pressed (start recording)
- `windows-key-listener:key-up`: Fired when hotkey released (stop recording)

### 13. Custom Dictionary

Improve transcription accuracy for specific words, names, or technical terms:

**How it works**:
- User adds words/phrases through Settings → Custom Dictionary
- Words stored as JSON array in localStorage (`customDictionary` key)
- On transcription, words are joined and passed as `prompt` parameter to Whisper
- Works with both local whisper.cpp and cloud OpenAI Whisper API

**Implementation**:
- `src/hooks/useSettings.ts`: Manages `customDictionary` state
- `src/components/SettingsPage.tsx`: UI for adding/removing dictionary words
- `src/helpers/audioManager.js`: Reads dictionary and adds to transcription options
- `src/helpers/whisperServer.js`: Includes dictionary as `prompt` in API request

**Whisper Prompt Parameter**:
- Whisper uses the prompt as context/hints for transcription
- Words in the prompt are more likely to be recognized correctly
- Useful for: uncommon names, technical jargon, brand names, domain-specific terms

### 14. GNOME Wayland Global Hotkeys

On GNOME Wayland, Electron's `globalShortcut` API doesn't work due to Wayland's security model. OpenWhispr uses native GNOME shortcuts:

**Architecture**:
1. `main.js` enables `GlobalShortcutsPortal` feature flag for Wayland
2. `hotkeyManager.js` detects GNOME + Wayland and initializes `GnomeShortcutManager`
3. `gnomeShortcut.js` creates D-Bus service at `com.openwhispr.App`
4. Shortcuts registered via `gsettings` as custom GNOME keybindings
5. GNOME triggers `dbus-send` command which calls the D-Bus `Toggle()` method

**Key Constants**:
- D-Bus service: `com.openwhispr.App`
- D-Bus path: `/com/openwhispr/App`
- gsettings path: `/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/openwhispr/`

**IPC Integration**:
- `get-hotkey-mode-info`: Returns `{ isUsingGnome: boolean }` to renderer
- UI hides activation mode selector when `isUsingGnome` is true
- Forces tap-to-talk mode (push-to-talk not supported)

**Hotkey Format Conversion**:
- Electron format: `Alt+R`, `CommandOrControl+Shift+Space`
- GNOME format: `<Alt>r`, `<Control><Shift>space`
- Backtick (`) → `grave` in GNOME keysym format

## Development Guidelines

### Internationalization (i18n) — REQUIRED

All user-facing strings **must** use the i18n system. Never hardcode UI text in components.

**Setup**: react-i18next (v15) with i18next (v25). Translation files in `src/locales/{lang}/translation.json`.

**Supported languages**: en, es, fr, de, pt, it, ru, zh-CN, zh-TW

**How to use**:
```tsx
import { useTranslation } from "react-i18next";

const { t } = useTranslation();
// Simple: t("notes.list.title")
// With interpolation: t("notes.upload.using", { model: "Whisper" })
```

**Rules**:
1. Every new UI string must have a translation key in `en/translation.json` and all other language files
2. Use `useTranslation()` hook in components and hooks
3. Keep `{{variable}}` interpolation syntax for dynamic values
4. Do NOT translate: brand names (OpenWhispr, Pro), technical terms (Markdown, Signal ID), format names (MP3, WAV), AI system prompts
5. Group keys by feature area (e.g., `notes.editor.*`, `referral.toasts.*`)

### Adding New Features

1. **New IPC Channel**: Add to both ipcHandlers.js and preload.js
2. **New Setting**: Update useSettings.ts and SettingsPage.tsx
3. **New UI Component**: Follow shadcn/ui patterns in src/components/ui
4. **New Manager**: Create in src/helpers/, initialize in main.js
5. **New UI Strings**: Add translation keys to all 9 language files (see i18n section above)

### Testing Checklist

- [ ] Test both local and cloud processing modes
- [ ] Verify hotkey works globally
- [ ] Check clipboard pasting on all platforms
- [ ] Test with different audio input devices
- [ ] Verify whisper.cpp binary detection
- [ ] Test all Whisper models
- [ ] Check agent naming functionality
- [ ] Test custom dictionary with uncommon words
- [ ] Verify Windows Push-to-Talk with compound hotkeys
- [ ] Test GNOME Wayland hotkeys (if on GNOME + Wayland)
- [ ] Verify activation mode selector is hidden on GNOME Wayland

### Common Issues and Solutions

1. **No Audio Detected**:
   - Check FFmpeg path resolution
   - Verify microphone permissions
   - Check audio levels in debug logs

2. **Transcription Fails**:
   - Ensure whisper.cpp binary is available
   - Check model is downloaded
   - Check temporary file creation
   - Verify FFmpeg is executable

3. **Clipboard Not Working**:
   - macOS: Check accessibility permissions (required for AppleScript paste)
   - Linux: Native `linux-fast-paste` binary (XTest) is tried first, works for X11 and XWayland apps
     - X11: xdotool fallback if native binary unavailable
     - GNOME/KDE Wayland: xdotool (XWayland apps) → ydotool (requires ydotoold daemon)
     - wlroots Wayland (Sway, Hyprland): wtype → xdotool → ydotool
   - Windows: PowerShell SendKeys (built-in) or nircmd.exe (bundled)

4. **Build Issues**:
   - Use `npm run pack` for unsigned builds (CSC_IDENTITY_AUTO_DISCOVERY=false)
   - Signing requires Apple Developer account
   - ASAR unpacking needed for FFmpeg
   - Run `npm run download:whisper-cpp` before packaging (current platform)
   - Use `npm run download:whisper-cpp:all` for multi-platform packaging
   - afterSign.js automatically skips signing when CSC_IDENTITY_AUTO_DISCOVERY=false

5. **Windows Push-to-Talk Binary**:
   - Prebuilt binary downloaded automatically on Windows during build
   - If download fails, push-to-talk falls back to tap mode
   - To compile locally: install Visual Studio Build Tools or MinGW-w64
   - CI workflow (`.github/workflows/build-windows-key-listener.yml`) auto-builds on push to main

### Platform-Specific Notes

**macOS**:
- Requires accessibility permissions for clipboard (auto-paste)
- Requires microphone permission (prompted by system)
- Uses AppleScript for reliable pasting
- Notarization needed for distribution
- Shows in dock with indicator dot when running (LSUIElement: false)
- whisper.cpp bundled for both arm64 and x64
- System settings accessible via `x-apple.systempreferences:` URL scheme

**Windows**:
- No special accessibility permissions needed
- Microphone privacy settings at `ms-settings:privacy-microphone`
- Sound settings at `ms-settings:sound`
- NSIS installer for distribution
- whisper.cpp bundled for x64
- **Push-to-Talk**: Native key listener binary (`windows-key-listener.exe`) enables true push-to-talk
  - Uses Windows Low-Level Keyboard Hook (`WH_KEYBOARD_LL`)
  - Supports compound hotkeys (e.g., `Ctrl+Shift+F11`)
  - Prebuilt binary auto-downloaded from GitHub releases
  - Falls back to tap mode if unavailable

**Linux**:
- Multiple package manager support
- Standard XDG directories
- AppImage for distribution
- whisper.cpp bundled for x64
- No standardized URL scheme for system settings (user must open manually)
- Privacy settings button hidden in UI (not applicable on Linux)
- Recommend `pavucontrol` for audio device management
- **Clipboard paste tools** (at least one required for auto-paste):
  - **X11**: `xdotool` (recommended)
  - **Wayland** (non-GNOME): `wtype` (requires virtual keyboard protocol) or `xdotool` (works via XWayland, recommended for Electron apps)
  - **GNOME Wayland**: `xdotool` for XWayland apps only (native Wayland apps require manual paste)
  - Terminal detection: Auto-detects terminal emulators and uses Ctrl+Shift+V
  - Fallback: Text copied to clipboard with manual paste instructions
- **GNOME Wayland global hotkeys**:
  - Uses native GNOME shortcuts via D-Bus and gsettings (no special permissions needed)
  - Hotkeys visible in GNOME Settings → Keyboard → Shortcuts → Custom
  - Default hotkey: `Alt+R` (backtick not supported)
  - Push-to-talk unavailable (GNOME shortcuts only fire single toggle event)
  - Falls back to X11/globalShortcut if GNOME integration fails
  - `dbus-next` npm package used for D-Bus communication

## Code Style and Conventions

- Use TypeScript for new React components
- Follow existing patterns in helpers/
- Descriptive error messages for users
- Comprehensive debug logging
- Clean up resources (files, listeners)
- Handle edge cases gracefully

## Performance Considerations

- Whisper model size vs speed tradeoff
- Audio blob size limits for IPC (10MB)
- Temporary file cleanup
- Memory usage with large models
- Process timeout protection (5 minutes)

## Security Considerations

- API keys stored in system keychain when possible
- Context isolation enabled
- No remote code execution
- Sanitized file paths
- Limited IPC surface area

## Future Enhancements to Consider

- Streaming transcription support
- Custom wake word detection
- ~~Multi-language UI~~ (implemented — 9 languages via react-i18next)
- Cloud model selection
- Batch transcription
- Export formats beyond clipboard

## ScottySpeaks V2 Additions (July 2026)

### AI Polish Engine (dictation formatting)
- Every dictation ≥8 words runs through a local LLM polish pass: lists, paragraphs, filler removal, self-corrections, spoken commands ("new paragraph"), app-aware tone.
- Default model: `qwen3-4b-instruct-2507-q4_k_m` (2.5GB, non-thinking instruct — Qwen3-8B thinking mode took 20s; this does 0.4–3s). Prewarmed at app start (main.js).
- Prompt: `cleanupPrompt` in `src/locales/*/prompts.json` (synced across locales). Context blocks (style profile `instructions`, frontmost app, learned examples) appended via `src/services/polish/polishContext.ts`.
- Safety: 20s timeout + output validation (length ratio, answered-instead-of-rewrote detection) → falls back to raw transcript. `audioManager.processTranscription` is the orchestrator.
- llama-server MUST run with `--reasoning-format none` (llamaServer.js) and ctx-size clamped ≤16384 (modelManagerBridge) — 128k+ ctx causes Metal "Compute error" on 16GB.

**Polish is now the latency budget.** Measured on Granite 4.0 Micro (what Scott's machine has selected; the code default in `settingsStore.POLISH_MODEL` is still Qwen3-4B-Instruct), for a 10s / 41-word dictation:

| Stage | Time | Share |
|---|---|---|
| Transcribe (Parakeet on ANE) | 74ms | 6% |
| Polish prefill (cache hit) | ~25ms | 2% |
| **Polish generation** | **~780–840ms** | **~80%** |
| Paste | ~140ms | 12% |

- Prefill caching already works — the constant 873-token system prompt costs ~25ms warm vs ~1975ms when forced to miss. Nothing to win there.
- **Speculative decoding was measured and ruled out** (Jul 2026). llama-server supports model-free n-gram drafting via `--spec-type`; across three novel-text runs at temperature 0 with byte-identical outputs: `ngram-simple` +9%/−2%/0% (noise), `ngram-cache` −3%/−9%/−9% (consistently worse), `ngram-map-k` ≈0%. An early +51% for `ngram-cache` was a benchmark artifact — repeating the same prompt let the n-gram cache hold the answer, which never happens with real dictation. Don't re-litigate without a novel-text harness.
- Generation cost scales with output length, so the only real lever left is a faster/smaller polish model or emitting fewer tokens.
- **Edit effort is free; output length is not.** Measured across light/default/heavy editing instructions on the same 172-word dictation, throughput was flat (34.8 / 34.8 / 34.4 tok/s) — a heavier edit that emitted 119 tokens instead of 191 was *37% faster*. A "lighter formatting" control therefore cannot speed anything up; only emitting fewer words can. Rule of thumb: **~30ms per output word** (50w ≈ 1.6s, 200w ≈ 6.3s).
- Parallel chunked polish across llama-server slots was measured and rejected: 1.07x / 1.13x / 1.24x for 2/3/4-way, and chunking breaks self-corrections that span a boundary.

### Editing style: Balanced vs Verbatim
`polishStyle` (localStorage, default `balanced`) selects between two **separate** system prompts, not a modifier on one:
- Appending "keep the filler" to `cleanupPrompt` measured as near-placebo (53% vs 41% filler kept) — the base prompt's removal contract dominates. A standalone `verbatimPrompt` with no removal contract keeps **100%** of filler and word count while still applying punctuation.
- `verbatimPrompt` lives alongside `cleanupPrompt` in `src/locales/*/prompts.json` (English in every locale, like the other AI prompts). Selected in `config/prompts.ts`; agent-addressed commands always use `fullPrompt` regardless of style.

### Polish invention guard (`validatePolishOutput`)
The polish model completes cut-off dictations and answers them. "i think we should probably" came back as a 43-word bulleted document-revision plan; "it looks like the issue is" became contract-enforcement steps.
- Root cause is *not* temperature — the polish path already passes 0.2 (`audioManager.js`). Prompt hardening did **not** fix it (it measured slightly worse). The reliable fix is the deterministic guard.
- Old rule only ran at `inWords >= 12` and allowed `2x + 12`, so short dictations were entirely unguarded: **14/32 sampled short truncations grew by >3 words and the guard caught 0**.
- Now a growth cap applies at every length: `outWords > inWords + max(3, 10% of inWords)` → reject and paste the raw transcript. Caught 14/14 with **0 false positives** across 24 short complete dictations; legitimate cleanup never added more than +2 words in any measured config.

### Transcription on the Neural Engine (CoreML)
Parakeet TDT 0.6B **v3 — the same model as the sherpa-onnx path**, run through CoreML with the encoder pinned to the ANE. Two interchangeable backends now sit behind `ParakeetServerManager`:

| | sherpa-onnx (CPU) | CoreML (ANE) |
|---|---|---|
| Inference, 10.8s audio | 226ms | **74ms** |
| Cold start (warm ANE cache) | ~2.0–2.3s | **~150–220ms** |
| On-disk model | 670MB | **470MB** |
| Transcript | identical | identical |

- `resources/parakeet-coreml/` is a SwiftPM package (depends on [FluidAudio](https://github.com/FluidInference/FluidAudio) 0.15.5) producing a persistent helper binary. Protocol on stdin: `[uint32LE metaLen][uint32LE audioLen][meta JSON][float32 16kHz mono]`; replies are JSON lines on stdout. Human logs go to stderr so they can't corrupt the stream.
- `npm run compile:parakeet-coreml` (part of `compile:native`) builds it to `resources/bin/parakeet-coreml-darwin-arm64`. Hash-cached; first build fetches FluidAudio (~45s). **arm64-only** — the ANE doesn't exist on Intel, and the backend auto-falls-back to sherpa-onnx.
- Engine selection: `ParakeetServerManager.getEngine()` prefers CoreML when the binary is present. Override via `setEngine("onnx"|"coreml")`, the `PARAKEET_ENGINE` env var, or a `parakeetEngine` setting passed to `initializeAtStartup`.
- **UI:** Settings → Transcription → NVIDIA Parakeet shows a Compute toggle (Neural Engine / CPU) when the CoreML binary is present, backed by the `get-parakeet-engine-info` / `set-parakeet-engine` IPC pair. Switching stops *both* backends so the next dictation starts clean, and persists `PARAKEET_ENGINE` to the userData `.env`.
- CoreML models auto-download from HuggingFace on first start (~470MB) to `~/.cache/scottyspeaks/parakeet-coreml-models/parakeet-tdt-0.6b-v3`. **First run after install also pays a one-time ~12s ANE model compile**; afterwards cold start is ~150ms.
- **FluidAudio path quirk:** `AsrModels.download(to:)` resolves its cache as `dirname(passedPath)/<repoFolderName>` — the leaf you pass is discarded. `ParakeetCoremlServer.getModelDir()` therefore passes the full final path so the location is predictable.
- int8 encoders must use `.cpuAndNeuralEngine`, never `.all` — CoreML routes quantized ops to MPSGraph under `.all`, which fails its MLIR pass.
- No manual 15s segmentation on this path: FluidAudio windows long audio internally and merges on a 2s overlap, which beats the hard cuts in `parakeetServer.js`.
- **Readiness race:** `transcribe()` gives CoreML `COREML_READY_BUDGET_MS` (1500ms) to come up. If it doesn't, that one dictation is served by sherpa-onnx while CoreML keeps provisioning in the background. This covers both the first-run 470MB download and the periodic ~14s ANE recompile that macOS triggers when it evicts the e5rt bundle cache — neither ever stalls a dictation.
- `findAvailablePort` used to probe `127.0.0.1`; Node's default `SO_REUSEADDR` let that succeed while a stale process still held `*:port`, so sherpa-onnx would be handed an occupied port and die with EADDRINUSE. It now probes `0.0.0.0` and waits for the probe socket to close.
- `.build/` is gitignored (1.2GB); `Package.resolved` is committed to pin the FluidAudio revision.

**Note:** ANE vs CPU here is a raw-throughput win, *not* a GPU-contention fix. sherpa-onnx runs ONNX on the CPU and never touched Metal, so it was never competing with the llama.cpp polish model. Under sustained Metal load both backends degrade only slightly (CPU 226→362ms, ANE 74→90ms).

### Stream Deck Pedal
- `src/helpers/pedalManager.js` (@elgato-stream-deck/node). Default: left=tap-toggle, middle=hold-to-talk, right=voice command. Config: `userData/pedal-config.json`, UI in Settings → Hotkeys + onboarding.
- Voice command mode: spoken instruction applied to selected text (Cmd+C capture via `clipboard.captureSelection`) or last dictation; `src/services/polish/voiceCommand.ts`.

### Stable Code Signing (TCC fix)
- `scripts/ensure-signing.js` + `scripts/sign-mac-app.js` (postpack) re-sign the packed app with the self-signed "ScottySpeaks Local Signing" identity so Accessibility/Mic permissions survive rebuilds. Do not regenerate `~/.scottyspeaks-signing/identity.p12`.
- electron-builder has `npmRebuild: false`; `prepack` rebuilds only better-sqlite3 (`electron-rebuild --only better-sqlite3`). node-hid uses its bundled N-API prebuilds (source build breaks on the space in the repo path).

### Improvement Loop
- `transcriptions.raw_text` stores the pre-polish transcript. Editing an entry in History (pencil icon) saves a `style_examples` row (raw → preferred) that is injected as few-shot context into future polish prompts (max 4, newest first, 50 kept).
- Style profiles gained `instructions` (free-text AI directives) and `aiPolish: false` (bypass, used by "Raw" profile).

### Voice command: replace-in-place
When a voice command runs with nothing selected, `ClipboardManager.replaceLastPaste()` replaces the app's own previous paste instead of appending a duplicate. It selects back exactly `expectedText.length` characters, copies the selection, and replaces **only** on an exact match; any mismatch collapses the selection (right-arrow) and appends, so it can never overwrite text the app didn't produce. Capped at 1200 chars (`MAX_REPLACE_CHARS`).

Selection uses `macos-fast-paste --select-back <N>` (CGEvent, ~142ms/111 chars). The osascript fallback costs ~9ms per keystroke and is therefore limited to 150 chars (`OSASCRIPT_SELECT_LIMIT`). After editing `resources/macos-fast-paste.swift`, run `npm run compile:fast-paste`.

### Distribution & settings migration
- `npm run share` → `~/Desktop/SS2-<date>.zip` (SS2.app + INSTALL.txt, no user data). Uses `ditto` so code signatures survive the round trip.
- `npm run settings:export` → `~/Desktop/ss2-settings-<date>.tar.gz` (~100KB): Local Storage (prefs), transcriptions.db (history/snippets/style profiles/dictionary/learned examples), pedal-config.json, .env. Requires SS2 to be quit; checkpoints the WAL first. Excludes `~/.cache/scottyspeaks` (9.3GB of models — they re-download).
- `npm run settings:import -- <archive>` → restores it, moving any existing data to `scotty-speaks-backup-<ts>` first.

**Gatekeeper:** the app is signed with a local self-signed identity, not an Apple Developer ID, so on any *other* Mac the recipient must run `xattr -dr com.apple.quarantine /Applications/SS2.app` once after transfer. Documented in the generated INSTALL.txt. Builds are arm64-only (Apple Silicon).

### Shipping updates to other Macs
`npm run publish` (patch bump; `-- minor` / `-- none` also accepted) bumps the version, builds, signs, installs locally, and publishes the zip as a **GitHub Release** on `scottfox95/scottyspeaks`.

On any other Mac: double-click `SS2-Update.command` (written to ~/Desktop on publish; send it over once, it self-updates thereafter). It reads the latest release from the GitHub API, compares `CFBundleShortVersionString`, downloads with curl, swaps `/Applications/SS2.app`, clears quarantine, verifies the signature, and relaunches. Needs only curl + python3 (both built into macOS) — no Node, no repo, and **no shared iCloud/Apple account**, since the work Mac uses a different one.

The bundled electron-updater (GitHub provider) is *not* used — Squirrel.Mac validates update signatures, unproven with a self-signed identity. Revisit with an Apple Developer ID.
