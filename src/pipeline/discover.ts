import { basename, extname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { TranscriptDiscovery } from "../adapters/_common/intermediate.js";
import { discoverClaudeCodeInputs } from "../adapters/claude-code/discover.js";
import { discoverCodexCliInputs } from "../adapters/codex-cli/discover.js";
import { discoverCursorInputs } from "../adapters/cursor/discover.js";
import { discoverKimiInputs } from "../adapters/kimi/discover.js";
import { discoverPiInputs } from "../adapters/pi/discover.js";
import { type UpsertSourceSessionResult, upsertSourceSession } from "../db/ledger.js";
import type { SourceSession } from "../models/canonical.js";
import { resolveProjectId } from "../v2/project/resolve.js";

export const supportedSources = ["cursor", "claude-code", "codex-cli", "kimi", "pi"] as const;
export type SupportedSource = (typeof supportedSources)[number];

export type DiscoverPhaseInput = {
  database: DatabaseSync;
  excludePaths?: readonly string[];
  excludeProjectKeys?: readonly string[];
  includeTestSessions?: boolean;
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
  const discovery = await runAdapterDiscovery(input);
  const sinceTimestamp = input.since ? Date.parse(input.since) : Number.NEGATIVE_INFINITY;

  if (Number.isNaN(sinceTimestamp)) {
    throw new Error(`Invalid --since value: ${input.since}`);
  }

  const transcripts = discovery.transcripts
    .filter((entry) => Date.parse(entry.modifiedAt) >= sinceTimestamp)
    .filter((entry) => !shouldExcludeTranscript(entry, input))
    .sort((left, right) => {
      const byTime = Date.parse(left.modifiedAt) - Date.parse(right.modifiedAt);
      return byTime !== 0 ? byTime : left.sourcePath.localeCompare(right.sourcePath);
    });

  const selected: DiscoveredSourceSession[] = [];

  for (const transcript of transcripts) {
    const projectKey = await resolveProjectKeyForTranscript(transcript);
    const sourceSession = toSourceSession(transcript, input.source, projectKey);
    const ledger = upsertSourceSession(input.database, sourceSession);

    if (
      input.onlyNewOrChanged &&
      !ledger.sourceChanged &&
      ledger.sourceSession.content_revision > 1
    ) {
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
      ledger,
    });

    if (input.limit !== undefined && selected.length >= input.limit) {
      break;
    }
  }

  return {
    discoveredCount: transcripts.length,
    selectedCount: selected.length,
    sessions: selected,
    source: input.source,
  };
}

async function resolveProjectKeyForTranscript(transcript: TranscriptDiscovery): Promise<string> {
  const resolved = await resolveProjectId({
    workspacePath: transcript.workspacePath,
    sessionRoot: transcript.workspacePath ?? transcript.workspaceSlug,
  });
  return resolved.id;
}

function toSourceSession(
  transcript: TranscriptDiscovery,
  source: SupportedSource,
  projectKey: string,
): SourceSession {
  const sessionId =
    transcript.sessionId ?? basename(transcript.sourcePath, extname(transcript.sourcePath));

  return {
    conversation_id: `${projectKey}:${sessionId}`,
    ingest_status: "discovered",
    project_key: projectKey,
    retention_status: "kept",
    session_id: sessionId,
    source_format: transcript.sourceFormat,
    source_hash: transcript.sourceHash,
    source_path: transcript.sourcePath,
    source_tool: source,
    started_at: transcript.modifiedAt,
    updated_at: transcript.modifiedAt,
    workspace_path: transcript.workspacePath ?? transcript.workspaceSlug,
  };
}

function shouldExcludeTranscript(entry: TranscriptDiscovery, input: DiscoverPhaseInput): boolean {
  const excludePaths = input.excludePaths ?? [];
  for (const fragment of excludePaths) {
    if (fragment.length > 0 && entry.sourcePath.includes(fragment)) {
      return true;
    }
  }

  const excludeProjects = input.excludeProjectKeys ?? [];
  return excludeProjects.includes(entry.projectKey);
}

async function runAdapterDiscovery(
  input: DiscoverPhaseInput,
): Promise<{ transcripts: readonly TranscriptDiscovery[] }> {
  const source = input.source;
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
    case "kimi": {
      const result = await discoverKimiInputs();
      return { transcripts: result.transcripts };
    }
    case "pi": {
      const result = await discoverPiInputs({
        includeTestSessions: input.includeTestSessions === true,
      });
      return { transcripts: result.transcripts };
    }
    default: {
      // Exhaustiveness check
      const _exhaustive: never = source;
      throw new Error(`Unsupported source: ${String(_exhaustive)}`);
    }
  }
}
