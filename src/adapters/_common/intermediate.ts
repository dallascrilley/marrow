import type { JsonValue } from "../../models/canonical.js";

/**
 * Discriminator for transcript records flowing through the pipeline. Every
 * adapter classifies its source-specific record types into one of these
 * kinds; the pipeline (`parse`, `reduce`, `summarize`, `extract`) only
 * branches on this discriminator.
 */
export const transcriptRecordKinds = [
  "user_message",
  "assistant_message",
  "tool_use_stub",
  "tool_result_stub",
  "event"
] as const;

export type TranscriptRecordKind = (typeof transcriptRecordKinds)[number];

export type TranscriptProvenance = {
  lineNumber: number;
  sourceHash: string;
  sourcePath: string;
};

export type ToolUseStub = {
  callId: string | null;
  inputText: string | null;
  name: string | null;
  status: string | null;
};

/**
 * Canonical per-line record produced by every transcript parser. Structurally
 * shared across adapters so the pipeline can stay adapter-agnostic.
 */
export type TranscriptRecord = {
  commandStrings: string[];
  contentRedacted: boolean;
  filePaths: string[];
  kind: TranscriptRecordKind;
  messageText: string | null;
  provenance: TranscriptProvenance;
  rawEvent: JsonValue;
  rawType: string | null;
  timestampHint: string | null;
  toolUse: ToolUseStub | null;
};

export type ParseTranscriptOptions = {
  sourceHash: string;
  sourcePath: string;
};

export type ParseTranscriptResult = {
  records: TranscriptRecord[];
};

/** Shared workspace-mapping shape. Per-adapter mappings may extend this. */
export type WorkspaceMapping = {
  projectKey: string;
  workspacePath: string | null;
  workspaceSlug: string;
};

/** Shared transcript-discovery shape. Per-adapter discoveries may extend this. */
export type TranscriptDiscovery = WorkspaceMapping & {
  modifiedAt: string;
  sizeBytes: number;
  sourceFormat: string;
  sourceHash: string;
  sourcePath: string;
};
