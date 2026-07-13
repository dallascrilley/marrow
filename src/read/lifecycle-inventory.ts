import type { Dir } from "node:fs";
import { access, opendir, stat } from "node:fs/promises";
import { relative, sep } from "node:path";

import type { DatabaseSync } from "node:sqlite";

import { getRuntimeRoot } from "../config/paths.js";
import { listDeletionCandidates, listSourceSessions } from "../db/ledger.js";
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
  path: string;
  reason: string;
  session_id: string;
}

export interface ParsedIntermediateCleanupOptions {
  now?: Date;
  olderThanDays: number;
}

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

  for await (const file of walkRuntimeFiles(runtimeRoot)) {
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
  const runtimeRoot = getRuntimeRoot();
  const now = options.now ?? new Date();
  const cutoff = now.getTime() - options.olderThanDays * millisecondsPerDay;
  const context = buildInventoryContext(database);
  const candidates: ParsedIntermediateCleanupCandidate[] = [];

  for await (const file of walkRuntimeFiles(runtimeRoot)) {
    if (file.modifiedAt.getTime() > cutoff) {
      continue;
    }

    const classified = classifyRuntimeArtifact(file.path, runtimeRoot, context);
    if (
      classified.kind !== "staging_parsed" ||
      classified.retention !== "reclaimable" ||
      classified.sessionId === null ||
      !isExactParsedIntermediatePath(file.path, runtimeRoot)
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

    candidates.push({
      bytes: file.bytes,
      device: file.device,
      inode: file.inode,
      lifecycle_state: classified.lifecycleState,
      modified_at: file.modifiedAt.toISOString(),
      path: file.path,
      reason: classified.reason,
      session_id: classified.sessionId,
    });
  }

  return candidates.sort((left, right) => left.path.localeCompare(right.path));
}

export function isRuntimeInventoryLifecycleState(
  value: string,
): value is RuntimeInventoryLifecycleState {
  return runtimeInventoryLifecycleStates.includes(value as RuntimeInventoryLifecycleState);
}

export function renderRuntimeLifecycleInventory(report: RuntimeLifecycleInventory): string {
  const filterLines = [
    `Runtime root: ${report.runtime_root}`,
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

function isExactParsedIntermediatePath(path: string, runtimeRoot: string): boolean {
  const segments = relative(runtimeRoot, path).split(sep);
  return (
    segments.length === 3 &&
    segments[0] === "staging" &&
    segments[1] !== undefined &&
    segments[2] === "parsed-records.json"
  );
}

async function hasRequiredRetentionArtifacts(candidate: DeletionCandidateRow): Promise<boolean> {
  const manifestPresent =
    (await pathExists(
      getSessionManifestPathForRevision(candidate.session_id, candidate.source_hash),
    )) || (await pathExists(getSessionManifestPath(candidate.session_id)));
  const [
    projectKnowledgePresent,
    receiptPresent,
    summaryJsonPresent,
    summaryMarkdownPresent,
    userKnowledgePresent,
  ] = await Promise.all([
    pathExists(getProjectKnowledgeSessionPath(candidate.project_key, candidate.session_id)),
    pathExists(getRetentionReceiptPath(candidate.session_id)),
    pathExists(getSessionSummaryJsonPath(candidate.session_id)),
    pathExists(getSessionSummaryMarkdownPath(candidate.session_id)),
    pathExists(getUserKnowledgeSessionPath("operator", candidate.session_id)),
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
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
        const metadata = await stat(entryPath);
        yield {
          bytes: metadata.size,
          device: metadata.dev,
          inode: metadata.ino,
          modifiedAt: metadata.mtime,
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
