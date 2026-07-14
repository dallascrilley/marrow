import { stat } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { getSourceSessionById, listDeletionCandidates } from "../db/ledger.js";
import type { DeletionCandidateRow, SourceSessionRow } from "../db/queries.js";
import {
  archiveVerifiedCodexSource,
  inspectCodexRawArchive,
  removeArchivedCodexSource,
} from "../pipeline/raw-source-archive.js";
import { applyDeletionCandidate } from "./delete-apply.js";

type SourceDeletionEntry = {
  archive_path?: string;
  reclaimable_bytes?: number;
  reason?: string;
  session_id: string;
  source_path?: string;
};

export async function executeDeleteSources(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  if (sourceArgument(context.args) !== "codex-cli") {
    context.output.error("delete sources requires --source codex-cli.");
    return 1;
  }

  const apply = context.args.includes("--apply");
  const archivable: SourceDeletionEntry[] = [];
  const alreadyArchived: SourceDeletionEntry[] = [];
  const blocked: SourceDeletionEntry[] = [];
  const missing: SourceDeletionEntry[] = [];
  const applied: SourceDeletionEntry[] = [];

  for (const candidate of listDeletionCandidates(database)) {
    try {
      const sourceSession = getSourceSessionById(database, candidate.source_session_id);
      if (sourceSession.source_tool !== "codex-cli") {
        continue;
      }
      if (!isEligibleCandidate(candidate)) {
        blocked.push({
          reason: "Candidate is not in a safe ready or legacy-applied state.",
          session_id: candidate.session_id,
        });
        continue;
      }

      const inspection = await inspectCodexRawArchive(sourceSession);
      if (inspection.status === "blocked") {
        blocked.push({ reason: inspection.reason, session_id: candidate.session_id });
        continue;
      }
      if (inspection.status === "missing") {
        missing.push({ reason: inspection.reason, session_id: candidate.session_id });
        continue;
      }
      if (inspection.status === "archived") {
        const entry = {
          archive_path: inspection.archivePaths.archivePath,
          session_id: candidate.session_id,
          source_path: inspection.sourcePath ?? inspection.receipt.source_path,
        };
        alreadyArchived.push(entry);
        if (apply) {
          const receipt = await removeArchivedCodexSource({
            receipt: inspection.receipt,
            receiptPath: inspection.archivePaths.receiptPath,
            sourcePath: inspection.sourcePath,
          });
          applied.push(
            await finalizeDeletion(database, candidate, sourceSession, receipt.archive_path),
          );
        }
        continue;
      }

      const reclaimableBytes = await getSourceSize(inspection.sourcePath);
      const entry = {
        archive_path: inspection.archivePaths.archivePath,
        reclaimable_bytes: reclaimableBytes,
        session_id: candidate.session_id,
        source_path: inspection.sourcePath,
      };
      archivable.push(entry);
      if (apply) {
        const archive = await archiveVerifiedCodexSource(sourceSession, inspection);
        const receipt = await removeArchivedCodexSource({
          receipt: archive.receipt,
          receiptPath: archive.receiptPath,
          sourcePath: archive.sourcePath,
        });
        applied.push(
          await finalizeDeletion(database, candidate, sourceSession, receipt.archive_path),
        );
      }
    } catch (error) {
      blocked.push({
        reason: error instanceof Error ? error.message : "Unexpected archive failure.",
        session_id: candidate.session_id,
      });
    }
  }

  context.output.info(
    JSON.stringify(
      {
        already_archived: alreadyArchived,
        apply,
        applied,
        archivable,
        blocked,
        missing,
        source: "codex-cli",
      },
      null,
      2,
    ),
  );
  return 0;
}

function sourceArgument(args: readonly string[]): string | null {
  const index = args.indexOf("--source");
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function isEligibleCandidate(candidate: DeletionCandidateRow): boolean {
  if (candidate.candidate_state === "applied") {
    return true;
  }
  return (
    candidate.safe_to_delete === 1 &&
    (candidate.candidate_state === "ready" || candidate.candidate_state === "discardable_no_signal")
  );
}

async function finalizeDeletion(
  database: DatabaseSync,
  candidate: DeletionCandidateRow,
  sourceSession: SourceSessionRow,
  archivePath: string,
): Promise<SourceDeletionEntry> {
  if (candidate.candidate_state !== "applied") {
    await applyDeletionCandidate(database, candidate);
  }
  return {
    archive_path: archivePath,
    session_id: candidate.session_id,
    source_path: sourceSession.source_path,
  };
}

async function getSourceSize(path: string): Promise<number> {
  return (await stat(path)).size;
}
