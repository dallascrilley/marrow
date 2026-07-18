import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeStorageInventory } from "../dist/commands/storage-inventory.js";
import { runtimeRootOverrideEnvVar, stagingRootOverrideEnvVar } from "../dist/config/paths.js";
import {
  createLedger,
  transitionPhase,
  upsertDeletionCandidate,
  upsertSourceSession,
} from "../dist/db/ledger.js";
import { sourceSessionFixture } from "../dist/models/canonical.js";
import {
  listRuntimeLifecycleInventory,
  renderRuntimeLifecycleInventory,
} from "../dist/read/lifecycle-inventory.js";

async function withRuntimeRoot(run) {
  const previousRoot = process.env[runtimeRootOverrideEnvVar];
  const runtimeRoot = await mkdtemp(join(tmpdir(), "asd-lifecycle-inventory-"));
  process.env[runtimeRootOverrideEnvVar] = runtimeRoot;

  try {
    await run(runtimeRoot);
  } finally {
    if (previousRoot === undefined) {
      delete process.env[runtimeRootOverrideEnvVar];
    } else {
      process.env[runtimeRootOverrideEnvVar] = previousRoot;
    }
    await rm(runtimeRoot, { force: true, recursive: true });
  }
}

function sourceSession(sessionId, ingestStatus = "archived", overrides = {}) {
  return {
    ...sourceSessionFixture,
    conversation_id: `inventory:${sessionId}`,
    ingest_status: ingestStatus,
    project_key: "inventory-project",
    session_id: sessionId,
    source_hash: `sha256:${sessionId}`,
    ...overrides,
  };
}

async function writeArtifact(path, contents, modifiedAt = new Date("2026-07-01T12:00:00.000Z")) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents, "utf8");
  await utimes(path, modifiedAt, modifiedAt);
}

function aggregate(report, kind, lifecycleState, retention) {
  const result = report.artifacts.find(
    (item) =>
      item.kind === kind && item.lifecycle_state === lifecycleState && item.retention === retention,
  );
  assert.ok(result, `missing ${kind}/${lifecycleState}/${retention}`);
  return result;
}

