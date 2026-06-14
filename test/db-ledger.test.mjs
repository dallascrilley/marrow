import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createLedger,
  listPhaseCheckpoints,
  transitionPhase,
  upsertDeletionCandidate,
  upsertReviewQueueEntry,
  upsertSourceSession,
} from "../dist/db/ledger.js";
import { getLedgerDatabasePath, getLedgerDirectoryPath } from "../dist/db/migrations.js";
import { sourceSessionFixture } from "../dist/models/canonical.js";

const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";

async function withRuntimeRoot(run) {
  const sandboxBase = await mkdtemp(join(tmpdir(), "asd-ledger-"));
  const runtimeRoot = join(sandboxBase, "runtime-root");
  const previousOverride = process.env[runtimeOverrideEnvVar];

  process.env[runtimeOverrideEnvVar] = runtimeRoot;

  try {
    await run(runtimeRoot);
  } finally {
    if (previousOverride === undefined) {
      delete process.env[runtimeOverrideEnvVar];
    } else {
      process.env[runtimeOverrideEnvVar] = previousOverride;
    }

    await rm(sandboxBase, { force: true, recursive: true });
  }
}

function buildSession(overrides = {}) {
  return {
    ...sourceSessionFixture,
    ...overrides,
  };
}

test("ledger bootstrap creates the sqlite file and reopens idempotently", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const databasePath = join(runtimeRoot, "ledger", "sessions.sqlite");
    const database = await createLedger();

    try {
      assert.equal(getLedgerDirectoryPath(), join(runtimeRoot, "ledger"));
      assert.equal(getLedgerDatabasePath(), databasePath);
      await access(databasePath);

      const objectNames = database
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type IN ('table', 'index')
           ORDER BY name`,
        )
        .all()
        .map((row) => row.name);

      for (const requiredName of [
        "source_sessions",
        "run_history",
        "phase_checkpoints",
        "review_queue_entries",
        "deletion_candidates",
        "idx_source_sessions_source_hash",
        "idx_source_sessions_source_path",
        "idx_source_sessions_source_tool",
        "idx_source_sessions_session_id",
        "idx_source_sessions_project_key",
        "idx_source_sessions_lifecycle",
      ]) {
        assert.ok(objectNames.includes(requiredName), `${requiredName} should exist`);
      }

      const firstInsert = upsertSourceSession(database, buildSession());
      assert.equal(firstInsert.sourceChanged, false);
      assert.equal(firstInsert.sourceSession.content_revision, 1);
    } finally {
      database.close();
    }

    const reopened = await createLedger();

    try {
      const persisted = reopened
        .prepare(
          `SELECT session_id, source_hash, current_lifecycle_state, content_revision
           FROM source_sessions`,
        )
        .get();

      assert.equal(persisted.session_id, sourceSessionFixture.session_id);
      assert.equal(persisted.source_hash, sourceSessionFixture.source_hash);
      assert.equal(persisted.current_lifecycle_state, "summarized");
      assert.equal(persisted.content_revision, 1);
    } finally {
      reopened.close();
    }
  });
});

test("changed source hashes mark downstream artifacts stale without duplicating the session row", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();

    try {
      const inserted = upsertSourceSession(database, buildSession());
      const sessionId = inserted.sourceSession.id;

      transitionPhase(database, {
        phaseName: "parsed",
        phaseState: "completed",
        sourceSessionId: sessionId,
      });
      transitionPhase(database, {
        phaseName: "summarized",
        phaseState: "completed",
        sourceSessionId: sessionId,
      });

      upsertReviewQueueEntry(database, {
        currentLifecycleState: "summarized",
        projectKey: inserted.sourceSession.project_key,
        queueState: "completed",
        reason: "Summary approved for review.",
        reviewKind: "summary",
        sessionId: inserted.sourceSession.session_id,
        sourceHash: inserted.sourceSession.source_hash,
        sourceSessionId: sessionId,
      });

      upsertDeletionCandidate(database, {
        candidateState: "ready",
        currentLifecycleState: "summarized",
        projectKey: inserted.sourceSession.project_key,
        reason: "All derived artifacts were written.",
        safeToDelete: true,
        sessionId: inserted.sourceSession.session_id,
        sourceHash: inserted.sourceSession.source_hash,
        sourceSessionId: sessionId,
      });

      const changed = upsertSourceSession(
        database,
        buildSession({
          source_hash: "sha256:session-0002",
          updated_at: "2026-05-16T08:40:00Z",
        }),
      );

      assert.equal(changed.sourceChanged, true);
      assert.equal(changed.sourceSession.id, sessionId);
      assert.equal(changed.sourceSession.content_revision, 2);
      assert.equal(changed.sourceSession.current_lifecycle_state, "stale");
      assert.deepEqual(changed.stalePhases, ["parsed", "summarized"]);

      const checkpoints = listPhaseCheckpoints(database, sessionId);
      assert.deepEqual(
        checkpoints.map(({ phase_name, phase_state }) => ({ phase_name, phase_state })),
        [
          { phase_name: "parsed", phase_state: "stale" },
          { phase_name: "summarized", phase_state: "stale" },
        ],
      );

      const reviewEntry = database
        .prepare(
          `SELECT queue_state, current_lifecycle_state
           FROM review_queue_entries
           WHERE source_session_id = ?`,
        )
        .get(sessionId);
      assert.equal(reviewEntry.queue_state, "stale");
      assert.equal(reviewEntry.current_lifecycle_state, "stale");

      const deletionCandidate = database
        .prepare(
          `SELECT candidate_state, current_lifecycle_state, safe_to_delete
           FROM deletion_candidates
           WHERE source_session_id = ?`,
        )
        .get(sessionId);
      assert.equal(deletionCandidate.candidate_state, "stale");
      assert.equal(deletionCandidate.current_lifecycle_state, "stale");
      assert.equal(deletionCandidate.safe_to_delete, 0);

      const repeated = upsertSourceSession(
        database,
        buildSession({
          source_hash: "sha256:session-0002",
          updated_at: "2026-05-16T08:45:00Z",
        }),
      );

      assert.equal(repeated.sourceChanged, false);
      assert.equal(repeated.sourceSession.id, sessionId);
      assert.equal(repeated.sourceSession.content_revision, 2);
      assert.deepEqual(repeated.stalePhases, []);

      const rowCount = database
        .prepare("SELECT COUNT(*) AS total FROM source_sessions")
        .get().total;
      assert.equal(rowCount, 1);
    } finally {
      database.close();
    }
  });
});
