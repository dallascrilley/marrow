import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import type { ParsedIntermediateCleanupFileSystem } from "../pipeline/parsed-cleanup.js";
import {
  applyParsedIntermediateCleanupWithReceipt,
  loadPendingParsedIntermediateCleanup,
} from "../pipeline/parsed-cleanup-receipts.js";
import {
  listParsedIntermediateCleanupCandidates,
  type ParsedIntermediateCleanupCandidate,
} from "../read/lifecycle-inventory.js";

const defaultOlderThanDays = 30;

type StorageParsedCleanupOptions = {
  apply: boolean;
  maxTotalBytes: number | undefined;
  olderThanDays: number;
};

export async function executeStorageParsedCleanup(
  context: CommandContext,
  database: DatabaseSync,
  dependencies: { fileSystem?: ParsedIntermediateCleanupFileSystem; now?: Date } = {},
): Promise<number> {
  const options = parseStorageParsedCleanupOptions(context.args);
  const now = dependencies.now ?? new Date();
  const cleanupOptions = {
    olderThanDays: options.olderThanDays,
    ...(options.maxTotalBytes === undefined ? {} : { maxTotalBytes: options.maxTotalBytes }),
    now,
  };
  const [ordinaryCandidates, pending] = await Promise.all([
    listParsedIntermediateCleanupCandidates(database, cleanupOptions),
    loadPendingParsedIntermediateCleanup(),
  ]);
  const candidates = mergeCandidateSnapshots(pending.candidates, ordinaryCandidates);

  if (!options.apply) {
    context.output.info(
      JSON.stringify(
        {
          apply: false,
          candidates,
          max_total_bytes: options.maxTotalBytes ?? null,
          older_than_days: options.olderThanDays,
          pending_retry_count: pending.pendingReceiptCount,
          pending_conflicts: pending.conflicts,
          total_bytes: sumBytes(candidates),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (pending.conflicts.length > 0) {
    throw new Error(
      `parsed cleanup pending receipt conflict: ${JSON.stringify(pending.conflicts)}`,
    );
  }

  const { cleanup, receiptPath } = await applyParsedIntermediateCleanupWithReceipt({
    candidates,
    createdAt: now,
    database,
    ...(dependencies.fileSystem === undefined ? {} : { fileSystem: dependencies.fileSystem }),
    ...(options.maxTotalBytes === undefined ? {} : { maxTotalBytes: options.maxTotalBytes }),
    olderThanDays: options.olderThanDays,
    pendingRetryCount: pending.pendingReceiptCount,
    quarantines: pending.quarantines,
    supersedesReceiptPaths: pending.receiptPaths,
  });
  context.output.info(
    JSON.stringify(
      {
        apply: true,
        deleted: cleanup.deleted,
        max_total_bytes: options.maxTotalBytes ?? null,
        older_than_days: options.olderThanDays,
        pending_retry_count: pending.pendingReceiptCount,
        quarantines: cleanup.quarantines,
        receipt_path: receiptPath,
        skipped: cleanup.skipped,
        total_bytes: sumBytes(cleanup.deleted),
      },
      null,
      2,
    ),
  );
  return 0;
}

function parseStorageParsedCleanupOptions(args: readonly string[]): StorageParsedCleanupOptions {
  let apply = false;
  let maxTotalBytes: number | undefined;
  let olderThanDays = defaultOlderThanDays;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument === "--older-than-days") {
      const value = args[index + 1];
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error("storage cleanup-parsed --older-than-days requires a non-negative integer");
      }
      olderThanDays = parsed;
      index += 1;
      continue;
    }
    if (argument === "--max-total-bytes") {
      const value = args[index + 1];
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error("storage cleanup-parsed --max-total-bytes requires a non-negative integer");
      }
      maxTotalBytes = parsed;
      index += 1;
      continue;
    }
    throw new Error(`Unknown storage cleanup-parsed option: ${argument ?? ""}`);
  }

  return { apply, maxTotalBytes, olderThanDays };
}

function sumBytes(candidates: readonly ParsedIntermediateCleanupCandidate[]): number {
  return candidates.reduce((total, candidate) => total + candidate.bytes, 0);
}

function mergeCandidateSnapshots(
  pending: readonly ParsedIntermediateCleanupCandidate[],
  ordinary: readonly ParsedIntermediateCleanupCandidate[],
): ParsedIntermediateCleanupCandidate[] {
  const merged = new Map<string, ParsedIntermediateCleanupCandidate>();
  for (const candidate of pending) {
    if (!merged.has(candidate.path)) {
      merged.set(candidate.path, { ...candidate });
    }
  }
  for (const candidate of ordinary) {
    if (!merged.has(candidate.path)) {
      merged.set(candidate.path, { ...candidate });
    }
  }
  return [...merged.values()];
}
