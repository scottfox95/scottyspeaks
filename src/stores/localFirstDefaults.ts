// Local-first defaults: a fresh Mac dictates with Parakeet and polishes with
// the local Qwen3 4B Instruct model. The upstream defaults pointed at the
// OpenWhispr cloud, which this build cannot reach.
export const DEFAULT_PARAKEET_MODEL = "parakeet-tdt-0.6b-v3";
export const DEFAULT_POLISH_MODEL = "qwen3-4b-instruct-2507-q4_k_m";
export const DEFAULT_POLISH_PROVIDER = "qwen";

export const LOCAL_FIRST_MIGRATION_KEY = "localFirstDefaultsMigrated";

type SettingsStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const BYOK_TRANSCRIPTION_KEYS = [
  "openaiApiKey",
  "groqApiKey",
  "mistralApiKey",
  "customTranscriptionApiKey",
];

/**
 * Runs once, before the settings store reads storage. Changing a default must
 * not change what an existing install was actually using, so implicit values
 * that worked under the old defaults are written down explicitly first.
 * Values that only ever reached the removed OpenWhispr cloud are not kept:
 * those installs move to the local defaults.
 */
export function migrateToLocalFirstDefaults(storage: SettingsStorage): void {
  if (storage.getItem(LOCAL_FIRST_MIGRATION_KEY) === "1") return;
  const stored = (key: string) => storage.getItem(key);
  const hasByokKey = BYOK_TRANSCRIPTION_KEYS.some((key) => !!stored(key));
  const transcriptionMode = stored("cloudTranscriptionMode");
  const useLocalWhisper = stored("useLocalWhisper");

  if (useLocalWhisper === null) {
    // The old default was cloud, which only worked in BYOK mode with a key.
    if (transcriptionMode !== "openwhispr" && hasByokKey) {
      storage.setItem("useLocalWhisper", "false");
    }
  } else if (useLocalWhisper === "false" && transcriptionMode === "openwhispr" && !hasByokKey) {
    // Explicitly on the dead cloud with no key of their own: go local.
    storage.setItem("useLocalWhisper", "true");
  }

  // The old local-engine default was whisper.cpp; keep it for installs using it.
  if (useLocalWhisper === "true" && stored("localTranscriptionProvider") === null) {
    storage.setItem("localTranscriptionProvider", "whisper");
  }

  // The old polish-provider default was OpenAI; keep it where a model was chosen.
  if (stored("reasoningProvider") === null && stored("reasoningModel")) {
    storage.setItem("reasoningProvider", "openai");
  }

  // Sign-in state and the cloud routing modes no longer exist. A stale
  // isSignedIn=true must never re-enable a removed path.
  for (const key of ["isSignedIn", "cloudTranscriptionMode", "cloudReasoningMode"]) {
    storage.removeItem(key);
  }
  storage.setItem(LOCAL_FIRST_MIGRATION_KEY, "1");
}
