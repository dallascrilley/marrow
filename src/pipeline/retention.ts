import { access } from "node:fs/promises";

import type { DeletionCandidateInput, LifecycleState } from "../db/queries.js";
import type { RetentionReceipt, SourceSession } from "../models/canonical.js";
import { retentionReceiptSchema } from "../models/canonical.js";
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
  summaryWritten: boolean;
  userLearningsWritten: boolean;
}): string {
  if (!input.summaryWritten) {
    return "Summary artifacts have not been written yet.";
  }

  if (!input.projectLearningsWritten && !input.userLearningsWritten) {
    return "No project or user learnings have been written yet.";
  }

  if (!input.manifestWritten) {
    return "Immutable provenance manifest has not been written yet.";
  }

  if (!input.receiptWritten) {
    return "Retention receipt has not been written yet.";
  }

  return "";
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
