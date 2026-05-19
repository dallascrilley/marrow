import type { DatabaseSync } from "node:sqlite";
import { basename, extname } from "node:path";

import { discoverClaudeCodeInputs } from "../adapters/claude-code/discover.js";
import { discoverCodexCliInputs } from "../adapters/codex-cli/discover.js";
import { discoverCursorInputs } from "../adapters/cursor/discover.js";
import type { TranscriptDiscovery } from "../adapters/_common/intermediate.js";
import { upsertSourceSession, type UpsertSourceSessionResult } from "../db/ledger.js";
import type { SourceSession } from "../models/canonical.js";

export const supportedSources = ["cursor", "claude-code", "codex-cli"] as const;
export type SupportedSource = (typeof supportedSources)[number];

export type DiscoverPhaseInput = {
  database: DatabaseSync;
  limit?: number;
  onlyNewOrChanged?: boolean;
  since?: string;
  source: SupportedSource;
};

export type DiscoveredSourceSession = {
  discovery: TranscriptDiscovery;
  ledger: UpsertSourceSessionResult;
};

export type DiscoverPhaseResult = {
  discoveredCount: number;
  selectedCount: number;
  sessions: DiscoveredSourceSession[];
  source: SupportedSource;
};

export async function runDiscoverPhase(input: DiscoverPhaseInput): Promise<DiscoverPhaseResult> {
  const discovery = await runAdapterDiscovery(input.source);
  const sinceTimestamp = input.since ? Date.parse(input.since) : Number.NEGATIVE_INFINITY;

  if (Number.isNaN(sinceTimestamp)) {
    throw new Error(`Invalid --since value: ${input.since}`);
  }

  const transcripts = discovery.transcripts
    .filter((entry) => Date.parse(entry.modifiedAt) >= sinceTimestamp)
    .sort((left, right) => {
      const byTime = Date.parse(left.modifiedAt) - Date.parse(right.modifiedAt);
      return byTime !== 0 ? byTime : left.sourcePath.localeCompare(right.sourcePath);
    });

  const selected: DiscoveredSourceSession[] = [];

  for (const transcript of transcripts) {
    const sourceSession = toSourceSession(transcript, input.source);
    const ledger = upsertSourceSession(input.database, sourceSession);

    if (input.onlyNewOrChanged && !ledger.sourceChanged && ledger.sourceSession.content_revision > 1) {
      continue;
    }

    if (
      input.onlyNewOrChanged &&
      !ledger.sourceChanged &&
      ledger.sourceSession.content_revision === 1 &&
      ledger.sourceSession.current_lifecycle_state !== "discovered"
    ) {
      continue;
    }

    selected.push({
      discovery: transcript,
      ledger
    });

    if (input.limit !== undefined && selected.length >= input.limit) {
      break;
    }
  }

  return {
    discoveredCount: transcripts.length,
    selectedCount: selected.length,
    sessions: selected,
    source: input.source
  };
}

function toSourceSession(transcript: TranscriptDiscovery, source: SupportedSource): SourceSession {
  const sessionId = basename(transcript.sourcePath, extname(transcript.sourcePath));

  return {
    conversation_id: `${transcript.projectKey}:${sessionId}`,
    ingest_status: "discovered",
    project_key: transcript.projectKey,
    retention_status: "kept",
    session_id: sessionId,
    source_format: transcript.sourceFormat,
    source_hash: transcript.sourceHash,
    source_path: transcript.sourcePath,
    source_tool: source,
    started_at: transcript.modifiedAt,
    updated_at: transcript.modifiedAt,
    workspace_path: transcript.workspacePath ?? transcript.workspaceSlug
  };
}

async function runAdapterDiscovery(source: SupportedSource): Promise<{ transcripts: readonly TranscriptDiscovery[] }> {
  switch (source) {
    case "cursor": {
      const result = await discoverCursorInputs();
      return { transcripts: result.transcripts };
    }
    case "claude-code": {
      const result = await discoverClaudeCodeInputs();
      return { transcripts: result.transcripts };
    }
    case "codex-cli": {
      const result = await discoverCodexCliInputs();
      return { transcripts: result.transcripts };
    }
    default: {
      // Exhaustiveness check
      const _exhaustive: never = source;
      throw new Error(`Unsupported source: ${String(_exhaustive)}`);
    }
  }
}
