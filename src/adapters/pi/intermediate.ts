import type {
  ParseTranscriptOptions,
  ParseTranscriptResult,
  TranscriptRecord,
  WorkspaceMapping
} from "../_common/intermediate.js";

/**
 * Pi (Zosma) adapter types alias the shared `_common` shapes; the parser
 * produces structurally identical records to every other adapter so the
 * pipeline can stay adapter-agnostic.
 */
export type PiTranscriptRecord = TranscriptRecord;
export type ParsePiTranscriptOptions = ParseTranscriptOptions;

/**
 * The Pi parser additionally surfaces a `sessionMeta` sidecar lifted from
 * the `session` line at the top of every session file. The workspace mapper
 * relies on it.
 */
export type PiSessionMeta = {
  cwd: string | null;
  id: string | null;
  timestamp: string | null;
  version: number | null;
};

export type ParsePiTranscriptResult = ParseTranscriptResult & {
  sessionMeta: PiSessionMeta | null;
};

export type PiWorkspaceMapping = WorkspaceMapping & {
  piSessionPath: string;
};

export type PiTranscriptFormat = "jsonl";

export type PiTranscriptDiscovery = PiWorkspaceMapping & {
  modifiedAt: string;
  sizeBytes: number;
  sourceFormat: PiTranscriptFormat;
  sourceHash: string;
  sourcePath: string;
};

export type PiDiscoveryResult = {
  transcripts: readonly PiTranscriptDiscovery[];
};
