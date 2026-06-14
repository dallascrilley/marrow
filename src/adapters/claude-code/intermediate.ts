import type {
  ParseTranscriptOptions,
  ParseTranscriptResult,
  TranscriptRecord,
  WorkspaceMapping,
} from "../_common/intermediate.js";

/**
 * Claude Code adapter types alias the shared `_common` shapes; the parser
 * produces structurally identical records to every other adapter so the
 * pipeline can stay adapter-agnostic.
 */
export type ClaudeCodeTranscriptRecord = TranscriptRecord;
export type ParseClaudeCodeTranscriptOptions = ParseTranscriptOptions;
export type ParseClaudeCodeTranscriptResult = ParseTranscriptResult;

/**
 * Claude Code stores transcripts under a per-workspace directory. The
 * "project path" alias is the absolute directory containing the session
 * `.jsonl` files; useful for diagnostics.
 */
export type ClaudeCodeWorkspaceMapping = WorkspaceMapping & {
  claudeCodeProjectPath: string;
};

export type ClaudeCodeTranscriptFormat = "jsonl";

export type ClaudeCodeTranscriptDiscovery = ClaudeCodeWorkspaceMapping & {
  modifiedAt: string;
  sizeBytes: number;
  sourceFormat: ClaudeCodeTranscriptFormat;
  sourceHash: string;
  sourcePath: string;
};

export type ClaudeCodeDiscoveryResult = {
  transcripts: readonly ClaudeCodeTranscriptDiscovery[];
};
