import type { DatabaseSync } from "node:sqlite";

import {
  insertRunHistory,
  transitionPhase,
  upsertDeletionCandidate,
  upsertReviewQueueEntry,
} from "../db/ledger.js";
import type { SourceSessionRow } from "../db/queries.js";
import type { Event, Turn } from "../models/canonical.js";
import type { KnowledgeWriteResult } from "../writers/knowledge-writer.js";
import { writeSessionManifest } from "../writers/manifest-writer.js";
import {
  getRetentionReceiptPath,
  writeRetentionBatchReport,
  writeRetentionReceipt,
} from "../writers/report-writer.js";
import type { SummaryWriteResult } from "../writers/summary-writer.js";
import { evaluateRetentionReadiness } from "./retention.js";

export type ArchivePhaseResult = {
  deletionCandidateState: string;
  reportPath: string;
  safeToDelete: boolean;
};

export async function runArchivePhase(input: {
  database: DatabaseSync;
  events: readonly Event[];
  knowledge: KnowledgeWriteResult;
  sourceSession: SourceSessionRow;
  sourceSessionId: number;
  summary: SummaryWriteResult;
  turns: readonly Turn[];
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

    return {
      deletionCandidateState: candidate.candidate_state,
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
