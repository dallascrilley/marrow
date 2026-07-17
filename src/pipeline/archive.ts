import type { DatabaseSync } from "node:sqlite";

import {
  insertRunHistory,
  transitionPhase,
  upsertDeletionCandidate,
  upsertReviewQueueEntry,
} from "../db/ledger.js";
import type { SourceSessionRow } from "../db/queries.js";
import type { Event, Turn } from "../models/canonical.js";
import { listParsedIntermediateCleanupCandidatesForSessions } from "../read/lifecycle-inventory.js";
import type { KnowledgeWriteResult } from "../writers/knowledge-writer.js";
import { writeSessionManifest } from "../writers/manifest-writer.js";
import {
  getRetentionReceiptPath,
  writeRetentionBatchReport,
  writeRetentionReceipt,
} from "../writers/report-writer.js";
import { type SummaryWriteResult, writeSessionSummary } from "../writers/summary-writer.js";
import type { ParsedIntermediateCleanupFileSystem } from "./parsed-cleanup.js";
import { applyParsedIntermediateCleanupWithReceipt } from "./parsed-cleanup-receipts.js";
import { evaluateRetentionReadiness } from "./retention.js";

export type ArchivePhaseResult = {
  deletionCandidateState: string;
  parsedIntermediateCleanupError: string | null;
  parsedIntermediateDeleted: boolean;
  reportPath: string;
  safeToDelete: boolean;
};

