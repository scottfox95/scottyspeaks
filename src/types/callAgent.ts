import type { MeetingResult } from "./meeting";
export interface AgentDraft {
  id: string;
  callId: string;
  title: string;
  body: string;
  createdAt: string;
  sourceVersion: string;
  citations: {
    evidenceId: string;
    kind: string;
    start: number | null;
    end: number | null;
    speaker: string;
    quote: string;
  }[];
}
export interface CallAgentState {
  ready: boolean;
  lastConnectedAt: string | null;
  shared: boolean;
  drafts: Pick<AgentDraft, "id" | "title" | "createdAt">[];
  configuration: { json: string; codex: string; claude: string };
}
export interface CallAgentAPI {
  state(args: { callId: string }): Promise<MeetingResult<CallAgentState>>;
  grant(args: { callId: string }): Promise<MeetingResult<CallAgentState>>;
  revoke(args: { callId: string }): Promise<MeetingResult<CallAgentState>>;
  handoff(args: { callId: string }): Promise<MeetingResult<string>>;
  getDraft(args: { draftId: string }): Promise<MeetingResult<AgentDraft>>;
  deleteDraft(args: { draftId: string }): Promise<MeetingResult<null>>;
  fileDraft(args: { draftId: string; folderId: string }): Promise<MeetingResult<{ path: string }>>;
}
