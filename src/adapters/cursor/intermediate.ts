import {
  type ParseTranscriptOptions,
  type ParseTranscriptResult,
  type ToolUseStub,
  type TranscriptProvenance,
  type TranscriptRecord,
  type TranscriptRecordKind,
  transcriptRecordKinds,
} from "../_common/intermediate.js";

/**
 * Cursor adapter types alias the shared `_common` shapes; the parser produces
 * structurally identical records to every other adapter so the pipeline can
 * stay adapter-agnostic.
 */
export const cursorTranscriptRecordKinds = transcriptRecordKinds;
export type CursorTranscriptRecordKind = TranscriptRecordKind;
export type CursorTranscriptProvenance = TranscriptProvenance;
export type CursorToolUseStub = ToolUseStub;
export type CursorTranscriptRecord = TranscriptRecord;
export type ParseCursorTranscriptOptions = ParseTranscriptOptions;
export type ParseCursorTranscriptResult = ParseTranscriptResult;

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
