import { access } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { listDeletionCandidates } from "../db/ledger.js";
import type { DeletionCandidateRow } from "../db/queries.js";
import {
  getProjectKnowledgeSessionPath,
  getUserKnowledgeSessionPath,
} from "../writers/knowledge-writer.js";
import {
  getSessionManifestPath,
  getSessionManifestPathForRevision,
} from "../writers/manifest-writer.js";
import { getRetentionReceiptPath } from "../writers/report-writer.js";
import {
  getSessionSummaryJsonPath,
  getSessionSummaryMarkdownPath,
} from "../writers/summary-writer.js";

type RetentionArtifactPaths = {
  manifest_json: string;
  project_knowledge_jsonl: string;
  retention_receipt_json: string;
  summary_json: string;
  summary_markdown: string;
  user_knowledge_jsonl: string;
};

type RetentionDecision = {
  artifact_paths: RetentionArtifactPaths;
  artifact_presence: Record<keyof RetentionArtifactPaths, boolean>;
  candidate_state: string;
  current_lifecycle_state: string;
  missing_required_artifacts: string[];
  next_action: string;
  project_key: string;
  reason: string;
  safe_to_delete: boolean;
  session_id: string;
  source_hash: string;
  source_session_id: number;
  status: "ready" | "blocked";
  updated_at: string;
};

export async function executeDeleteCandidates(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const candidates = listDeletionCandidates(database);
  const decisions = await Promise.all(candidates.map(buildRetentionDecision));

  context.output.info(JSON.stringify({ candidates, decisions }, null, 2));
  return 0;
}

async function buildRetentionDecision(candidate: DeletionCandidateRow): Promise<RetentionDecision> {
  const manifestPath = getSessionManifestPathForRevision(
    candidate.session_id,
    candidate.source_hash,
  );
  const artifactPaths = {
    manifest_json: manifestPath,
    project_knowledge_jsonl: getProjectKnowledgeSessionPath(
      candidate.project_key,
      candidate.session_id,
    ),
    retention_receipt_json: getRetentionReceiptPath(candidate.session_id),
    summary_json: getSessionSummaryJsonPath(candidate.session_id),
    summary_markdown: getSessionSummaryMarkdownPath(candidate.session_id),
    user_knowledge_jsonl: getUserKnowledgeSessionPath("operator", candidate.session_id),
  };
  const artifactPresenceEntries = await Promise.all(
    Object.entries(artifactPaths).map(
      async ([name, path]) => [name, await pathExists(path)] as const,
    ),
  );
  const artifactPresenceBeforeManifestFallback = Object.fromEntries(
    artifactPresenceEntries,
  ) as RetentionDecision["artifact_presence"];
  const manifestPresent =
    artifactPresenceBeforeManifestFallback.manifest_json ||
    (await pathExists(getSessionManifestPath(candidate.session_id)));
  const artifactPresence = {
    ...artifactPresenceBeforeManifestFallback,
    manifest_json: manifestPresent,
  };
  const missingArtifacts = missingRequiredArtifacts(artifactPresence, candidate.candidate_state);
  const safeToDelete = candidate.safe_to_delete === 1;

  return {
    artifact_paths: artifactPaths,
    artifact_presence: artifactPresence,
    candidate_state: candidate.candidate_state,
    current_lifecycle_state: candidate.current_lifecycle_state,
    missing_required_artifacts: missingArtifacts,
    next_action: nextAction(candidate, missingArtifacts),
    project_key: candidate.project_key,
    reason: candidate.reason,
    safe_to_delete: safeToDelete,
    session_id: candidate.session_id,
    source_hash: candidate.source_hash,
    source_session_id: candidate.source_session_id,
    status: safeToDelete && isDeletionReadyState(candidate.candidate_state) ? "ready" : "blocked",
    updated_at: candidate.updated_at,
  };
}

function isDeletionReadyState(candidateState: string): boolean {
  return candidateState === "ready" || candidateState === "discardable_no_signal";
}

function missingRequiredArtifacts(
  artifactPresence: RetentionDecision["artifact_presence"],
  candidateState: string,
): string[] {
  const knowledgeOptional = candidateState === "discardable_no_signal";
  const missing = [
    artifactPresence.manifest_json ? null : "manifest_json",
    artifactPresence.retention_receipt_json ? null : "retention_receipt_json",
    artifactPresence.summary_json ? null : "summary_json",
    artifactPresence.summary_markdown ? null : "summary_markdown",
    knowledgeOptional ||
    artifactPresence.project_knowledge_jsonl ||
    artifactPresence.user_knowledge_jsonl
      ? null
      : "knowledge_jsonl",
  ].filter((value): value is string => value !== null);

  return missing.sort();
}

function nextAction(candidate: DeletionCandidateRow, missingArtifacts: readonly string[]): string {
  if (candidate.safe_to_delete === 1 && isDeletionReadyState(candidate.candidate_state)) {
    return "Review the manifest and retention receipt; run delete apply --apply only when deletion is intentionally approved.";
  }

  if (missingArtifacts.length > 0) {
    return "Keep the source transcript; rerun ingest/archive or inspect explain output until required artifacts are present.";
  }

  return "Keep the source transcript; inspect the blocked reason and improve summary or learning signal before deletion.";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }

    throw error;
  }
}
