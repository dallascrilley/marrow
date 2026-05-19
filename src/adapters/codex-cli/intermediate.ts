import type {
  ParseTranscriptOptions,
  ParseTranscriptResult,
  TranscriptRecord,
  WorkspaceMapping
} from "../_common/intermediate.js";

/**
 * Codex CLI adapter types alias the shared `_common` shapes; the parser
 * produces structurally identical records to every other adapter so the
 * pipeline can stay adapter-agnostic.
 */
export type CodexCliTranscriptRecord = TranscriptRecord;
export type ParseCodexCliTranscriptOptions = ParseTranscriptOptions;

/**
 * The Codex CLI parser additionally surfaces a `sessionMeta` sidecar lifted
 * from the session_meta line at the top of every rollout file. Callers that
 * just want the record stream can ignore it; the workspace mapper relies on
 * it.
 */
export type CodexCliSessionMeta = {
  cliVersion: string | null;
  cwd: string | null;
  id: string | null;
  originator: string | null;
  parentThreadId: string | null;
  agentNickname: string | null;
  agentRole: string | null;
  subagentDepth: number | null;
  timestamp: string | null;
};

export type ParseCodexCliTranscriptResult = ParseTranscriptResult & {
  sessionMeta: CodexCliSessionMeta | null;
};

/**
 * Codex CLI stores transcripts in a date-partitioned tree plus a flat
 * archive. The "rollout path" alias is the absolute path to the JSONL file;
 * useful for diagnostics. The "rollout tree root" identifies which root the
 * file was discovered under.
 */
export type CodexCliRolloutTreeRoot = "sessions" | "archived_sessions";

export type CodexCliWorkspaceMapping = WorkspaceMapping & {
  rolloutPath: string;
  rolloutTreeRoot: CodexCliRolloutTreeRoot;
};

export type CodexCliTranscriptFormat = "jsonl";

export type CodexCliTranscriptDiscovery = CodexCliWorkspaceMapping & {
  modifiedAt: string;
  sizeBytes: number;
  sourceFormat: CodexCliTranscriptFormat;
  sourceHash: string;
  sourcePath: string;
};

export type CodexCliDiscoveryResult = {
  transcripts: readonly CodexCliTranscriptDiscovery[];
};
