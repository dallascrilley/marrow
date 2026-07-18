import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { getRuntimePath } from "../config/paths.js";
import type { ParsedIntermediateCleanupCandidate } from "../read/lifecycle-inventory.js";
import {
  getParsedStagingArtifactPath,
  getStagingQuarantineRoot,
  getStagingRoot,
} from "../storage/staging.js";
import {
  applyParsedIntermediateCleanup,
  ParsedIntermediateCleanupError,
  type ParsedIntermediateCleanupFileSystem,
  type ParsedIntermediateCleanupQuarantine,
  type ParsedIntermediateCleanupResult,
  planParsedIntermediateCleanupQuarantines,
  prepareParsedIntermediateCleanupQuarantines,
  selectParsedCleanupQuarantineRoot,
} from "./parsed-cleanup.js";

type ParsedCleanupReceiptStatus = "applying" | "completed" | "failed";

export type ParsedCleanupReceipt = {
  candidates: ParsedIntermediateCleanupCandidate[];
  created_at: string;
  deleted_paths: string[];
  max_total_bytes: number | null;
  older_than_days: number;
  pending_retry_count: number;
  quarantines: ParsedIntermediateCleanupQuarantine[];
  receipt_path: string;
  retried_by: string | null;
  skipped_paths: string[];
  status: ParsedCleanupReceiptStatus;
};

export type ParsedCleanupReceiptWriter = (
  path: string,
  value: ParsedCleanupReceipt,
) => Promise<void>;

export type PendingParsedIntermediateCleanup = {
  candidates: ParsedIntermediateCleanupCandidate[];
  conflicts: ParsedIntermediateCleanupReceiptConflict[];
  pendingReceiptCount: number;
  quarantines: ParsedIntermediateCleanupQuarantine[];
  receiptPaths: string[];
};

export type ParsedIntermediateCleanupReceiptConflict = {
  original_path: string;
  quarantine_paths: string[];
  reason: string;
};

export type ParsedCleanupReceiptFileSystem = {
  mkdir: typeof mkdir;
  open: typeof open;
  rename: typeof rename;
  unlink: typeof unlink;
};

export async function loadPendingParsedIntermediateCleanup(): Promise<PendingParsedIntermediateCleanup> {
  const receiptDirectory = join(getRuntimePath("deletes"), "receipts");
  const entries = await readdir(receiptDirectory, { withFileTypes: true }).catch((error) => {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  });
  const candidatesByPath = new Map<string, ParsedIntermediateCleanupCandidate[]>();
  const quarantinesByPath = new Map<string, ParsedIntermediateCleanupQuarantine[]>();
  const receiptPaths: string[] = [];
  let pendingReceiptCount = 0;

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !/^parsed-cleanup-.+\.json$/.test(entry.name)) {
      continue;
    }
    const path = join(receiptDirectory, entry.name);
    const contents = await readFile(path, "utf8");
    const header = parseReceiptHeader(contents, path);
    if (
      (header.status !== "applying" && header.status !== "failed") ||
      header.retried_by !== null
    ) {
      continue;
    }
    const receipt = parseReceipt(contents, path);
    pendingReceiptCount += 1;
    receiptPaths.push(path);
    for (const candidate of receipt.candidates) {
      const grouped = candidatesByPath.get(candidate.path) ?? [];
      grouped.push(candidate);
      candidatesByPath.set(candidate.path, grouped);
    }
    for (const mapping of receipt.quarantines) {
      const grouped = quarantinesByPath.get(mapping.original_path) ?? [];
      grouped.push(mapping);
      quarantinesByPath.set(mapping.original_path, grouped);
    }
  }

  const candidates: ParsedIntermediateCleanupCandidate[] = [];
  const conflicts: ParsedIntermediateCleanupReceiptConflict[] = [];
  const quarantines: ParsedIntermediateCleanupQuarantine[] = [];
  const originalPaths = new Set([...candidatesByPath.keys(), ...quarantinesByPath.keys()]);
  for (const originalPath of [...originalPaths].sort()) {
    const resolution = await resolvePendingOriginal(
      originalPath,
      candidatesByPath.get(originalPath) ?? [],
      quarantinesByPath.get(originalPath) ?? [],
    );
    if (resolution.conflict !== undefined) {
      conflicts.push(resolution.conflict);
      continue;
    }
    if (resolution.candidate !== undefined) {
      candidates.push(resolution.candidate);
    }
    if (resolution.quarantine !== undefined) {
      quarantines.push(resolution.quarantine);
    }
  }

  return {
    candidates,
    conflicts,
    pendingReceiptCount,
    quarantines,
    receiptPaths,
  };
}

