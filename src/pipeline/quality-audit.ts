import { access, readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

import { getDeletionCandidateBySessionId, listSourceSessions } from "../db/ledger.js";
import type { DeletionCandidateRow, SourceSessionRow } from "../db/queries.js";
import type { Summary } from "../models/canonical.js";
import { summarySchema } from "../models/canonical.js";
import {
  getProjectKnowledgeSessionPath,
  getUserKnowledgeSessionPath,
} from "../writers/knowledge-writer.js";
import { getSessionSummaryJsonPath } from "../writers/summary-writer.js";
import { defaultUserScopeKey } from "./extract.js";

export type QualityIssueCode =
  | "summary_missing"
  | "summary_invalid"
  | "summary_low_signal"
  | "completion_as_next_step"
  | "process_chatter"
  | "wrapper_tags"
  | "no_useful_commands"
  | "no_files_of_interest"
  | "no_project_learnings"
  | "blocked_deletion";

export type QualityAuditSession = {
  blocked_reason: string | null;
  candidate_state: string | null;
  issue_count: number;
  issues: QualityIssueCode[];
  knowledge_artifacts: {
    project: boolean;
    user: boolean;
  };
  project_key: string;
  project_learning_count: number;
  safe_to_delete: boolean | null;
  session_id: string;
  topic: string | null;
};

export type QualityAuditReport = {
  blocked_reasons: Record<string, number>;
  deletion_readiness: {
    blocked: number;
    discardable_no_signal: number;
    missing_candidate: number;
    ready: number;
  };
  issue_counts: Record<QualityIssueCode, number>;
  learning_distribution: LearningDistribution;
  recommendations: Array<{
    affected_sessions: number;
    issue: QualityIssueCode;
    suggested_next_extraction_category: string;
  }>;
  sessions: QualityAuditSession[];
  totals: {
    audited: number;
    with_issues: number;
  };
  worst_sessions: QualityAuditSession[];
};

export type LearningDistribution = {
  buckets: {
    gt_10: number;
    gt_25: number;
    gt_50: number;
    gte_10: number;
    gte_25: number;
    gte_50: number;
  };
  max_project_learnings: number;
  percentiles: {
    p50: number;
    p75: number;
    p90: number;
    p95: number;
    p99: number;
  };
  sessions_with_project_learnings: number;
  top_sessions: Array<{
    project_learning_count: number;
    session_id: string;
  }>;
  total_project_learnings: number;
};

export async function auditQuality(
  database: DatabaseSync,
  options: { limit?: number } = {},
): Promise<QualityAuditReport> {
  const sourceSessions = listSourceSessions(database);
  const selectedSessions =
    options.limit === undefined
      ? sourceSessions
      : sourceSessions.slice(0, Math.max(0, options.limit));
  const sessions: QualityAuditSession[] = [];
  const issueCounts = createIssueCountMap();
  const blockedReasons: Record<string, number> = {};
  const deletionReadiness = {
    blocked: 0,
    discardable_no_signal: 0,
    missing_candidate: 0,
    ready: 0,
  };

  for (const sourceSession of selectedSessions) {
    const candidate = getDeletionCandidateBySessionId(database, sourceSession.session_id);
    const summaryResult = await readSummary(sourceSession.session_id);
    const knowledgeArtifacts = await readKnowledgeArtifactState(sourceSession);
    const projectLearningCount = await countProjectLearnings(sourceSession);
    const issues = collectSessionIssues(
      sourceSession,
      candidate,
      summaryResult,
      knowledgeArtifacts,
    );

    for (const issue of issues) {
      issueCounts[issue] += 1;
    }

    if (candidate === null) {
      deletionReadiness.missing_candidate += 1;
    } else if (
      candidate.safe_to_delete === 1 &&
      candidate.candidate_state === "discardable_no_signal"
    ) {
      deletionReadiness.discardable_no_signal += 1;
    } else if (candidate.safe_to_delete === 1) {
      deletionReadiness.ready += 1;
    } else {
      deletionReadiness.blocked += 1;
      blockedReasons[candidate.reason] = (blockedReasons[candidate.reason] ?? 0) + 1;
    }

    sessions.push({
      blocked_reason: candidate?.safe_to_delete === 0 ? candidate.reason : null,
      candidate_state: candidate?.candidate_state ?? null,
      issue_count: issues.length,
      issues,
      knowledge_artifacts: knowledgeArtifacts,
      project_key: sourceSession.project_key,
      project_learning_count: projectLearningCount,
      safe_to_delete: candidate === null ? null : candidate.safe_to_delete === 1,
      session_id: sourceSession.session_id,
      topic: summaryResult.summary?.topic ?? null,
    });
  }

  return {
    blocked_reasons: blockedReasons,
    deletion_readiness: deletionReadiness,
    issue_counts: issueCounts,
    learning_distribution: buildLearningDistribution(sessions),
    recommendations: buildRecommendations(issueCounts),
    sessions,
    totals: {
      audited: sessions.length,
      with_issues: sessions.filter((session) => session.issue_count > 0).length,
    },
    worst_sessions: [...sessions]
      .sort((left, right) => {
        if (right.issue_count !== left.issue_count) {
          return right.issue_count - left.issue_count;
        }

        return left.session_id.localeCompare(right.session_id);
      })
      .slice(0, 10),
  };
}

function buildRecommendations(
  issueCounts: Record<QualityIssueCode, number>,
): QualityAuditReport["recommendations"] {
  return Object.entries(issueCounts)
    .filter((entry): entry is [QualityIssueCode, number] => entry[1] > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([issue, affectedSessions]) => ({
      affected_sessions: affectedSessions,
      issue,
      suggested_next_extraction_category: recommendationForIssue(issue),
    }));
}

function recommendationForIssue(issue: QualityIssueCode): string {
  switch (issue) {
    case "no_project_learnings":
      return "Add project-learning promotion for verified fixes, error resolutions, repo workflows, or file-scoped outcomes.";
    case "no_useful_commands":
      return "Improve command extraction from tool input, inline executable commands, and verification evidence.";
    case "no_files_of_interest":
      return "Improve file extraction/ranking from event payloads, source refs, and project-relative paths.";
    case "summary_low_signal":
      return "Improve summary synthesis for short sessions or classify them as intentionally low-signal.";
    case "process_chatter":
      return "Suppress assistant process chatter before summary and learning promotion.";
    case "blocked_deletion":
      return "Inspect blocked reasons; most require summary signal or durable learning artifacts before deletion.";
    case "completion_as_next_step":
      return "Tighten next-step selection to reject completed verified outcomes.";
    case "wrapper_tags":
      return "Keep attachment/code-selection wrappers in provenance payloads, not summary text.";
    case "summary_invalid":
      return "Repair or regenerate invalid summary artifacts.";
    case "summary_missing":
      return "Rerun summarization for sessions missing summary artifacts.";
  }
}

type SummaryReadResult =
  | {
      error: "missing" | "invalid";
      summary: null;
    }
  | {
      error: null;
      summary: Summary;
    };

async function readSummary(sessionId: string): Promise<SummaryReadResult> {
  try {
    const contents = await readFile(getSessionSummaryJsonPath(sessionId), "utf8");
    return {
      error: null,
      summary: summarySchema.parse(JSON.parse(contents)),
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        error: "missing",
        summary: null,
      };
    }

    return {
      error: "invalid",
      summary: null,
    };
  }
}

