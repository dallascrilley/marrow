import type { DatabaseSync } from "node:sqlite";

import { openLedgerDatabase } from "./migrations.js";
import type { SourceSession } from "../models/canonical.js";
import {
  currentTimestampExpression,
  getAllDerivedPhases,
  getDownstreamPhases,
  normalizeLifecycleState,
  resolveLifecycleStateForPhase,
  toSourceSessionInsertRecord,
  type DeletionCandidateInput,
  type DeletionCandidateRow,
  type LifecycleState,
  type PhaseCheckpointRow,
  type PhaseName,
  type PhaseState,
  type PhaseTransitionInput,
  type ReviewQueueEntryInput,
  type ReviewQueueEntryRow,
  type RunHistoryInput,
  type RunHistoryRow,
  type SourceSessionRow
} from "./queries.js";

export type UpsertSourceSessionResult = {
  sourceChanged: boolean;
  sourceSession: SourceSessionRow;
  stalePhases: PhaseName[];
};

export async function createLedger(): Promise<DatabaseSync> {
  return openLedgerDatabase();
}

function mapSourceSessionRow(row: Record<string, unknown>): SourceSessionRow {
  return {
    content_revision: Number(row.content_revision),
    conversation_id: String(row.conversation_id),
    created_at: String(row.created_at),
    current_lifecycle_state: normalizeLifecycleState(String(row.current_lifecycle_state)),
    id: Number(row.id),
    ingest_status: String(row.ingest_status) as SourceSession["ingest_status"],
    last_ingested_at: String(row.last_ingested_at),
    project_key: String(row.project_key),
    retention_status: String(row.retention_status) as SourceSession["retention_status"],
    session_id: String(row.session_id),
    source_format: String(row.source_format),
    source_hash: String(row.source_hash),
    source_path: String(row.source_path),
    source_tool: String(row.source_tool),
    started_at: String(row.started_at),
    updated_at: String(row.updated_at),
    workspace_path: String(row.workspace_path)
  };
}

function mapPhaseCheckpointRow(row: Record<string, unknown>): PhaseCheckpointRow {
  return {
    completed_at: row.completed_at === null ? null : String(row.completed_at),
    current_lifecycle_state: normalizeLifecycleState(String(row.current_lifecycle_state)),
    details_json: String(row.details_json),
    invalidated_at: row.invalidated_at === null ? null : String(row.invalidated_at),
    phase_name: String(row.phase_name) as PhaseName,
    phase_state: String(row.phase_state) as PhaseState,
    run_id: row.run_id === null ? null : Number(row.run_id),
    session_id: String(row.session_id),
    source_hash: String(row.source_hash),
    source_session_id: Number(row.source_session_id),
    updated_at: String(row.updated_at)
  };
}

function mapRunHistoryRow(row: Record<string, unknown>): RunHistoryRow {
  return {
    details_json: String(row.details_json),
    finished_at: row.finished_at === null ? null : String(row.finished_at),
    id: Number(row.id),
    phase_name: String(row.phase_name) as PhaseName,
    phase_state: String(row.phase_state) as PhaseState,
    session_id: String(row.session_id),
    source_hash: String(row.source_hash),
    source_session_id: Number(row.source_session_id),
    started_at: String(row.started_at)
  };
}

function mapReviewQueueEntryRow(row: Record<string, unknown>): ReviewQueueEntryRow {
  return {
    current_lifecycle_state: normalizeLifecycleState(String(row.current_lifecycle_state)),
    enqueued_at: String(row.enqueued_at),
    id: Number(row.id),
    project_key: String(row.project_key),
    queue_state: String(row.queue_state),
    reason: String(row.reason),
    review_kind: String(row.review_kind),
    session_id: String(row.session_id),
    source_hash: String(row.source_hash),
    source_session_id: Number(row.source_session_id),
    updated_at: String(row.updated_at)
  };
}

function mapDeletionCandidateRow(row: Record<string, unknown>): DeletionCandidateRow {
  return {
    candidate_state: String(row.candidate_state),
    current_lifecycle_state: normalizeLifecycleState(String(row.current_lifecycle_state)),
    id: Number(row.id),
    project_key: String(row.project_key),
    reason: String(row.reason),
    safe_to_delete: Number(row.safe_to_delete),
    session_id: String(row.session_id),
    source_hash: String(row.source_hash),
    source_session_id: Number(row.source_session_id),
    updated_at: String(row.updated_at)
  };
}

function transaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec("BEGIN IMMEDIATE");

  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function getSourceSessionByIdentity(
  database: DatabaseSync,
  identity: Pick<SourceSession, "session_id" | "source_path" | "source_tool">
): SourceSessionRow | null {
  const row = database
    .prepare(
      `SELECT *
       FROM source_sessions
       WHERE source_tool = ? AND source_path = ? AND session_id = ?`
    )
    .get(identity.source_tool, identity.source_path, identity.session_id) as
    | Record<string, unknown>
    | undefined;

  return row ? mapSourceSessionRow(row) : null;
}

function getSourceSessionById(database: DatabaseSync, sourceSessionId: number): SourceSessionRow {
  const row = database
    .prepare("SELECT * FROM source_sessions WHERE id = ?")
    .get(sourceSessionId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new Error(`Unknown source session id: ${sourceSessionId}`);
  }

  return mapSourceSessionRow(row);
}

function invalidateDerivedData(
  database: DatabaseSync,
  sourceSession: SourceSessionRow
): PhaseName[] {
  const stalePhases = database
    .prepare(
      `SELECT phase_name
       FROM phase_checkpoints
       WHERE source_session_id = ? AND phase_state = 'completed'
       ORDER BY rowid`
    )
    .all(sourceSession.id) as Array<Record<string, unknown>>;

  if (stalePhases.length === 0) {
    database
      .prepare(
        `UPDATE source_sessions
         SET current_lifecycle_state = 'discovered'
         WHERE id = ?`
      )
      .run(sourceSession.id);

    return [];
  }

  const knownPhases = new Set(getAllDerivedPhases());
  const phaseNames = stalePhases
    .map((row) => String(row.phase_name) as PhaseName)
    .filter((phaseName) => knownPhases.has(phaseName));

  database
    .prepare(
      `UPDATE phase_checkpoints
       SET
         phase_state = 'stale',
         current_lifecycle_state = 'stale',
         invalidated_at = ${currentTimestampExpression},
         updated_at = ${currentTimestampExpression}
       WHERE source_session_id = ? AND phase_state = 'completed'`
    )
    .run(sourceSession.id);

  database
    .prepare(
      `UPDATE review_queue_entries
       SET
         current_lifecycle_state = 'stale',
         updated_at = ${currentTimestampExpression},
         queue_state = CASE
           WHEN queue_state = 'completed' THEN 'stale'
           ELSE queue_state
         END
       WHERE source_session_id = ?`
    )
    .run(sourceSession.id);

  database
    .prepare(
      `UPDATE deletion_candidates
       SET
         current_lifecycle_state = 'stale',
         updated_at = ${currentTimestampExpression},
         candidate_state = CASE
           WHEN candidate_state = 'ready' THEN 'stale'
           ELSE candidate_state
         END,
         safe_to_delete = 0
       WHERE source_session_id = ?`
    )
    .run(sourceSession.id);

  database
    .prepare(
      `UPDATE source_sessions
       SET current_lifecycle_state = 'stale'
       WHERE id = ?`
    )
    .run(sourceSession.id);

  return phaseNames;
}

export function upsertSourceSession(
  database: DatabaseSync,
  session: SourceSession
): UpsertSourceSessionResult {
  return transaction(database, () => {
    const existing = getSourceSessionByIdentity(database, session);
    const initialLifecycleState: LifecycleState = existing?.current_lifecycle_state ?? session.ingest_status;
    const record = toSourceSessionInsertRecord(session, initialLifecycleState);

    if (!existing) {
      database
        .prepare(
          `INSERT INTO source_sessions (
             source_tool,
             source_format,
             source_path,
             source_hash,
             workspace_path,
             project_key,
             session_id,
             conversation_id,
             started_at,
             updated_at,
             ingest_status,
             retention_status,
             current_lifecycle_state
           ) VALUES (
             @source_tool,
             @source_format,
             @source_path,
             @source_hash,
             @workspace_path,
             @project_key,
             @session_id,
             @conversation_id,
             @started_at,
             @updated_at,
             @ingest_status,
             @retention_status,
             @current_lifecycle_state
           )`
        )
        .run(record);

      return {
        sourceChanged: false,
        sourceSession: getSourceSessionByIdentity(database, session)!,
        stalePhases: []
      };
    }

    const sourceChanged = existing.source_hash !== session.source_hash;
    const nextLifecycleState: LifecycleState = sourceChanged
      ? "stale"
      : existing.current_lifecycle_state;

    database
      .prepare(
        `UPDATE source_sessions
         SET
           source_format = @source_format,
           source_hash = @source_hash,
           workspace_path = @workspace_path,
           project_key = @project_key,
           conversation_id = @conversation_id,
           started_at = @started_at,
           updated_at = @updated_at,
           ingest_status = @ingest_status,
           retention_status = @retention_status,
           current_lifecycle_state = @current_lifecycle_state,
           content_revision = CASE
             WHEN source_hash = @source_hash THEN content_revision
             ELSE content_revision + 1
           END,
           last_ingested_at = ${currentTimestampExpression}
         WHERE id = @id`
      )
      .run({
        conversation_id: session.conversation_id,
        current_lifecycle_state: nextLifecycleState,
        id: existing.id,
        ingest_status: session.ingest_status,
        project_key: session.project_key,
        retention_status: session.retention_status,
        source_format: session.source_format,
        source_hash: session.source_hash,
        started_at: session.started_at,
        updated_at: session.updated_at,
        workspace_path: session.workspace_path
      });

    const refreshed = getSourceSessionById(database, existing.id);
    const stalePhases = sourceChanged ? invalidateDerivedData(database, refreshed) : [];

    return {
      sourceChanged,
      sourceSession: getSourceSessionById(database, existing.id),
      stalePhases
    };
  });
}