export async function runArchivePhase(input: {
  /**
   * Pass true only from deliberate regeneration flows (pipeline
   * reextract/rereduce) so the provenance manifest can be superseded; normal
   * ingest keeps the immutability guard.
   */
  allowManifestOverwrite?: boolean;
  database: DatabaseSync;
  events: readonly Event[];
  knowledge: KnowledgeWriteResult;
  sourceSession: SourceSessionRow;
  sourceSessionId: number;
  summary: SummaryWriteResult;
  turns: readonly Turn[];
  now?: Date;
  parsedCleanupFileSystem?: ParsedIntermediateCleanupFileSystem;
}): Promise<ArchivePhaseResult> {
  try {
    const receiptPath = getReceiptPath(input.sourceSession.session_id);
    const sourceSessionModel = toSourceSessionModel(input.sourceSession);
    const manifest = await writeSessionManifest({
      artifactPaths: {
        project_knowledge_jsonl_path: input.knowledge.project.path,
        retention_receipt_path: receiptPath,
        summary_json_path: input.summary.summaryPath,
        summary_markdown_path: input.summary.markdownPath,
        user_knowledge_jsonl_path: input.knowledge.user.path,
      },
      events: input.events,
      ...(input.allowManifestOverwrite === true ? { overwriteIfDifferent: true } : {}),
      sourceSession: sourceSessionModel,
      turns: input.turns,
    });

    const preReceipt = await evaluateRetentionReadiness({
      currentLifecycleState: "extracted",
      sourceSession: sourceSessionModel,
      sourceSessionId: input.sourceSessionId,
      turns: input.turns,
    });
    await writeRetentionReceipt(preReceipt.receipt);

    const archivedDetails = JSON.stringify({
      manifest_path: manifest.path,
      receipt_path: receiptPath,
      summary_path: input.summary.summaryPath,
    });
    const archivedRun = insertRunHistory(input.database, {
      detailsJson: archivedDetails,
      finishedAt: new Date().toISOString(),
      phaseName: "archived",
      phaseState: "completed",
      sessionId: input.sourceSession.session_id,
      sourceHash: input.sourceSession.source_hash,
      sourceSessionId: input.sourceSessionId,
    });
    transitionPhase(input.database, {
      detailsJson: archivedDetails,
      phaseName: "archived",
      phaseState: "completed",
      runId: archivedRun.id,
      sourceHash: input.sourceSession.source_hash,
      sourceSessionId: input.sourceSessionId,
    });

    const postReceipt = await evaluateRetentionReadiness({
      currentLifecycleState: "archived",
      sourceSession: sourceSessionModel,
      sourceSessionId: input.sourceSessionId,
      turns: input.turns,
    });
    const candidate = upsertDeletionCandidate(input.database, postReceipt.candidate);
    // Write the fresh retention verdict into the persisted summary so
    // deletion_readiness reflects reality instead of the summarize-phase
    // default ("not_ready" on 100% of the corpus historically).
    await writeSessionSummary({
      ...input.summary.summary,
      deletion_readiness: candidate.candidate_state,
    });
    const report = await writeRetentionBatchReport(
      [postReceipt],
      `archive-${input.sourceSession.session_id}`,
    );
    upsertReviewQueueEntry(input.database, {
      currentLifecycleState: "deletion_candidate",
      projectKey: input.sourceSession.project_key,
      queueState: "completed",
      reason: candidate.reason,
      reviewKind: "summary",
      sessionId: input.sourceSession.session_id,
      sourceHash: input.sourceSession.source_hash,
      sourceSessionId: input.sourceSessionId,
    });

    const deletionDetails = JSON.stringify({
      candidate_state: candidate.candidate_state,
      report_json_path: report.jsonPath,
      safe_to_delete: candidate.safe_to_delete === 1,
    });
    const deletionRun = insertRunHistory(input.database, {
      detailsJson: deletionDetails,
      finishedAt: new Date().toISOString(),
      phaseName: "deletion_candidate",
      phaseState: "completed",
      sessionId: input.sourceSession.session_id,
      sourceHash: input.sourceSession.source_hash,
      sourceSessionId: input.sourceSessionId,
    });
    transitionPhase(input.database, {
      detailsJson: deletionDetails,
      phaseName: "deletion_candidate",
      phaseState: "completed",
      runId: deletionRun.id,
      sourceHash: input.sourceSession.source_hash,
      sourceSessionId: input.sourceSessionId,
    });

    let parsedIntermediateDeleted = false;
    let parsedIntermediateCleanupError: string | null = null;
    if (candidate.safe_to_delete === 1) {
      const cleanupNow = input.now ?? new Date();
      try {
        const cleanupOptions = { now: cleanupNow, olderThanDays: 0 };
        const candidates =
          input.parsedCleanupFileSystem === undefined
            ? await listParsedIntermediateCleanupCandidatesForSessions(
                input.database,
                [input.sourceSession.session_id],
                cleanupOptions,
              )
            : await listParsedIntermediateCleanupCandidatesForSessions(
                input.database,
                [input.sourceSession.session_id],
                cleanupOptions,
                input.parsedCleanupFileSystem,
              );
        const { cleanup } = await applyParsedIntermediateCleanupWithReceipt({
          candidates,
          createdAt: cleanupNow,
          database: input.database,
          olderThanDays: 0,
          ...(input.parsedCleanupFileSystem === undefined
            ? {}
            : { fileSystem: input.parsedCleanupFileSystem }),
        });
        parsedIntermediateDeleted = cleanup.deleted.length > 0;
      } catch (error) {
        parsedIntermediateCleanupError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      deletionCandidateState: candidate.candidate_state,
      parsedIntermediateCleanupError,
      parsedIntermediateDeleted,
      reportPath: report.jsonPath,
      safeToDelete: candidate.safe_to_delete === 1,
    };
  } catch (error) {
    const detailsJson = JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    });
    const run = insertRunHistory(input.database, {
      detailsJson,
      finishedAt: new Date().toISOString(),
      phaseName: "archived",
      phaseState: "failed",
      sessionId: input.sourceSession.session_id,
      sourceHash: input.sourceSession.source_hash,
      sourceSessionId: input.sourceSessionId,
    });
    transitionPhase(input.database, {
      detailsJson,
      phaseName: "archived",
      phaseState: "failed",
      runId: run.id,
      sourceHash: input.sourceSession.source_hash,
      sourceSessionId: input.sourceSessionId,
    });
    throw error;
  }
}

function getReceiptPath(sessionId: string): string {
  return getRetentionReceiptPath(sessionId);
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
