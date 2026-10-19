import type { Meeting } from "../../types/meeting";
export const editable = (meeting: Meeting) => ({
  title: meeting.title,
  notes: meeting.notes,
  transcript: meeting.transcript,
  speakers: meeting.speakers,
});
export function changedFields(before: Meeting, after: Meeting): Partial<Meeting> {
  return Object.fromEntries(
    Object.entries(editable(after)).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(editable(before)[key])
    )
  );
}
/** Carry only edits made while a save was in flight over the server response. */
export function rebaseDraft(saved: Meeting, submitted: Meeting, current: Meeting): Meeting {
  return { ...saved, ...changedFields(submitted, current) };
}