function collectSessionIssues(
  sourceSession: SourceSessionRow,
  candidate: DeletionCandidateRow | null,
  summaryResult: SummaryReadResult,
  knowledgeArtifacts: {
    project: boolean;
    user: boolean;
  },
): QualityIssueCode[] {
  const issues: QualityIssueCode[] = [];

  if (summaryResult.error === "missing") {
    issues.push("summary_missing");
  }

  if (summaryResult.error === "invalid") {
    issues.push("summary_invalid");
  }

  if (candidate !== null && candidate.safe_to_delete === 0) {
    issues.push("blocked_deletion");
  }

  const summary = summaryResult.summary;
  if (summary === null) {
    return issues;
  }

  const summaryText = [
    summary.topic,
    ...summary.what_worked,
    ...summary.what_failed,
    ...summary.what_was_decided,
    summary.next_step,
    ...summary.project_learnings,
    ...summary.user_learnings,
  ].join("\n");

  if (isLowSignalSummary(summary)) {
    issues.push("summary_low_signal");
  }

  if (looksLikeCompletedOutcome(summary.next_step)) {
    issues.push("completion_as_next_step");
  }

  if (hasProcessChatter(summaryText)) {
    issues.push("process_chatter");
  }

  if (/<(?:attached_files|code_selection|plugin_info|skill)\b/i.test(summaryText)) {
    issues.push("wrapper_tags");
  }

  if (summary.useful_commands.length === 0 && hasUsefulSummarySignal(summary)) {
    issues.push("no_useful_commands");
  }

  if (summary.files_of_interest.length === 0 && hasUsefulSummarySignal(summary)) {
    issues.push("no_files_of_interest");
  }

  if (
    sourceSession.current_lifecycle_state === "deletion_candidate" &&
    summary.project_learnings.length === 0 &&
    !knowledgeArtifacts.project &&
    hasUsefulSummarySignal(summary)
  ) {
    issues.push("no_project_learnings");
  }

  return issues;
}

async function readKnowledgeArtifactState(sourceSession: SourceSessionRow): Promise<{
  project: boolean;
  user: boolean;
}> {
  const [project, user] = await Promise.all([
    fileExists(getProjectKnowledgeSessionPath(sourceSession.project_key, sourceSession.session_id)),
    fileExists(getUserKnowledgeSessionPath(defaultUserScopeKey, sourceSession.session_id)),
  ]);

  return {
    project,
    user,
  };
}

function isLowSignalSummary(summary: Summary): boolean {
  return (
    !hasUsefulSummarySignal(summary) && summary.next_step === "No explicit next step recorded."
  );
}

