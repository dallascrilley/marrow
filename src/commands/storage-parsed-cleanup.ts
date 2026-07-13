import { randomUUID } from "node:crypto";
import { access, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { getRuntimePath } from "../config/paths.js";
import {
  listParsedIntermediateCleanupCandidates,
  type ParsedIntermediateCleanupCandidate,
} from "../read/lifecycle-inventory.js";

const defaultOlderThanDays = 30;

type StorageParsedCleanupOptions = {
  apply: boolean;
  olderThanDays: number;
};

export async function executeStorageParsedCleanup(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const options = parseStorageParsedCleanupOptions(context.args);
  const candidates = await listParsedIntermediateCleanupCandidates(database, {
    olderThanDays: options.olderThanDays,
  });

  if (!options.apply) {
    context.output.info(
      JSON.stringify(
        {
          apply: false,
          candidates,
          older_than_days: options.olderThanDays,
          total_bytes: sumBytes(candidates),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const receiptPath = getReceiptPath();
  const applyingReceipt = {
    candidates,
    created_at: new Date().toISOString(),
    deleted_paths: [],
    older_than_days: options.olderThanDays,
    skipped_paths: [],
    quarantined_paths: [],
    status: "applying",
  };
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeReceipt(receiptPath, applyingReceipt);

  const deleted: ParsedIntermediateCleanupCandidate[] = [];
  const quarantined = new Set<string>();
  const skipped: string[] = [];
  try {
    for (const candidate of candidates) {
      const current = await findCurrentCandidate(database, candidate, options.olderThanDays);
      if (current === undefined) {
        skipped.push(candidate.path);
        continue;
      }

      const quarantinePath = `${current.path}.asd-cleanup-${randomUUID()}.quarantine`;
      try {
        await rename(current.path, quarantinePath);
      } catch (error) {
        if (isMissingPathError(error)) {
          skipped.push(candidate.path);
          continue;
        }
        throw error;
      }
      quarantined.add(quarantinePath);

      const metadata = await stat(quarantinePath);
      if (!sameFileIdentity(current, metadata)) {
        skipped.push(candidate.path);
        if (await restoreQuarantinedFile(quarantinePath, current.path)) {
          quarantined.delete(quarantinePath);
          continue;
        }
        continue;
      }

      await unlink(quarantinePath);
      quarantined.delete(quarantinePath);
      deleted.push(current);
    }
    await writeReceipt(receiptPath, {
      ...applyingReceipt,
      deleted_paths: deleted.map((candidate) => candidate.path),
      quarantined_paths: [...quarantined],
      skipped_paths: skipped,
      status: "completed",
    });
  } catch (error) {
    await writeReceipt(receiptPath, {
      ...applyingReceipt,
      deleted_paths: deleted.map((candidate) => candidate.path),
      quarantined_paths: [...quarantined],
      skipped_paths: skipped,
      status: "failed",
    });
    throw error;
  }

  context.output.info(
    JSON.stringify(
      {
        apply: true,
        deleted,
        older_than_days: options.olderThanDays,
        quarantined: [...quarantined],
        receipt_path: receiptPath,
        skipped,
        total_bytes: sumBytes(deleted),
      },
      null,
      2,
    ),
  );
  return 0;
}

function parseStorageParsedCleanupOptions(args: readonly string[]): StorageParsedCleanupOptions {
  let apply = false;
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
    throw new Error(`Unknown storage cleanup-parsed option: ${argument ?? ""}`);
  }

  return { apply, olderThanDays };
}

function getReceiptPath(): string {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  return join(getRuntimePath("deletes"), "receipts", `parsed-cleanup-${timestamp}.json`);
}

async function writeReceipt(path: string, value: Record<string, unknown>): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function findCurrentCandidate(
  database: DatabaseSync,
  expected: ParsedIntermediateCleanupCandidate,
  olderThanDays: number,
): Promise<ParsedIntermediateCleanupCandidate | undefined> {
  const candidates = await listParsedIntermediateCleanupCandidates(database, { olderThanDays });
  return candidates.find((candidate) => sameCandidateIdentity(expected, candidate));
}

async function restoreQuarantinedFile(
  quarantinePath: string,
  originalPath: string,
): Promise<boolean> {
  try {
    await access(originalPath);
    return false;
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
  await rename(quarantinePath, originalPath);
  return true;
}

function sameCandidateIdentity(
  left: ParsedIntermediateCleanupCandidate,
  right: ParsedIntermediateCleanupCandidate,
): boolean {
  return (
    left.bytes === right.bytes &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.lifecycle_state === right.lifecycle_state &&
    left.modified_at === right.modified_at &&
    left.path === right.path &&
    left.session_id === right.session_id
  );
}

function sameFileIdentity(
  candidate: ParsedIntermediateCleanupCandidate,
  metadata: Awaited<ReturnType<typeof stat>>,
): boolean {
  return (
    candidate.bytes === metadata.size &&
    candidate.device === metadata.dev &&
    candidate.inode === metadata.ino &&
    candidate.modified_at === metadata.mtime.toISOString()
  );
}
function sumBytes(candidates: readonly ParsedIntermediateCleanupCandidate[]): number {
  return candidates.reduce((total, candidate) => total + candidate.bytes, 0);
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
