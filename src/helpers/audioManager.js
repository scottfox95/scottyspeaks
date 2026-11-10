import { openRecordingMicrophone } from "./recordingActivity";
import { cleanupChoices, applyDictationCleanup, cleanupViolation, isNamedDictationCommand } from "../services/polish/dictationCleanup";
import { getSystemPrompt } from "../config/prompts";
import { getModelProvider } from "../models/ModelRegistry";
import ReasoningService from "../services/ReasoningService";
import { API_ENDPOINTS, buildApiUrl, normalizeBaseUrl } from "../config/constants";
import logger from "../utils/logger";
import { isBuiltInMicrophone } from "../utils/audioDeviceUtils";
import { isSecureEndpoint } from "../utils/urlUtils";
import { getBaseLanguageCode, validateLanguageForModel } from "../utils/languageSupport";
import { getSettings, getEffectiveReasoningModel } from "../stores/settingsStore";

const SHORT_CLIP_DURATION_SECONDS = 2.5;
const REASONING_CACHE_TTL = 30000; // 30 seconds
const POLISH_TIMEOUT_MS = 20000; // hard cap on the polish pass; raw text is the fallback
const POLISH_SKIPPED = Symbol("polish-skipped");

const TRUNCATED_ENDING_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "because",
  "but",
  "by",
  "for",
  "from",
  "if",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "when",
  "while",
  "with",
]);

const NEGATION_ALIASES = {
  "ain't": "be:not",
  "aren't": "are:not",
  "can't": "can:not",
  cannot: "can:not",
  "couldn't": "could:not",
  "didn't": "did:not",
  "doesn't": "does:not",
  "don't": "do:not",
  "hadn't": "had:not",
  "hasn't": "has:not",
  "haven't": "have:not",
  "isn't": "is:not",
  "mustn't": "must:not",
  "needn't": "need:not",
  "shouldn't": "should:not",
  "wasn't": "was:not",
  "weren't": "were:not",
  "won't": "will:not",
  "wouldn't": "would:not",
};

const NEGATABLE_AUXILIARIES = new Set([
  "are",
  "be",
  "can",
  "could",
  "did",
  "do",
  "does",
  "had",
  "has",
  "have",
  "is",
  "must",
  "need",
  "should",
  "was",
  "were",
  "will",
  "would",
]);

function extractNumericTokens(text) {
  return (text.match(/[$€£¥]?\d+(?:[,.]\d+)*(?:%|[a-z]{1,4})?/gi) || []).map((token) =>
    token.toLowerCase().replace(/,(?=\d)/g, "")
  );
}