function parseReceiptHeader(
  contents: string,
  path: string,
): Pick<ParsedCleanupReceipt, "retried_by" | "status"> {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid parsed cleanup receipt JSON at ${path}`, { cause: error });
  }
  if (!isRecord(value) || !isReceiptStatus(value.status)) {
    throw new Error(`Invalid parsed cleanup receipt at ${path}`);
  }
  return {
    retried_by: typeof value.retried_by === "string" ? value.retried_by : null,
    status: value.status,
  };
}

async function resolvePendingOriginal(
  originalPath: string,
  candidateInputs: readonly ParsedIntermediateCleanupCandidate[],
  quarantineInputs: readonly ParsedIntermediateCleanupQuarantine[],
): Promise<{
  candidate?: ParsedIntermediateCleanupCandidate;
  conflict?: ParsedIntermediateCleanupReceiptConflict;
  quarantine?: ParsedIntermediateCleanupQuarantine;
}> {
  const candidates = deduplicateCandidates(candidateInputs);
  const quarantines = deduplicateQuarantines(quarantineInputs);
  const candidatesByFileIdentity = indexCandidatesByFileIdentity(candidates);
  if (candidates.length === 0) {
    return {
      conflict: makeReceiptConflict(originalPath, quarantines, "mapping has no candidate snapshot"),
    };
  }
  if (quarantines.length === 0) {
    return {
      candidate:
        (await selectCandidateAtPath(originalPath, candidatesByFileIdentity)) ??
        (candidates[0] as ParsedIntermediateCleanupCandidate),
    };
  }
  if (quarantines.some((mapping) => !isCentralQuarantinePath(mapping.quarantine_path))) {
    return {
      conflict: makeReceiptConflict(
        originalPath,
        quarantines,
        "unrecognized parsed cleanup quarantine mapping",
      ),
    };
  }
  if (
    quarantines.some(
      (mapping) =>
        mapping.legacy_quarantine_path !== undefined &&
        !isCleanupOwnedQuarantine(mapping.original_path, mapping.legacy_quarantine_path),
    )
  ) {
    return {
      conflict: makeReceiptConflict(
        originalPath,
        quarantines,
        "unrecognized legacy parsed cleanup quarantine mapping",
      ),
    };
  }

  const active: Array<{
    candidate: ParsedIntermediateCleanupCandidate;
    quarantine: ParsedIntermediateCleanupQuarantine;
  }> = [];
  for (const quarantine of quarantines) {
    const paths = [
      quarantine.quarantine_path,
      ...(quarantine.legacy_quarantine_path === undefined
        ? []
        : [quarantine.legacy_quarantine_path]),
    ];
    const present = [];
    for (const path of paths) {
      const metadata = await lstatIfPresent(path);
      if (metadata !== undefined) {
        present.push(metadata);
      }
    }
    if (present.length > 1) {
      return {
        conflict: makeReceiptConflict(
          originalPath,
          quarantines,
          "one mapping has both central and legacy quarantine files",
        ),
      };
    }
    if (present.length === 1) {
      const metadata = present[0];
      if (metadata === undefined || metadata.isSymbolicLink() || !metadata.isFile()) {
        return {
          conflict: makeReceiptConflict(
            originalPath,
            quarantines,
            "quarantine is not a regular file",
          ),
        };
      }
      const matches = candidatesByFileIdentity.get(fileMetadataIdentityKey(metadata)) ?? [];
      if (matches.length !== 1) {
        return {
          conflict: makeReceiptConflict(
            originalPath,
            quarantines,
            "quarantine identity does not select exactly one candidate snapshot",
          ),
        };
      }
      active.push({ candidate: matches[0] as ParsedIntermediateCleanupCandidate, quarantine });
    }
  }
  if (active.length === 1) {
    return active[0] as {
      candidate: ParsedIntermediateCleanupCandidate;
      quarantine: ParsedIntermediateCleanupQuarantine;
    };
  }
  if (active.length > 1) {
    return {
      conflict: makeReceiptConflict(
        originalPath,
        quarantines,
        "multiple live quarantine files match pending candidate snapshots",
      ),
    };
  }

  const originalCandidate = await selectCandidateAtPath(originalPath, candidatesByFileIdentity);
  if (originalCandidate !== undefined) {
    return { candidate: originalCandidate };
  }
  if (quarantines.length === 1) {
    return {
      candidate: candidates[0] as ParsedIntermediateCleanupCandidate,
      quarantine: quarantines[0] as ParsedIntermediateCleanupQuarantine,
    };
  }
  return {
    conflict: makeReceiptConflict(
      originalPath,
      quarantines,
      "multiple mappings are unresolved because neither original nor quarantine exists",
    ),
  };
}

function deduplicateCandidates(
  candidates: readonly ParsedIntermediateCleanupCandidate[],
): ParsedIntermediateCleanupCandidate[] {
  const indexed = new Map<string, ParsedIntermediateCleanupCandidate>();
  for (const candidate of candidates) {
    const key = [
      candidate.path,
      candidate.device,
      candidate.inode,
      candidate.bytes,
      candidate.modified_at,
      candidate.modified_at_nanoseconds ?? "",
      candidate.lifecycle_state,
    ].join("\0");
    indexed.set(key, candidate);
  }
  return [...indexed.values()].sort(compareCandidates);
}

function deduplicateQuarantines(
  quarantines: readonly ParsedIntermediateCleanupQuarantine[],
): ParsedIntermediateCleanupQuarantine[] {
  const indexed = new Map<string, ParsedIntermediateCleanupQuarantine>();
  for (const quarantine of quarantines) {
    const key = `${quarantine.original_path}\0${quarantine.legacy_quarantine_path ?? quarantine.quarantine_path}`;
    const existing = indexed.get(key);
    if (existing === undefined) {
      indexed.set(key, quarantine);
      continue;
    }
    if (
      identitiesConflict(
        existing.quarantine_directory_device,
        quarantine.quarantine_directory_device,
      ) ||
      identitiesConflict(existing.quarantine_directory_inode, quarantine.quarantine_directory_inode)
    ) {
      indexed.set(`${key}\0identity-conflict-${indexed.size}`, quarantine);
      continue;
    }
    if (
      existing.quarantine_directory_device === undefined &&
      quarantine.quarantine_directory_device !== undefined
    ) {
      indexed.set(key, quarantine);
    }
  }
  return [...indexed.values()].sort((left, right) =>
    (left.legacy_quarantine_path ?? left.quarantine_path).localeCompare(
      right.legacy_quarantine_path ?? right.quarantine_path,
    ),
  );
}

function identitiesConflict(left: number | undefined, right: number | undefined): boolean {
  return left !== undefined && right !== undefined && left !== right;
}

async function selectCandidateAtPath(
  path: string,
  candidatesByFileIdentity: ReadonlyMap<string, ParsedIntermediateCleanupCandidate[]>,
): Promise<ParsedIntermediateCleanupCandidate | undefined> {
  const metadata = await lstatIfPresent(path);
  if (metadata === undefined || metadata.isSymbolicLink() || !metadata.isFile()) {
    return undefined;
  }
  const matches = candidatesByFileIdentity.get(fileMetadataIdentityKey(metadata)) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

function indexCandidatesByFileIdentity(
  candidates: readonly ParsedIntermediateCleanupCandidate[],
): Map<string, ParsedIntermediateCleanupCandidate[]> {
  const indexed = new Map<string, ParsedIntermediateCleanupCandidate[]>();
  for (const candidate of candidates) {
    const key = candidateFileIdentityKey(candidate);
    const grouped = indexed.get(key) ?? [];
    grouped.push(candidate);
    indexed.set(key, grouped);
  }
  return indexed;
}

function candidateFileIdentityKey(candidate: ParsedIntermediateCleanupCandidate): string {
  return [candidate.bytes, candidate.device, candidate.inode, candidate.modified_at].join("\0");
}

function fileMetadataIdentityKey(metadata: Awaited<ReturnType<typeof lstat>>): string {
  return [metadata.size, metadata.dev, metadata.ino, metadata.mtime.toISOString()].join("\0");
}

function compareCandidates(
  left: ParsedIntermediateCleanupCandidate,
  right: ParsedIntermediateCleanupCandidate,
): number {
  return (
    left.modified_at.localeCompare(right.modified_at) ||
    left.device - right.device ||
    left.inode - right.inode ||
    left.path.localeCompare(right.path)
  );
}

function makeReceiptConflict(
  originalPath: string,
  quarantines: readonly ParsedIntermediateCleanupQuarantine[],
  reason: string,
): ParsedIntermediateCleanupReceiptConflict {
  return {
    original_path: originalPath,
    quarantine_paths: quarantines.flatMap((mapping) => [
      mapping.quarantine_path,
      ...(mapping.legacy_quarantine_path === undefined ? [] : [mapping.legacy_quarantine_path]),
    ]),
    reason,
  };
}

function isCentralQuarantinePath(path: string): boolean {
  const roots = [
    join(getRuntimePath("deletes"), "parsed-cleanup-quarantine"),
    getStagingQuarantineRoot(),
  ];
  return roots.some((root) => {
    const segments = relative(root, path).split(sep);
    return (
      segments.length === 1 &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.quarantine$/i.test(
        segments[0] ?? "",
      )
    );
  });
}

export async function applyParsedIntermediateCleanupWithReceipt(input: {
  candidates: readonly ParsedIntermediateCleanupCandidate[];
  createdAt: Date;
  database: DatabaseSync;
  fileSystem?: ParsedIntermediateCleanupFileSystem;
  maxTotalBytes?: number;
  olderThanDays: number;
  pendingRetryCount?: number;
  quarantines?: readonly ParsedIntermediateCleanupQuarantine[];
  receiptFileSystem?: ParsedCleanupReceiptFileSystem;
  receiptWriter?: ParsedCleanupReceiptWriter;
  supersedesReceiptPaths?: readonly string[];
}): Promise<{ cleanup: ParsedIntermediateCleanupResult; receiptPath: string }> {
  const candidates = input.candidates.map((candidate) => ({ ...candidate }));
  const quarantineRoot =
    candidates.length > 0 && (input.quarantines === undefined || input.quarantines.length === 0)
      ? await selectParsedCleanupQuarantineRoot(input.fileSystem)
      : undefined;
  const quarantines = await prepareParsedIntermediateCleanupQuarantines(
    planParsedIntermediateCleanupQuarantines(candidates, input.quarantines, quarantineRoot),
    input.fileSystem,
  );
  const receiptPath = getReceiptPath(input.createdAt);
  const receiptWriter =
    input.receiptWriter ??
    ((path, receipt) => writeReceipt(path, receipt, input.receiptFileSystem));
  const applyingReceipt: ParsedCleanupReceipt = {
    candidates,
    created_at: input.createdAt.toISOString(),
    deleted_paths: [],
    max_total_bytes: input.maxTotalBytes ?? null,
    older_than_days: input.olderThanDays,
    pending_retry_count: input.pendingRetryCount ?? 0,
    quarantines,
    receipt_path: receiptPath,
    retried_by: null,
    skipped_paths: [],
    status: "applying",
  };
  await receiptWriter(receiptPath, applyingReceipt);

  try {
    await Promise.all(
      (input.supersedesReceiptPaths ?? []).map((path) =>
        markReceiptRetried(path, receiptPath, input.receiptFileSystem),
      ),
    );
  } catch (error) {
    await receiptWriter(receiptPath, { ...applyingReceipt, status: "failed" });
    throw error;
  }

  let cleanup: ParsedIntermediateCleanupResult;
  try {
    cleanup = await applyParsedIntermediateCleanup(
      input.database,
      candidates,
      input.fileSystem,
      quarantines,
    );
  } catch (error) {
    const partial =
      error instanceof ParsedIntermediateCleanupError
        ? error.result
        : {
            candidates,
            deleted: [],
            quarantines,
            skipped: [],
          };
    await receiptWriter(receiptPath, {
      ...applyingReceipt,
      deleted_paths: partial.deleted.map((candidate) => candidate.path),
      quarantines: partial.quarantines,
      skipped_paths: partial.skipped,
      status: "failed",
    });
    throw error;
  }

  try {
    await receiptWriter(receiptPath, {
      ...applyingReceipt,
      deleted_paths: cleanup.deleted.map((candidate) => candidate.path),
      quarantines: cleanup.quarantines,
      skipped_paths: cleanup.skipped,
      status: "completed",
    });
  } catch (error) {
    await receiptWriter(receiptPath, {
      ...applyingReceipt,
      deleted_paths: cleanup.deleted.map((candidate) => candidate.path),
      quarantines: cleanup.quarantines,
      skipped_paths: cleanup.skipped,
      status: "failed",
    });
    throw error;
  }
  return { cleanup, receiptPath };
}

function parseReceipt(contents: string, path: string): ParsedCleanupReceipt {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid parsed cleanup receipt JSON at ${path}`, { cause: error });
  }
  if (!isRecord(value) || !isReceiptStatus(value.status)) {
    throw new Error(`Invalid parsed cleanup receipt at ${path}`);
  }
  const candidates = requireArray(value.candidates, path).map((candidate) =>
    parseCandidate(candidate, path),
  );
  const quarantines = requireArray(value.quarantines ?? [], path).map((mapping) =>
    parseQuarantine(mapping, path),
  );
  const candidatesByPath = new Map(candidates.map((candidate) => [candidate.path, candidate]));
  for (const quarantinePath of stringArray(value.quarantined_paths)) {
    const originalPath = getLegacyQuarantineOriginalPath(quarantinePath);
    const candidate = originalPath === undefined ? undefined : candidatesByPath.get(originalPath);
    if (candidate === undefined || !isCleanupOwnedQuarantine(candidate.path, quarantinePath)) {
      throw new Error(`Unsafe legacy quarantine path in parsed cleanup receipt ${path}`);
    }
    quarantines.push({
      legacy_quarantine_path: quarantinePath,
      original_path: candidate.path,
      quarantine_path: join(
        getRuntimePath("deletes"),
        "parsed-cleanup-quarantine",
        `${randomUUID()}.quarantine`,
      ),
    });
  }
  return {
    candidates,
    created_at: typeof value.created_at === "string" ? value.created_at : "",
    deleted_paths: stringArray(value.deleted_paths),
    max_total_bytes: typeof value.max_total_bytes === "number" ? value.max_total_bytes : null,
    older_than_days: typeof value.older_than_days === "number" ? value.older_than_days : 0,
    pending_retry_count:
      typeof value.pending_retry_count === "number" ? value.pending_retry_count : 0,
    quarantines,
    receipt_path: typeof value.receipt_path === "string" ? value.receipt_path : path,
    retried_by: typeof value.retried_by === "string" ? value.retried_by : null,
    skipped_paths: stringArray(value.skipped_paths),
    status: value.status,
  };
}

