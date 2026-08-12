import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createLedger,
  getDeletionCandidateBySessionId,
  getPhaseCheckpoint,
  upsertDeletionCandidate,
  upsertSourceSession,
} from "../dist/db/ledger.js";
import { sourceSessionFixture } from "../dist/models/canonical.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(testDir);
const cliPath = join(projectRoot, "dist", "cli.js");
const runtimeOverrideEnvVar = "MARROW_ROOT";

async function withRuntime(run) {
  const root = await mkdtemp(join(tmpdir(), "marrow-delete-apply-"));
  const prior = process.env[runtimeOverrideEnvVar];
  process.env[runtimeOverrideEnvVar] = root;

  try {
    await run(root);
  } finally {
    if (prior === undefined) {
      delete process.env[runtimeOverrideEnvVar];
    } else {
      process.env[runtimeOverrideEnvVar] = prior;
    }

    await rm(root, { recursive: true, force: true });
  }
}

function runCli(args, root) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, [runtimeOverrideEnvVar]: root },
  });
}

function buildSession(overrides = {}) {
  return {
    ...sourceSessionFixture,
    ...overrides,
  };
}

async function seedCandidate(database, overrides = {}) {
  const {
    sessionOverrides = {},
    candidateState = "ready",
    safeToDelete = true,
    reason = "All derived artifacts were written.",
  } = overrides;

  const inserted = upsertSourceSession(
    database,
    buildSession({
      session_id: sessionOverrides.session_id ?? "session-0001",
      source_path: sessionOverrides.source_path ?? "/tmp/session-0001.jsonl",
      source_hash: sessionOverrides.source_hash ?? "sha256:session-0001",
      ...sessionOverrides,
    }),
  );
  const sourceSession = inserted.sourceSession;

  upsertDeletionCandidate(database, {
    candidateState,
    currentLifecycleState: sourceSession.current_lifecycle_state,
    projectKey: sourceSession.project_key,
    reason,
    safeToDelete,
    sessionId: sourceSession.session_id,
    sourceHash: sourceSession.source_hash,
    sourceSessionId: sourceSession.id,
  });

  return sourceSession;
}

async function tombstonePathFor(root, sessionId) {
  return join(root, "deletes", "tombstones", `${sessionId}.json`);
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("delete apply dry-run reports candidates without mutating anything", async () => {
  await withRuntime(async (root) => {
    const database = await createLedger();
    let sourceSession;

    try {
      sourceSession = await seedCandidate(database);
    } finally {
      database.close();
    }

    const result = runCli(["delete", "apply"], root);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.apply, false);
    assert.equal(payload.ready.length, 1);
    assert.equal(payload.ready[0].session_id, sourceSession.session_id);
    assert.equal(payload.ready[0].candidate_state, "ready");

    assert.equal(await pathExists(await tombstonePathFor(root, sourceSession.session_id)), false);
    assert.equal(await pathExists(join(root, "deletes")), false);

    const verifyDb = await createLedger();
    try {
      const candidate = getDeletionCandidateBySessionId(verifyDb, sourceSession.session_id);
      assert.equal(candidate.candidate_state, "ready");
      assert.equal(candidate.current_lifecycle_state, sourceSession.current_lifecycle_state);

      const deletedPhase = getPhaseCheckpoint(verifyDb, sourceSession.id, "deleted");
      assert.equal(deletedPhase, null);
    } finally {
      verifyDb.close();
    }
  });
});

test("delete apply --apply writes a tombstone, marks the candidate applied, and transitions the phase", async () => {
  await withRuntime(async (root) => {
    const database = await createLedger();
    let sourceSession;

    try {
      sourceSession = await seedCandidate(database, {
        reason: "Summary and knowledge artifacts confirmed present.",
      });
    } finally {
      database.close();
    }

    const result = runCli(["delete", "apply", "--apply"], root);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.apply, true);
    assert.equal(payload.applied.length, 1);
    assert.equal(payload.applied[0].session_id, sourceSession.session_id);

    const tombstonePath = await tombstonePathFor(root, sourceSession.session_id);
    assert.equal(payload.applied[0].tombstone_path, tombstonePath);
    assert.equal(await pathExists(tombstonePath), true);

    const tombstone = JSON.parse(await readFile(tombstonePath, "utf8"));
    assert.equal(tombstone.session_id, sourceSession.session_id);
    assert.equal(tombstone.source_hash, sourceSession.source_hash);
    assert.equal(tombstone.reason, "Summary and knowledge artifacts confirmed present.");
    assert.match(tombstone.applied_at, /^\d{4}-\d{2}-\d{2}T/);

    const verifyDb = await createLedger();
    try {
      const candidate = getDeletionCandidateBySessionId(verifyDb, sourceSession.session_id);
      assert.equal(candidate.candidate_state, "applied");
      assert.equal(candidate.current_lifecycle_state, "deleted");

      const deletedPhase = getPhaseCheckpoint(verifyDb, sourceSession.id, "deleted");
      assert.equal(deletedPhase.phase_state, "completed");
      const details = JSON.parse(deletedPhase.details_json);
      assert.equal(details.tombstone_path, tombstonePath);
    } finally {
      verifyDb.close();
    }
  });
});

