import type { IngestStatus, RetentionStatus, SourceSession } from "../models/canonical.js";

export const ledgerDatabaseFileName = "sessions.sqlite";

export const phaseNames = [
  "parsed",
  "reduced",
  "summarized",
  "extracted",
  "archived",
  "deletion_candidate",
  "deleted"
] as const;

export const phaseStates = [
  "pending",
  "running",
  "completed",
  "stale",
  "failed",
  "skipped"
] as const;

export type PhaseName = (typeof phaseNames)[number];
export type PhaseState = (typeof phaseStates)[number];
export type LifecycleState = IngestStatus | "stale";

export type SourceSessionRow = SourceSession & {
  content_revision: number;
  created_at: string;
  current_lifecycle_state: LifecycleState;
  id: number;
  last_ingested_at: string;
};

export type PhaseCheckpointRow = {
  completed_at: string | null;
  current_lifecycle_state: LifecycleState;
  details_json: string;
  invalidated_at: string | null;
  phase_name: PhaseName;
  phase_state: PhaseState;
  run_id: number | null;
  session_id: string;
  source_hash: string;
  source_session_id: number;
  updated_at: string;
};

export type RunHistoryRow = {
  details_json: string;
  finished_at: string | null;
  id: number;
  phase_name: PhaseName;
  phase_state: PhaseState;
  session_id: string;
  source_hash: string;
  source_session_id: number;
  started_at: string;
};

export type ReviewQueueEntryRow = {
  current_lifecycle_state: LifecycleState;
  enqueued_at: string;
  id: number;
  project_key: string;
  queue_state: string;
  reason: string;
  review_kind: string;
  session_id: string;
  source_hash: string;
  source_session_id: number;
  updated_at: string;
};

export type DeletionCandidateRow = {
  candidate_state: string;
  current_lifecycle_state: LifecycleState;
  id: number;
  project_key: string;
  reason: string;
  safe_to_delete: number;
  session_id: string;
  source_hash: string;
  source_session_id: number;
  updated_at: string;
};

export type PhaseTransitionInput = {
  completedAt?: string | null;
  detailsJson?: string;
  phaseName: PhaseName;
  phaseState: PhaseState;
  runId?: number | null;
  sourceHash?: string;
  sourceSessionId: number;
};

export type RunHistoryInput = {
  detailsJson?: string;
  finishedAt?: string | null;
  phaseName: PhaseName;
  phaseState: PhaseState;
  sessionId: string;
  sourceHash: string;
  sourceSessionId: number;
  startedAt?: string;
};

export type ReviewQueueEntryInput = {
  currentLifecycleState: LifecycleState;
  projectKey: string;
  queueState: string;
  reason: string;
  reviewKind: string;
  sessionId: string;
  sourceHash: string;
  sourceSessionId: number;
};

export type DeletionCandidateInput = {
  candidateState: string;
  currentLifecycleState: LifecycleState;
  projectKey: string;
  reason: string;
  safeToDelete: boolean;
  sessionId: string;
  sourceHash: string;
  sourceSessionId: number;
};

export const currentTimestampExpression = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export function getAllDerivedPhases(): readonly PhaseName[] {
  return phaseNames;
}

export function getDownstreamPhases(phaseName: PhaseName): readonly PhaseName[] {
  const startIndex = phaseNames.indexOf(phaseName);
  return startIndex >= 0 ? phaseNames.slice(startIndex + 1) : [];
}

export function normalizeLifecycleState(value: string): LifecycleState {
  if (value === "stale") {
    return value;
  }

  return value as IngestStatus;
}

export function isPhaseName(value: string): value is PhaseName {
  return phaseNames.includes(value as PhaseName);
}

export function resolveLifecycleStateForPhase(
  phaseName: PhaseName,
  phaseState: PhaseState
): LifecycleState {
  if (phaseState === "completed") {
    return phaseName;
  }

  if (phaseState === "stale") {
    return "stale";
  }

  return "error";
}

export function toSourceSessionInsertRecord(
  session: SourceSession,
  lifecycleState: LifecycleState
): Record<string, string> {
  return {
    conversation_id: session.conversation_id,
    current_lifecycle_state: lifecycleState,
    ingest_status: session.ingest_status,
    project_key: session.project_key,
    retention_status: session.retention_status,
    session_id: session.session_id,
    source_format: session.source_format,
    source_hash: session.source_hash,
    source_path: session.source_path,
    source_tool: session.source_tool,
    started_at: session.started_at,
    updated_at: session.updated_at,
    workspace_path: session.workspace_path
  };
}

export function coerceRetentionStatus(value: string): RetentionStatus {
  return value as RetentionStatus;
}
