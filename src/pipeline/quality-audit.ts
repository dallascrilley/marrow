import { access, readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

import {
  getDeletionCandidateBySessionId,
  listSourceSessions
} from "../db/ledger.js";
import type { DeletionCandidateRow, SourceSessionRow } from "../db/queries.js";
import type { Summary } from "../models/canonical.js";
import { summarySchema } from "../models/canonical.js";
import { defaultUserScopeKey } from "./extract.js";
import {
  getProjectKnowledgeSessionPath,
  getUserKnowledgeSessionPath
} from "../writers/knowledge-writer.js";
import { getSessionSummaryJsonPath } from "../writers/summary-writer.js";

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
  safe_to_delete: boolean | null;
  session_id: string;
  topic: string | null;
};

export type QualityAuditReport = {
  blocked_reasons: Record<string, number>;
  deletion_readiness: {
    blocked: number;
    missing_candidate: number;
    ready: number;
  };
  issue_counts: Record<QualityIssueCode, number>;
  sessions: QualityAuditSession[];
  totals: {
    audited: number;
    with_issues: number;
  };
  worst_sessions: QualityAuditSession[];
};

export async function auditQuality(database: DatabaseSync, options: { limit?: number } = {}): Promise<QualityAuditReport> {
  const sourceSessions = listSourceSessions(database);
  const selectedSessions =
    options.limit === undefined ? sourceSessions : sourceSessions.slice(0, Math.max(0, options.limit));
  const sessions: QualityAuditSession[] = [];
  const issueCounts = createIssueCountMap();
  const blockedReasons: Record<string, number> = {};
  const deletionReadiness = {
    blocked: 0,
    missing_candidate: 0,
    ready: 0
  };

  for (const sourceSession of selectedSessions) {
    const candidate = getDeletionCandidateBySessionId(database, sourceSession.session_id);
    const summaryResult = await readSummary(sourceSession.session_id);
    const knowledgeArtifacts = await readKnowledgeArtifactState(sourceSession);
    const issues = collectSessionIssues(sourceSession, candidate, summaryResult, knowledgeArtifacts);

    for (const issue of issues) {
      issueCounts[issue] += 1;
    }

    if (candidate === null) {
      deletionReadiness.missing_candidate += 1;
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
      safe_to_delete: candidate === null ? null : candidate.safe_to_delete === 1,
      session_id: sourceSession.session_id,
      topic: summaryResult.summary?.topic ?? null
    });
  }

  return {
    blocked_reasons: blockedReasons,
    deletion_readiness: deletionReadiness,
    issue_counts: issueCounts,
    sessions,
    totals: {
      audited: sessions.length,
      with_issues: sessions.filter((session) => session.issue_count > 0).length
    },
    worst_sessions: [...sessions]
      .sort((left, right) => {
        if (right.issue_count !== left.issue_count) {
          return right.issue_count - left.issue_count;
        }

        return left.session_id.localeCompare(right.session_id);
      })
      .slice(0, 10)
  };
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
      summary: summarySchema.parse(JSON.parse(contents))
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        error: "missing",
        summary: null
      };
    }

    return {
      error: "invalid",
      summary: null
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
  }
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
    ...summary.user_learnings
  ].join("\n");

  if (isLowSignalSummary(summary)) {
    issues.push("summary_low_signal");
  }

  if (looksLikeCompletedOutcome(summary.next_step)) {
    issues.push("completion_as_next_step");
  }

  if (/\b(?:let me|i(?:'|’)ll|i need to|checking|exploring)\b/i.test(summaryText)) {
    issues.push("process_chatter");
  }

  if (/<(?:attached_files|code_selection|plugin_info)\b/i.test(summaryText)) {
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
    fileExists(getUserKnowledgeSessionPath(defaultUserScopeKey, sourceSession.session_id))
  ]);

  return {
    project,
    user
  };
}

function isLowSignalSummary(summary: Summary): boolean {
  return !hasUsefulSummarySignal(summary) && summary.next_step === "No explicit next step recorded.";
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
    wrapper_tags: 0
  };
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
