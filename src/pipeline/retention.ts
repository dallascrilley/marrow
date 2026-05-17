import { access, readFile } from "node:fs/promises";

import type { DeletionCandidateInput, LifecycleState } from "../db/queries.js";
import type { RetentionReceipt, SourceSession, Summary } from "../models/canonical.js";
import { retentionReceiptSchema, summarySchema } from "../models/canonical.js";
import { defaultUserScopeKey } from "./extract.js";
import { getSessionManifestPath } from "../writers/manifest-writer.js";
import {
  getProjectKnowledgeSessionPath,
  getUserKnowledgeSessionPath
} from "../writers/knowledge-writer.js";
import { getRetentionReceiptPath } from "../writers/report-writer.js";
import { getSessionSummaryJsonPath, getSessionSummaryMarkdownPath } from "../writers/summary-writer.js";

export type RetentionEvaluation = {
  artifactState: {
    manifestWritten: boolean;
    projectLearningsWritten: boolean;
    receiptWritten: boolean;
    summaryWritten: boolean;
    userLearningsWritten: boolean;
  };
  candidate: DeletionCandidateInput;
  receipt: RetentionReceipt;
  receiptPath: string;
};

export async function evaluateRetentionReadiness(input: {
  currentLifecycleState: LifecycleState;
  projectKey?: string;
  sessionId?: string;
  sourceHash?: string;
  sourceSession: SourceSession;
  sourceSessionId: number;
  userScopeKey?: string;
}): Promise<RetentionEvaluation> {
  const sessionId = input.sessionId ?? input.sourceSession.session_id;
  const projectKey = input.projectKey ?? input.sourceSession.project_key;
  const userScopeKey = input.userScopeKey ?? defaultUserScopeKey;
  const summaryWritten = await hasSummaryArtifacts(sessionId);
  const summary = summaryWritten ? await readSummary(sessionId) : null;
  const projectLearningsWritten = await fileExists(getProjectKnowledgeSessionPath(projectKey, sessionId));
  const userLearningsWritten = await fileExists(getUserKnowledgeSessionPath(userScopeKey, sessionId));
  const manifestWritten = await fileExists(getSessionManifestPath(sessionId));
  const receiptPath = getRetentionReceiptPath(sessionId);
  const receiptWritten = await fileExists(receiptPath);
  const safeToDelete =
    summaryWritten &&
    (projectLearningsWritten || userLearningsWritten) &&
    manifestWritten &&
    receiptWritten;
  const reason = determineBlockedReason({
    manifestWritten,
    projectLearningsWritten,
    receiptWritten,
    summary,
    summaryWritten,
    userLearningsWritten
  });
  const receipt = retentionReceiptSchema.parse({
    archive_copy_written: manifestWritten,
    extracted_at: new Date().toISOString(),
    project_learnings_written: projectLearningsWritten,
    reason_if_not: safeToDelete ? "" : reason,
    safe_to_delete: safeToDelete,
    session_id: sessionId,
    source_hash: input.sourceHash ?? input.sourceSession.source_hash,
    summary_written: summaryWritten,
    user_learnings_written: userLearningsWritten
  } satisfies RetentionReceipt);

  return {
    artifactState: {
      manifestWritten,
      projectLearningsWritten,
      receiptWritten,
      summaryWritten,
      userLearningsWritten
    },
    candidate: {
      candidateState: safeToDelete ? "ready" : "pending_artifacts",
      currentLifecycleState: input.currentLifecycleState,
      projectKey,
      reason: safeToDelete ? "All required retention artifacts are present." : reason,
      safeToDelete,
      sessionId,
      sourceHash: receipt.source_hash,
      sourceSessionId: input.sourceSessionId
    },
    receipt,
    receiptPath
  };
}

async function hasSummaryArtifacts(sessionId: string): Promise<boolean> {
  const [jsonExists, markdownExists] = await Promise.all([
    fileExists(getSessionSummaryJsonPath(sessionId)),
    fileExists(getSessionSummaryMarkdownPath(sessionId))
  ]);

  return jsonExists && markdownExists;
}

function determineBlockedReason(input: {
  manifestWritten: boolean;
  projectLearningsWritten: boolean;
  receiptWritten: boolean;
  summary: Summary | null;
  summaryWritten: boolean;
  userLearningsWritten: boolean;
}): string {
  if (!input.summaryWritten) {
    return "summary_missing: Summary artifacts have not been written yet.";
  }

  if (input.summary !== null && isLowSignalSummary(input.summary)) {
    return "summary_low_signal: Summary captured no durable signal yet.";
  }

  if (!input.projectLearningsWritten && !input.userLearningsWritten) {
    return "no_durable_learnings: No project or user learnings have been written yet.";
  }

  if (!input.manifestWritten) {
    return "manifest_missing: Immutable provenance manifest has not been written yet.";
  }

  if (!input.receiptWritten) {
    return "receipt_missing: Retention receipt has not been written yet.";
  }

  return "";
}

async function readSummary(sessionId: string): Promise<Summary | null> {
  try {
    const contents = await readFile(getSessionSummaryJsonPath(sessionId), "utf8");
    return summarySchema.parse(JSON.parse(contents));
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

function isLowSignalSummary(summary: Summary): boolean {
  const hasSignal =
    summary.what_worked.length > 0 ||
    summary.what_failed.length > 0 ||
    summary.what_was_decided.length > 0 ||
    summary.useful_commands.length > 0 ||
    summary.files_of_interest.length > 0 ||
    summary.project_learnings.length > 0 ||
    summary.user_learnings.length > 0;

  if (hasSignal) {
    return false;
  }

  return summary.next_step === "No explicit next step recorded.";
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
