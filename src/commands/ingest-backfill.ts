import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import {
  getPhaseCheckpoint,
  insertRunHistory,
  transitionPhase,
  upsertReviewQueueEntry
} from "../db/ledger.js";
import type { SourceSessionRow } from "../db/queries.js";
import { extractLearnings } from "../pipeline/extract.js";
import { runArchivePhase } from "../pipeline/archive.js";
import { runDiscoverPhase, type DiscoveredSourceSession } from "../pipeline/discover.js";
import { runParsePhase } from "../pipeline/parse.js";
import { runReducePhase } from "../pipeline/reduce.js";
import { summarizeSession } from "../pipeline/summarize.js";
import { writeKnowledgeArtifacts } from "../writers/knowledge-writer.js";
import { writeSessionSummary } from "../writers/summary-writer.js";

export async function executeIngestBackfill(context: CommandContext, database: DatabaseSync): Promise<number> {
  const options = parseIngestOptions(context.args);
  const discovery = await runDiscoverPhase({
    database,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.since === undefined ? {} : { since: options.since }),
    source: options.source
  });
  const sessions = await processDiscoveredSessions(database, discovery.sessions, options.resume);

  context.output.info(
    JSON.stringify(
      {
        discovered_count: discovery.discoveredCount,
        processed_count: discovery.sessions.length,
        resumed: options.resume,
        sessions,
        source: options.source
      },
      null,
      2
    )
  );

  return 0;
}

export async function processDiscoveredSessions(
  database: DatabaseSync,
  entries: readonly DiscoveredSourceSession[],
  resume: boolean
): Promise<Array<Record<string, unknown>>> {
  const sessions: Array<Record<string, unknown>> = [];

  for (const entry of entries) {
    const sourceSession = entry.ledger.sourceSession;
    const parsed = await runParsePhase({
      database,
      resume,
      sourceSession
    });
    const reduced = await runReducePhase({
      database,
      parsedRecords: parsed.records,
      resume,
      sourceSession
    });
    const summary = await runSummarizePhase(database, sourceSession, reduced.turns, reduced.events, resume);
    const extracted = await runExtractPhase(database, sourceSession, reduced.turns, reduced.events, resume);
    const archived = await runArchivePhase({
      database,
      events: reduced.events,
      knowledge: extracted,
      sourceSession,
      sourceSessionId: sourceSession.id,
      summary,
      turns: reduced.turns
    });

    sessions.push({
      archived,
      parsed: parsed.recordCount,
      project_key: sourceSession.project_key,
      session_id: sourceSession.session_id,
      source_changed: entry.ledger.sourceChanged,
      summary_path: summary.summaryPath,
      turns: reduced.turns.length
    });
  }

  return sessions;
}

export function parseIngestOptions(args: string[]): {
  limit?: number;
  resume: boolean;
  since?: string;
  source: "cursor" | "claude-code";
} {
  let limit: number | undefined;
  let resume = false;
  let since: string | undefined;
  let source: "cursor" | "claude-code" = "cursor";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--resume") {
      resume = true;
      continue;
    }

    if (arg === "--source") {
      const value = args[index + 1];
      if (value !== "cursor" && value !== "claude-code") {
        throw new Error(`Unsupported --source value: ${value ?? "<missing>"}`);
      }
      source = value;
      index += 1;
      continue;
    }

    if (arg === "--since") {
      since = requireOptionValue("--since", args[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--limit") {
      const parsedLimit = Number.parseInt(requireOptionValue("--limit", args[index + 1]), 10);
      if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
        throw new Error(`Invalid --limit value: ${args[index + 1] ?? "<missing>"}`);
      }
      limit = parsedLimit;
      index += 1;
      continue;
    }

    throw new Error(`Unknown ingest option: ${arg}`);
  }

  return {
    ...(limit === undefined ? {} : { limit }),
    resume,
    ...(since === undefined ? {} : { since }),
    source
  };
}

