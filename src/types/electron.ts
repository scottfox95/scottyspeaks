export type LocalTranscriptionProvider = "whisper" | "nvidia";

export interface TranscriptionItem {
  id: number;
  text: string;
  timestamp: string;
  created_at: string;
  raw_text?: string | null;
}

export interface DictionaryAlias {
  word: string;
  alias: string;
  source: string;
}

export interface TranscriptionCursor {
  timestamp: string;
  id: number;
}

export interface TranscriptionQuery {
  query?: string;
  limit?: number;
  cursor?: TranscriptionCursor | null;
}

export interface TranscriptionPage {
  items: TranscriptionItem[];
  hasMore: boolean;
  nextCursor: TranscriptionCursor | null;
}

export interface UsageStats {
  totalDays: number;
  totalWords: number;
  totalDictations: number;
  averageWpm: number;
}

export interface SnippetItem {
  id: number;
  keyword: string;
  expansion: string;
  use_count: number;
  created_at: string;
  updated_at: string;
}

export interface StyleProfileItem {
  id: number;
  name: string;
  rules: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface StyleExampleItem {
  before: string;
  after: string;
  source: string;
}

export interface NoteItem {
  id: number;
  title: string;
  content: string;
  enhanced_content: string | null;
  enhancement_prompt: string | null;
  enhanced_at_content_hash: string | null;
  note_type: "personal" | "meeting" | "upload";
  source_file: string | null;
  audio_duration_seconds: number | null;
  folder_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface FolderItem {
  id: number;
  name: string;
  is_default: number;
  sort_order: number;
  created_at: string;
}

export interface ActionItem {
  id: number;
  name: string;
  description: string;
  prompt: string;
  icon: string;
  is_builtin: number;
  sort_order: number;
  translation_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface GpuInfo {
  hasNvidiaGpu: boolean;
  gpuName?: string;
  driverVersion?: string;
  vramMb?: number;
}

export interface WhisperCheckResult {
  installed: boolean;
  working: boolean;
  error?: string;
}

export interface WhisperModelResult {
  success: boolean;
  model: string;
  downloaded: boolean;
  size_mb?: number;
  error?: string;
  code?: string;
}

export interface WhisperModelDeleteResult {
  success: boolean;
  model: string;
  deleted: boolean;
  freed_mb?: number;
  error?: string;
}

export interface WhisperModelsListResult {
  success: boolean;
  models: Array<{ model: string; downloaded: boolean; size_mb?: number }>;
  cache_dir: string;
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  version?: string;
  releaseDate?: string;
  files?: any[];
  releaseNotes?: string;
  message?: string;
}

export interface UpdateStatusResult {
  updateAvailable: boolean;
  updateDownloaded: boolean;
  isDevelopment: boolean;
}

export interface UpdateInfoResult {
  version?: string;
  releaseDate?: string;
  releaseNotes?: string | null;
  files?: any[];
}

export interface UpdateResult {
  success: boolean;
  message: string;
}

export interface AppVersionResult {
  version: string;
}

export interface WhisperDownloadProgressData {
  type: "progress" | "installing" | "complete" | "error";
  model: string;
  percentage?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  error?: string;
  code?: string;
  result?: any;
}

export interface ParakeetModelResult {
  success: boolean;
  model: string;
  downloaded: boolean;
  path?: string;
  size_bytes?: number;
  size_mb?: number;
  error?: string;
  code?: string;
}

export interface ParakeetModelDeleteResult {
  success: boolean;
  model: string;
  deleted: boolean;
  freed_bytes?: number;
  freed_mb?: number;
  error?: string;
}

export interface ParakeetModelsListResult {
  success: boolean;
  models: Array<{ model: string; downloaded: boolean; size_mb?: number }>;
  cache_dir: string;
}

export interface ParakeetDownloadProgressData {
  type: "progress" | "installing" | "complete" | "error";
  model: string;
  percentage?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  error?: string;
  code?: string;
}

export interface ParakeetTranscriptionResult {
  success: boolean;
  text?: string;
  message?: string;
  error?: string;
}

export interface PasteToolsResult {
  platform: "darwin" | "win32" | "linux";
  available: boolean;
  method: string | null;
  requiresPermission: boolean;
  isWayland?: boolean;
  xwaylandAvailable?: boolean;
  terminalAware?: boolean;
  hasNativeBinary?: boolean;
  hasUinput?: boolean;
  tools?: string[];
  recommendedInstall?: string;
}

export type GpuBackend = "vulkan" | "cpu" | "metal" | null;

export interface LlamaServerStatus {
  available: boolean;
  running: boolean;
  port: number | null;
  modelPath: string | null;
  modelName: string | null;
  backend: GpuBackend;
  gpuAccelerated: boolean;
}

declare global {
  interface Window {
    electronAPI: {
      reserveLocalInference: () => Promise<string>;
      releaseLocalInference: (token: string) => Promise<void>;
      speech: import("./speech").SpeechAPI;
      callAgent: import("./callAgent").CallAgentAPI;
      meetings: import("./meeting").MeetingAPI;
      recordingAlerts: import("./recordingAlerts").RecordingAlertsAPI;
      captures: import("./capture").CaptureAPI;
      screenRecordings: import("./screenRecording").ScreenRecordingAPI;
      // Basic window operations
      captureRecordingTarget: () => Promise<{ available: boolean; token: string | null; reason?: string }>;
      releaseRecordingTarget: (token: string) => Promise<void>;
      pasteText: (text: string, options?: { fromStreaming?: boolean; targetToken?: string | null; exact?: boolean }) => Promise<{ success?: boolean; text: string; manualCopy?: boolean; onClipboard?: boolean; reason?: string }>;
      hideWindow: () => Promise<void>;
      showDictationPanel: () => Promise<void>;
      onToggleDictation: (callback: () => void) => () => void;
      onStartDictation?: (callback: () => void) => () => void;
      onStopDictation?: (callback: () => void) => () => void;


      // Database operations
      saveTranscription: (text: string) => Promise<{ id: number; success: boolean }>;
      getTranscriptions: (limit?: number) => Promise<TranscriptionItem[]>;
      queryTranscriptions: (options?: TranscriptionQuery) => Promise<TranscriptionPage>;
      clearTranscriptions: () => Promise<{ cleared: number; success: boolean }>;
      deleteTranscription: (id: number) => Promise<{ success: boolean }>;
      recordUsage: (wordCount: number, durationSeconds: number) => Promise<{ success: boolean }>;
      getUsageStats: () => Promise<UsageStats>;

      // Snippet operations
      getSnippets: () => Promise<SnippetItem[]>;
      createSnippet: (
        keyword: string,
        expansion: string
      ) => Promise<{ success: boolean; snippet?: SnippetItem; error?: string }>;
      updateSnippet: (
        id: number,
        updates: { keyword?: string; expansion?: string }
      ) => Promise<{ success: boolean; snippet?: SnippetItem; error?: string }>;
      deleteSnippet: (id: number) => Promise<{ success: boolean; id?: number; error?: string }>;
      findSnippet: (text: string) => Promise<SnippetItem | null>;

      // Style profile operations
      getStyleProfiles: () => Promise<StyleProfileItem[]>;
      getActiveStyleProfile: () => Promise<StyleProfileItem | null>;
      setActiveStyleProfile: (id: number | null) => Promise<{ success: boolean; error?: string }>;
      createStyleProfile: (
        name: string,
        rules: import("../services/StyleProcessor").StyleRules
      ) => Promise<{ success: boolean; id?: number; error?: string }>;
      updateStyleProfile: (
        id: number,
        updates: {
          name?: string;
          rules?: import("../services/StyleProcessor").StyleRules;
        }
      ) => Promise<{ success: boolean; error?: string }>;
      deleteStyleProfile: (id: number) => Promise<{ success: boolean; error?: string }>;
      getStyleExamples: (limit?: number) => Promise<StyleExampleItem[]>;
      addStyleExample: (
        beforeText: string,
        afterText: string,
        source?: string
      ) => Promise<{ id: number } | null>;
      getFrontmostApp: () => Promise<{ name: string } | null>;

      // Dictionary operations
      getDictionary: () => Promise<string[]>;
      setDictionary: (words: string[]) => Promise<{ success: boolean }>;
      onDictionaryUpdated?: (callback: (words: string[]) => void) => () => void;
      // "Sounds like" aliases: what the recognizer hears for a dictionary word
      getDictionaryAliases: () => Promise<DictionaryAlias[]>;
      setWordAliases: (word: string, aliases: string[]) => Promise<DictionaryAlias[]>;
      removeDictionaryAlias: (alias: string) => Promise<DictionaryAlias[]>;
      onDictionaryAliasesUpdated?: (callback: (aliases: DictionaryAlias[]) => void) => () => void;
      setAutoLearnEnabled?: (enabled: boolean) => void;
      onCorrectionsLearned?: (callback: (words: string[]) => void) => () => void;
      undoLearnedCorrections?: (words: string[]) => Promise<{ success: boolean }>;

      // Note operations
      saveNote: (
        title: string,
        content: string,
        noteType?: string,
        sourceFile?: string | null,
        audioDuration?: number | null,
        folderId?: number | null
      ) => Promise<{ success: boolean; note?: NoteItem }>;
      getNotes: (
        noteType?: string | null,
        limit?: number,
        folderId?: number | null
      ) => Promise<NoteItem[]>;
      updateNote: (
        id: number,
        updates: {
          title?: string;
          content?: string;
          enhanced_content?: string | null;
          enhancement_prompt?: string | null;
          enhanced_at_content_hash?: string | null;
          folder_id?: number | null;
        }
      ) => Promise<{ success: boolean; note?: NoteItem }>;
      deleteNote: (id: number) => Promise<{ success: boolean }>;
      exportNote: (
        noteId: number,
        format: "txt" | "md"
      ) => Promise<{ success: boolean; error?: string }>;

      // Folder operations
      getFolders: () => Promise<FolderItem[]>;
      createFolder: (
        name: string
      ) => Promise<{ success: boolean; folder?: FolderItem; error?: string }>;
      deleteFolder: (id: number) => Promise<{ success: boolean; error?: string }>;
      renameFolder: (
        id: number,
        name: string
      ) => Promise<{ success: boolean; folder?: FolderItem; error?: string }>;
      getFolderNoteCounts: () => Promise<Array<{ folder_id: number; count: number }>>;

      // Action operations
      getActions: () => Promise<ActionItem[]>;
      createAction: (
        name: string,
        description: string,
        prompt: string,
        icon?: string
      ) => Promise<{ success: boolean; action?: ActionItem; error?: string }>;
      updateAction: (
        id: number,
        updates: {
          name?: string;
          description?: string;
          prompt?: string;
          icon?: string;
          sort_order?: number;
        }
      ) => Promise<{ success: boolean; action?: ActionItem; error?: string }>;
      deleteAction: (id: number) => Promise<{ success: boolean; id?: number; error?: string }>;
      onActionCreated?: (callback: (action: ActionItem) => void) => () => void;
      onActionUpdated?: (callback: (action: ActionItem) => void) => () => void;
      onActionDeleted?: (callback: (payload: { id: number }) => void) => () => void;


      // Note event listeners
      onNoteAdded?: (callback: (note: NoteItem) => void) => () => void;
      onNoteUpdated?: (callback: (note: NoteItem) => void) => () => void;
      onNoteDeleted?: (callback: (payload: { id: number }) => void) => () => void;

      // Database event listeners
      onTranscriptionAdded?: (callback: (item: TranscriptionItem) => void) => () => void;
      onTranscriptionDeleted?: (callback: (payload: { id: number }) => void) => () => void;
      onTranscriptionsCleared?: (callback: (payload: { cleared: number }) => void) => () => void;

      // API key management
      getOpenAIKey: () => Promise<string>;
      saveOpenAIKey: (key: string) => Promise<{ success: boolean }>;
      getAnthropicKey: () => Promise<string | null>;
      saveAnthropicKey: (key: string) => Promise<void>;
      getUiLanguage: () => Promise<string>;
      setUiLanguage: (language: string) => Promise<{ success: boolean; language: string }>;
      saveAllKeysToEnv: () => Promise<{ success: boolean; path: string }>;
      syncStartupPreferences: (prefs: {
        useLocalWhisper: boolean;
        localTranscriptionProvider: LocalTranscriptionProvider;
        model?: string;
        reasoningProvider: string;
        reasoningModel?: string;
      }) => Promise<void>;

      // Clipboard operations
      checkAccessibilityPermission: () => Promise<boolean>;
      readClipboard: () => Promise<string>;
      writeClipboard: (text: string) => Promise<{ success: boolean }>;
      checkPasteTools: () => Promise<PasteToolsResult>;

      // Audio
      onLocalTranscriptionStarted: (callback: (event: any, data: { requestId: string }) => void) => () => void;
      onNoAudioDetected: (callback: (event: any, data?: any) => void) => () => void;

      // Whisper operations (whisper.cpp)
      transcribeLocalWhisper: (audioBlob: Blob | ArrayBuffer, options?: any) => Promise<any>;
      checkWhisperInstallation: () => Promise<WhisperCheckResult>;
      downloadWhisperModel: (modelName: string) => Promise<WhisperModelResult>;
      onWhisperDownloadProgress: (
        callback: (event: any, data: WhisperDownloadProgressData) => void
      ) => () => void;
      checkModelStatus: (modelName: string) => Promise<WhisperModelResult>;
      listWhisperModels: () => Promise<WhisperModelsListResult>;
      deleteWhisperModel: (modelName: string) => Promise<WhisperModelDeleteResult>;
      deleteAllWhisperModels: () => Promise<{
        success: boolean;
        deleted_count?: number;
        freed_bytes?: number;
        freed_mb?: number;
        error?: string;
      }>;
      cancelWhisperDownload: () => Promise<{
        success: boolean;
        message?: string;
        error?: string;
      }>;


      // Parakeet operations (NVIDIA via sherpa-onnx)
      transcribeLocalParakeet: (
        audioBlob: ArrayBuffer,
        options?: { model?: string; language?: string }
      ) => Promise<ParakeetTranscriptionResult>;
      downloadParakeetModel: (modelName: string) => Promise<ParakeetModelResult>;
      onParakeetDownloadProgress: (
        callback: (event: any, data: ParakeetDownloadProgressData) => void
      ) => () => void;
      checkParakeetModelStatus: (modelName: string) => Promise<ParakeetModelResult>;
      listParakeetModels: () => Promise<ParakeetModelsListResult>;
      deleteParakeetModel: (modelName: string) => Promise<ParakeetModelDeleteResult>;
      deleteAllParakeetModels: () => Promise<{
        success: boolean;
        deleted_count?: number;
        freed_bytes?: number;
        freed_mb?: number;
        error?: string;
      }>;
      cancelParakeetDownload: () => Promise<{
        success: boolean;
        message?: string;
        error?: string;
      }>;
      getParakeetEngineInfo: () => Promise<{
        engine: string;
        coremlAvailable: boolean;
        coremlModelDownloaded: boolean;
      }>;
      setParakeetEngine: (engine: string | null) => Promise<{
        success: boolean;
        engine?: string;
        error?: string;
      }>;

      // Local AI model management
      modelGetAll: () => Promise<any[]>;
      modelCheck: (modelId: string) => Promise<boolean>;
      modelDownload: (modelId: string) => Promise<{
        success: boolean;
        path?: string;
        error?: string;
        code?: string;
        details?: string;
      }>;
      modelDelete: (modelId: string) => Promise<{
        success: boolean;
        error?: string;
        code?: string;
        details?: string;
      }>;
      modelDeleteAll: () => Promise<{
        success: boolean;
        error?: string;
        code?: string;
        details?: string;
      }>;
      modelCancelDownload: (modelId: string) => Promise<{ success: boolean; error?: string }>;
      onModelDownloadProgress: (callback: (event: any, data: any) => void) => () => void;

      // Local reasoning
      processLocalReasoning: (
        text: string,
        modelId: string,
        agentName: string | null,
        config: any
      ) => Promise<{ success: boolean; text?: string; error?: string }>;
      cancelLocalReasoning?: () => Promise<{ success: boolean; aborted?: number; error?: string }>;
      checkLocalReasoningAvailable: () => Promise<boolean>;

      // Anthropic reasoning
      processAnthropicReasoning: (
        text: string,
        modelId: string,
        agentName: string | null,
        config: any
      ) => Promise<{ success: boolean; text?: string; error?: string }>;


      // llama-server
      llamaServerStop: () => Promise<{ success: boolean; error?: string }>;
      llamaServerStatus: () => Promise<LlamaServerStatus>;

      // Window control operations
      windowMinimize: () => Promise<void>;
      windowMaximize: () => Promise<void>;
      windowClose: () => Promise<void>;
      windowIsMaximized: () => Promise<boolean>;
      getPlatform: () => string;
      startWindowDrag: () => Promise<void>;
      stopWindowDrag: () => Promise<void>;
      setMainWindowInteractivity: (interactive: boolean) => Promise<void>;

      // App management
      appQuit: () => Promise<void>;
      cleanupApp: () => Promise<{ success: boolean; message: string }>;

      // Update operations
      checkForUpdates: () => Promise<UpdateCheckResult>;
      downloadUpdate: () => Promise<UpdateResult>;
      installUpdate: () => Promise<UpdateResult>;
      getAppVersion: () => Promise<AppVersionResult>;
      getUpdateStatus: () => Promise<UpdateStatusResult>;
      getUpdateInfo: () => Promise<UpdateInfoResult | null>;

      // Update event listeners
      onUpdateAvailable: (callback: (event: any, info: any) => void) => () => void;
      onUpdateNotAvailable: (callback: (event: any, info: any) => void) => () => void;
      onUpdateDownloaded: (callback: (event: any, info: any) => void) => () => void;
      onUpdateDownloadProgress: (callback: (event: any, progressObj: any) => void) => () => void;
      onUpdateError: (callback: (event: any, error: any) => void) => () => void;

      openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;

      // Hotkey management
      updateHotkey: (key: string) => Promise<{ success: boolean; message: string }>;
      setHotkeyListeningMode?: (
        enabled: boolean,
        newHotkey?: string | null
      ) => Promise<{ success: boolean }>;

      // Globe key listener for hotkey capture (macOS only)
      onGlobeKeyPressed?: (callback: () => void) => () => void;
      onGlobeKeyReleased?: (callback: () => void) => () => void;

      // Mouse button as secondary trigger (macOS only)
      onMouseButtonPressed?: (callback: (button: number) => void) => () => void;
      getMouseButton?: () => Promise<number>;
      setMouseButton?: (button: number) => Promise<{ success: boolean; button: number }>;

      // Hotkey registration events
      onHotkeyFallbackUsed?: (
        callback: (data: { original: string; fallback: string; message: string }) => void
      ) => () => void;
      onHotkeyRegistrationFailed?: (
        callback: (data: { hotkey: string; error: string; suggestions: string[] }) => void
      ) => () => void;

      // Gemini API key management
      getGeminiKey: () => Promise<string | null>;
      saveGeminiKey: (key: string) => Promise<void>;

      // Groq API key management
      getGroqKey: () => Promise<string | null>;
      saveGroqKey: (key: string) => Promise<void>;

      // Mistral API key management
      getMistralKey: () => Promise<string | null>;
      saveMistralKey: (key: string) => Promise<void>;
      proxyMistralTranscription: (data: {
        audioBuffer: ArrayBuffer;
        model?: string;
        language?: string;
        contextBias?: string[];
      }) => Promise<{ text: string }>;

      // Custom endpoint API keys
      getCustomTranscriptionKey?: () => Promise<string | null>;
      saveCustomTranscriptionKey?: (key: string) => Promise<void>;
      getCustomReasoningKey?: () => Promise<string | null>;
      saveCustomReasoningKey?: (key: string) => Promise<void>;

      // Dictation key persistence (file-based for reliable startup)
      getDictationKey?: () => Promise<string | null>;
      saveDictationKey?: (key: string) => Promise<void>;

      // Activation mode persistence (file-based for reliable startup)
      getActivationMode?: () => Promise<"tap" | "push">;

      // Debug logging
      getLogLevel?: () => Promise<string>;
      log?: (entry: {
        level: string;
        message: string;
        meta?: any;
        scope?: string;
        source?: string;
      }) => Promise<void>;
      getDebugState: () => Promise<{
        enabled: boolean;
        logPath: string | null;
        logLevel: string;
      }>;
      setDebugLogging: (enabled: boolean) => Promise<{
        success: boolean;
        enabled?: boolean;
        logPath?: string | null;
        error?: string;
      }>;
      openLogsFolder: () => Promise<{ success: boolean; error?: string }>;


      // System settings helpers
      requestMicrophoneAccess?: () => Promise<{ granted: boolean }>;
      openMicrophoneSettings?: () => Promise<{ success: boolean; error?: string }>;
      openSoundInputSettings?: () => Promise<{ success: boolean; error?: string }>;
      openAccessibilitySettings?: () => Promise<{ success: boolean; error?: string }>;
      openWhisperModelsFolder?: () => Promise<{ success: boolean; error?: string }>;

      // Windows Push-to-Talk notifications
      notifyActivationModeChanged?: (mode: "tap" | "push") => void;
      notifyHotkeyChanged?: (hotkey: string) => void;
      notifyFloatingIconAutoHideChanged?: (enabled: boolean) => void;
      onFloatingIconAutoHideChanged?: (callback: (enabled: boolean) => void) => () => void;

      // Auto-start at login
      getAutoStartEnabled?: () => Promise<boolean>;
      setAutoStartEnabled?: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;




      onUploadTranscriptionProgress?: (
        callback: (data: { stage: string; chunksTotal: number; chunksCompleted: number }) => void
      ) => () => void;







      // Deepgram Streaming
    };

    api?: {
      sendDebugLog: (message: string) => void;
    };
  }
}
