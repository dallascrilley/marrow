import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

import { getRuntimePath } from "../config/paths.js";
import type { SourceSessionRow } from "../db/queries.js";
import {
  type RawSourceArchiveReceipt,
  rawSourceArchiveReceiptSchema,
} from "../models/canonical.js";

type ArchivePaths = {
  archivePath: string;
  receiptPath: string;
};

export type RawArchiveInspection =
  | {
      archivePaths: ArchivePaths;
      receipt: RawSourceArchiveReceipt;
      sourceExists: boolean;
      sourcePath: string | null;
      status: "archived";
    }
  | {
      archivePaths: ArchivePaths;
      sourcePath: string;
      status: "ready";
    }
  | {
      archivePaths: ArchivePaths;
      reason: string;
      status: "blocked";
    }
  | {
      archivePaths: ArchivePaths;
      reason: string;
      status: "missing";
    };

export type RawArchiveResult = {
  archivePath: string;
  receipt: RawSourceArchiveReceipt;
  receiptPath: string;
  sourcePath: string;
};

export async function inspectCodexRawArchive(
  sourceSession: SourceSessionRow,
): Promise<RawArchiveInspection> {
  const archivePaths = getArchivePaths(sourceSession.session_id);
  const sourceLocation = await resolveCodexSource(sourceSession);
  if (sourceLocation.status === "blocked") {
    return { archivePaths, reason: sourceLocation.reason, status: "blocked" };
  }

  const archiveExists = await pathExists(archivePaths.archivePath);
  const receiptExists = await pathExists(archivePaths.receiptPath);
  if (archiveExists || receiptExists) {
    if (!archiveExists || !receiptExists) {
      return {
        archivePaths,
        reason: "Archive collision: both the gzip artifact and receipt must exist together.",
        status: "blocked",
      };
    }

    const receipt = await readArchiveReceipt(archivePaths.receiptPath);
    if (receipt === null) {
      return {
        archivePaths,
        reason: "Archive collision: the existing receipt is invalid.",
        status: "blocked",
      };
    }
    if (
      receipt.archive_path !== archivePaths.archivePath ||
      receipt.session_id !== sourceSession.session_id ||
      receipt.source_hash !== sourceSession.source_hash ||
      receipt.source_tool !== "codex-cli"
    ) {
      return {
        archivePaths,
        reason: "Archive collision: the existing receipt does not match the source session.",
        status: "blocked",
      };
    }

    const archiveVerification = await verifyGzipHash(archivePaths.archivePath);
    const archiveHash = await hashFile(archivePaths.archivePath);
    if (
      archiveVerification.hash !== sourceSession.source_hash ||
      archiveHash !== receipt.archive_sha256
    ) {
      return {
        archivePaths,
        reason: "Archive collision: the gzip artifact does not match the recorded source hash.",
        status: "blocked",
      };
    }

    return {
      archivePaths,
      receipt,
      sourceExists: sourceLocation.status === "found",
      sourcePath: sourceLocation.status === "found" ? sourceLocation.path : null,
      status: "archived",
    };
  }

  if (sourceLocation.status === "missing") {
    return { archivePaths, reason: sourceLocation.reason, status: "missing" };
  }

  const sourceHash = await hashFile(sourceLocation.path);
  if (sourceHash !== sourceSession.source_hash) {
    return {
      archivePaths,
      reason: "Source hash mismatch: the current bytes do not match the ledger hash.",
      status: "blocked",
    };
  }

  return { archivePaths, sourcePath: sourceLocation.path, status: "ready" };
}

export async function archiveVerifiedCodexSource(
  sourceSession: SourceSessionRow,
  inspection: Extract<RawArchiveInspection, { status: "ready" }>,
): Promise<RawArchiveResult> {
  const sourceStat = await stat(inspection.sourcePath);
  const sourceHash = await hashFile(inspection.sourcePath);
  if (sourceHash !== sourceSession.source_hash) {
    throw new Error("Source hash mismatch: the source changed before archival.");
  }

  await writeGzipAtomically(inspection.sourcePath, inspection.archivePaths.archivePath);
  const archiveVerification = await verifyGzipHash(inspection.archivePaths.archivePath);
  if (archiveVerification.hash !== sourceHash) {
    await rm(inspection.archivePaths.archivePath, { force: true });
    throw new Error("Archive verification failed: gzip content hash does not match the source.");
  }

  const archiveStat = await stat(inspection.archivePaths.archivePath);
  const receipt = rawSourceArchiveReceiptSchema.parse({
    archive_path: inspection.archivePaths.archivePath,
    archive_sha256: await hashFile(inspection.archivePaths.archivePath),
    archived_at: new Date().toISOString(),
    compressed_bytes: archiveStat.size,
    session_id: sourceSession.session_id,
    source_bytes: sourceStat.size,
    source_hash: sourceHash,
    source_path: inspection.sourcePath,
    source_removed_at: null,
    source_tool: "codex-cli",
  });
  await writeArchiveReceipt(inspection.archivePaths.receiptPath, receipt);

  return {
    archivePath: inspection.archivePaths.archivePath,
    receipt,
    receiptPath: inspection.archivePaths.receiptPath,
    sourcePath: inspection.sourcePath,
  };
}