export async function runSummarizePhase(
  database: DatabaseSync,
  sourceSession: SourceSessionRow,
  turns: Parameters<typeof summarizeSession>[0]["turns"],
  events: Parameters<typeof summarizeSession>[0]["events"],
  resume: boolean
) {
  const checkpoint = getPhaseCheckpoint(database, sourceSession.id, "summarized");
  const reducedLearnings = extractLearnings({
    events,
    sourceSession: toSourceSessionModel(sourceSession),
    turns
  });
  const summary = summarizeSession({
    events,
    projectLearnings: reducedLearnings.project,
    sourceSession: toSourceSessionModel(sourceSession),
    turns,
    userLearnings: reducedLearnings.user
  });
  const summaryResult = await writeSessionSummary(summary);

  if (
    resume &&
    checkpoint?.phase_state === "completed" &&
    checkpoint.source_hash === sourceSession.source_hash
  ) {
    return summaryResult;
  }

  upsertReviewQueueEntry(database, {
    currentLifecycleState: "summarized",
    projectKey: sourceSession.project_key,
    queueState: "pending",
    reason: "Summary and reduced artifacts are ready for review.",
    reviewKind: "summary",
    sessionId: sourceSession.session_id,
    sourceHash: sourceSession.source_hash,
    sourceSessionId: sourceSession.id
  });
  const detailsJson = JSON.stringify({
    summary_json_path: summaryResult.summaryPath,
    summary_markdown_path: summaryResult.markdownPath
  });
  const run = insertRunHistory(database, {
    detailsJson,
    finishedAt: new Date().toISOString(),
    phaseName: "summarized",
    phaseState: "completed",
    sessionId: sourceSession.session_id,
    sourceHash: sourceSession.source_hash,
    sourceSessionId: sourceSession.id
  });
  transitionPhase(database, {
    detailsJson,
    phaseName: "summarized",
    phaseState: "completed",
    runId: run.id,
    sourceHash: sourceSession.source_hash,
    sourceSessionId: sourceSession.id
  });

  return summaryResult;
}

export async function runExtractPhase(
  database: DatabaseSync,
  sourceSession: SourceSessionRow,
  turns: readonly import("../models/canonical.js").Turn[],
  events: readonly import("../models/canonical.js").Event[],
  resume: boolean
) {
  const checkpoint = getPhaseCheckpoint(database, sourceSession.id, "extracted");
  const learnings = extractLearnings({
    events,
    sourceSession: toSourceSessionModel(sourceSession),
    turns
  });
  const knowledge = await writeKnowledgeArtifacts({
    projectLearnings: learnings.project,
    sessionId: sourceSession.session_id,
    userLearnings: learnings.user
  });

  if (
    resume &&
    checkpoint?.phase_state === "completed" &&
    checkpoint.source_hash === sourceSession.source_hash
  ) {
    return knowledge;
  }

  const detailsJson = JSON.stringify({
    project_knowledge_path: knowledge.project.path,
    project_learning_count: knowledge.project.count,
    user_knowledge_path: knowledge.user.path,
    user_learning_count: knowledge.user.count
  });
  const run = insertRunHistory(database, {
    detailsJson,
    finishedAt: new Date().toISOString(),
    phaseName: "extracted",
    phaseState: "completed",
    sessionId: sourceSession.session_id,
    sourceHash: sourceSession.source_hash,
    sourceSessionId: sourceSession.id
  });
  transitionPhase(database, {
    detailsJson,
    phaseName: "extracted",
    phaseState: "completed",
    runId: run.id,
    sourceHash: sourceSession.source_hash,
    sourceSessionId: sourceSession.id
  });

  return knowledge;
}

function requireOptionValue(flag: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}

function toSourceSessionModel(sourceSession: SourceSessionRow) {
  return {
    conversation_id: sourceSession.conversation_id,
    ingest_status: sourceSession.ingest_status,
    project_key: sourceSession.project_key,
    retention_status: sourceSession.retention_status,
    session_id: sourceSession.session_id,
    source_format: sourceSession.source_format,
    source_hash: sourceSession.source_hash,
    source_path: sourceSession.source_path,
    source_tool: sourceSession.source_tool,
    started_at: sourceSession.started_at,
    updated_at: sourceSession.updated_at,
    workspace_path: sourceSession.workspace_path
  };
}