test("delete apply --apply never deletes candidates that fail the safety filter", async () => {
  await withRuntime(async (root) => {
    const database = await createLedger();
    let readyCandidate;
    let unsafeCandidate;
    let wrongStateCandidate;

    try {
      readyCandidate = await seedCandidate(database, {
        sessionOverrides: {
          session_id: "session-ready",
          source_path: "/tmp/session-ready.jsonl",
          source_hash: "sha256:session-ready",
        },
        candidateState: "ready",
        safeToDelete: true,
      });
      unsafeCandidate = await seedCandidate(database, {
        sessionOverrides: {
          session_id: "session-unsafe",
          source_path: "/tmp/session-unsafe.jsonl",
          source_hash: "sha256:session-unsafe",
        },
        candidateState: "ready",
        safeToDelete: false,
        reason: "Missing required artifacts.",
      });
      wrongStateCandidate = await seedCandidate(database, {
        sessionOverrides: {
          session_id: "session-pending",
          source_path: "/tmp/session-pending.jsonl",
          source_hash: "sha256:session-pending",
        },
        candidateState: "pending_artifacts",
        safeToDelete: true,
        reason: "Artifacts still being generated.",
      });
    } finally {
      database.close();
    }

    const result = runCli(["delete", "apply", "--apply"], root);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.applied.length, 1);
    assert.equal(payload.applied[0].session_id, readyCandidate.session_id);

    assert.equal(await pathExists(await tombstonePathFor(root, readyCandidate.session_id)), true);
    assert.equal(await pathExists(await tombstonePathFor(root, unsafeCandidate.session_id)), false);
    assert.equal(
      await pathExists(await tombstonePathFor(root, wrongStateCandidate.session_id)),
      false,
    );

    const tombstoneDir = join(root, "deletes", "tombstones");
    const writtenFiles = await readdir(tombstoneDir);
    assert.deepEqual(writtenFiles, [`${readyCandidate.session_id}.json`]);

    const verifyDb = await createLedger();
    try {
      const applied = getDeletionCandidateBySessionId(verifyDb, readyCandidate.session_id);
      assert.equal(applied.candidate_state, "applied");

      const unsafe = getDeletionCandidateBySessionId(verifyDb, unsafeCandidate.session_id);
      assert.equal(unsafe.candidate_state, "ready");
      assert.equal(unsafe.safe_to_delete, 0);

      const wrongState = getDeletionCandidateBySessionId(verifyDb, wrongStateCandidate.session_id);
      assert.equal(wrongState.candidate_state, "pending_artifacts");
    } finally {
      verifyDb.close();
    }
  });
});

test("delete apply --apply is idempotent: an already-applied candidate is not re-processed", async () => {
  await withRuntime(async (root) => {
    const database = await createLedger();
    let sourceSession;

    try {
      sourceSession = await seedCandidate(database);
    } finally {
      database.close();
    }

    const firstRun = runCli(["delete", "apply", "--apply"], root);
    assert.equal(firstRun.status, 0, firstRun.stderr);
    const firstPayload = JSON.parse(firstRun.stdout);
    assert.equal(firstPayload.applied.length, 1);

    const tombstonePath = await tombstonePathFor(root, sourceSession.session_id);
    const firstTombstone = await readFile(tombstonePath, "utf8");

    const secondRun = runCli(["delete", "apply", "--apply"], root);
    assert.equal(secondRun.status, 0, secondRun.stderr);
    const secondPayload = JSON.parse(secondRun.stdout);
    assert.equal(secondPayload.applied.length, 0);

    const secondTombstone = await readFile(tombstonePath, "utf8");
    assert.equal(secondTombstone, firstTombstone);

    const dryRunAfter = runCli(["delete", "apply"], root);
    assert.equal(dryRunAfter.status, 0, dryRunAfter.stderr);
    const dryRunPayload = JSON.parse(dryRunAfter.stdout);
    assert.equal(dryRunPayload.ready.length, 0);
  });
});
