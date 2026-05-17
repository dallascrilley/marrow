import type { DatabaseSync } from "node:sqlite";
import { basename, extname } from "node:path";

import { discoverCursorInputs } from "../adapters/cursor/discover.js";
import { upsertSourceSession, type UpsertSourceSessionResult } from "../db/ledger.js";
import type { SourceSession } from "../models/canonical.js";

export type SupportedSource = "cursor";

export type DiscoverPhaseInput = {
  database: DatabaseSync;
  limit?: number;
  onlyNewOrChanged?: boolean;
  since?: string;
  source: SupportedSource;
};

export type DiscoveredSourceSession = {
  discovery: Awaited<ReturnType<typeof discoverCursorInputs>>["transcripts"][number];
  ledger: UpsertSourceSessionResult;
};

export type DiscoverPhaseResult = {
  discoveredCount: number;
  selectedCount: number;
  sessions: DiscoveredSourceSession[];
  source: SupportedSource;
};

export async function runDiscoverPhase(input: DiscoverPhaseInput): Promise<DiscoverPhaseResult> {
  if (input.source !== "cursor") {
    throw new Error(`Unsupported source: ${input.source}`);
  }

  const discovery = await discoverCursorInputs();
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
    const sourceSession = toSourceSession(transcript);
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

function toSourceSession(
  transcript: Awaited<ReturnType<typeof discoverCursorInputs>>["transcripts"][number]
): SourceSession {
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
    source_tool: "cursor",
    started_at: transcript.modifiedAt,
    updated_at: transcript.modifiedAt,
    workspace_path: transcript.workspacePath ?? transcript.workspaceSlug
  };
}
