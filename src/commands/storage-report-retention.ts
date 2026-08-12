import { randomUUID } from "node:crypto";
import { access, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { getRuntimePath } from "../config/paths.js";
import {
  defaultReportRetentionHistory,
  listReportRetentionCandidates,
  type ReportRetentionCandidate,
} from "../read/report-retention.js";

const defaultOlderThanDays = 30;

type StorageReportRetentionOptions = {
  apply: boolean;
  history: number;
  olderThanDays: number;
};

export async function executeStorageReportRetention(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const options = parseStorageReportRetentionOptions(context.args);
  const candidates = await listCurrentCandidates(database, options);

  if (!options.apply) {
    context.output.info(JSON.stringify(renderOutput(false, candidates, [], [], options), null, 2));
    return 0;
  }

  const receiptPath = getReceiptPath();
  const applyingReceipt = {
    candidates,
    created_at: new Date().toISOString(),
    deleted_paths: [],
    history: options.history,
    older_than_days: options.olderThanDays,
    quarantined_paths: [],
    skipped_paths: [],
    status: "applying",
  };
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeReceipt(receiptPath, applyingReceipt);

  const deleted: ReportRetentionCandidate[] = [];
  const quarantined = new Set<string>();
  const skipped: string[] = [];
  try {
    for (const candidate of candidates) {
      const current = await findCurrentCandidate(database, candidate, options);
      if (!current) {
        skipped.push(candidate.path);
        continue;
      }

      const quarantinePath = `${current.path}.marrow-cleanup-${randomUUID()}.quarantine`;
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
        if (await restoreQuarantinedFile(quarantinePath, current.path))
          quarantined.delete(quarantinePath);
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
      renderOutput(true, deleted, skipped, [...quarantined], options, receiptPath),
      null,
      2,
    ),
  );
  return 0;
}

function renderOutput(
  apply: boolean,
  candidates: readonly ReportRetentionCandidate[],
  skipped: readonly string[],
  quarantined: readonly string[],
  options: StorageReportRetentionOptions,
  receiptPath?: string,
): Record<string, unknown> {
  return {
    apply,
    candidates,
    history: options.history,
    older_than_days: options.olderThanDays,
    ...(receiptPath ? { receipt_path: receiptPath } : {}),
    ...(apply ? { quarantined, skipped } : {}),
    total_bytes: sumBytes(candidates),
  };
}

function parseStorageReportRetentionOptions(
  args: readonly string[],
): StorageReportRetentionOptions {
  let apply = false;
  let history = defaultReportRetentionHistory;
  let olderThanDays = defaultOlderThanDays;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument === "--history" || argument === "--older-than-days") {
      const parsed = Number(args[index + 1]);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`storage retain-reports ${argument} requires a non-negative integer`);
      }
      if (argument === "--history") history = parsed;
      else olderThanDays = parsed;
      index += 1;
      continue;
    }
    throw new Error(`Unknown storage retain-reports option: ${argument ?? ""}`);
  }
  return { apply, history, olderThanDays };
}

async function listCurrentCandidates(
  database: DatabaseSync,
  options: StorageReportRetentionOptions,
): Promise<ReportRetentionCandidate[]> {
  const candidates = await listReportRetentionCandidates(database, { history: options.history });
  const cutoff = Date.now() - options.olderThanDays * 24 * 60 * 60 * 1000;
  return candidates.filter((candidate) => Date.parse(candidate.modified_at) <= cutoff);
}

async function findCurrentCandidate(
  database: DatabaseSync,
  expected: ReportRetentionCandidate,
  options: StorageReportRetentionOptions,
): Promise<ReportRetentionCandidate | undefined> {
  const candidates = await listCurrentCandidates(database, options);
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
    if (!isMissingPathError(error)) throw error;
  }
  await rename(quarantinePath, originalPath);
  return true;
}

function getReceiptPath(): string {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  return join(getRuntimePath("deletes"), "receipts", `report-retention-${timestamp}.json`);
}

function sameCandidateIdentity(
  left: ReportRetentionCandidate,
  right: ReportRetentionCandidate,
): boolean {
  return (
    left.bytes === right.bytes &&
    left.category === right.category &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.modified_at === right.modified_at &&
    left.path === right.path &&
    left.reason === right.reason
  );
}

function sameFileIdentity(
  candidate: ReportRetentionCandidate,
  metadata: Awaited<ReturnType<typeof stat>>,
): boolean {
  return (
    candidate.bytes === metadata.size &&
    candidate.device === metadata.dev &&
    candidate.inode === metadata.ino &&
    candidate.modified_at === metadata.mtime.toISOString()
  );
}

function sumBytes(candidates: readonly ReportRetentionCandidate[]): number {
  return candidates.reduce((total, candidate) => total + candidate.bytes, 0);
}

async function writeReceipt(path: string, value: Record<string, unknown>): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
