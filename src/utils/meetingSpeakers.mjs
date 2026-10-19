// Display labels never replace raw speaker keys or merge speakers across audio chunks.
export function describeSpeakers(meeting) {
  const entries = new Map();
  let number = 0;
  for (const segment of meeting.segments || []) {
    const id = segment.speaker;
    if (!entries.has(id)) {
      const kind =
        id === "microphone"
          ? "microphone"
          : id === "system" || id === "combined"
            ? "system"
            : !id || id === "audio"
              ? "unknown"
              : /^(?:(?:part|chunk)(?:-[^:]*)?:|\d+$)/.test(id)
                ? "numbered"
                : "named";
      entries.set(id, { id, kind, number: kind === "numbered" ? ++number : null, sample: segment });
    } else {
      const entry = entries.get(id);
      // Prefer a useful short utterance over an initial acknowledgment.
      if (
        entry.sample.text.trim().length < 40 &&
        segment.text.trim().length > entry.sample.text.trim().length
      )
        entry.sample = segment;
    }
  }
  return [...entries.values()];
}

export function speakerLabels(meeting, translate = null) {
  const t =
    translate ||
    ((key, values) =>
      ({
        "meetings.microphoneSource": "Microphone",
        "meetings.callAudio": "Call audio",
        "meetings.unknownSpeaker": "Speaker",
        "meetings.speakerLabel": `Speaker ${values?.id}`,
      })[key]);
  return new Map(
    describeSpeakers(meeting).map((entry) => [
      entry.id,
      meeting.speakers?.[entry.id]?.trim() ||
        (entry.kind === "microphone"
          ? t("meetings.microphoneSource")
          : entry.kind === "system"
            ? t("meetings.callAudio")
            : entry.kind === "unknown"
              ? t("meetings.unknownSpeaker")
              : entry.kind === "named"
                ? entry.id
                : t("meetings.speakerLabel", { id: entry.number })),
    ])
  );
}
