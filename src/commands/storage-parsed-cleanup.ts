import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { getRuntimePath } from "../config/paths.js";
import {
  applyParsedIntermediateCleanup,
  ParsedIntermediateCleanupError,
  type ParsedIntermediateCleanupFileSystem,
  type ParsedIntermediateCleanupResult,
} from "../pipeline/parsed-cleanup.js";
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
  const cleanupOptions = {
    olderThanDays: options.olderThanDays,
    ...(options.maxTotalBytes === undefined ? {} : { maxTotalBytes: options.maxTotalBytes }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  };
  const candidates = await listParsedIntermediateCleanupCandidates(database, cleanupOptions);

  if (!options.apply) {
    context.output.info(
      JSON.stringify(
        {
          apply: false,
          candidates,
          max_total_bytes: options.maxTotalBytes ?? null,
          older_than_days: options.olderThanDays,
          total_bytes: sumBytes(candidates),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const receiptPath = getReceiptPath(dependencies.now);
  const applyingReceipt = {
    candidates,
    created_at: (dependencies.now ?? new Date()).toISOString(),
    deleted_paths: [],
    max_total_bytes: options.maxTotalBytes ?? null,
    older_than_days: options.olderThanDays,
    skipped_paths: [],
    quarantined_paths: [],
    status: "applying",
  };
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeReceipt(receiptPath, applyingReceipt);

  let cleanup: ParsedIntermediateCleanupResult | undefined;
  try {
    cleanup = await applyParsedIntermediateCleanup(
      database,
      cleanupOptions,
      dependencies.fileSystem,
    );
    await writeReceipt(receiptPath, {
      ...applyingReceipt,
      deleted_paths: cleanup.deleted.map((candidate) => candidate.path),
      quarantined_paths: cleanup.quarantined,
      skipped_paths: cleanup.skipped,
      status: "completed",
    });
  } catch (error) {
    const partial = error instanceof ParsedIntermediateCleanupError ? error.result : cleanup;
    await writeReceipt(receiptPath, {
      ...applyingReceipt,
      deleted_paths: partial?.deleted.map((candidate) => candidate.path) ?? [],
      quarantined_paths: partial?.quarantined ?? [],
      skipped_paths: partial?.skipped ?? [],
      status: "failed",
    });
    throw error;
  }

  if (cleanup === undefined) {
    throw new Error("parsed cleanup completed without a result");
  }
  context.output.info(
    JSON.stringify(
      {
        apply: true,
        deleted: cleanup.deleted,
        max_total_bytes: options.maxTotalBytes ?? null,
        older_than_days: options.olderThanDays,
        quarantined: cleanup.quarantined,
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

function getReceiptPath(now: Date = new Date()): string {
  const timestamp = now.toISOString().replaceAll(":", "-");
  return join(getRuntimePath("deletes"), "receipts", `parsed-cleanup-${timestamp}.json`);
}

async function writeReceipt(path: string, value: Record<string, unknown>): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sumBytes(candidates: readonly ParsedIntermediateCleanupCandidate[]): number {
  return candidates.reduce((total, candidate) => total + candidate.bytes, 0);
}
