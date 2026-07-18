import { access, readFile } from "node:fs/promises";

import type { DatabaseSync } from "node:sqlite";
import { listSourceSessions } from "../db/ledger.js";
import type { SourceSessionRow } from "../db/queries.js";
import { summarySchema } from "../models/canonical.js";
import { preflightStagingReadRoot } from "../storage/staging.js";
import {
  getSessionManifestPath,
  getSessionManifestPathForRevision,
} from "../writers/manifest-writer.js";
import { getSessionSummaryJsonPath } from "../writers/summary-writer.js";
import { getProjectLearningCap } from "./extract.js";
import { countProjectLearnings } from "./learning-count.js";
import {
  assessLlmBudget,
  getDefaultMaxPerWindow,
  type LlmBudgetStatus,
  recordLlmBudgetUse,
} from "./llm-budget.js";
import { runParsePhase } from "./parse.js";
import { getReducedArtifactPath, type ReducedArtifact, runReducePhase } from "./reduce.js";
import {
  isHarnessTopicLine,
  isLowSignalTopic,
  type LlmTopicGenerator,
  type LlmUsageSink,
  shouldAttemptLlmTopic,
} from "./summarize.js";
import { runSummarizePhase } from "./summarize-phase.js";

export type ResummarizeSkipReason =
  | "clean_topic"
  | "high_signal_topic"
  | "missing_manifest"
  | "not_over_extracted";

export type ResummarizeSkip = {
  reason: ResummarizeSkipReason;
  session_id: string;
};

export type ResummarizeOptions = {
  dryRun?: boolean;
  exportIndex?: boolean;
  generateTopic?: LlmTopicGenerator;
  limit?: number;
  llmTopic?: boolean;
  leakedTopicOnly?: boolean;
  lowSignalOnly?: boolean;
  maxPer?: string;
  onUsage?: LlmUsageSink;
  overExtractedOnly?: boolean;
  projectKeys?: readonly string[];
  sessionIds?: readonly string[];
};

export type ResummarizeFailure = {
  error: string;
  session_id: string;
};

export type ResummarizeResult = {
  candidate_count: number;
  dry_run: boolean;
  export_path: string | null;
  failed_count: number;
  failures: ResummarizeFailure[];
  processed_count: number;
  sessions: Array<{
    session_id: string;
    summary_path: string;
    topic: string;
    topic_source: string;
  }>;
  skipped: ResummarizeSkip[];
  skipped_count: number;
  would_process_count: number;
  llm_budget: LlmBudgetStatus | null;
  llm_topic_calls: number;
  llm_topic_skipped_for_budget: number;
};