test("inventory groups runtime artifacts by lifecycle and conservative retention policy", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const ready = upsertSourceSession(database, sourceSession("ready-session")).sourceSession;
      const applied = upsertSourceSession(database, sourceSession("applied-session")).sourceSession;
      upsertSourceSession(database, sourceSession("incomplete-session", "parsed"));
      const priorRevision = upsertSourceSession(
        database,
        sourceSession("revised-session", "archived", {
          source_hash: "sha256:revised-old",
          source_path: "/tmp/inventory-revised-old.jsonl",
          updated_at: "2026-12-31T00:00:00.000Z",
        }),
      ).sourceSession;
      upsertSourceSession(
        database,
        sourceSession("revised-session", "discovered", {
          source_hash: "sha256:revised-current",
          source_path: "/tmp/inventory-revised-current.jsonl",
        }),
      );
      const stale = upsertSourceSession(
        database,
        sourceSession("stale-session", "parsed"),
      ).sourceSession;
      const failed = upsertSourceSession(
        database,
        sourceSession("failed-session", "parsed"),
      ).sourceSession;

      transitionPhase(database, {
        phaseName: "parsed",
        phaseState: "stale",
        sourceSessionId: stale.id,
      });
      transitionPhase(database, {
        phaseName: "parsed",
        phaseState: "failed",
        sourceSessionId: failed.id,
      });
      upsertDeletionCandidate(database, {
        candidateState: "ready",
        currentLifecycleState: "archived",
        projectKey: ready.project_key,
        reason: "All retention artifacts are present.",
        safeToDelete: true,
        sessionId: ready.session_id,
        sourceHash: ready.source_hash,
        sourceSessionId: ready.id,
      });
      upsertDeletionCandidate(database, {
        candidateState: "ready",
        currentLifecycleState: "archived",
        projectKey: priorRevision.project_key,
        reason: "Prior source revision was archived.",
        safeToDelete: true,
        sessionId: priorRevision.session_id,
        sourceHash: priorRevision.source_hash,
        sourceSessionId: priorRevision.id,
      });
      upsertDeletionCandidate(database, {
        candidateState: "applied",
        currentLifecycleState: "deleted",
        projectKey: applied.project_key,
        reason: "Deletion receipt was applied.",
        safeToDelete: true,
        sessionId: applied.session_id,
        sourceHash: applied.source_hash,
        sourceSessionId: applied.id,
      });
      transitionPhase(database, {
        phaseName: "deleted",
        phaseState: "completed",
        sourceSessionId: applied.id,
      });

      await Promise.all([
        writeArtifact(
          join(runtimeRoot, "staging", "ready-session", "parsed-records.json"),
          "parsed",
        ),
        writeArtifact(
          join(runtimeRoot, "staging", "applied-session", "parsed-records.json"),
          "applied",
        ),
        writeArtifact(
          join(runtimeRoot, "staging", "revised-session", "parsed-records.json"),
          "current",
        ),
        writeArtifact(
          join(runtimeRoot, "staging", "ready-session", "reduced-session.json"),
          "reduced",
        ),
        writeArtifact(
          join(runtimeRoot, "staging", "incomplete-session", "parsed-records.json"),
          "incomplete",
        ),
        writeArtifact(
          join(runtimeRoot, "staging", "stale-session", "parsed-records.json"),
          "stale",
        ),
        writeArtifact(
          join(runtimeRoot, "staging", "failed-session", "parsed-records.json"),
          "failed",
        ),
        writeArtifact(
          join(runtimeRoot, "summaries", "by-session", "ready-session", "summary.json"),
          "{}",
        ),
        writeArtifact(join(runtimeRoot, "sources", "manifests", "ready-session.abc123.json"), "{}"),
        writeArtifact(join(runtimeRoot, "deletes", "receipts", "ready-session.json"), "{}"),
        writeArtifact(
          join(
            runtimeRoot,
            "knowledge",
            "projects-reviewed",
            "inventory-project",
            "ready-session.jsonl",
          ),
          "{}\n",
        ),
        writeArtifact(join(runtimeRoot, "index", "session-index.jsonl"), "{}\n"),
        writeArtifact(join(runtimeRoot, "archives", "ready-session.tar.gz"), "archive"),
        writeArtifact(join(runtimeRoot, "reports", "archive-ready-session.json"), "{}"),
        writeArtifact(join(runtimeRoot, "unmanaged", "unknown.bin"), "?"),
      ]);

      const report = await listRuntimeLifecycleInventory(database, {
        now: new Date("2026-07-12T12:00:00.000Z"),
      });

      assert.equal(aggregate(report, "staging_parsed", "archived", "reclaimable").count, 1);
      assert.equal(aggregate(report, "staging_parsed", "deleted", "reclaimable").count, 1);
      assert.equal(aggregate(report, "staging_reduced", "archived", "required").count, 1);
      assert.equal(aggregate(report, "staging_parsed", "parsed", "required").count, 1);
      assert.equal(aggregate(report, "staging_parsed", "discovered", "required").count, 1);
      assert.equal(aggregate(report, "staging_parsed", "stale", "required").count, 1);
      assert.equal(aggregate(report, "staging_parsed", "error", "required").count, 1);
      assert.equal(aggregate(report, "summary", "archived", "required").count, 1);
      assert.equal(aggregate(report, "manifest", "archived", "required").count, 1);
      assert.equal(aggregate(report, "receipt", "archived", "required").count, 1);
      assert.equal(aggregate(report, "reviewed_memory", "archived", "required").count, 1);
      assert.equal(aggregate(report, "index", "unknown", "required").count, 1);
      assert.equal(aggregate(report, "archive", "archived", "required").count, 1);
      assert.equal(aggregate(report, "report", "unknown", "required").count, 1);
      assert.equal(aggregate(report, "unknown", "unknown", "unknown").count, 1);

      const reclaimable = aggregate(report, "staging_parsed", "archived", "reclaimable");
      assert.equal(reclaimable.bytes, Buffer.byteLength("parsed"));
      assert.equal(reclaimable.oldest_at, "2026-07-01T12:00:00.000Z");
      assert.equal(reclaimable.newest_at, "2026-07-01T12:00:00.000Z");
      assert.match(reclaimable.reason, /durable downstream retention artifacts/i);
    } finally {
      database.close();
    }
  });
});