function extractNegations(text) {
  const words =
    text
      .toLowerCase()
      .replace(/[’]/g, "'")
      .match(/[a-z]+(?:'[a-z]+)?/g) || [];
  const markers = [];

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (NEGATION_ALIASES[word]) {
      markers.push(NEGATION_ALIASES[word]);
    } else if (word === "not") {
      const previous = words[index - 1];
      markers.push(NEGATABLE_AUXILIARIES.has(previous) ? `${previous}:not` : "not");
    } else if (["neither", "never", "no", "nobody", "none", "nothing", "nowhere"].includes(word)) {
      markers.push(word);
    }
  }

  return markers;
}

// Common words that open a sentence only because of grammar. Polish
// legitimately drops or rewords them ("So, …", "There's some that…"), and
// protecting them as if they were names threw away 77 of 361 good polish
// results on Scott's own dictations. Any other capitalized word, including a
// name at the start of a sentence ("Élodie will…"), stays protected.
const SENTENCE_OPENERS = new Set(
  (
    "a an the and but or so yet also plus then now well okay ok oh hey hi yes yeah yep no nope " +
    "i i'm i'd i'll i've me my we we're we'll we've our us you you're you'll you've your he she it it's " +
    "they they're their them this that these those there there's here here's what what's why how when " +
    "where who which whose if because since though although while unless until after before as just " +
    "actually basically honestly really maybe perhaps probably obviously anyway alright right sure " +
    "is are was were am be been do does did don't doesn't didn't can can't could couldn't will won't " +
    "would wouldn't should shouldn't shall may might must have has had haven't hasn't let let's " +
    "please thanks thank send add make check go get put take tell ask give keep try use see look " +
    "find set call write update remind need want think know like one some any all every each both " +
    "even still only not never always sometimes first second third next last finally otherwise " +
    "instead however also overall meanwhile sorry wait um uh"
  ).split(" ")
);

function extractProtectedNames(text) {
  const names = [];
  const matches = text.matchAll(/[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu);
  for (const match of matches) {
    const token = match[0];
    const firstCharacter = [...token][0];
    const hasCase = firstCharacter.toLocaleLowerCase() !== firstCharacter.toLocaleUpperCase();
    const isCapitalized = hasCase && firstCharacter === firstCharacter.toLocaleUpperCase();
    if (!isCapitalized) continue;
    const before = text.slice(0, match.index).trimEnd();
    const startsSentence = before === "" || /[.!?:;\n"“(—–-]$/.test(before);
    if (/^I(?:['’](?:m|d|ll|ve))?$/.test(token)) continue;
    if (startsSentence && SENTENCE_OPENERS.has(token.toLocaleLowerCase().replace(/’/g, "'")))
      continue;
    names.push(token.toLocaleLowerCase());
  }
  return names;
}

const NUMBER_WORDS =
  /\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|half|quarter)\b(?:[\s-]+(?:and\s+)?\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)\b)*/gi;

/**
 * Every number the speaker gave as digits survives unchanged, and polish may
 * only add digits where the transcript had a spelled-out number ("ten ninety
 * nine" → 1099, "seven fifty" → 750; the paste path does the same).
 * Currency signs and unit suffixes don't count as a change ("625" → "$625").
 */
const SHARE_FILLERS = new Set(
  "um uh like so just really actually basically you know i mean kind sort of okay ok well and".split(" ")
);

// Who is speaking to whom must not change: "check my email" → "check your
// email" turns a note to self into an instruction. Compare first- and
// second-person pronoun counts (contractions expanded).
const PERSON_PRONOUNS = new Set("i me my mine myself we us our ours you your yours yourself".split(" "));
function personPronouns(text) {
  const counts = {};
  for (const word of (text.toLowerCase().replace(/[’]/g, "'").match(/[a-z']+/g) || []).flatMap(
    (w) => (CONTRACTIONS[w] || w.replace(/'(?:m|re|ve|ll|d|s)$/, "")).split(" ")
  ))
    if (PERSON_PRONOUNS.has(word)) counts[word === "me" || word === "myself" ? "i" : word] = (counts[word === "me" || word === "myself" ? "i" : word] || 0) + 1;
  return counts;
}
function samePerson(input, output) {
  const a = personPronouns(input);
  const b = personPronouns(output);
  const groups = { first: ["i", "my", "mine"], plural: ["we", "us", "our", "ours"], second: ["you", "your", "yours", "yourself"] };
  // Dropping a filler "you know" is fine; switching person is not.
  for (const keys of Object.values(groups)) {
    const n = (c) => keys.reduce((s, k) => s + (c[k] || 0), 0);
    if (n(b) > n(a)) return false;
  }
  const inFirst = groups.first.some((k) => a[k]);
  const outFirst = groups.first.some((k) => b[k]);
  return !(inFirst && !outFirst && groups.second.some((k) => b[k]));
}
const CONTRACTIONS = {
  "don't": "do not", "didn't": "did not", "doesn't": "does not", "isn't": "is not", "can't": "can not",
  "won't": "will not", "it's": "it is", "i'm": "i am", "we're": "we are", "you're": "you are",
  "they're": "they are", "that's": "that is", "there's": "there is", "what's": "what is",
  "i've": "i have", "i'll": "i will", "we'll": "we will", "let's": "let us", "gonna": "going to", "wanna": "want to",
};
/** Mic RMS (0..1 amplitude) → meter level 0..1 on a -60..-10 dBFS scale. */
function levelFromRms(rms) {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db + 60) / 50));
}

// Spoken formatting commands are meant to disappear ("new paragraph" → a blank line).
const SPOKEN_COMMANDS =
  /\b(?:new (?:line|paragraph)|period|full stop|comma|colon|semicolon|question mark|exclamation (?:point|mark)|scratch that|(?:open |close )?quote|unquote|bullet(?: point)?|numbered list|dash|hyphen)\b/g;
// Numbers are checked separately (numbersPreserved), so spelled-out numbers
// turning into digits ("nineteen thousand" → 19,000) don't count as rewording.
function contentWords(text) {
  return (
    text
      .toLowerCase()
      .replace(/[’]/g, "'")
      .replace(SPOKEN_COMMANDS, " ")
      .replace(NUMBER_WORDS, " ")
      .match(/[a-z']+/g) || []
  )
    .flatMap((word) => (CONTRACTIONS[word] || word).split(" "))
    .filter((word) => !SHARE_FILLERS.has(word));
}

/** Share of the input's content words that appear in the output, in order (LCS). */
function keptWordShare(input, output) {
  const a = contentWords(input);
  const b = contentWords(output);
  if (!a.length) return 1;
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = above;
    }
  }
  return row[b.length] / a.length;
}

function numbersPreserved(input, output) {
  const core = (token) => token.replace(/^[$€£¥]/, "").replace(/(?:%|[a-z]{1,4})$/i, "");
  const inCores = extractNumericTokens(input).map(core);
  const outCores = extractNumericTokens(output).map(core);
  const remaining = [...outCores];
  for (const value of inCores) {
    const index = remaining.indexOf(value);
    if (index === -1) return false;
    remaining.splice(index, 1);
  }
  return remaining.length <= (input.match(NUMBER_WORDS) || []).length;
}

const PLACEHOLDER_KEYS = {
  openai: "your_openai_api_key_here",
  groq: "your_groq_api_key_here",
  mistral: "your_mistral_api_key_here",
};

const isValidApiKey = (key, provider = "openai") => {
  if (!key || key.trim() === "") return false;
  const placeholder = PLACEHOLDER_KEYS[provider] || PLACEHOLDER_KEYS.openai;
  return key !== placeholder;
};

class AudioManager {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.isRecording = false;
    this.isProcessing = false;
    this.onStateChange = null;
    this.onError = null;
    this.onTranscriptionComplete = null;
    this.cachedApiKey = null;
    this.cachedApiKeyProvider = null;
    this.commandMode = false; // true while capturing a voice-command instruction
    this.lastPolishInfo = { polished: false, raw: "" };
    this.lastPastedText = null; // exact text of our most recent paste

    this._onApiKeyChanged = () => {
      this.cachedApiKey = null;
      this.cachedApiKeyProvider = null;
    };
    window.addEventListener("api-key-changed", this._onApiKeyChanged);
    this.cachedTranscriptionEndpoint = null;
    this.cachedEndpointProvider = null;
    this.cachedEndpointBaseUrl = null;
    this.recordingStartTime = null;
    this.reasoningAvailabilityCache = { value: false, expiresAt: 0 };
    this.cachedReasoningPreference = null;
    this.cachedMicDeviceId = null;
    this.skipReasoning = false;
    this.context = "dictation";
  }

  getCustomDictionaryPrompt(snapshot = this.captureSnapshot) {
    const words = this.processingSettings(snapshot).customDictionary;
    return words.length > 0 ? words.join(", ") : null;
  }

  setCallbacks({ onStateChange, onError, onTranscriptionComplete, onLevel = null, onTarget = null }) {
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.onTranscriptionComplete = onTranscriptionComplete;
    // Overlay v2: live mic level (0..1, every 100 ms) and the paste target's app name.
    this.onLevel = onLevel;
    this.onTarget = onTarget;
  }

  setSkipReasoning(skip) {
    this.skipReasoning = skip;
  }

  setContext(context) {
    this.context = context;
  }

  async getAudioConstraints() {
    const { preferBuiltInMic: preferBuiltIn, selectedMicDeviceId: selectedDeviceId } =
      getSettings();

    // Disable browser audio processing — dictation doesn't need it and it adds ~48ms latency
    const noProcessing = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };

    if (preferBuiltIn) {
      if (this.cachedMicDeviceId) {
        logger.debug(
          "Using cached microphone device ID",
          { deviceId: this.cachedMicDeviceId },
          "audio"
        );
        return { audio: { deviceId: { exact: this.cachedMicDeviceId }, ...noProcessing } };
      }

      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter((d) => d.kind === "audioinput");
        const builtInMic = audioInputs.find((d) => isBuiltInMicrophone(d.label));

        if (builtInMic) {
          this.cachedMicDeviceId = builtInMic.deviceId;
          logger.debug(
            "Using built-in microphone (cached for next time)",
            { deviceId: builtInMic.deviceId, label: builtInMic.label },
            "audio"
          );
          return { audio: { deviceId: { exact: builtInMic.deviceId }, ...noProcessing } };
        }
      } catch (error) {
        logger.debug(
          "Failed to enumerate devices for built-in mic detection",
          { error: error.message },
          "audio"
        );
      }
    }

    if (!preferBuiltIn && selectedDeviceId) {
      logger.debug("Using selected microphone", { deviceId: selectedDeviceId }, "audio");
      return { audio: { deviceId: { exact: selectedDeviceId }, ...noProcessing } };
    }

    logger.debug("Using default microphone", {}, "audio");
    return { audio: noProcessing };
  }

  releaseLocalInference(token = this._localInferenceToken) {
    if (!token) return;
    if (this._localInferenceToken === token) this._localInferenceToken = null;
    return window.electronAPI.releaseLocalInference(token).catch(() => {});
  }

  async captureRecordingTarget(target) {
    if (this.context !== "dictation") return;
    try {
      const result = await window.electronAPI?.captureRecordingTarget?.();
      target.token = result?.token || null;
      target.appName = typeof result?.appName === "string" ? result.appName : "";
      if (target.released && target.token) await window.electronAPI?.releaseRecordingTarget?.(target.token);
      else this.onTarget?.({ appName: target.appName });
    } catch { target.token = null; }
  }

  releaseRecordingTarget(target = this._recordingTarget) {
    if (!target || target.released) return;
    target.released = true;
    if (this._recordingTarget === target) this._recordingTarget = null;
    if (target.token) window.electronAPI?.releaseRecordingTarget?.(target.token)?.catch(() => {});
  }

  processingSettings(snapshot = this.captureSnapshot) { return snapshot?.settings || getSettings(); }

  async snapshotCaptureSettings(recordingTarget) {
    const settings = { ...getSettings(), customDictionary: [...(getSettings().customDictionary || [])] };
    const agentName = typeof localStorage !== "undefined" ? localStorage.getItem("agentName") : null;
    const model = getEffectiveReasoningModel();
    const provider = getModelProvider(model);
    const { refreshPolishContext, getPolishContext } = await import("../services/polish/polishContext");
    await refreshPolishContext({ appName: recordingTarget?.appName });
    const context = getPolishContext();
    // A concurrent context refresh must not replace this recording's original
    // destination with whichever application happens to be foreground now.
    if (recordingTarget?.appName) context.appName = recordingTarget.appName;
    const cleanup = cleanupChoices(settings);
    // A Raw profile is an effective exact-wording override, recorded with the capture.
    if (context.aiPolishDisabled) cleanup.exact = true;
    this.captureSnapshot = { settings, model, provider, context, cleanup, agentName };
    return this.captureSnapshot;
  }

  /** Capture target → settings snapshot → inference lane. Resolves false when cancelled or failed. */
  async prepareRecording(target, captureTarget, attempt) {
    const cancelled = () => this._cancelledRecordingAttempt === attempt;
    try {
      if (captureTarget) await this.captureRecordingTarget(target);
      if (cancelled()) return false;
      await this.snapshotCaptureSettings(target);
      if (cancelled()) return false;
      if (this.processingSettings().useLocalWhisper) {
        const token = await window.electronAPI.reserveLocalInference();
        if (cancelled()) {
          await this.releaseLocalInference(token);
          return false;
        }
        this._localInferenceToken = token;
      }
      return true;
    } catch (error) {
      logger.warn("Recording preparation failed", { error: error.message }, "audio");
      return false;
    }
  }

  setPipelineStage(pipelineStage) {
    this.onStateChange?.({ isRecording: false, isProcessing: true, pipelineStage });
  }

  async startRecording({ recordingTarget } = {}) {
    const attempt = Symbol();
    const target = recordingTarget || { token: null, released: false };
    let started = false;
    let prepared = Promise.resolve(false);
    let microphone;
    try {
      if (
        this._recordingStartAttempt ||
        this.isRecording ||
        this.isProcessing ||
        this.mediaRecorder?.state === "recording"
      ) {
        return false;
      }

      this._recordingStartAttempt = attempt;
      this._recordingTarget = target;
      // The paste-target capture (an AX round trip that can take up to 2.5 s in
      // a slow app), the settings snapshot and the inference reservation run
      // alongside the microphone instead of before it, so hold-to-talk no
      // longer clips the first words. Processing waits for them on stop.
      prepared = this.prepareRecording(target, !recordingTarget, attempt);

      const constraints = await this.getAudioConstraints();
      if (this._cancelledRecordingAttempt === attempt) return false;
      microphone = await openRecordingMicrophone(constraints, this.context === "notes" ? "notes" : "dictation", () => this._cancelledRecordingAttempt === attempt);
      this._batchMicrophone = microphone;
      const { stream } = microphone;

      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        const settings = audioTrack.getSettings();
        logger.info(
          "Recording started with microphone",
          {
            label: audioTrack.label,
            deviceId: settings.deviceId?.slice(0, 20) + "...",
            sampleRate: settings.sampleRate,
            channelCount: settings.channelCount,
          },
          "audio"
        );
      }

      // Silence detection: observe audio energy via AnalyserNode
      try {
        this._silenceCtx = new AudioContext();
        this._silenceAnalyser = this._silenceCtx.createAnalyser();
        this._silenceAnalyser.fftSize = 2048;
        const sourceNode = this._silenceCtx.createMediaStreamSource(stream);
        sourceNode.connect(this._silenceAnalyser);
        this._peakRms = 0;
        const dataArray = new Uint8Array(this._silenceAnalyser.fftSize);
        this._silenceInterval = setInterval(() => {
          this._silenceAnalyser.getByteTimeDomainData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) {
            const v = (dataArray[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / dataArray.length);
          if (rms > this._peakRms) this._peakRms = rms;
          // The overlay's level meter, -60 dBFS → 0 and -10 dBFS → 1. Computed
          // anyway for silence detection; until 0.3.16 it was thrown away.
          this.onLevel?.(levelFromRms(rms));
        }, 100);
      } catch (e) {
        this.cleanupSilenceDetection();
        logger.warn("Silence detection setup failed, skipping", { error: e.message }, "audio");
        this._peakRms = 1; // assume speech if detection fails
      }

      this.mediaRecorder = new MediaRecorder(stream);
      this.audioChunks = [];
      this.recordingStartTime = Date.now();
      this.recordingMimeType = this.mediaRecorder.mimeType || "audio/webm";

      this.mediaRecorder.ondataavailable = (event) => {
        this.audioChunks.push(event.data);
      };

      this.mediaRecorder.onstop = async () => {
        await microphone.release();
        if (this._batchMicrophone === microphone) this._batchMicrophone = null;
        this.cleanupSilenceDetection();

        this.isRecording = false;
        this.isProcessing = true;
        this.onStateChange?.({ isRecording: false, isProcessing: true });

        const audioBlob = new Blob(this.audioChunks, { type: this.recordingMimeType });

        logger.info(
          "Recording stopped",
          {
            blobSize: audioBlob.size,
            blobType: audioBlob.type,
            chunksCount: this.audioChunks.length,
          },
          "audio"
        );

        const durationSeconds = this.recordingStartTime
          ? (Date.now() - this.recordingStartTime) / 1000
          : null;
        this.recordingStartTime = null;
        if (!(await prepared)) {
          this.isProcessing = false;
          this.onStateChange?.({ isRecording: false, isProcessing: false });
          return;
        }
        await this.processAudio(audioBlob, { durationSeconds, recordingTarget: target });

      };

      this.mediaRecorder.start();
      started = true;
      this.isRecording = true;
      this.onStateChange?.({ isRecording: true, isProcessing: false });

      if (!(await prepared)) {
        // Cancelled (or the reservation failed) while the mic was already live.
        if (
          this.mediaRecorder?.state === "recording" &&
          this._cancelledRecordingAttempt !== attempt
        )
          this.cancelRecording();
        return false;
      }
      return true;
    } catch (error) {
      await this.releaseLocalInference();
      // Releasing push-to-talk while the microphone is opening is a normal
      // cancellation, not a microphone failure to show to the user.
      if (this._cancelledRecordingAttempt === attempt) return false;
      let errorTitle = "Recording Error";
      let errorDescription = `Failed to access microphone: ${error.message}`;

      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        errorTitle = "Microphone Access Denied";
        errorDescription =
          "Please grant microphone permission in your system settings and try again.";
      } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
        errorTitle = "No Microphone Found";
        errorDescription = "No microphone was detected. Please connect a microphone and try again.";
      } else if (error.name === "NotReadableError" || error.name === "TrackStartError") {
        errorTitle = "Microphone In Use";
        errorDescription =
          "The microphone is being used by another application. Please close other apps and try again.";
      }

      this.onError?.({
        title: errorTitle,
        description: errorDescription,
      });
      return false;
    } finally {
      if (!started) {
        // Preparation may still be in flight; give back whatever it reserves.
        void prepared.then((ok) => ok && this.releaseLocalInference());
        if (this._recordingStartAttempt === attempt) this.cleanupSilenceDetection();
        if (microphone) await microphone.release();
        if (this._batchMicrophone === microphone) this._batchMicrophone = null;
        this.releaseRecordingTarget(target);
      }
      if (this._recordingStartAttempt === attempt) this._recordingStartAttempt = null;
      if (this._cancelledRecordingAttempt === attempt) this._cancelledRecordingAttempt = null;
    }
  }

  cleanupSilenceDetection() {
    if (this._silenceInterval != null) {
      clearInterval(this._silenceInterval);
      this._silenceInterval = null;
    }
    this._silenceCtx?.close().catch(() => {});
    this._silenceCtx = null;
    this._silenceAnalyser = null;
  }

  stopRecording() {
    if (this.mediaRecorder?.state === "recording") {
      this.mediaRecorder.stop();
      return true;
    }
    if (this._recordingStartAttempt) return this.cancelRecording();
    return false;
  }

  cancelRecording() {
    const wasStarting = !!this._recordingStartAttempt;
    this.releaseRecordingTarget();
    this.releaseRecordingTarget(this._evidenceOperation?.target);
    if (this._evidenceOperation) this._evidenceOperation.cancelled = true;
    this._cancelledRecordingAttempt = this._recordingStartAttempt;
    this.releaseLocalInference();
    this.cleanupSilenceDetection();
    this._peakRms = null;
    if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
      this.mediaRecorder.onstop = () => {
        this.isRecording = false;
        this.isProcessing = false;
        this.audioChunks = [];
        this.recordingStartTime = null;
        this.onStateChange?.({ isRecording: false, isProcessing: false });
      };

      this.mediaRecorder.stop();

      if (this._batchMicrophone) {
        void this._batchMicrophone.release().catch(() => {});
        this._batchMicrophone = null;
      } else {
        this.mediaRecorder.stream?.getTracks().forEach((track) => track.stop());
      }

      return true;
    }
    return wasStarting;
  }

  cancelProcessing() {
    // The words are already transcribed: cancelling the AI pass delivers them
    // as they are instead of throwing the dictation away.
    if (this.skipPolish()) return true;
    this.releaseRecordingTarget();
    this.releaseRecordingTarget(this._evidenceOperation?.target);
    if (this._evidenceOperation) this._evidenceOperation.cancelled = true;
    this.releaseLocalInference();
    if (this.isProcessing) {
      this.isProcessing = false;
      this.onStateChange?.({ isRecording: false, isProcessing: false });
      return true;
    }
    return false;
  }

  async createEvidence(audioBlob, metadata = {}) {
    if (this.context !== "dictation" || !window.electronAPI?.captures || !audioBlob?.size) return null;
    const snapshot = metadata.captureSnapshot || this.captureSnapshot;
    const s = this.processingSettings(snapshot);
    try {
      const response = await window.electronAPI.captures.create({
        audio: await audioBlob.arrayBuffer(), mimeType: audioBlob.type || "audio/webm",
        durationSeconds: metadata.durationSeconds || 0,
        settings: { provider: s.useLocalWhisper ? (s.localTranscriptionProvider === "nvidia" ? "parakeet" : "whisper") : (s.cloudTranscriptionProvider || "openai"),
          model: s.useLocalWhisper ? (s.localTranscriptionProvider === "nvidia" ? s.parakeetModel : s.whisperModel) : this.getTranscriptionModel(snapshot),
          language: s.preferredLanguage || "auto", polishModel: snapshot?.model || s.reasoningModel,
          styleId: snapshot?.context.styleId, styleName: snapshot?.context.styleName,
          styleRules: snapshot?.context.styleRules, dictionary: s.customDictionary,
          polishProvider: snapshot?.provider, cleanup: snapshot?.cleanup || cleanupChoices(s) },
      });
      return response?.success ? response.data.id : null;
    } catch { return null; }
  }

  async finishEvidence(id, result = {}) {
    if (!id) return;
    try { await window.electronAPI?.captures?.complete({ id, ...result }); } catch {}
  }

  async processAudio(audioBlob, metadata = {}) {
    const inferenceToken = this._localInferenceToken;
    const pipelineStart = performance.now();

    // Skip transcription if recording was silence
    const SILENCE_THRESHOLD = 0.01;
    if (this._peakRms != null && this._peakRms < SILENCE_THRESHOLD) {
      logger.info(
        "Silence detected, skipping transcription",
        { peakRms: this._peakRms.toFixed(4), threshold: SILENCE_THRESHOLD },
        "audio"
      );
      this._peakRms = null;
      this.isProcessing = false;
      this.onStateChange?.({ isRecording: false, isProcessing: false });
      await this.releaseLocalInference(inferenceToken);
      this.releaseRecordingTarget(metadata.recordingTarget || this._recordingTarget);
      this.onTranscriptionComplete?.({ success: true, text: "" });
      return;
    }
    this._peakRms = null;

    const target = metadata.recordingTarget || this._recordingTarget;
    if (this._recordingTarget === target) this._recordingTarget = null;
    const operation = { cancelled: false, target };
    this._evidenceOperation = operation;
    const evidence = { rawText: "", polished: false, snapshot: this.captureSnapshot, operation };
    const captureId = await this.createEvidence(audioBlob, { ...metadata, captureSnapshot: evidence.snapshot });
    metadata = { ...metadata, evidence };
    if (!operation.cancelled && this._evidenceOperation === operation) this.setPipelineStage("transcribing");
    let evidenceFinished = false;
    try {
      if (operation.cancelled || this._evidenceOperation !== operation) return;
      const s = this.processingSettings(evidence.snapshot);
      const useLocalWhisper = s.useLocalWhisper;
      const localProvider = s.localTranscriptionProvider;
      const whisperModel = s.whisperModel;
      const parakeetModel = s.parakeetModel || "parakeet-tdt-0.6b-v3";
      logger.debug("Transcription routing", { useLocalWhisper, localProvider }, "transcription");

      let result;
      let activeModel;
      if (useLocalWhisper) {
        if (localProvider === "nvidia") {
          activeModel = parakeetModel;
          result = await this.processWithLocalParakeet(audioBlob, parakeetModel, metadata);
        } else {
          activeModel = whisperModel;
          result = await this.processWithLocalWhisper(audioBlob, whisperModel, metadata);
        }
      } else {
        activeModel = this.getTranscriptionModel();
        result = await this.processWithOpenAIAPI(audioBlob, metadata);
      }

      if (!this.isProcessing || operation.cancelled || this._evidenceOperation !== operation) {
        return;
      }

      result = { ...result, captureId, rawText: evidence.rawText || result.rawText || result.text || "", polished: evidence.polished,
        isCancelled: () => operation.cancelled || this._evidenceOperation !== operation };
      if (!this.onTranscriptionComplete) { result.evidenceFinalText = ""; result.evidenceError = "Recording window unavailable"; }
      result.captureSnapshot = evidence.snapshot;
      result.targetToken = operation.target?.token || null;
      await this.onTranscriptionComplete?.(result);
      if (result.isCancelled()) {
        result.evidenceError = "Transcription delivery was cancelled";
        result.evidenceFinalText ??= "";
      }
      await this.finishEvidence(captureId, { rawText: result.rawText, finalText: result.evidenceFinalText ?? result.text ?? "", historyId: result.historyId, error: result.evidenceError });
      evidenceFinished = true;

      const roundTripDurationMs = Math.round(performance.now() - pipelineStart);

      const timingData = {
        mode: useLocalWhisper ? `local-${localProvider}` : "cloud",
        model: activeModel,
        audioDurationMs: metadata.durationSeconds
          ? Math.round(metadata.durationSeconds * 1000)
          : null,
        reasoningProcessingDurationMs: result?.timings?.reasoningProcessingDurationMs ?? null,
        roundTripDurationMs,
        audioSizeBytes: audioBlob.size,
        audioFormat: audioBlob.type,
        outputTextLength: result?.text?.length,
      };

      if (useLocalWhisper) {
        timingData.audioConversionDurationMs = result?.timings?.audioConversionDurationMs ?? null;
      }
      timingData.transcriptionProcessingDurationMs =
        result?.timings?.transcriptionProcessingDurationMs ?? null;

      logger.info("Pipeline timing", timingData, "performance");
    } catch (error) {
      const errorAtMs = Math.round(performance.now() - pipelineStart);

      logger.error(
        "Pipeline failed",
        {
          errorAtMs,
          error: error.message,
        },
        "performance"
      );

      if (error.message !== "No audio detected") {
        this.onError?.({
          title: "Transcription Error",
          description: `Transcription failed: ${error.message}`,
          code: error.code,
        });
      }
    } finally {
      this.releaseRecordingTarget(operation.target);
      if (!evidenceFinished) await this.finishEvidence(captureId, { rawText: evidence.rawText, error: "Transcription failed or was cancelled" });
      await this.releaseLocalInference(inferenceToken);
      if (this._evidenceOperation === operation) {
        this._evidenceOperation = null;
        if (this.isProcessing) {
          this.isProcessing = false;
          this.onStateChange?.({ isRecording: false, isProcessing: false });
        }
      }
    }
  }

  async transcribeLocal(provider, audio, options) {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const operation = this._evidenceOperation;
    this.setPipelineStage("queued");
    const remove = window.electronAPI.onLocalTranscriptionStarted?.((_event, data) => {
      if (data?.requestId === requestId && this._evidenceOperation === operation && !operation?.cancelled)
        this.setPipelineStage("transcribing");
    });
    const aliasOptions = this.aliasSubstitution === false ? { skipAliases: true } : {};
    try { return await window.electronAPI[provider](audio, { ...options, ...aliasOptions, requestId }); }
    finally { remove?.(); }
  }

  /**
   * Local transcription normally rewrites known mishearings ("a rather" →
   * Aravo) before the text reaches the renderer. The "teach it" recorder turns
   * that off so it can see exactly what the recognizer heard.
   */
  setAliasSubstitution(enabled) {
    this.aliasSubstitution = enabled !== false;
  }

  async processWithLocalWhisper(audioBlob, model = "base", metadata = {}) {
    const timings = {};

    try {
      // Send original audio to main process - FFmpeg in main process handles conversion
      // (renderer-side AudioContext conversion was unreliable with WebM/Opus format)
      const arrayBuffer = await audioBlob.arrayBuffer();
      if (metadata.evidence?.operation?.cancelled) return { success: false, text: "" };
      const language = getBaseLanguageCode(this.processingSettings(metadata.evidence?.snapshot).preferredLanguage);
      const options = { model };
      if (language) {
        options.language = language;
      }

      // Add custom dictionary as initial prompt to help Whisper recognize specific words
      const dictionaryPrompt = this.getCustomDictionaryPrompt(metadata.evidence?.snapshot);
      if (dictionaryPrompt) {
        options.initialPrompt = dictionaryPrompt;
      }

      logger.debug(
        "Local transcription starting",
        {
          audioFormat: audioBlob.type,
          audioSizeBytes: audioBlob.size,
        },
        "performance"
      );

      const transcriptionStart = performance.now();
      const result = await this.transcribeLocal("transcribeLocalWhisper", arrayBuffer, options);
      timings.transcriptionProcessingDurationMs = Math.round(
        performance.now() - transcriptionStart
      );

      logger.debug(
        "Local transcription complete",
        {
          transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
          success: result.success,
        },
        "performance"
      );

      if (result.success && result.text) {
        const reasoningStart = performance.now();
        const text = await this.processTranscription(result.text, "local", metadata.evidence);
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        if (text !== null && text !== undefined) {
          return { success: true, text, source: "local", timings };
        } else {
          throw new Error("No text transcribed");
        }
      } else if (result.success === false && result.message === "No audio detected") {
        throw new Error("No audio detected");
      } else {
        throw new Error(result.message || result.error || "Local Whisper transcription failed");
      }
    } catch (error) {
      if (error.message === "No audio detected") {
        throw error;
      }

      const { allowOpenAIFallback, useLocalWhisper: isLocalMode } = this.processingSettings(metadata.evidence?.snapshot);

      if (allowOpenAIFallback && isLocalMode) {
        try {
          const fallbackResult = await this.processWithOpenAIAPI(audioBlob, metadata);
          return { ...fallbackResult, source: "openai-fallback" };
        } catch (fallbackError) {
          throw new Error(
            `Local Whisper failed: ${error.message}. OpenAI fallback also failed: ${fallbackError.message}`
          );
        }
      } else {
        throw new Error(`Local Whisper failed: ${error.message}`);
      }
    }
  }

  async processWithLocalParakeet(audioBlob, model = "parakeet-tdt-0.6b-v3", metadata = {}) {
    const timings = {};

    try {
      const arrayBuffer = await audioBlob.arrayBuffer();
      if (metadata.evidence?.operation?.cancelled) return { success: false, text: "" };
      const language = validateLanguageForModel(this.processingSettings(metadata.evidence?.snapshot).preferredLanguage, model);
      const options = { model };
      if (language) {
        options.language = language;
      }

      logger.debug(
        "Parakeet transcription starting",
        {
          audioFormat: audioBlob.type,
          audioSizeBytes: audioBlob.size,
          model,
        },
        "performance"
      );

      const transcriptionStart = performance.now();
      const result = await this.transcribeLocal("transcribeLocalParakeet", arrayBuffer, options);
      timings.transcriptionProcessingDurationMs = Math.round(
        performance.now() - transcriptionStart
      );

      logger.debug(
        "Parakeet transcription complete",
        {
          transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
          success: result.success,
        },
        "performance"
      );

      if (result.success && result.text) {
        const reasoningStart = performance.now();
        const text = await this.processTranscription(result.text, "local-parakeet", metadata.evidence);
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        if (text !== null && text !== undefined) {
          return { success: true, text, source: "local-parakeet", timings };
        } else {
          throw new Error("No text transcribed");
        }
      } else if (result.success === false && result.message === "No audio detected") {
        throw new Error("No audio detected");
      } else {
        throw new Error(result.message || result.error || "Parakeet transcription failed");
      }
    } catch (error) {
      if (error.message === "No audio detected") {
        throw error;
      }

      const { allowOpenAIFallback, useLocalWhisper: isLocalMode } = this.processingSettings(metadata.evidence?.snapshot);

      if (allowOpenAIFallback && isLocalMode) {
        try {
          const fallbackResult = await this.processWithOpenAIAPI(audioBlob, metadata);
          return { ...fallbackResult, source: "openai-fallback" };
        } catch (fallbackError) {
          throw new Error(
            `Parakeet failed: ${error.message}. OpenAI fallback also failed: ${fallbackError.message}`
          );
        }
      } else {
        throw new Error(`Parakeet failed: ${error.message}`);
      }
    }
  }

  async getAPIKey(snapshot = this.captureSnapshot) {
    const s = this.processingSettings(snapshot);
    const provider = s.cloudTranscriptionProvider || "openai";

    // Check cache (invalidate if provider changed)
    if (this.cachedApiKey !== null && this.cachedApiKeyProvider === provider) {
      return this.cachedApiKey;
    }

    let apiKey = null;

    if (provider === "custom") {
      // Prefer store value (user-entered via UI) over main process (.env)
      apiKey = s.customTranscriptionApiKey || "";
      if (!apiKey.trim()) {
        try {
          apiKey = await window.electronAPI.getCustomTranscriptionKey?.();
        } catch (err) {
          logger.debug(
            "Failed to get custom transcription key via IPC",
            { error: err?.message },
            "transcription"
          );
        }
      }
      apiKey = apiKey?.trim() || "";

      logger.debug(
        "Custom STT API key retrieval",
        {
          provider,
          hasKey: !!apiKey,
          keyLength: apiKey?.length || 0,
          hasKey: Boolean(apiKey),
        },
        "transcription"
      );

      // For custom, we allow null/empty - the endpoint may not require auth
      if (!apiKey) {
        apiKey = null;
      }
    } else if (provider === "mistral") {
      // Prefer store value (user-entered via UI) over main process (.env)
      // to avoid stale keys in process.env after auth mode transitions
      apiKey = s.mistralApiKey;
      if (!isValidApiKey(apiKey, "mistral")) {
        apiKey = await window.electronAPI.getMistralKey?.();
      }
      if (!isValidApiKey(apiKey, "mistral")) {
        throw new Error("Mistral API key not found. Please set your API key in the Control Panel.");
      }
    } else if (provider === "groq") {
      // Prefer store value (user-entered via UI) over main process (.env)
      apiKey = s.groqApiKey;
      if (!isValidApiKey(apiKey, "groq")) {
        apiKey = await window.electronAPI.getGroqKey?.();
      }
      if (!isValidApiKey(apiKey, "groq")) {
        throw new Error("Groq API key not found. Please set your API key in the Control Panel.");
      }
    } else {
      // Default to OpenAI
      // Prefer store value (user-entered via UI) over main process (.env)
      // to avoid stale keys in process.env after auth mode transitions
      apiKey = s.openaiApiKey;
      if (!isValidApiKey(apiKey, "openai")) {
        apiKey = await window.electronAPI.getOpenAIKey();
      }
      if (!isValidApiKey(apiKey, "openai")) {
        throw new Error(
          "OpenAI API key not found. Please set your API key in the .env file or Control Panel."
        );
      }
    }

    this.cachedApiKey = apiKey;
    this.cachedApiKeyProvider = provider;
    return apiKey;
  }

  async optimizeAudio(audioBlob) {
    return new Promise((resolve) => {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const reader = new FileReader();

      reader.onload = async () => {
        try {
          const arrayBuffer = reader.result;
          const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

          // Convert to 16kHz mono for smaller size and faster upload
          const sampleRate = 16000;
          const channels = 1;
          const length = Math.floor(audioBuffer.duration * sampleRate);
          const offlineContext = new OfflineAudioContext(channels, length, sampleRate);

          const source = offlineContext.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(offlineContext.destination);
          source.start();

          const renderedBuffer = await offlineContext.startRendering();
          const wavBlob = this.audioBufferToWav(renderedBuffer);
          resolve(wavBlob);
        } catch (error) {
          // If optimization fails, use original
          resolve(audioBlob);
        }
      };

      reader.onerror = () => resolve(audioBlob);
      reader.readAsArrayBuffer(audioBlob);
    });
  }

  audioBufferToWav(buffer) {
    const length = buffer.length;
    const arrayBuffer = new ArrayBuffer(44 + length * 2);
    const view = new DataView(arrayBuffer);
    const sampleRate = buffer.sampleRate;
    const channelData = buffer.getChannelData(0);

    const writeString = (offset, string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(0, "RIFF");
    view.setUint32(4, 36 + length * 2, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, length * 2, true);

    let offset = 44;
    for (let i = 0; i < length; i++) {
      const sample = Math.max(-1, Math.min(1, channelData[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }

    return new Blob([arrayBuffer], { type: "audio/wav" });
  }

  async processWithReasoningModel(text, model, agentName, snapshot = this.captureSnapshot) {
    logger.logReasoning("CALLING_REASONING_SERVICE", {
      model,
      agentName,
      textLength: text.length,
    });

    const startTime = Date.now();

    try {
      // Low temperature: polish is a faithful rewrite, not creative generation
      const result = await ReasoningService.processText(text, model, agentName, {
        temperature: 0.2,
        provider: snapshot?.provider,
        baseUrl: snapshot?.settings.cloudReasoningBaseUrl,
        dictionary: snapshot?.settings.customDictionary,
        language: snapshot?.settings.preferredLanguage,
        locale: snapshot?.settings.uiLanguage,
        systemPrompt: snapshot ? getSystemPrompt(agentName, snapshot.settings.customDictionary,
          snapshot.settings.preferredLanguage, text, snapshot.settings.uiLanguage, snapshot) : undefined,
      });

      const processingTime = Date.now() - startTime;

      logger.logReasoning("REASONING_SERVICE_COMPLETE", {
        model,
        processingTimeMs: processingTime,
        resultLength: result.length,
        success: true,
      });

      return result;
    } catch (error) {
      const processingTime = Date.now() - startTime;

      logger.logReasoning("REASONING_SERVICE_ERROR", {
        model,
        processingTimeMs: processingTime,
        error: error.message,
        stack: error.stack,
      });

      throw error;
    }
  }

  async isReasoningAvailable() {
    if (typeof window === "undefined") {
      return false;
    }

    const useReasoning = this.processingSettings().useReasoningModel;
    const now = Date.now();
    const cacheValid =
      this.reasoningAvailabilityCache &&
      now < this.reasoningAvailabilityCache.expiresAt &&
      this.cachedReasoningPreference === useReasoning;

    if (cacheValid) {
      return this.reasoningAvailabilityCache.value;
    }

    logger.logReasoning("REASONING_STORAGE_CHECK", {
      useReasoning,
    });

    if (!useReasoning) {
      this.reasoningAvailabilityCache = {
        value: false,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = useReasoning;
      return false;
    }

    try {
      const isAvailable = await ReasoningService.isAvailable();

      logger.logReasoning("REASONING_AVAILABILITY", {
        isAvailable,
        reasoningEnabled: useReasoning,
        finalDecision: useReasoning && isAvailable,
      });

      this.reasoningAvailabilityCache = {
        value: isAvailable,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = useReasoning;

      return isAvailable;
    } catch (error) {
      logger.logReasoning("REASONING_AVAILABILITY_ERROR", {
        error: error.message,
        stack: error.stack,
      });

      this.reasoningAvailabilityCache = {
        value: false,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = useReasoning;
      return false;
    }
  }

  /**
   * Fast path: very short utterances with no formatting cues paste instantly
   * without an LLM round-trip (the transcription engine's own punctuation is
   * good enough for "sounds good, see you there").
   */
  shouldSkipPolish(text) {
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length >= 8) return false;
    const formattingCues =
      /(new line|new paragraph|bullet|numbered? list|question mark|exclamation|scratch that|first|second|third)/i;
    return !formattingCues.test(text);
  }

  /**
   * Sanity-checks LLM polish output. Returns the cleaned text, or null when
   * the model went off the rails (answered instead of rewriting, summarized,
   * hallucinated) — in which case the raw transcript is used.
   */
  validatePolishOutput(input, output) {
    return AudioManager.prototype.explainPolishOutput(input, output).text;
  }

  /** Same check, plus which rule refused: `{ text, reason }` (reason "" when accepted). */
  explainPolishOutput(input, output) {
    if (typeof input !== "string" || !input.trim() || typeof output !== "string" || !output) {
      return { text: null, reason: "invalid" };
    }

    let out = output
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/<think>[\s\S]*$/, "")
      .trim();

    // Strip a wrapping code fence or matched quotes the model sometimes adds
    const fence = out.match(/^```(?:\w+)?\r?\n([\s\S]*?)\r?\n```$/);
    if (fence) out = fence[1].trim();
    if (
      out.length > 2 &&
      out.startsWith('"') &&
      out.endsWith('"') &&
      !input.trim().startsWith('"')
    ) {
      out = out.slice(1, -1).trim();
    }

    // Markdown soft-break artifacts: trailing double spaces per line
    out = out
      .split("\n")
      .map((line) => line.replace(/\s+$/, ""))
      .join("\n")
      .trim();

    if (!out) return { text: null, reason: "empty" };

    const inWords = input.split(/\s+/).filter(Boolean).length;
    const outWords = out.split(/\s+/).filter(Boolean).length;

    // Growth cap, applied at EVERY length. Polish removes filler, so a faithful
    // rewrite is almost always shorter; measured legitimate cleanup never added
    // more than +2 words. The old rule only ran at >=12 words and allowed
    // 2x+12, which let short cut-off dictations ("i think we should probably")
    // come back as invented bullet lists — 14/32 sampled truncations grew by
    // >3 words and none were caught.
    const allowedGrowth = Math.max(3, Math.round(inWords * 0.1));
    if (outWords > inWords + allowedGrowth) return { text: null, reason: "grew" }; // expanded → invented content
    if (inWords >= 12 && outWords < inWords * 0.4) return { text: null, reason: "shrank" }; // shrunk → summarized/answered
    // Numbers and negation carry disproportionate meaning. Accept harmless
    // formatting variants (1,200 → 1200 and can't → cannot), but fall back to
    // the raw transcript if the model adds, removes, or changes either signal.
    if (!numbersPreserved(input, out)) return { text: null, reason: "numbers" };
    if (extractNegations(input).length !== extractNegations(out).length)
      return { text: null, reason: "negation" };

    // Preserve names and acronyms already present in the transcript. This is a
    // conservative signal rather than a semantic-equivalence claim: a rejected
    // polish result simply leaves the user's raw words intact.
    const outputWords = new Set(
      out.toLocaleLowerCase().match(/[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu) || []
    );
    if (extractProtectedNames(input).some((name) => !outputWords.has(name)))
      return { text: null, reason: "names" };

    // Cleanup, not ghost-writing: at least 85% of the speaker's own words
    // (fillers and spoken commands aside) must survive, in order. Measured on
    // Scott's dictations with the full polish prompt, edits below that dropped
    // or reworded real content ("what you say" → "what I said").
    if (inWords >= 6 && keptWordShare(input, out) < 0.85) return { text: null, reason: "rewrote" };
    if (!samePerson(input, out)) return { text: null, reason: "pronouns" };

    // A trailing connective strongly suggests recording stopped mid-thought.
    // Punctuation/case cleanup remains valid, while invented completion does not.
    const inputLexicalWords = input.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || [];
    const outputLexicalWords = out.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || [];
    const inputLastWord = inputLexicalWords.at(-1);
    if (
      inputLastWord &&
      TRUNCATED_ENDING_WORDS.has(inputLastWord) &&
      outputLexicalWords.at(-1) !== inputLastWord
    ) {
      return { text: null, reason: "completed-truncation" };
    }

    // The model answered the dictation instead of rewriting it
    if (
      /^(sure[,!.]|here('|’)s |i can('|’)t |as an ai)/i.test(out) &&
      !/^(sure|here)/i.test(input.trim())
    ) {
      return { text: null, reason: "answered" };
    }

    return { text: out, reason: "" };
  }

  /**
   * Races a polish request against its timeout and against "use the raw text
   * now" (cancel while refining). Either way the HTTP request to llama-server
   * is aborted so it stops generating instead of holding the next dictation.
   * Resolves POLISH_SKIPPED when the person skipped the pass.
   */
  _withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const settle = (fn, value, abort) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this._skipPolish === skip) this._skipPolish = null;
        if (abort) void window.electronAPI?.cancelLocalReasoning?.()?.catch?.(() => {});
        fn(value);
      };
      const skip = () => settle(resolve, POLISH_SKIPPED, true);
      this._skipPolish = skip;
      timer = setTimeout(() => settle(reject, new Error(`${label} timed out after ${ms}ms`), true), ms);
      promise.then(
        (v) => settle(resolve, v),
        (e) => settle(reject, e)
      );
    });
  }

  /** Cancel while refining: keep the dictation and deliver it without the AI pass. */
  skipPolish() {
    if (!this._skipPolish) return false;
    this._skipPolish();
    return true;
  }

  async processTranscription(text, source, evidence) {
    const raw = typeof text === "string" ? text : "";
    if (evidence) { evidence.rawText = raw; evidence.polished = false; }
    this.lastPolishInfo = { polished: false, raw };
    const snapshot = evidence?.snapshot || this.captureSnapshot || {
      settings: this.processingSettings(), model: getEffectiveReasoningModel(),
      provider: getModelProvider(getEffectiveReasoningModel()),
      cleanup: cleanupChoices(this.processingSettings()),
      context: { styleName: "", styleInstructions: "", appName: "", examples: [], aiPolishDisabled: false },
    };
    if (evidence?.operation?.cancelled || !raw.trim() || this.commandMode || this.skipReasoning) return raw;
    const namedCommand = isNamedDictationCommand(raw, snapshot.agentName || snapshot.settings.agentName);
    if (snapshot.cleanup.exact && !namedCommand) return raw;
    if (namedCommand && (snapshot.model || snapshot.provider === "openwhispr")) {
      this.setPipelineStage("refining");
      try {
        const result = await this._withTimeout(this.processWithReasoningModel(raw, snapshot.model,
          snapshot.agentName || snapshot.settings.agentName, { ...snapshot, command: true }), POLISH_TIMEOUT_MS, "Voice command");
        if (result === POLISH_SKIPPED || typeof result !== "string" || !result.trim()) return raw;
        if (evidence) { evidence.polished = true; evidence.explicitCommand = true; }
        this.lastPolishInfo = { polished: true, raw };
        return result;
      } catch (error) {
        this.onError?.({ code: "POLISH_UNAVAILABLE" });
        return raw;
      }
    }
    const baseline = applyDictationCleanup(raw, snapshot.cleanup);
    // Deterministic cleanup always precedes short-utterance and disabled-AI paths.
    if (!snapshot.settings.useReasoningModel || this.shouldSkipPolish(baseline)) return baseline;
    if (!snapshot.model && snapshot.provider !== "openwhispr") return baseline;
    this.setPipelineStage("refining");
    try {
      const result = await this._withTimeout(
        this.processWithReasoningModel(baseline, snapshot.model, null, snapshot),
        POLISH_TIMEOUT_MS, "Polish"
      );
      if (result === POLISH_SKIPPED) return baseline;
      const { text: validated, reason } = this.explainPolishOutput(baseline, result);
      const violation = validated === null ? reason : cleanupViolation(baseline, validated, snapshot.cleanup);
      if (violation) {
        // Why polish was set aside lands in logs/ss2.log; the text never does.
        logger.warn("Polish result set aside; cleanup kept", { reason: violation, words: baseline.split(/\s+/).length }, "polish");
        return baseline;
      }
      if (evidence) evidence.polished = true;
      this.lastPolishInfo = { polished: true, raw };
      return validated;
    } catch (error) {
      logger.warn("Reasoning failed; deterministic cleanup retained", { source, error: error.message }, "notes");
      this.onError?.({ code: "POLISH_UNAVAILABLE" });
      return baseline;
    }
  }

  shouldStreamTranscription(model, provider) {
    if (provider !== "openai") {
      return false;
    }
    const normalized = typeof model === "string" ? model.trim() : "";
    if (!normalized || normalized === "whisper-1") {
      return false;
    }
    if (normalized === "gpt-4o-transcribe" || normalized === "gpt-4o-transcribe-diarize") {
      return true;
    }
    return normalized.startsWith("gpt-4o-mini-transcribe");
  }

  async readTranscriptionStream(response) {
    const reader = response.body?.getReader();
    if (!reader) {
      logger.error("Streaming response body not available", {}, "transcription");
      throw new Error("Streaming response body not available");
    }

    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let collectedText = "";
    let finalText = null;
    let eventCount = 0;
    const eventTypes = {};

    const handleEvent = (payload) => {
      if (!payload || typeof payload !== "object") {
        return;
      }
      eventCount++;
      const eventType = payload.type || "unknown";
      eventTypes[eventType] = (eventTypes[eventType] || 0) + 1;

      logger.debug(
        "Stream event received",
        {
          type: eventType,
          eventNumber: eventCount,
          payloadKeys: Object.keys(payload),
        },
        "transcription"
      );

      if (payload.type === "transcript.text.delta" && typeof payload.delta === "string") {
        collectedText += payload.delta;
        return;
      }
      if (payload.type === "transcript.text.segment" && typeof payload.text === "string") {
        collectedText += payload.text;
        return;
      }
      if (payload.type === "transcript.text.done" && typeof payload.text === "string") {
        finalText = payload.text;
        logger.debug(
          "Final transcript received",
          {
            textLength: payload.text.length,
          },
          "transcription"
        );
      }
    };

    logger.debug("Starting to read transcription stream", {}, "transcription");

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        logger.debug(
          "Stream reading complete",
          {
            eventCount,
            eventTypes,
            collectedTextLength: collectedText.length,
            hasFinalText: finalText !== null,
          },
          "transcription"
        );
        break;
      }
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      // Log first chunk to see format
      if (eventCount === 0 && chunk.length > 0) {
        logger.debug(
          "First stream chunk received",
          {
            chunkLength: chunk.length,
            chunkLength: chunk.length,
          },
          "transcription"
        );
      }

      // Process complete lines from the buffer
      // Each SSE event is "data: <json>\n" followed by empty line
      const lines = buffer.split("\n");
      buffer = "";

      for (const line of lines) {
        const trimmedLine = line.trim();

        // Skip empty lines
        if (!trimmedLine) {
          continue;
        }

        // Extract data from "data: " prefix
        let data = "";
        if (trimmedLine.startsWith("data: ")) {
          data = trimmedLine.slice(6);
        } else if (trimmedLine.startsWith("data:")) {
          data = trimmedLine.slice(5).trim();
        } else {
          // Not a data line, could be leftover - keep in buffer
          buffer += line + "\n";
          continue;
        }

        // Handle [DONE] marker
        if (data === "[DONE]") {
          finalText = finalText ?? collectedText;
          continue;
        }

        // Try to parse JSON
        try {
          const parsed = JSON.parse(data);
          handleEvent(parsed);
        } catch (error) {
          // Incomplete JSON - put back in buffer for next iteration
          buffer += line + "\n";
        }
      }
    }

    const result = finalText ?? collectedText;
    logger.debug(
      "Stream processing complete",
      {
        resultLength: result.length,
        usedFinalText: finalText !== null,
        eventCount,
        eventTypes,
      },
      "transcription"
    );

    return result;
  }

  async processWithOpenAIAPI(audioBlob, metadata = {}) {
    const timings = {};
    const apiSettings = this.processingSettings(metadata.evidence?.snapshot);
    const language = getBaseLanguageCode(apiSettings.preferredLanguage);
    const allowLocalFallback = apiSettings.allowLocalFallback;
    const fallbackModel = apiSettings.fallbackWhisperModel || "base";

    try {
      const durationSeconds = metadata.durationSeconds ?? null;
      const shouldSkipOptimizationForDuration =
        typeof durationSeconds === "number" &&
        durationSeconds > 0 &&
        durationSeconds < SHORT_CLIP_DURATION_SECONDS;

      const model = this.getTranscriptionModel(metadata.evidence?.snapshot);
      const provider = apiSettings.cloudTranscriptionProvider || "openai";

      logger.debug(
        "Transcription request starting",
        {
          provider,
          model,
          blobSize: audioBlob.size,
          blobType: audioBlob.type,
          durationSeconds,
          language,
        },
        "transcription"
      );

      // gpt-4o-transcribe models don't support WAV format - they need webm, mp3, mp4, etc.
      // Only use WAV optimization for whisper-1 and groq models
      const is4oModel = model.includes("gpt-4o");
      const shouldOptimize =
        !is4oModel && !shouldSkipOptimizationForDuration && audioBlob.size > 1024 * 1024;

      logger.debug(
        "Audio optimization decision",
        {
          is4oModel,
          shouldOptimize,
          shouldSkipOptimizationForDuration,
        },
        "transcription"
      );

      const [apiKey, optimizedAudio] = await Promise.all([
        this.getAPIKey(metadata.evidence?.snapshot),
        shouldOptimize ? this.optimizeAudio(audioBlob) : Promise.resolve(audioBlob),
      ]);

      const formData = new FormData();
      // Determine the correct file extension based on the blob type
      const mimeType = optimizedAudio.type || "audio/webm";
      const extension = mimeType.includes("webm")
        ? "webm"
        : mimeType.includes("ogg")
          ? "ogg"
          : mimeType.includes("mp4")
            ? "mp4"
            : mimeType.includes("mpeg")
              ? "mp3"
              : mimeType.includes("wav")
                ? "wav"
                : "webm";

      logger.debug(
        "FormData preparation",
        {
          mimeType,
          extension,
          optimizedSize: optimizedAudio.size,
          hasApiKey: !!apiKey,
        },
        "transcription"
      );

      formData.append("file", optimizedAudio, `audio.${extension}`);
      formData.append("model", model);

      if (language) {
        formData.append("language", language);
      }

      // Add custom dictionary as prompt hint for cloud transcription
      const dictionaryPrompt = this.getCustomDictionaryPrompt(metadata.evidence?.snapshot);
      if (dictionaryPrompt) {
        formData.append("prompt", dictionaryPrompt);
      }

      const shouldStream = this.shouldStreamTranscription(model, provider);
      if (shouldStream) {
        formData.append("stream", "true");
      }

      const endpoint = this.getTranscriptionEndpoint(metadata.evidence?.snapshot);
      const isCustomEndpoint =
        provider === "custom" ||
        (!endpoint.includes("api.openai.com") &&
          !endpoint.includes("api.groq.com") &&
          !endpoint.includes("api.mistral.ai"));

      const apiCallStart = performance.now();

      // Mistral uses x-api-key auth (not Bearer) and doesn't allow browser CORS — proxy through main process
      if (provider === "mistral" && window.electronAPI?.proxyMistralTranscription) {
        const audioBuffer = await optimizedAudio.arrayBuffer();
        const proxyData = { audioBuffer, model, language };

        if (dictionaryPrompt) {
          const tokens = dictionaryPrompt
            .split(",")
            .flatMap((entry) => entry.trim().split(/\s+/))
            .filter(Boolean)
            .slice(0, 100);
          if (tokens.length > 0) {
            proxyData.contextBias = tokens;
          }
        }

        const result = await window.electronAPI.proxyMistralTranscription(proxyData);
        const proxyText = result?.text;

        if (proxyText && proxyText.trim().length > 0) {
          timings.transcriptionProcessingDurationMs = Math.round(performance.now() - apiCallStart);
          const reasoningStart = performance.now();
          const text = await this.processTranscription(proxyText, "mistral", metadata.evidence);
          timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

          const source = (await this.isReasoningAvailable()) ? "mistral-reasoned" : "mistral";
          return { success: true, text, source, timings };
        }

        throw new Error("No text transcribed - Mistral response was empty");
      }

      logger.debug(
        "Making transcription API request",
        {
          endpoint,
          shouldStream,
          model,
          provider,
          isCustomEndpoint,
          hasApiKey: !!apiKey,
          hasApiKey: Boolean(apiKey),
        },
        "transcription"
      );

      // Build headers - only include Authorization if we have an API key
      const headers = {};
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }

      logger.debug(
        "STT request details",
        {
          endpoint,
          method: "POST",
          hasAuthHeader: !!apiKey,
          formDataFields: [
            "file",
            "model",
            language && language !== "auto" ? "language" : null,
            shouldStream ? "stream" : null,
          ].filter(Boolean),
        },
        "transcription"
      );

      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: formData,
      });

      const responseContentType = response.headers.get("content-type") || "";

      logger.debug(
        "Transcription API response received",
        {
          status: response.status,
          statusText: response.statusText,
          contentType: responseContentType,
          ok: response.ok,
        },
        "transcription"
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(
          "Transcription API error response",
          {
            status: response.status,
            errorText,
          },
          "transcription"
        );
        throw new Error(`API Error: ${response.status} ${errorText}`);
      }

      let result;
      const contentType = responseContentType;

      if (shouldStream && contentType.includes("text/event-stream")) {
        logger.debug("Processing streaming response", { contentType }, "transcription");
        const streamedText = await this.readTranscriptionStream(response);
        result = { text: streamedText };
        logger.debug(
          "Streaming response parsed",
          {
            hasText: !!streamedText,
            textLength: streamedText?.length,
          },
          "transcription"
        );
      } else {
        const rawText = await response.text();
        logger.debug(
          "Raw API response body",
          {
            rawText: rawText.substring(0, 1000),
            fullLength: rawText.length,
          },
          "transcription"
        );

        try {
          result = JSON.parse(rawText);
        } catch (parseError) {
          logger.error(
            "Failed to parse JSON response",
            {
              parseError: parseError.message,
              responseLength: rawText.length,
            },
            "transcription"
          );
          throw new Error(`Failed to parse API response: ${parseError.message}`);
        }

        logger.debug(
          "Parsed transcription result",
          {
            hasText: !!result.text,
            textLength: result.text?.length,
            resultKeys: Object.keys(result),
            fullResult: result,
          },
          "transcription"
        );
      }

      // Check for text - handle both empty string and missing field
      if (result.text && result.text.trim().length > 0) {
        timings.transcriptionProcessingDurationMs = Math.round(performance.now() - apiCallStart);

        const reasoningStart = performance.now();
        const text = await this.processTranscription(result.text, "openai", metadata.evidence);
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        const source = (await this.isReasoningAvailable()) ? "openai-reasoned" : "openai";
        logger.debug(
          "Transcription successful",
          {
            originalLength: result.text.length,
            processedLength: text.length,
            source,
            transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
            reasoningProcessingDurationMs: timings.reasoningProcessingDurationMs,
          },
          "transcription"
        );
        return { success: true, text, source, timings };
      } else {
        // Log at info level so it shows without debug mode
        logger.info(
          "Transcription returned empty - check audio input",
          {
            model,
            provider,
            endpoint,
            blobSize: audioBlob.size,
            blobType: audioBlob.type,
            mimeType,
            extension,
            resultText: result.text,
            resultKeys: Object.keys(result),
          },
          "transcription"
        );
        logger.error(
          "No text in transcription result",
          {
            result,
            resultKeys: Object.keys(result),
          },
          "transcription"
        );
        throw new Error(
          "No text transcribed - audio may be too short, silent, or in an unsupported format"
        );
      }
    } catch (error) {
      const isOpenAIMode = !this.processingSettings(metadata.evidence?.snapshot).useLocalWhisper;

      if (allowLocalFallback && isOpenAIMode) {
        try {
          const arrayBuffer = await audioBlob.arrayBuffer();
          const options = { model: fallbackModel };
          if (language && language !== "auto") {
            options.language = language;
          }

          const result = await this.transcribeLocal("transcribeLocalWhisper", arrayBuffer, options);

          if (result.success && result.text) {
            const text = await this.processTranscription(result.text, "local-fallback", metadata.evidence);
            if (text) {
              return { success: true, text, source: "local-fallback" };
            }
          }
          throw error;
        } catch (fallbackError) {
          throw new Error(
            `OpenAI API failed: ${error.message}. Local fallback also failed: ${fallbackError.message}`
          );
        }
      }

      throw error;
    }
  }

  getTranscriptionModel(snapshot = this.captureSnapshot) {
    try {
      const s = this.processingSettings(snapshot);
      const provider = s.cloudTranscriptionProvider || "openai";
      const trimmedModel = (s.cloudTranscriptionModel || "").trim();

      // For custom provider, use whatever model is set (or fallback to whisper-1)
      if (provider === "custom") {
        return trimmedModel || "whisper-1";
      }

      // Validate model matches provider to handle settings migration
      if (trimmedModel) {
        const isGroqModel = trimmedModel.startsWith("whisper-large-v3");
        const isOpenAIModel = trimmedModel.startsWith("gpt-4o") || trimmedModel === "whisper-1";
        const isMistralModel = trimmedModel.startsWith("voxtral-");

        if (provider === "groq" && isGroqModel) {
          return trimmedModel;
        }
        if (provider === "openai" && isOpenAIModel) {
          return trimmedModel;
        }
        if (provider === "mistral" && isMistralModel) {
          return trimmedModel;
        }
        // Model doesn't match provider - fall through to default
      }

      // Return provider-appropriate default
      if (provider === "groq") return "whisper-large-v3-turbo";
      if (provider === "mistral") return "voxtral-mini-latest";
      return "gpt-4o-mini-transcribe";
    } catch (error) {
      return "gpt-4o-mini-transcribe";
    }
  }

  getTranscriptionEndpoint(snapshot = this.captureSnapshot) {
    const s = this.processingSettings(snapshot);
    const currentProvider = s.cloudTranscriptionProvider || "openai";
    const currentBaseUrl = s.cloudTranscriptionBaseUrl || "";

    // Only use custom URL when provider is explicitly "custom"
    const isCustomEndpoint = currentProvider === "custom";

    // Invalidate cache if provider or base URL changed
    if (
      this.cachedTranscriptionEndpoint &&
      (this.cachedEndpointProvider !== currentProvider ||
        this.cachedEndpointBaseUrl !== currentBaseUrl)
    ) {
      logger.debug(
        "STT endpoint cache invalidated",
        {
          previousProvider: this.cachedEndpointProvider,
          newProvider: currentProvider,
          previousBaseUrl: this.cachedEndpointBaseUrl,
          newBaseUrl: currentBaseUrl,
        },
        "transcription"
      );
      this.cachedTranscriptionEndpoint = null;
    }

    if (this.cachedTranscriptionEndpoint) {
      return this.cachedTranscriptionEndpoint;
    }

    try {
      // Use custom URL only when provider is "custom", otherwise use provider-specific defaults
      let base;
      if (isCustomEndpoint) {
        base = currentBaseUrl.trim() || API_ENDPOINTS.TRANSCRIPTION_BASE;
      } else if (currentProvider === "groq") {
        base = API_ENDPOINTS.GROQ_BASE;
      } else if (currentProvider === "mistral") {
        base = API_ENDPOINTS.MISTRAL_BASE;
      } else {
        // OpenAI or other standard providers
        base = API_ENDPOINTS.TRANSCRIPTION_BASE;
      }

      const normalizedBase = normalizeBaseUrl(base);

      logger.debug(
        "STT endpoint resolution",
        {
          provider: currentProvider,
          isCustomEndpoint,
          rawBaseUrl: currentBaseUrl,
          normalizedBase,
          defaultBase: API_ENDPOINTS.TRANSCRIPTION_BASE,
        },
        "transcription"
      );

      const cacheResult = (endpoint) => {
        this.cachedTranscriptionEndpoint = endpoint;
        this.cachedEndpointProvider = currentProvider;
        this.cachedEndpointBaseUrl = currentBaseUrl;

        logger.debug(
          "STT endpoint resolved",
          {
            endpoint,
            provider: currentProvider,
            isCustomEndpoint,
            usingDefault: endpoint === API_ENDPOINTS.TRANSCRIPTION,
          },
          "transcription"
        );

        return endpoint;
      };

      if (!normalizedBase) {
        logger.debug(
          "STT endpoint: using default (normalization failed)",
          { rawBase: base },
          "transcription"
        );
        return cacheResult(API_ENDPOINTS.TRANSCRIPTION);
      }

      // Only validate HTTPS for custom endpoints (known providers are already HTTPS)
      if (isCustomEndpoint && !isSecureEndpoint(normalizedBase)) {
        logger.warn(
          "STT endpoint: HTTPS required, falling back to default",
          { attemptedUrl: normalizedBase },
          "transcription"
        );
        return cacheResult(API_ENDPOINTS.TRANSCRIPTION);
      }

      let endpoint;
      if (/\/audio\/(transcriptions|translations)$/i.test(normalizedBase)) {
        endpoint = normalizedBase;
        logger.debug("STT endpoint: using full path from config", { endpoint }, "transcription");
      } else {
        endpoint = buildApiUrl(normalizedBase, "/audio/transcriptions");
        logger.debug(
          "STT endpoint: appending /audio/transcriptions to base",
          { base: normalizedBase, endpoint },
          "transcription"
        );
      }

      return cacheResult(endpoint);
    } catch (error) {
      logger.error(
        "STT endpoint resolution failed",
        { error: error.message, stack: error.stack },
        "transcription"
      );
      this.cachedTranscriptionEndpoint = API_ENDPOINTS.TRANSCRIPTION;
      this.cachedEndpointProvider = currentProvider;
      this.cachedEndpointBaseUrl = currentBaseUrl;
      return API_ENDPOINTS.TRANSCRIPTION;
    }
  }

  async safePaste(text, options = {}) {
    try {
      const pasted = await window.electronAPI.pasteText(text, options);
      if (pasted?.success === false) {
        this.onError?.({
          code: "PASTE_FAILED",
          onClipboard: pasted.onClipboard === true,
          reason: typeof pasted.reason === "string" ? pasted.reason : "",
          appName: typeof pasted.appName === "string" ? pasted.appName : "",
        });
        return { ...pasted, text: pasted.text ?? text };
      }
      this.lastPastedText = pasted?.text ?? text;
      return {
        success: true,
        text: this.lastPastedText,
        appName: typeof pasted?.appName === "string" ? pasted.appName : "",
      };
    } catch {
      this.onError?.({ code: "PASTE_FAILED" });
      return { success: false, manualCopy: true, text };
    }
  }

  async saveTranscription(text, rawText) {
    try {
      // Persist the pre-polish transcript alongside the final text so edits
      // in History can teach the polish pass (raw → preferred pairs)
      const raw = rawText ?? (this.lastPolishInfo?.polished ? this.lastPolishInfo.raw : null);
      return await window.electronAPI.saveTranscription(text, raw);
    } catch (error) {
      return false;
    }
  }

  getState() {
    return {
      isRecording: this.isRecording,
      isProcessing: this.isProcessing,
      // Streaming dictation was removed; kept false for existing callers.
      isStreaming: false,
      isStreamingStartInProgress: false,
      isRecordingStartInProgress: !!this._recordingStartAttempt,
    };
  }

  // Streaming dictation (OpenWhispr cloud, Deepgram, AssemblyAI) was removed.
  // These stubs keep callers that still branch on streaming (useAudioRecording)
  // on the batch path until they drop those branches.
  shouldUseStreaming() {
    return false;
  }

  async warmupStreamingConnection() {
    return false;
  }

  async startStreamingRecording() {
    return false;
  }

  async stopStreamingRecording() {
    return false;
  }

  async cancelStreamingRecording() {
    return false;
  }

  cleanup() {
    if (this._evidenceOperation) this._evidenceOperation.cancelled = true;
    this.releaseRecordingTarget();
    this.releaseRecordingTarget(this._evidenceOperation?.target);
    // A component may unmount without destroying its renderer. Retire a pending
    // acquisition now; startRecording stops any tracks that arrive afterwards.
    if (this._recordingStartAttempt) {
      this._cancelledRecordingAttempt = this._recordingStartAttempt;
      this.releaseLocalInference();
    }
    if (this.mediaRecorder?.state === "recording") {
      this.cancelRecording();
    }
    this.cleanupSilenceDetection();
    this.onStateChange = null;
    this.onError = null;
    this.onTranscriptionComplete = null;
    if (this._onApiKeyChanged) {
      window.removeEventListener("api-key-changed", this._onApiKeyChanged);
    }
  }
}

export default AudioManager;