function getLegacyQuarantineOriginalPath(quarantinePath: string): string | undefined {
  const match =
    /^(.*)\.asd-cleanup-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.quarantine$/i.exec(
      quarantinePath,
    );
  return match?.[1];
}

function parseCandidate(value: unknown, receiptPath: string): ParsedIntermediateCleanupCandidate {
  if (
    !isRecord(value) ||
    typeof value.bytes !== "number" ||
    typeof value.device !== "number" ||
    typeof value.inode !== "number" ||
    typeof value.lifecycle_state !== "string" ||
    typeof value.modified_at !== "string" ||
    (value.modified_at_nanoseconds !== undefined &&
      (typeof value.modified_at_nanoseconds !== "string" ||
        !/^\d+$/.test(value.modified_at_nanoseconds))) ||
    typeof value.path !== "string" ||
    typeof value.reason !== "string" ||
    typeof value.session_id !== "string"
  ) {
    throw new Error(`Invalid candidate in parsed cleanup receipt ${receiptPath}`);
  }
  const stagingRoot = getStagingRoot();
  const segments = relative(stagingRoot, value.path).split(sep);
  if (
    segments.length !== 2 ||
    segments[0] !== value.session_id ||
    segments[1] !== "parsed-records.json" ||
    value.path !== getParsedStagingArtifactPath(value.session_id)
  ) {
    throw new Error(`Unsafe candidate path in parsed cleanup receipt ${receiptPath}`);
  }
  return value as unknown as ParsedIntermediateCleanupCandidate;
}

