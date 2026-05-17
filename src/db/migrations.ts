import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { getRuntimePath } from "../config/paths.js";
import { currentTimestampExpression, ledgerDatabaseFileName } from "./queries.js";

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS source_sessions (
    id INTEGER PRIMARY KEY,
    source_tool TEXT NOT NULL,
    source_format TEXT NOT NULL,
    source_path TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    project_key TEXT NOT NULL,
    session_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ingest_status TEXT NOT NULL,
    retention_status TEXT NOT NULL,
    current_lifecycle_state TEXT NOT NULL,
    content_revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (${currentTimestampExpression}),
    last_ingested_at TEXT NOT NULL DEFAULT (${currentTimestampExpression}),
    UNIQUE(source_tool, source_path, session_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS run_history (
    id INTEGER PRIMARY KEY,
    source_session_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    phase_name TEXT NOT NULL,
    phase_state TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    started_at TEXT NOT NULL DEFAULT (${currentTimestampExpression}),
    finished_at TEXT,
    FOREIGN KEY (source_session_id) REFERENCES source_sessions(id) ON DELETE CASCADE
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS phase_checkpoints (
    id INTEGER PRIMARY KEY,
    source_session_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    phase_name TEXT NOT NULL,
    phase_state TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    current_lifecycle_state TEXT NOT NULL,
    run_id INTEGER,
    completed_at TEXT,
    invalidated_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (${currentTimestampExpression}),
    UNIQUE(source_session_id, phase_name),
    FOREIGN KEY (source_session_id) REFERENCES source_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (run_id) REFERENCES run_history(id) ON DELETE SET NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS review_queue_entries (
    id INTEGER PRIMARY KEY,
    source_session_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    project_key TEXT NOT NULL,
    review_kind TEXT NOT NULL,
    queue_state TEXT NOT NULL,
    current_lifecycle_state TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    reason TEXT NOT NULL,
    enqueued_at TEXT NOT NULL DEFAULT (${currentTimestampExpression}),
    updated_at TEXT NOT NULL DEFAULT (${currentTimestampExpression}),
    UNIQUE(source_session_id, review_kind),
    FOREIGN KEY (source_session_id) REFERENCES source_sessions(id) ON DELETE CASCADE
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS deletion_candidates (
    id INTEGER PRIMARY KEY,
    source_session_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    project_key TEXT NOT NULL,
    current_lifecycle_state TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    safe_to_delete INTEGER NOT NULL DEFAULT 0,
    candidate_state TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (${currentTimestampExpression}),
    updated_at TEXT NOT NULL DEFAULT (${currentTimestampExpression}),
    UNIQUE(source_session_id),
    FOREIGN KEY (source_session_id) REFERENCES source_sessions(id) ON DELETE CASCADE
  ) STRICT`,
  "CREATE INDEX IF NOT EXISTS idx_source_sessions_source_hash ON source_sessions(source_hash)",
  "CREATE INDEX IF NOT EXISTS idx_source_sessions_source_path ON source_sessions(source_path)",
  "CREATE INDEX IF NOT EXISTS idx_source_sessions_source_tool ON source_sessions(source_tool)",
  "CREATE INDEX IF NOT EXISTS idx_source_sessions_session_id ON source_sessions(session_id)",
  "CREATE INDEX IF NOT EXISTS idx_source_sessions_project_key ON source_sessions(project_key)",
  "CREATE INDEX IF NOT EXISTS idx_source_sessions_lifecycle ON source_sessions(current_lifecycle_state)",
  "CREATE INDEX IF NOT EXISTS idx_run_history_session_id ON run_history(session_id)",
  "CREATE INDEX IF NOT EXISTS idx_phase_checkpoints_session_id ON phase_checkpoints(session_id)",
  "CREATE INDEX IF NOT EXISTS idx_phase_checkpoints_lifecycle ON phase_checkpoints(current_lifecycle_state)",
  "CREATE INDEX IF NOT EXISTS idx_review_queue_session_id ON review_queue_entries(session_id)",
  "CREATE INDEX IF NOT EXISTS idx_review_queue_project_key ON review_queue_entries(project_key)",
  "CREATE INDEX IF NOT EXISTS idx_review_queue_lifecycle ON review_queue_entries(current_lifecycle_state)",
  "CREATE INDEX IF NOT EXISTS idx_deletion_candidates_session_id ON deletion_candidates(session_id)",
  "CREATE INDEX IF NOT EXISTS idx_deletion_candidates_project_key ON deletion_candidates(project_key)",
  "CREATE INDEX IF NOT EXISTS idx_deletion_candidates_lifecycle ON deletion_candidates(current_lifecycle_state)"
] as const;

export function getLedgerDirectoryPath(): string {
  return getRuntimePath("ledger");
}

export function getLedgerDatabasePath(): string {
  return join(getLedgerDirectoryPath(), ledgerDatabaseFileName);
}

export async function ensureLedgerDirectory(): Promise<string> {
  const ledgerDirectory = getLedgerDirectoryPath();
  await mkdir(ledgerDirectory, { recursive: true });
  return ledgerDirectory;
}

export function applyLedgerMigrations(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = NORMAL");

  for (const statement of schemaStatements) {
    database.exec(statement);
  }
}

export async function openLedgerDatabase(): Promise<DatabaseSync> {
  await ensureLedgerDirectory();

  const database = new DatabaseSync(getLedgerDatabasePath());
  applyLedgerMigrations(database);
  return database;
}
