import type { JsonValue } from "../../models/canonical.js";

export const cursorTranscriptRecordKinds = [
  "user_message",
  "assistant_message",
  "tool_use_stub",
  "tool_result_stub",
  "event"
] as const;

export type CursorTranscriptRecordKind = (typeof cursorTranscriptRecordKinds)[number];

export type CursorTranscriptProvenance = {
  lineNumber: number;
  sourceHash: string;
  sourcePath: string;
};

export type CursorToolUseStub = {
  callId: string | null;
  inputText: string | null;
  name: string | null;
  status: string | null;
};

export type CursorTranscriptRecord = {
  commandStrings: string[];
  contentRedacted: boolean;
  filePaths: string[];
  kind: CursorTranscriptRecordKind;
  messageText: string | null;
  provenance: CursorTranscriptProvenance;
  rawEvent: JsonValue;
  rawType: string | null;
  timestampHint: string | null;
  toolUse: CursorToolUseStub | null;
};

export type ParseCursorTranscriptOptions = {
  sourceHash: string;
  sourcePath: string;
};

export type ParseCursorTranscriptResult = {
  records: CursorTranscriptRecord[];
};

export type CursorStateDbEnrichment = {
  activeComposerIds: string[];
  conversationIds: string[];
  matchedKeys: string[];
  workspaceIds: string[];
  workspacePaths: string[];
};

export type CursorTrackingDbEnrichment = {
  activeComposerIds: string[];
  matchedKeys: string[];
  requestIds: string[];
  sessionIds: string[];
  workspaceIds: string[];
  workspacePaths: string[];
  workspaceStorageIds: string[];
};