export function insertRunHistory(database: DatabaseSync, input: RunHistoryInput): RunHistoryRow {
  const sourceSession = getSourceSessionById(database, input.sourceSessionId);

  const result = database
    .prepare(
      `INSERT INTO run_history (
         source_session_id,
         session_id,
         phase_name,
         phase_state,
         source_hash,
         details_json,
         started_at,
         finished_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.sourceSessionId,
      input.sessionId,
      input.phaseName,
      input.phaseState,
      input.sourceHash,
      input.detailsJson ?? "{}",
      input.startedAt ?? sourceSession.updated_at,
      input.finishedAt ?? null
    );

  const row = database
    .prepare("SELECT * FROM run_history WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as Record<string, unknown> | undefined;

  if (!row) {
    throw new Error("Run history insert did not return a row.");
  }

  return mapRunHistoryRow(row);
}

export function transitionPhase(
  database: DatabaseSync,
  input: PhaseTransitionInput
): PhaseCheckpointRow {
  return transaction(database, () => {
    const sourceSession = getSourceSessionById(database, input.sourceSessionId);
    const lifecycleState = resolveLifecycleStateForPhase(input.phaseName, input.phaseState);
    const sourceHash = input.sourceHash ?? sourceSession.source_hash;
    const phaseDetails = input.detailsJson ?? "{}";

    database
      .prepare(
        `INSERT INTO phase_checkpoints (
           source_session_id,
           session_id,
           phase_name,
           phase_state,
           source_hash,
           details_json,
           current_lifecycle_state,
           run_id,
           completed_at,
           invalidated_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${currentTimestampExpression})
         ON CONFLICT(source_session_id, phase_name) DO UPDATE SET
           phase_state = excluded.phase_state,
           source_hash = excluded.source_hash,
           details_json = excluded.details_json,
           current_lifecycle_state = excluded.current_lifecycle_state,
           run_id = excluded.run_id,
           completed_at = excluded.completed_at,
           invalidated_at = excluded.invalidated_at,
           updated_at = ${currentTimestampExpression}`
      )
      .run(
        input.sourceSessionId,
        sourceSession.session_id,
        input.phaseName,
        input.phaseState,
        sourceHash,
        phaseDetails,
        lifecycleState,
        input.runId ?? null,
        input.completedAt ?? (input.phaseState === "completed" ? sourceSession.updated_at : null),
        input.phaseState === "stale" ? sourceSession.updated_at : null
      );

    database
      .prepare(
        `UPDATE source_sessions
         SET current_lifecycle_state = ?, ingest_status = ?, last_ingested_at = ${currentTimestampExpression}
         WHERE id = ?`
      )
      .run(lifecycleState, lifecycleState === "stale" ? sourceSession.ingest_status : input.phaseName, sourceSession.id);

    if (input.phaseState === "completed") {
      const downstreamPhases = getDownstreamPhases(input.phaseName);

      if (downstreamPhases.length > 0) {
      database
        .prepare(
          `UPDATE phase_checkpoints
           SET
             phase_state = 'stale',
             current_lifecycle_state = 'stale',
             invalidated_at = ${currentTimestampExpression},
             updated_at = ${currentTimestampExpression}
           WHERE source_session_id = ? AND phase_name IN (${downstreamPhases
             .map(() => "?")
             .join(", ")}) AND phase_name != ? AND phase_state = 'completed'`
        )
        .run(sourceSession.id, ...downstreamPhases, input.phaseName);
      }
    }

    const row = database
      .prepare(
        `SELECT *
         FROM phase_checkpoints
         WHERE source_session_id = ? AND phase_name = ?`
      )
      .get(sourceSession.id, input.phaseName) as Record<string, unknown> | undefined;

    if (!row) {
      throw new Error(`Phase checkpoint missing after transition: ${input.phaseName}`);
    }

    return mapPhaseCheckpointRow(row);
  });
}

export function upsertReviewQueueEntry(
  database: DatabaseSync,
  input: ReviewQueueEntryInput
): ReviewQueueEntryRow {
  database
    .prepare(
      `INSERT INTO review_queue_entries (
         source_session_id,
         session_id,
         project_key,
         review_kind,
         queue_state,
         current_lifecycle_state,
         source_hash,
         reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_session_id, review_kind) DO UPDATE SET
         queue_state = excluded.queue_state,
         current_lifecycle_state = excluded.current_lifecycle_state,
         source_hash = excluded.source_hash,
         reason = excluded.reason,
         updated_at = ${currentTimestampExpression}`
    )
    .run(
      input.sourceSessionId,
      input.sessionId,
      input.projectKey,
      input.reviewKind,
      input.queueState,
      input.currentLifecycleState,
      input.sourceHash,
      input.reason
    );

  const row = database
    .prepare(
      `SELECT *
       FROM review_queue_entries
       WHERE source_session_id = ? AND review_kind = ?`
    )
    .get(input.sourceSessionId, input.reviewKind) as Record<string, unknown> | undefined;

  if (!row) {
    throw new Error(`Review queue entry missing after upsert: ${input.reviewKind}`);
  }

  return mapReviewQueueEntryRow(row);
}

export function upsertDeletionCandidate(
  database: DatabaseSync,
  input: DeletionCandidateInput
): DeletionCandidateRow {
  database
    .prepare(
      `INSERT INTO deletion_candidates (
         source_session_id,
         session_id,
         project_key,
         current_lifecycle_state,
         source_hash,
         safe_to_delete,
         candidate_state,
         reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_session_id) DO UPDATE SET
         current_lifecycle_state = excluded.current_lifecycle_state,
         source_hash = excluded.source_hash,
         safe_to_delete = excluded.safe_to_delete,
         candidate_state = excluded.candidate_state,
         reason = excluded.reason,
         updated_at = ${currentTimestampExpression}`
    )
    .run(
      input.sourceSessionId,
      input.sessionId,
      input.projectKey,
      input.currentLifecycleState,
      input.sourceHash,
      input.safeToDelete ? 1 : 0,
      input.candidateState,
      input.reason
    );

  const row = database
    .prepare("SELECT * FROM deletion_candidates WHERE source_session_id = ?")
    .get(input.sourceSessionId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new Error(`Deletion candidate missing after upsert: ${input.sourceSessionId}`);
  }

  return mapDeletionCandidateRow(row);
}

export function listPhaseCheckpoints(
  database: DatabaseSync,
  sourceSessionId: number
): PhaseCheckpointRow[] {
  const rows = database
    .prepare(
      `SELECT *
       FROM phase_checkpoints
       WHERE source_session_id = ?
       ORDER BY phase_name`
    )
    .all(sourceSessionId) as Array<Record<string, unknown>>;

  return rows.map(mapPhaseCheckpointRow);
}

export function getPhaseCheckpoint(
  database: DatabaseSync,
  sourceSessionId: number,
  phaseName: PhaseName
): PhaseCheckpointRow | null {
  const row = database
    .prepare(
      `SELECT *
       FROM phase_checkpoints
       WHERE source_session_id = ? AND phase_name = ?`
    )
    .get(sourceSessionId, phaseName) as Record<string, unknown> | undefined;

  return row ? mapPhaseCheckpointRow(row) : null;
}

export function getSourceSessionBySessionId(
  database: DatabaseSync,
  sessionId: string
): SourceSessionRow | null {
  const row = database
    .prepare(
      `SELECT *
       FROM source_sessions
       WHERE session_id = ?
       ORDER BY id DESC
       LIMIT 1`
    )
    .get(sessionId) as Record<string, unknown> | undefined;

  return row ? mapSourceSessionRow(row) : null;
}

export function listSourceSessions(database: DatabaseSync): SourceSessionRow[] {
  const rows = database
    .prepare(
      `SELECT *
       FROM source_sessions
       ORDER BY updated_at ASC, id ASC`
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map(mapSourceSessionRow);
}

export function listSourceSessionsByLifecycle(
  database: DatabaseSync,
  lifecycleStates: readonly LifecycleState[]
): SourceSessionRow[] {
  if (lifecycleStates.length === 0) {
    return [];
  }

  const rows = database
    .prepare(
      `SELECT *
       FROM source_sessions
       WHERE current_lifecycle_state IN (${lifecycleStates.map(() => "?").join(", ")})
       ORDER BY updated_at ASC, id ASC`
    )
    .all(...lifecycleStates) as Array<Record<string, unknown>>;

  return rows.map(mapSourceSessionRow);
}

export function listReviewQueueEntries(database: DatabaseSync): ReviewQueueEntryRow[] {
  const rows = database
    .prepare(
      `SELECT *
       FROM review_queue_entries
       ORDER BY updated_at ASC, id ASC`
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map(mapReviewQueueEntryRow);
}

export function getReviewQueueEntryBySessionId(
  database: DatabaseSync,
  sessionId: string
): ReviewQueueEntryRow | null {
  const row = database
    .prepare(
      `SELECT *
       FROM review_queue_entries
       WHERE session_id = ?
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`
    )
    .get(sessionId) as Record<string, unknown> | undefined;

  return row ? mapReviewQueueEntryRow(row) : null;
}

export function listDeletionCandidates(database: DatabaseSync): DeletionCandidateRow[] {
  const rows = database
    .prepare(
      `SELECT *
       FROM deletion_candidates
       ORDER BY updated_at ASC, id ASC`
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map(mapDeletionCandidateRow);
}

export function getDeletionCandidateBySessionId(
  database: DatabaseSync,
  sessionId: string
): DeletionCandidateRow | null {
  const row = database
    .prepare(
      `SELECT *
       FROM deletion_candidates
       WHERE session_id = ?
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`
    )
    .get(sessionId) as Record<string, unknown> | undefined;

  return row ? mapDeletionCandidateRow(row) : null;
}

export function markDeletionCandidateApplied(
  database: DatabaseSync,
  sourceSessionId: number
): DeletionCandidateRow {
  database
    .prepare(
      `UPDATE deletion_candidates
       SET
         candidate_state = 'applied',
         current_lifecycle_state = 'deleted',
         updated_at = ${currentTimestampExpression}
       WHERE source_session_id = ?`
    )
    .run(sourceSessionId);

  const row = database
    .prepare("SELECT * FROM deletion_candidates WHERE source_session_id = ?")
    .get(sourceSessionId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new Error(`Deletion candidate missing after apply: ${sourceSessionId}`);
  }

  return mapDeletionCandidateRow(row);
}

export function listRunHistory(
  database: DatabaseSync,
  sourceSessionId: number
): RunHistoryRow[] {
  const rows = database
    .prepare(
      `SELECT *
       FROM run_history
       WHERE source_session_id = ?
       ORDER BY id ASC`
    )
    .all(sourceSessionId) as Array<Record<string, unknown>>;

  return rows.map(mapRunHistoryRow);
}

export function getOperationalStats(database: DatabaseSync): {
  deletionCandidates: Record<string, number>;
  reviewQueue: Record<string, number>;
  sessionsByLifecycle: Record<string, number>;
  totalSessions: number;
} {
  const lifecycleRows = database
    .prepare(
      `SELECT current_lifecycle_state AS state, COUNT(*) AS total
       FROM source_sessions
       GROUP BY current_lifecycle_state`
    )
    .all() as Array<Record<string, unknown>>;
  const reviewRows = database
    .prepare(
      `SELECT queue_state AS state, COUNT(*) AS total
       FROM review_queue_entries
       GROUP BY queue_state`
    )
    .all() as Array<Record<string, unknown>>;
  const deletionRows = database
    .prepare(
      `SELECT candidate_state AS state, COUNT(*) AS total
       FROM deletion_candidates
       GROUP BY candidate_state`
    )
    .all() as Array<Record<string, unknown>>;

  return {
    deletionCandidates: toCountMap(deletionRows),
    reviewQueue: toCountMap(reviewRows),
    sessionsByLifecycle: toCountMap(lifecycleRows),
    totalSessions: listSourceSessions(database).length
  };
}

function toCountMap(rows: Array<Record<string, unknown>>): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const row of rows) {
    counts[String(row.state)] = Number(row.total);
  }

  return counts;
}
