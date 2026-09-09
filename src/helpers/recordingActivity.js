// The lease spans pending microphone acquisition as well as live tracks. A late
// getUserMedia result must be stopped before main is told recording has ended.
export async function openRecordingMicrophone(
  constraints,
  kind = "dictation",
  cancelled = () => false
) {
  const api = window.electronAPI.speech;
  const token = await api.beginRecording(kind);
  let stream,
    released = false;
  const release = async () => {
    if (released) return;
    if (stream) stream.getTracks().forEach((track) => track.stop());
    released = true;
    await api.endRecording(token);
  };
  try {
    if (cancelled()) throw new Error("recording-cancelled");
    document.querySelectorAll("audio, video").forEach((media) => media.pause());
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (cancelled()) throw new Error("recording-cancelled");
    return { stream, release };
  } catch (error) {
    await release();
    throw error;
  }
}
