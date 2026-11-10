import { TFunction } from "i18next";

// The cloud-only codes (AUTH_EXPIRED, OFFLINE, LIMIT_REACHED) came from the
// removed OpenWhispr service; every remaining error carries its own title.
export function getRecordingErrorTitle(
  error: { code?: string; title: string },
  _t?: TFunction
): string {
  return error.title;
}