function parseQuarantine(value: unknown, receiptPath: string): ParsedIntermediateCleanupQuarantine {
  if (
    !isRecord(value) ||
    typeof value.original_path !== "string" ||
    typeof value.quarantine_path !== "string"
  ) {
    throw new Error(`Invalid quarantine mapping in parsed cleanup receipt ${receiptPath}`);
  }
  return {
    ...(typeof value.legacy_quarantine_path === "string"
      ? { legacy_quarantine_path: value.legacy_quarantine_path }
      : {}),
    original_path: value.original_path,
    quarantine_path: value.quarantine_path,
    ...(typeof value.quarantine_directory_device === "number"
      ? { quarantine_directory_device: value.quarantine_directory_device }
      : {}),
    ...(typeof value.quarantine_directory_inode === "number"
      ? { quarantine_directory_inode: value.quarantine_directory_inode }
      : {}),
  };
}

function getReceiptPath(now: Date): string {
  const timestamp = now.toISOString().replaceAll(":", "-");
  return join(
    getRuntimePath("deletes"),
    "receipts",
    `parsed-cleanup-${timestamp}-${randomUUID()}.json`,
  );
}

async function writeReceipt(
  path: string,
  value: ParsedCleanupReceipt,
  fileSystem: ParsedCleanupReceiptFileSystem = { mkdir, open, rename, unlink },
): Promise<void> {
  const directory = dirname(path);
  await fileSystem.mkdir(directory, { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    temporaryHandle = await fileSystem.open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    await temporaryHandle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await fileSystem.rename(temporaryPath, path);

    const directoryHandle = await fileSystem.open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await temporaryHandle?.close().catch(() => undefined);
    await fileSystem.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function markReceiptRetried(
  path: string,
  retryReceiptPath: string,
  fileSystem?: ParsedCleanupReceiptFileSystem,
): Promise<void> {
  const receipt = parseReceipt(await readFile(path, "utf8"), path);
  if (receipt.status !== "applying" && receipt.status !== "failed") {
    return;
  }
  await writeReceipt(
    path,
    { ...receipt, receipt_path: path, retried_by: retryReceiptPath },
    fileSystem,
  );
}

function isCleanupOwnedQuarantine(originalPath: string, quarantinePath: string): boolean {
  const prefix = `${originalPath}.asd-cleanup-`;
  const ending = ".quarantine";
  if (!quarantinePath.startsWith(prefix) || !quarantinePath.endsWith(ending)) {
    return false;
  }
  const id = quarantinePath.slice(prefix.length, -ending.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

function isReceiptStatus(value: unknown): value is ParsedCleanupReceiptStatus {
  return value === "applying" || value === "completed" || value === "failed";
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid parsed cleanup receipt array at ${path}`);
  }
  return value;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function lstatIfPresent(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}
