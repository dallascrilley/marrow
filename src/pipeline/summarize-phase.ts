import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

import {
  getPhaseCheckpoint,
  insertRunHistory,
  transitionPhase,
  upsertReviewQueueEntry,
} from "../db/ledger.js";
import type { SourceSessionRow } from "../db/queries.js";
import type { Event, Turn } from "../models/canonical.js";
import { summarySchema } from "../models/canonical.js";
import {
  getSessionSummaryDirectoryPath,
  getSessionSummaryJsonPath,
  getSessionSummaryMarkdownPath,
  writeSessionSummary,
} from "../writers/summary-writer.js";
import { extractLearnings } from "./extract.js";
import { type LlmTopicGenerator, summarizeSessionWithOptionalLlmTopic } from "./summarize.js";

export async function runSummarizePhase(
  database: DatabaseSync,
  sourceSession: SourceSessionRow,
  turns: readonly Turn[],
  events: readonly Event[],
  resume: boolean,
  llmTopic = false,
  force = false,
  generateTopic?: LlmTopicGenerator,
) {
  const checkpoint = getPhaseCheckpoint(database, sourceSession.id, "summarized");

  if (
    !force &&
    resume &&
    checkpoint?.phase_state === "completed" &&
    checkpoint.source_hash === sourceSession.source_hash
  ) {
    const summaryPath = getSessionSummaryJsonPath(sourceSession.session_id);
    const summary = summarySchema.parse(JSON.parse(await readFile(summaryPath, "utf8")));
    return {
      markdownPath: getSessionSummaryMarkdownPath(sourceSession.session_id),
      sessionDirectoryPath: getSessionSummaryDirectoryPath(sourceSession.session_id),
      summary,
      summaryPath,
    };
  }

  const reducedLearnings = extractLearnings({
    events,
    sourceSession: toSourceSessionModel(sourceSession),
    turns,
  });
  const summary = await summarizeSessionWithOptionalLlmTopic(
    {
      events,
      projectLearnings: reducedLearnings.project,
      sourceSession: toSourceSessionModel(sourceSession),
      turns,
      userLearnings: reducedLearnings.user,
    },
    {
      ...(generateTopic === undefined ? { llmTopic } : { generateTopic, llmTopic }),
    },
  );
  const summaryResult = await writeSessionSummary(summary);

  upsertReviewQueueEntry(database, {
    currentLifecycleState: "summarized",
    projectKey: sourceSession.project_key,
    queueState: "pending",
    reason: "Summary and reduced artifacts are ready for review.",
    reviewKind: "summary",
    sessionId: sourceSession.session_id,
    sourceHash: sourceSession.source_hash,
    sourceSessionId: sourceSession.id,
  });
  const detailsJson = JSON.stringify({
    summary_json_path: summaryResult.summaryPath,
    summary_markdown_path: summaryResult.markdownPath,
  });
  const run = insertRunHistory(database, {
    detailsJson,
    finishedAt: new Date().toISOString(),
    phaseName: "summarized",
    phaseState: "completed",
    sessionId: sourceSession.session_id,
    sourceHash: sourceSession.source_hash,
    sourceSessionId: sourceSession.id,
  });
  transitionPhase(database, {
    detailsJson,
    phaseName: "summarized",
    phaseState: "completed",
    runId: run.id,
    sourceHash: sourceSession.source_hash,
    sourceSessionId: sourceSession.id,
  });

  return summaryResult;
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
    workspace_path: sourceSession.workspace_path,
  };
}
