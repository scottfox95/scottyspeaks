/** Which destination-card state to show, or null for the idle button. */
export function overlayStateFor({ isRecording, isProcessing, pipelineStage, outcome }) {
  if (isRecording) return "listening";
  if (isProcessing) return pipelineStage === "refining" ? "polishing" : "transcribing";
  return outcome?.kind || null;
}

export const formatElapsed = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