function hasUsefulSummarySignal(summary: Summary): boolean {
  return (
    summary.what_worked.length > 0 ||
    summary.what_failed.length > 0 ||
    summary.what_was_decided.length > 0 ||
    summary.useful_commands.length > 0 ||
    summary.files_of_interest.length > 0 ||
    summary.project_learnings.length > 0 ||
    summary.user_learnings.length > 0
  );
}

function looksLikeCompletedOutcome(value: string): boolean {
  return (
    /\b(?:done|completed|implemented|fixed|resolved|merged|pushed)\b/i.test(value) &&
    /\b(?:verified|tests? pass(?:ed)?|all checks passed|0 failures)\b/i.test(value)
  );
}

function hasProcessChatter(summaryText: string): boolean {
  const lines = summaryText.split(/\r?\n/);

  for (const line of lines) {
    if (looksLikeProcessChatterLine(line)) {
      return true;
    }
  }

  return false;
}

function looksLikeProcessChatterLine(line: string): boolean {
  const normalized = line.trim().toLowerCase();

  if (normalized.length === 0) {
    return false;
  }

  // Process-only prefixes/phrases that strongly signal assistant narration.
  const processPhrasePattern =
    /^(?:let me|i(?:'|’)ll|i will|i need to|i(?:'|’)m|checking|exploring|now let me|now i(?:'|’)ll|now i(?:'|’)m|first, let me|first, i(?:'|’)ll|first, i(?:'|’)m)\b/i;

  if (!processPhrasePattern.test(normalized)) {
    return false;
  }

  // If the same line also contains concrete outcome signal or is long enough
  // to convey substance, it is durable content wrapped in process wording,
  // not pure chatter.
  const concreteSignalPattern =
    /\b(?:fix|fixed|implement|implemented|resolve|resolved|verify|verified|test|tests?|pass|passed|fail|failed|error|add|added|update|updated|remove|removed|create|created|commit|committed|push|pushed|merge|merged|build|built|run|ran|command|file|path|change|changes|outcome|result|results|output|done|completed|deployed|released|refactored|migrated|upgraded|downgraded|configured|installed)\b/i;
  const hasConcreteSignal = concreteSignalPattern.test(normalized);
  const isSubstantiveLength = normalized.length >= 60;

  return !(hasConcreteSignal || isSubstantiveLength);
}

function createIssueCountMap(): Record<QualityIssueCode, number> {
  return {
    blocked_deletion: 0,
    completion_as_next_step: 0,
    no_files_of_interest: 0,
    no_project_learnings: 0,
    no_useful_commands: 0,
    process_chatter: 0,
    summary_invalid: 0,
    summary_low_signal: 0,
    summary_missing: 0,
    wrapper_tags: 0,
  };
}

async function countProjectLearnings(sourceSession: SourceSessionRow): Promise<number> {
  try {
    const contents = await readFile(
      getProjectKnowledgeSessionPath(sourceSession.project_key, sourceSession.session_id),
      "utf8",
    );
    return contents.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  } catch (error) {
    if (isMissingFileError(error)) {
      return 0;
    }

    throw error;
  }
}

function buildLearningDistribution(sessions: readonly QualityAuditSession[]): LearningDistribution {
  const counts = sessions
    .map((session) => session.project_learning_count)
    .filter((count) => count > 0)
    .sort((left, right) => left - right);

  return {
    buckets: {
      gt_10: counts.filter((count) => count > 10).length,
      gt_25: counts.filter((count) => count > 25).length,
      gt_50: counts.filter((count) => count > 50).length,
      gte_10: counts.filter((count) => count >= 10).length,
      gte_25: counts.filter((count) => count >= 25).length,
      gte_50: counts.filter((count) => count >= 50).length,
    },
    max_project_learnings: counts.at(-1) ?? 0,
    percentiles: {
      p50: percentileNearestRank(counts, 0.5),
      p75: percentileNearestRank(counts, 0.75),
      p90: percentileNearestRank(counts, 0.9),
      p95: percentileNearestRank(counts, 0.95),
      p99: percentileNearestRank(counts, 0.99),
    },
    sessions_with_project_learnings: counts.length,
    top_sessions: [...sessions]
      .filter((session) => session.project_learning_count > 0)
      .sort((left, right) => {
        if (right.project_learning_count !== left.project_learning_count) {
          return right.project_learning_count - left.project_learning_count;
        }

        return left.session_id.localeCompare(right.session_id);
      })
      .slice(0, 10)
      .map((session) => ({
        project_learning_count: session.project_learning_count,
        session_id: session.session_id,
      })),
    total_project_learnings: counts.reduce((total, count) => total + count, 0),
  };
}

function percentileNearestRank(sortedCounts: readonly number[], quantile: number): number {
  if (sortedCounts.length === 0) {
    return 0;
  }

  const rank = Math.ceil(quantile * sortedCounts.length);
  const index = Math.min(sortedCounts.length - 1, Math.max(0, rank - 1));
  return sortedCounts.at(index) ?? 0;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }

    throw error;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