export async function removeArchivedCodexSource(input: {
  receipt: RawSourceArchiveReceipt;
  receiptPath: string;
  sourcePath: string | null;
}): Promise<RawSourceArchiveReceipt> {
  if (input.sourcePath !== null && (await pathExists(input.sourcePath))) {
    await unlink(input.sourcePath);
  }

  const receipt = rawSourceArchiveReceiptSchema.parse({
    ...input.receipt,
    source_removed_at: input.receipt.source_removed_at ?? new Date().toISOString(),
  });
  await writeArchiveReceipt(input.receiptPath, receipt);
  return receipt;
}

function getArchivePaths(sessionId: string): ArchivePaths {
  const date = getSessionDate(sessionId);
  if (date === null || !/^[A-Za-z0-9._-]+$/.test(sessionId)) {
    throw new Error(`Unsupported Codex session id for raw archival: ${sessionId}`);
  }
  const archivePath = join(
    getRuntimePath("archives"),
    "raw",
    "codex-cli",
    date.year,
    date.month,
    date.day,
    `${sessionId}.jsonl.gz`,
  );
  return { archivePath, receiptPath: `${archivePath}.receipt.json` };
}

async function resolveCodexSource(
  sourceSession: SourceSessionRow,
): Promise<
  | { path: string; status: "found" }
  | { reason: string; status: "blocked" }
  | { reason: string; status: "missing" }
> {
  const roots = getCodexSourceRoots();
  if (!isAllowedCodexPath(sourceSession.source_path, roots)) {
    return {
      reason: "Blocked unsafe source path outside Codex transcript roots.",
      status: "blocked",
    };
  }

  const fallbackPaths = getFallbackPaths(sourceSession.session_id, roots);
  for (const candidate of [resolve(sourceSession.source_path), ...fallbackPaths]) {
    if (!(await pathExists(candidate))) {
      continue;
    }
    const metadata = await lstat(candidate);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return { reason: "Blocked source path is not a regular file.", status: "blocked" };
    }
    return { path: candidate, status: "found" };
  }

  return {
    reason: "Source transcript is missing from the Codex transcript roots.",
    status: "missing",
  };
}

function getCodexSourceRoots(): readonly string[] {
  const codexRoot = join(homedir(), ".codex");
  return [resolve(codexRoot, "sessions"), resolve(codexRoot, "archived_sessions")];
}

function getFallbackPaths(sessionId: string, roots: readonly string[]): readonly string[] {
  const date = getSessionDate(sessionId);
  if (date === null) {
    return [];
  }
  const sessionsRoot = roots[0];
  const archivedRoot = roots[1];
  if (sessionsRoot === undefined || archivedRoot === undefined) {
    return [];
  }
  return [
    join(sessionsRoot, date.year, date.month, date.day, `${sessionId}.jsonl`),
    join(archivedRoot, `${sessionId}.jsonl`),
  ];
}

function getSessionDate(sessionId: string): { day: string; month: string; year: string } | null {
  const match = /^rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(sessionId);
  const year = match?.[1];
  const month = match?.[2];
  const day = match?.[3];
  if (year === undefined || month === undefined || day === undefined) {
    return null;
  }
  return { day, month, year };
}

function isAllowedCodexPath(path: string, roots: readonly string[]): boolean {
  if (!isAbsolute(path)) {
    return false;
  }
  const resolvedPath = resolve(path);
  return roots.some((root) => {
    const pathRelativeToRoot = relative(root, resolvedPath);
    return (
      pathRelativeToRoot.length > 0 &&
      !pathRelativeToRoot.startsWith("..") &&
      !isAbsolute(pathRelativeToRoot)
    );
  });
}

async function writeGzipAtomically(sourcePath: string, archivePath: string): Promise<void> {
  await mkdir(dirname(archivePath), { recursive: true });
  const temporaryPath = `${archivePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await pipeline(
      createReadStream(sourcePath),
      createGzip(),
      createWriteStream(temporaryPath, { flags: "wx" }),
    );
    await rename(temporaryPath, archivePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function verifyGzipHash(archivePath: string): Promise<{ bytes: number; hash: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    createReadStream(archivePath),
    createGunzip(),
    new Writable({
      write(chunk, _encoding, callback) {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(value);
        bytes += value.length;
        callback();
      },
    }),
  );
  return { bytes, hash: `sha256:${hash.digest("hex")}` };
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(
    createReadStream(path),
    new Writable({
      write(chunk, _encoding, callback) {
        hash.update(chunk);
        callback();
      },
    }),
  );
  return `sha256:${hash.digest("hex")}`;
}

async function readArchiveReceipt(path: string): Promise<RawSourceArchiveReceipt | null> {
  try {
    return rawSourceArchiveReceiptSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null;
  }
}

async function writeArchiveReceipt(path: string, receipt: RawSourceArchiveReceipt): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
