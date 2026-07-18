import type { Dir } from "node:fs";
import { access, lstat, opendir, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { DatabaseSync } from "node:sqlite";

import { getRuntimePath, getRuntimeRoot } from "../config/paths.js";
import {
  getParsedStagingArtifactPath,
  getStagingRoot,
  inspectStagingRoot,
  preflightStagingReadRoot,
} from "../storage/staging.js";
import {
  getDeletionCandidateBySessionId,
  getSourceSessionBySessionId,
  listDeletionCandidates,
  listSourceSessions,
} from "../db/ledger.js";
import type { DeletionCandidateRow, SourceSessionRow } from "../db/queries.js";
import { ingestStatuses } from "../models/canonical.js";
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

const millisecondsPerDay = 24 * 60 * 60 * 1000;
const unknownLifecycleState = "unknown";

export const runtimeInventoryArtifactKinds = [
  "archive",
  "index",
  "knowledge",
  "ledger",
  "manifest",
  "receipt",
  "report",
  "review",
  "reviewed_memory",
  "staging_parsed",
  "staging_reduced",
  "summary",
  "unknown",
] as const;

export const runtimeInventoryRetentionStates = ["reclaimable", "required", "unknown"] as const;

export const runtimeInventoryLifecycleStates = [
  ...ingestStatuses,
  "stale",
  unknownLifecycleState,
] as const;

export type RuntimeInventoryArtifactKind = (typeof runtimeInventoryArtifactKinds)[number];
export type RuntimeInventoryRetentionState = (typeof runtimeInventoryRetentionStates)[number];
export type RuntimeInventoryLifecycleState = (typeof runtimeInventoryLifecycleStates)[number];

export interface RuntimeLifecycleInventoryFilters {
  older_than_days: number | null;
  state: RuntimeInventoryLifecycleState | null;
}

export interface RuntimeLifecycleInventoryArtifact {
  bytes: number;
  count: number;
  kind: RuntimeInventoryArtifactKind;
  lifecycle_state: RuntimeInventoryLifecycleState;
  newest_at: string | null;
  oldest_at: string | null;
  reason: string;
  retention: RuntimeInventoryRetentionState;
}

export interface RuntimeLifecycleInventory {
  artifacts: RuntimeLifecycleInventoryArtifact[];
  filters: RuntimeLifecycleInventoryFilters;
  runtime_root: string;
  staging: Awaited<ReturnType<typeof inspectStagingRoot>>;
  total: Pick<RuntimeLifecycleInventoryArtifact, "bytes" | "count">;
}

export interface RuntimeLifecycleInventoryOptions {
  now?: Date;
  olderThanDays?: number;
  state?: RuntimeInventoryLifecycleState;
}

export interface ParsedIntermediateCleanupCandidate {
  bytes: number;
  device: number;
  inode: number;
  lifecycle_state: RuntimeInventoryLifecycleState;
  modified_at: string;
  modified_at_nanoseconds?: string;
  path: string;
  reason: string;
  session_id: string;
}

export interface ParsedIntermediateCleanupOptions {
  maxTotalBytes?: number;
  now?: Date;
  olderThanDays: number;
}

export type ParsedIntermediateCandidateFileSystem = {
  access: typeof access;
  lstat?: typeof lstat;
  realpath?: typeof realpath;
  stat: typeof stat;
};

export type ParsedIntermediateCleanupSelectionObserver = {
  onVisit?: (candidate: ParsedIntermediateCleanupCandidate) => void;
};

type ResolvedParsedIntermediateCandidateFileSystem = {
  access: typeof access;
  lstat: typeof lstat;
  realpath: typeof realpath;
  usesNativeLstat: boolean;
};

type SafeParsedIntermediateMetadata = {
  metadata: Awaited<ReturnType<typeof lstat>>;
  modifiedAtNanoseconds?: string;
};

type KnownArtifact = {
  kind: RuntimeInventoryArtifactKind;
  sessionId: string | null;
};

type InventoryContext = {
  deletionCandidatesBySourceSessionId: Map<number, DeletionCandidateRow>;
  sessionsById: Map<string, SourceSessionRow>;
};

type ClassifiedArtifact = KnownArtifact & {
  lifecycleState: RuntimeInventoryLifecycleState;
  reason: string;
  retention: RuntimeInventoryRetentionState;
};

type Aggregate = {
  bytes: number;
  count: number;
  kind: RuntimeInventoryArtifactKind;
  lifecycleState: RuntimeInventoryLifecycleState;
  newestAt: Date | null;
  oldestAt: Date | null;
  reason: string;
  retention: RuntimeInventoryRetentionState;
};

/**
 * Summarize runtime file metadata without reading artifact contents, caching paths, or
 * retaining a per-file list. Session lifecycle comes from the ledger.
 */
export async function listRuntimeLifecycleInventory(
  database: DatabaseSync,
  options: RuntimeLifecycleInventoryOptions = {},
): Promise<RuntimeLifecycleInventory> {
  const runtimeRoot = getRuntimeRoot();
  const now = options.now ?? new Date();
  const filters: RuntimeLifecycleInventoryFilters = {
    older_than_days: options.olderThanDays ?? null,
    state: options.state ?? null,
  };
  const context = buildInventoryContext(database);
  const aggregates = new Map<string, Aggregate>();
  const staging = await inspectStagingRoot("read");
  const externalStaging = staging.root !== getRuntimePath("staging");

  for await (const file of walkRuntimeFiles(runtimeRoot)) {
    if (externalStaging && isPathWithin(file.path, getRuntimePath("staging"))) {
      continue;
    }
    if (options.olderThanDays !== undefined) {
      const cutoff = now.getTime() - options.olderThanDays * millisecondsPerDay;
      if (file.modifiedAt.getTime() > cutoff) {
        continue;
      }
    }

    const classified = classifyRuntimeArtifact(file.path, runtimeRoot, context);
    if (options.state !== undefined && classified.lifecycleState !== options.state) {
      continue;
    }

    const key = [
      classified.kind,
      classified.lifecycleState,
      classified.retention,
      classified.reason,
    ].join("\u0000");
    const aggregate = aggregates.get(key) ?? {
      bytes: 0,
      count: 0,
      kind: classified.kind,
      lifecycleState: classified.lifecycleState,
      newestAt: null,
      oldestAt: null,
      reason: classified.reason,
      retention: classified.retention,
    };

    aggregate.bytes += file.bytes;
    aggregate.count += 1;
    aggregate.oldestAt = earliest(aggregate.oldestAt, file.modifiedAt);
    aggregate.newestAt = latest(aggregate.newestAt, file.modifiedAt);
    aggregates.set(key, aggregate);
  }

  if (staging.available && externalStaging) {
    for await (const file of walkRuntimeFiles(staging.root)) {
      if (options.olderThanDays !== undefined) {
        const cutoff = now.getTime() - options.olderThanDays * millisecondsPerDay;
        if (file.modifiedAt.getTime() > cutoff) {
          continue;
        }
      }
      const classified = classifyStagingArtifact(file.path, staging.root, context);
      if (options.state !== undefined && classified.lifecycleState !== options.state) {
        continue;
      }
      addAggregate(aggregates, classified, file);
    }
  }

  const artifacts = [...aggregates.values()].sort(compareAggregates).map((aggregate) => ({
    bytes: aggregate.bytes,
    count: aggregate.count,
    kind: aggregate.kind,
    lifecycle_state: aggregate.lifecycleState,
    newest_at: aggregate.newestAt?.toISOString() ?? null,
    oldest_at: aggregate.oldestAt?.toISOString() ?? null,
    reason: aggregate.reason,
    retention: aggregate.retention,
  }));

  return {
    artifacts,
    filters,
    runtime_root: runtimeRoot,
    staging,
    total: {
      bytes: artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
      count: artifacts.reduce((sum, artifact) => sum + artifact.count, 0),
    },
  };
}

/**
 * Select individual parsed intermediates only when the same retention policy used by
 * the inventory confirms they are reclaimable. Callers own destructive application.
 */
export async function listParsedIntermediateCleanupCandidates(
  database: DatabaseSync,
  options: ParsedIntermediateCleanupOptions,
): Promise<ParsedIntermediateCleanupCandidate[]> {
  const stagingRoot = await preflightStagingReadRoot();
  const context = buildInventoryContext(database);
  const eligible: ParsedIntermediateCleanupCandidate[] = [];

  for await (const file of walkRuntimeFiles(stagingRoot)) {
    const classified = classifyStagingArtifact(file.path, stagingRoot, context);
    if (
      classified.kind !== "staging_parsed" ||
      classified.retention !== "reclaimable" ||
      classified.sessionId === null ||
      !isExactParsedIntermediatePath(file.path, stagingRoot)
    ) {
      continue;
    }

    const session = context.sessionsById.get(classified.sessionId);
    const candidate =
      session === undefined
        ? undefined
        : context.deletionCandidatesBySourceSessionId.get(session.id);
    if (candidate === undefined || !(await hasRequiredRetentionArtifacts(candidate))) {
      continue;
    }

    eligible.push({
      bytes: file.bytes,
      device: file.device,
      inode: file.inode,
      lifecycle_state: classified.lifecycleState,
      modified_at: file.modifiedAt.toISOString(),
      modified_at_nanoseconds: file.modifiedAtNanoseconds,
      path: file.path,
      reason: classified.reason,
      session_id: classified.sessionId,
    });
  }

  return selectParsedIntermediateCleanupCandidateSnapshot(eligible, options);
}

/**
 * Select cleanup candidates for exact sessions without traversing the runtime tree.
 * Each session can contribute only staging/<session>/parsed-records.json.
 */
export async function listParsedIntermediateCleanupCandidatesForSessions(
  database: DatabaseSync,
  sessionIds: readonly string[],
  options: ParsedIntermediateCleanupOptions,
  fileSystem: ParsedIntermediateCandidateFileSystem = { access, stat },
): Promise<ParsedIntermediateCleanupCandidate[]> {
  const resolvedFileSystem = resolveCandidateFileSystem(fileSystem);
  const eligible: ParsedIntermediateCleanupCandidate[] = [];
  for (const sessionId of new Set(sessionIds)) {
    const candidate = await inspectExactParsedIntermediateCandidate(
      database,
      sessionId,
      resolvedFileSystem,
    );
    if (candidate !== undefined) {
      eligible.push(candidate);
    }
  }
  return selectParsedIntermediateCleanupCandidateSnapshot(eligible, options);
}

/** Revalidate one immutable snapshot entry by its exact path and current retention state. */
export async function revalidateParsedIntermediateCleanupCandidate(
  database: DatabaseSync,
  expected: ParsedIntermediateCleanupCandidate,
  fileSystem: ParsedIntermediateCandidateFileSystem = { access, stat },
): Promise<ParsedIntermediateCleanupCandidate | undefined> {
  const resolvedFileSystem = resolveCandidateFileSystem(fileSystem);
  const current = await inspectExactParsedIntermediateCandidate(
    database,
    expected.session_id,
    resolvedFileSystem,
  );
  return current !== undefined && sameParsedIntermediateCleanupCandidateIdentity(expected, current)
    ? current
    : undefined;
}

/** Revalidate lifecycle and durable-artifact eligibility without rediscovering a file path. */
export async function revalidateParsedIntermediateCleanupCandidateRetention(
  database: DatabaseSync,
  expected: ParsedIntermediateCleanupCandidate,
  fileSystem: ParsedIntermediateCandidateFileSystem = { access, stat },
): Promise<boolean> {
  const eligibility = await inspectExactParsedIntermediateEligibility(
    database,
    expected.session_id,
    resolveCandidateFileSystem(fileSystem).access,
  );
  return (
    eligibility !== undefined &&
    eligibility.lifecycle_state === expected.lifecycle_state &&
    eligibility.path === expected.path &&
    eligibility.session_id === expected.session_id
  );
}

export function sameParsedIntermediateCleanupCandidateIdentity(
  left: ParsedIntermediateCleanupCandidate,
  right: ParsedIntermediateCleanupCandidate,
): boolean {
  return (
    left.bytes === right.bytes &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.lifecycle_state === right.lifecycle_state &&
    left.modified_at === right.modified_at &&
    (left.modified_at_nanoseconds === undefined ||
      right.modified_at_nanoseconds === undefined ||
      left.modified_at_nanoseconds === right.modified_at_nanoseconds) &&
    left.path === right.path &&
    left.session_id === right.session_id
  );
}

async function inspectExactParsedIntermediateCandidate(
  database: DatabaseSync,
  sessionId: string,
  fileSystem: ResolvedParsedIntermediateCandidateFileSystem,
): Promise<ParsedIntermediateCleanupCandidate | undefined> {
  const eligibility = await inspectExactParsedIntermediateEligibility(
    database,
    sessionId,
    fileSystem.access,
  );
  if (eligibility === undefined) {
    return undefined;
  }

  const inspected = await inspectSafeParsedIntermediatePath(
    eligibility.path,
    sessionId,
    fileSystem,
  );
  if (inspected === undefined) {
    return undefined;
  }
  const { metadata, modifiedAtNanoseconds } = inspected;

  return {
    bytes: Number(metadata.size),
    device: Number(metadata.dev),
    inode: Number(metadata.ino),
    lifecycle_state: eligibility.lifecycle_state,
    modified_at: metadata.mtime.toISOString(),
    ...(modifiedAtNanoseconds === undefined
      ? {}
      : { modified_at_nanoseconds: modifiedAtNanoseconds }),
    path: eligibility.path,
    reason: eligibility.reason,
    session_id: sessionId,
  };
}

async function inspectExactParsedIntermediateEligibility(
  database: DatabaseSync,
  sessionId: string,
  fileAccess: typeof access,
): Promise<
  | Pick<ParsedIntermediateCleanupCandidate, "lifecycle_state" | "path" | "reason" | "session_id">
  | undefined
> {
  const session = getSourceSessionBySessionId(database, sessionId);
  const deletionCandidate = getDeletionCandidateBySessionId(database, sessionId);
  if (
    session === null ||
    deletionCandidate === null ||
    deletionCandidate.source_session_id !== session.id
  ) {
    return undefined;
  }

  const classification = classifyRetention(
    "staging_parsed",
    session.current_lifecycle_state,
    deletionCandidate,
  );
  if (
    classification.retention !== "reclaimable" ||
    !(await hasRequiredRetentionArtifacts(deletionCandidate, fileAccess))
  ) {
    return undefined;
  }

  const path = getParsedStagingArtifactPath(sessionId);
  if (!isExactParsedIntermediatePath(path, getStagingRoot())) {
    return undefined;
  }
  return {
    lifecycle_state: session.current_lifecycle_state,
    path,
    reason: classification.reason,
    session_id: sessionId,
  };
}

async function inspectSafeParsedIntermediatePath(
  path: string,
  sessionId: string,
  fileSystem: ResolvedParsedIntermediateCandidateFileSystem,
): Promise<SafeParsedIntermediateMetadata | undefined> {
  const stagingRoot = getStagingRoot();
  const sessionDirectory = join(stagingRoot, sessionId);
  try {
    const [metadata, sessionMetadata, resolvedStagingRoot, resolvedSessionDirectory] =
      await Promise.all([
        fileSystem.lstat(path),
        fileSystem.lstat(sessionDirectory),
        fileSystem.realpath(stagingRoot),
        fileSystem.realpath(sessionDirectory),
      ]);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      sessionMetadata.isSymbolicLink() ||
      !sessionMetadata.isDirectory() ||
      relative(resolvedStagingRoot, resolvedSessionDirectory) !== sessionId
    ) {
      return undefined;
    }
    let modifiedAtNanoseconds: string | undefined;
    if (fileSystem.usesNativeLstat) {
      const exactMetadata = await lstat(path, { bigint: true });
      if (
        Number(exactMetadata.dev) !== Number(metadata.dev) ||
        Number(exactMetadata.ino) !== Number(metadata.ino)
      ) {
        return undefined;
      }
      modifiedAtNanoseconds = exactMetadata.mtimeNs.toString();
    }
    return {
      metadata,
      ...(modifiedAtNanoseconds === undefined ? {} : { modifiedAtNanoseconds }),
    };
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

function resolveCandidateFileSystem(
  fileSystem: ParsedIntermediateCandidateFileSystem,
): ResolvedParsedIntermediateCandidateFileSystem {
  return {
    access: fileSystem.access,
    lstat: fileSystem.lstat ?? lstat,
    realpath: fileSystem.realpath ?? realpath,
    usesNativeLstat: fileSystem.lstat === undefined || fileSystem.lstat === lstat,
  };
}

export function selectParsedIntermediateCleanupCandidateSnapshot(
  eligible: readonly ParsedIntermediateCleanupCandidate[],
  options: ParsedIntermediateCleanupOptions,
  observer: ParsedIntermediateCleanupSelectionObserver = {},
): ParsedIntermediateCleanupCandidate[] {
  const now = options.now ?? new Date();
  const cutoff = now.getTime() - options.olderThanDays * millisecondsPerDay;
  const selected = new Set<string>();
  let totalBytes = 0;
  for (const candidate of eligible) {
    observer.onVisit?.(candidate);
    totalBytes += candidate.bytes;
    if (Date.parse(candidate.modified_at) <= cutoff) {
      selected.add(candidate.path);
    }
  }

  if (options.maxTotalBytes !== undefined && totalBytes > options.maxTotalBytes) {
    const bytesToRemove = totalBytes - options.maxTotalBytes;
    for (const candidate of selectOldestCandidatesByBytes(eligible, bytesToRemove, observer)) {
      selected.add(candidate.path);
    }
  }

  // Deterministic oldest-first output: `eligible` follows walk/readdir order,
  // which is arbitrary (and differs between APFS and ext4), so the selection
  // filter alone made the returned order platform-dependent.
  return eligible
    .filter((candidate) => selected.has(candidate.path))
    .sort(compareParsedIntermediateCandidates);
}

function selectOldestCandidatesByBytes(
  eligible: readonly ParsedIntermediateCleanupCandidate[],
  bytesToRemove: number,
  observer: ParsedIntermediateCleanupSelectionObserver,
): ParsedIntermediateCleanupCandidate[] {
  const selected: ParsedIntermediateCleanupCandidate[] = [];
  let remainingBytes = bytesToRemove;
  let pool = [...eligible];

  while (remainingBytes > 0 && pool.length > 0) {
    const pivot = selectLinearPivot(pool, observer);
    const older: ParsedIntermediateCleanupCandidate[] = [];
    const equal: ParsedIntermediateCleanupCandidate[] = [];
    const newer: ParsedIntermediateCleanupCandidate[] = [];
    let olderBytes = 0;

    for (const candidate of pool) {
      observer.onVisit?.(candidate);
      const comparison = compareParsedIntermediateCandidates(candidate, pivot);
      if (comparison < 0) {
        older.push(candidate);
        olderBytes += candidate.bytes;
      } else if (comparison > 0) {
        newer.push(candidate);
      } else {
        equal.push(candidate);
      }
    }

    if (remainingBytes <= olderBytes) {
      pool = older;
      continue;
    }

    selected.push(...older);
    remainingBytes -= olderBytes;
    for (const candidate of equal) {
      selected.push(candidate);
      remainingBytes -= candidate.bytes;
      if (remainingBytes <= 0) {
        return selected;
      }
    }
    pool = newer;
  }

  return selected;
}

function selectLinearPivot(
  candidates: readonly ParsedIntermediateCleanupCandidate[],
  observer: ParsedIntermediateCleanupSelectionObserver,
): ParsedIntermediateCleanupCandidate {
  if (candidates.length <= 5) {
    for (const candidate of candidates) {
      observer.onVisit?.(candidate);
    }
    return [...candidates].sort(compareParsedIntermediateCandidates)[
      Math.floor(candidates.length / 2)
    ] as ParsedIntermediateCleanupCandidate;
  }

  const medians: ParsedIntermediateCleanupCandidate[] = [];
  for (let index = 0; index < candidates.length; index += 5) {
    const group = candidates.slice(index, index + 5);
    for (const candidate of group) {
      observer.onVisit?.(candidate);
    }
    group.sort(compareParsedIntermediateCandidates);
    const median = group[Math.floor(group.length / 2)];
    if (median !== undefined) {
      medians.push(median);
    }
  }
  return selectLinearPivot(medians, observer);
}

function compareParsedIntermediateCandidates(
  left: ParsedIntermediateCleanupCandidate,
  right: ParsedIntermediateCleanupCandidate,
): number {
  return left.modified_at.localeCompare(right.modified_at) || left.path.localeCompare(right.path);
}

export function isRuntimeInventoryLifecycleState(
  value: string,
): value is RuntimeInventoryLifecycleState {
  return runtimeInventoryLifecycleStates.includes(value as RuntimeInventoryLifecycleState);
}

export function renderRuntimeLifecycleInventory(report: RuntimeLifecycleInventory): string {
  const filterLines = [
    `Runtime root: ${report.runtime_root}`,
    `Staging root: ${report.staging.root} (${report.staging.available ? "available" : `unavailable: ${report.staging.error}`})`,
    `Filters: state=${report.filters.state ?? "all"}, older_than_days=${report.filters.older_than_days ?? "all"}`,
    `Total: ${report.total.count} files, ${formatBytes(report.total.bytes)}`,
    "",
    "Runtime lifecycle inventory",
    "kind | lifecycle | retention | count | bytes | oldest | newest | reason",
  ];

  if (report.artifacts.length === 0) {
    return [...filterLines, "No matching runtime files."].join("\n");
  }

  return [
    ...filterLines,
    ...report.artifacts.map(
      (artifact) =>
        `${artifact.kind} | ${artifact.lifecycle_state} | ${artifact.retention} | ${artifact.count} | ${formatBytes(artifact.bytes)} | ${artifact.oldest_at ?? "-"} | ${artifact.newest_at ?? "-"} | ${artifact.reason}`,
    ),
  ].join("\n");
}

function buildInventoryContext(database: DatabaseSync): InventoryContext {
  const sessionsById = new Map<string, SourceSessionRow>();

  for (const session of listSourceSessions(database)) {
    const existing = sessionsById.get(session.session_id);
    if (existing === undefined || session.id > existing.id) {
      sessionsById.set(session.session_id, session);
    }
  }

  const deletionCandidatesBySourceSessionId = new Map<number, DeletionCandidateRow>();
  for (const candidate of listDeletionCandidates(database)) {
    deletionCandidatesBySourceSessionId.set(candidate.source_session_id, candidate);
  }

  return { deletionCandidatesBySourceSessionId, sessionsById };
}

function classifyRuntimeArtifact(
  path: string,
  runtimeRoot: string,
  context: InventoryContext,
): ClassifiedArtifact {
  const relativePath = relative(runtimeRoot, path);
  const known = classifyByDirectory(relativePath, context);
  const session =
    known.sessionId === null ? null : (context.sessionsById.get(known.sessionId) ?? null);
  const lifecycleState = session?.current_lifecycle_state ?? unknownLifecycleState;
  const candidate =
    session === null ? null : (context.deletionCandidatesBySourceSessionId.get(session.id) ?? null);
  const classification = classifyRetention(known.kind, lifecycleState, candidate);

  return {
    ...known,
    lifecycleState,
    reason: classification.reason,
    retention: classification.retention,
  };
}

function classifyStagingArtifact(
  path: string,
  stagingRoot: string,
  context: InventoryContext,
): ClassifiedArtifact {
  const segments = relative(stagingRoot, path).split(sep);
  const sessionId = segments.length === 2 ? (segments[0] ?? null) : null;
  const kind: RuntimeInventoryArtifactKind =
    segments[1] === "parsed-records.json"
      ? "staging_parsed"
      : segments[1] === "reduced-session.json"
        ? "staging_reduced"
        : "unknown";
  const session = sessionId === null ? null : (context.sessionsById.get(sessionId) ?? null);
  const lifecycleState = session?.current_lifecycle_state ?? unknownLifecycleState;
  const candidate =
    session === null ? null : (context.deletionCandidatesBySourceSessionId.get(session.id) ?? null);
  const classification = classifyRetention(kind, lifecycleState, candidate);
  return {
    kind,
    lifecycleState,
    reason: classification.reason,
    retention: classification.retention,
    sessionId,
  };
}

function addAggregate(
  aggregates: Map<string, Aggregate>,
  classified: ClassifiedArtifact,
  file: { bytes: number; modifiedAt: Date },
): void {
  const key = [
    classified.kind,
    classified.lifecycleState,
    classified.retention,
    classified.reason,
  ].join("\u0000");
  const aggregate = aggregates.get(key) ?? {
    bytes: 0,
    count: 0,
    kind: classified.kind,
    lifecycleState: classified.lifecycleState,
    newestAt: null,
    oldestAt: null,
    reason: classified.reason,
    retention: classified.retention,
  };
  aggregate.bytes += file.bytes;
  aggregate.count += 1;
  aggregate.oldestAt = earliest(aggregate.oldestAt, file.modifiedAt);
  aggregate.newestAt = latest(aggregate.newestAt, file.modifiedAt);
  aggregates.set(key, aggregate);
}

function isPathWithin(path: string, root: string): boolean {
  const child = relative(root, path);
  return child.length > 0 && child !== ".." && !child.startsWith(`..${sep}`);
}

function classifyByDirectory(relativePath: string, context: InventoryContext): KnownArtifact {
  const segments = relativePath.split(sep);
  const first = segments[0];
  const second = segments[1];
  const third = segments[2];
  const sessionId = sessionIdFromKnownFilename(segments.at(-1) ?? "", context.sessionsById);

  if (first === "archives") {
    return { kind: "archive", sessionId };
  }
  if (first === "index") {
    return { kind: "index", sessionId: null };
  }
  if (first === "ledger") {
    return { kind: "ledger", sessionId: null };
  }
  if (first === "reports") {
    return { kind: "report", sessionId };
  }
  if (first === "reviews") {
    return { kind: "review", sessionId };
  }
  if (first === "deletes" && (second === "receipts" || second === "tombstones")) {
    return { kind: "receipt", sessionId };
  }
  if (first === "sources" && second === "manifests") {
    return { kind: "manifest", sessionId };
  }
  if (
    first === "summaries" &&
    second === "by-session" &&
    (segments.at(-1) === "summary.json" || segments.at(-1) === "summary.md")
  ) {
    return { kind: "summary", sessionId: third ?? null };
  }
  if (
    first === "staging" &&
    second !== undefined &&
    segments.length === 3 &&
    segments[2] === "parsed-records.json"
  ) {
    return { kind: "staging_parsed", sessionId: second };
  }
  if (
    first === "staging" &&
    second !== undefined &&
    segments.length === 3 &&
    segments[2] === "reduced-session.json"
  ) {
    return { kind: "staging_reduced", sessionId: second };
  }
  if (first === "knowledge" && second === "projects-reviewed") {
    return { kind: "reviewed_memory", sessionId };
  }
  if (first === "knowledge") {
    return { kind: "knowledge", sessionId };
  }
  if (first === "exports" && second === "wiki-memory") {
    return { kind: "reviewed_memory", sessionId: null };
  }

  return { kind: "unknown", sessionId: null };
}

function sessionIdFromKnownFilename(
  filename: string,
  sessionsById: Map<string, SourceSessionRow>,
): string | null {
  const firstDot = filename.indexOf(".");
  const candidate = firstDot >= 0 ? filename.slice(0, firstDot) : filename;
  return sessionsById.has(candidate) ? candidate : null;
}

function isExactParsedIntermediatePath(path: string, stagingRoot: string): boolean {
  const segments = relative(stagingRoot, path).split(sep);
  return (
    segments.length === 2 && segments[0] !== undefined && segments[1] === "parsed-records.json"
  );
}

async function hasRequiredRetentionArtifacts(
  candidate: DeletionCandidateRow,
  fileAccess: typeof access = access,
): Promise<boolean> {
  const manifestPresent =
    (await pathExists(
      getSessionManifestPathForRevision(candidate.session_id, candidate.source_hash),
      fileAccess,
    )) || (await pathExists(getSessionManifestPath(candidate.session_id), fileAccess));
  const [
    projectKnowledgePresent,
    receiptPresent,
    summaryJsonPresent,
    summaryMarkdownPresent,
    userKnowledgePresent,
  ] = await Promise.all([
    pathExists(
      getProjectKnowledgeSessionPath(candidate.project_key, candidate.session_id),
      fileAccess,
    ),
    pathExists(getRetentionReceiptPath(candidate.session_id), fileAccess),
    pathExists(getSessionSummaryJsonPath(candidate.session_id), fileAccess),
    pathExists(getSessionSummaryMarkdownPath(candidate.session_id), fileAccess),
    pathExists(getUserKnowledgeSessionPath("operator", candidate.session_id), fileAccess),
  ]);

  return (
    manifestPresent &&
    receiptPresent &&
    summaryJsonPresent &&
    summaryMarkdownPresent &&
    (candidate.candidate_state === "discardable_no_signal" ||
      projectKnowledgePresent ||
      userKnowledgePresent)
  );
}

async function pathExists(path: string, fileAccess: typeof access = access): Promise<boolean> {
  try {
    await fileAccess(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

function classifyRetention(
  kind: RuntimeInventoryArtifactKind,
  lifecycleState: RuntimeInventoryLifecycleState,
  candidate: DeletionCandidateRow | null,
): Pick<ClassifiedArtifact, "reason" | "retention"> {
  if (kind === "unknown") {
    return {
      reason: "No lifecycle policy is registered for this runtime path.",
      retention: "unknown",
    };
  }

  if (kind === "staging_parsed") {
    if (lifecycleState === "stale" || lifecycleState === "error") {
      return {
        reason: "Session is stale or failed; parsed data remains required for recovery.",
        retention: "required",
      };
    }
    if (
      candidate?.safe_to_delete === 1 &&
      (candidate.candidate_state === "ready" ||
        candidate.candidate_state === "discardable_no_signal" ||
        candidate.candidate_state === "applied")
    ) {
      return {
        reason:
          "Parsed intermediate has durable downstream retention artifacts confirmed by a safe deletion candidate.",
        retention: "reclaimable",
      };
    }
    return {
      reason:
        "Parsed intermediate remains required until a safe deletion candidate confirms durable downstream artifacts.",
      retention: "required",
    };
  }

  if (kind === "staging_reduced") {
    return {
      reason: "Reduced session remains required by archive, re-extract, and report readers.",
      retention: "required",
    };
  }

  const reasons: Record<
    Exclude<RuntimeInventoryArtifactKind, "staging_parsed" | "staging_reduced" | "unknown">,
    string
  > = {
    archive: "Archive evidence is retained for lifecycle provenance.",
    index: "Read index is retained for search and report consumers.",
    knowledge: "Durable knowledge artifact is retained for review and recall consumers.",
    ledger: "Ledger is the authoritative lifecycle state store.",
    manifest: "Immutable manifest is required provenance evidence.",
    receipt: "Receipt is required lifecycle and deletion audit evidence.",
    report: "Generated report retention is not yet enacted; retain conservatively.",
    review: "Review artifact is required for review state and audit evidence.",
    reviewed_memory: "Reviewed memory is retained for recall and downstream export consumers.",
    summary: "Summary is a durable session artifact required for audit and read consumers.",
  };

  return { reason: reasons[kind], retention: "required" };
}

async function* walkRuntimeFiles(root: string): AsyncGenerator<{
  bytes: number;
  device: number;
  inode: number;
  modifiedAt: Date;
  modifiedAtNanoseconds: string;
  path: string;
}> {
  const pendingDirectories = [root];

  while (pendingDirectories.length > 0) {
    const directoryPath = pendingDirectories.pop();
    if (directoryPath === undefined) {
      continue;
    }

    let directory: Dir;
    try {
      directory = await opendir(directoryPath);
    } catch (error) {
      if (isMissingPathError(error)) {
        continue;
      }
      throw error;
    }

    for await (const entry of directory) {
      const entryPath = `${directoryPath}${sep}${entry.name}`;
      if (entry.isDirectory()) {
        pendingDirectories.push(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      try {
        const metadata = await stat(entryPath, { bigint: true });
        yield {
          bytes: Number(metadata.size),
          device: Number(metadata.dev),
          inode: Number(metadata.ino),
          modifiedAt: new Date(Number(metadata.mtimeNs) / 1_000_000),
          modifiedAtNanoseconds: metadata.mtimeNs.toString(),
          path: entryPath,
        };
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error;
        }
      }
    }
  }
}

function earliest(current: Date | null, candidate: Date): Date {
  return current === null || candidate < current ? candidate : current;
}

function latest(current: Date | null, candidate: Date): Date {
  return current === null || candidate > current ? candidate : current;
}

function compareAggregates(left: Aggregate, right: Aggregate): number {
  return (
    left.kind.localeCompare(right.kind) ||
    left.lifecycleState.localeCompare(right.lifecycleState) ||
    left.retention.localeCompare(right.retention) ||
    left.reason.localeCompare(right.reason)
  );
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KiB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