export async function resummarizeSessions(
  database: DatabaseSync,
  options: ResummarizeOptions = {},
): Promise<ResummarizeResult> {
  const candidates = await selectResummarizeCandidates(database, options);
  const failures: ResummarizeFailure[] = [];
  const skipped: ResummarizeSkip[] = [];
  const sessions: ResummarizeResult["sessions"] = [];
  let wouldProcessCount = 0;
  let llmTopicCalls = 0;
  let llmTopicSkippedForBudget = 0;
  const maxPer = options.maxPer ?? getDefaultMaxPerWindow();
  let llmBudget = options.llmTopic === true ? await assessLlmBudget(maxPer) : null;

  const overExtractionCap = options.overExtractedOnly === true ? getProjectLearningCap() : 0;

  for (const sourceSession of candidates) {
    if (options.lowSignalOnly === true || options.leakedTopicOnly === true) {
      const existingTopic = await readExistingTopic(sourceSession.session_id);
      if (options.leakedTopicOnly === true) {
        if (existingTopic === null || !isHarnessTopicLine(existingTopic)) {
          skipped.push({
            reason: "clean_topic",
            session_id: sourceSession.session_id,
          });
          continue;
        }
      } else if (existingTopic === null || !isLowSignalTopic(existingTopic)) {
        skipped.push({
          reason: "high_signal_topic",
          session_id: sourceSession.session_id,
        });
        continue;
      }
    }

    if (options.overExtractedOnly === true) {
      const learningCount = await countProjectLearnings(sourceSession);
      if (learningCount <= overExtractionCap) {
        skipped.push({
          reason: "not_over_extracted",
          session_id: sourceSession.session_id,
        });
        continue;
      }
    }

    if (!(await manifestExists(sourceSession.session_id, sourceSession.source_hash))) {
      skipped.push({
        reason: "missing_manifest",
        session_id: sourceSession.session_id,
      });
      continue;
    }

    wouldProcessCount += 1;

    if (options.dryRun === true) {
      continue;
    }

    try {
      const reduced = await loadOrBuildReduced(database, sourceSession);
      const wantsLlmTopic = shouldAttemptLlmTopic(
        toSourceSessionModel(sourceSession),
        reduced.turns,
        options.llmTopic === true,
      );
      const useLlmTopic = wantsLlmTopic && llmBudget?.allowed !== false;
      if (wantsLlmTopic && !useLlmTopic) {
        llmTopicSkippedForBudget += 1;
      }

      const summaryResult = await runSummarizePhase(
        database,
        sourceSession,
        reduced.turns,
        reduced.events,
        false,
        useLlmTopic,
        true,
        options.generateTopic,
        options.onUsage,
      );
      if (summaryResult.summary.topic_source === "llm") {
        llmTopicCalls += 1;
        llmBudget = await recordLlmBudgetUse(maxPer);
      }
      sessions.push({
        session_id: sourceSession.session_id,
        summary_path: summaryResult.summaryPath,
        topic: summaryResult.summary.topic,
        topic_source: summaryResult.summary.topic_source,
      });
    } catch (error) {
      failures.push({
        session_id: sourceSession.session_id,
        error: error instanceof Error ? error.message : String(error),
      });
      console.warn(
        `[asd] resummarize skipped ${sourceSession.session_id}: ${failures[failures.length - 1]?.error}`,
      );
    }
  }

  return {
    candidate_count: candidates.length,
    dry_run: options.dryRun === true,
    export_path: null,
    failed_count: failures.length,
    failures,
    processed_count: sessions.length,
    sessions,
    skipped,
    skipped_count: skipped.length,
    would_process_count: wouldProcessCount,
    llm_budget: llmBudget,
    llm_topic_calls: llmTopicCalls,
    llm_topic_skipped_for_budget: llmTopicSkippedForBudget,
  };
}

async function selectResummarizeCandidates(
  database: DatabaseSync,
  options: ResummarizeOptions,
): Promise<SourceSessionRow[]> {
  let candidates = listSourceSessions(database).filter((session) =>
    ["archived", "deletion_candidate", "extracted", "summarized"].includes(
      session.current_lifecycle_state,
    ),
  );

  if (options.sessionIds !== undefined && options.sessionIds.length > 0) {
    const wanted = new Set(options.sessionIds);
    candidates = candidates.filter((session) => wanted.has(session.session_id));
  }

  if (options.projectKeys !== undefined && options.projectKeys.length > 0) {
    const wanted = new Set(options.projectKeys);
    candidates = candidates.filter((session) => wanted.has(session.project_key));
  }

  if (options.limit !== undefined) {
    candidates = candidates.slice(0, options.limit);
  }

  return candidates;
}

async function loadOrBuildReduced(
  database: DatabaseSync,
  sourceSession: SourceSessionRow,
): Promise<ReducedArtifact> {
  await preflightStagingReadRoot();
  const artifactPath = getReducedArtifactPath(sourceSession.session_id);
  if (await fileExists(artifactPath)) {
    return JSON.parse(await readFile(artifactPath, "utf8")) as ReducedArtifact;
  }

  const parsed = await runParsePhase({
    database,
    resume: true,
    sourceSession,
  });
  const reduced = await runReducePhase({
    database,
    parsedRecords: parsed.records,
    resume: true,
    sourceSession,
  });

  return {
    events: reduced.events,
    turns: reduced.turns,
  };
}

async function readExistingTopic(sessionId: string): Promise<string | null> {
  const summaryPath = getSessionSummaryJsonPath(sessionId);

  if (!(await fileExists(summaryPath))) {
    return null;
  }

  const summary = summarySchema.parse(JSON.parse(await readFile(summaryPath, "utf8")));
  return summary.topic;
}
async function manifestExists(sessionId: string, sourceHash: string): Promise<boolean> {
  if (await fileExists(getSessionManifestPathForRevision(sessionId, sourceHash))) {
    return true;
  }

  return fileExists(getSessionManifestPath(sessionId));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    return isMissingFileError(error) ? false : Promise.reject(error);
  }
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

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