test("inventory reports an unavailable configured staging root without creating it", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    const missingStagingRoot = join(runtimeRoot, "missing-volume", "staging");
    const previousStagingRoot = process.env[stagingRootOverrideEnvVar];
    process.env[stagingRootOverrideEnvVar] = missingStagingRoot;
    try {
      const report = await listRuntimeLifecycleInventory(database);
      assert.equal(report.staging.available, false);
      assert.equal(report.staging.configured, true);
      assert.equal(report.staging.root, missingStagingRoot);
      assert.match(report.staging.error, /staging root is unavailable/);
      await assert.rejects(access(missingStagingRoot), {
        code: "ENOENT",
      });
    } finally {
      database.close();
      if (previousStagingRoot === undefined) {
        delete process.env[stagingRootOverrideEnvVar];
      } else {
        process.env[stagingRootOverrideEnvVar] = previousStagingRoot;
      }
    }
  });
});

test("inventory applies lifecycle and age filters without retaining per-file entries", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      const ready = upsertSourceSession(database, sourceSession("old-ready")).sourceSession;
      upsertDeletionCandidate(database, {
        candidateState: "ready",
        currentLifecycleState: "archived",
        projectKey: ready.project_key,
        reason: "All retention artifacts are present.",
        safeToDelete: true,
        sessionId: ready.session_id,
        sourceHash: ready.source_hash,
        sourceSessionId: ready.id,
      });
      await writeArtifact(
        join(runtimeRoot, "staging", "old-ready", "parsed-records.json"),
        "old",
        new Date("2026-06-01T12:00:00.000Z"),
      );
      await writeArtifact(
        join(runtimeRoot, "staging", "old-ready", "reduced-session.json"),
        "new",
        new Date("2026-07-11T12:00:00.000Z"),
      );

      const report = await listRuntimeLifecycleInventory(database, {
        olderThanDays: 7,
        now: new Date("2026-07-12T12:00:00.000Z"),
        state: "archived",
      });

      assert.equal(report.artifacts.length, 1);
      assert.equal(report.artifacts[0].kind, "staging_parsed");
      assert.equal(report.artifacts[0].retention, "reclaimable");
      assert.deepEqual(report.filters, { older_than_days: 7, state: "archived" });
      assert.equal("paths" in report.artifacts[0], false);

      const human = renderRuntimeLifecycleInventory(report);
      assert.match(human, /Runtime lifecycle inventory/);
      assert.match(human, /staging_parsed/);
      assert.match(human, /reclaimable/);
    } finally {
      database.close();
    }
  });
});

test("storage inventory command provides human and JSON output", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const database = await createLedger();
    try {
      await writeArtifact(join(runtimeRoot, "reports", "retention-readiness.json"), "{}");
      const messages = [];
      const output = {
        error: (message) => messages.push(message),
        info: (message) => messages.push(message),
      };

      const humanExit = await executeStorageInventory(
        { args: [], commandPath: ["storage", "inventory"], output },
        database,
      );
      assert.equal(humanExit, 0);
      assert.match(messages[0], /Runtime lifecycle inventory/);
      assert.match(messages[0], /report/);

      messages.length = 0;
      const jsonExit = await executeStorageInventory(
        { args: ["--json", "--state", "unknown"], commandPath: ["storage", "inventory"], output },
        database,
      );
      assert.equal(jsonExit, 0);
      const parsed = JSON.parse(messages[0]);
      assert.equal(parsed.filters.state, "unknown");
      assert.equal(parsed.artifacts[0].kind, "ledger");
    } finally {
      database.close();
    }
  });
});
