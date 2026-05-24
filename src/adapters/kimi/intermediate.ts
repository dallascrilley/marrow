import type {
	ParseTranscriptOptions,
	ParseTranscriptResult,
	TranscriptDiscovery,
	TranscriptRecord,
	WorkspaceMapping,
} from "../_common/intermediate.js";

/**
 * Kimi (Kimi Code CLI) adapter types alias the shared `_common` shapes;
 * the parser produces structurally identical records to every other adapter
 * so the pipeline can stay adapter-agnostic.
 */
export type KimiTranscriptRecord = TranscriptRecord;
export type ParseKimiTranscriptOptions = ParseTranscriptOptions;
export type ParseKimiTranscriptResult = ParseTranscriptResult;

export type KimiWorkspaceMapping = WorkspaceMapping;

export type KimiTranscriptFormat = "jsonl";

export type KimiTranscriptDiscovery = KimiWorkspaceMapping &
	TranscriptDiscovery;

export type KimiDiscoveryResult = {
	transcripts: readonly KimiTranscriptDiscovery[];
};
