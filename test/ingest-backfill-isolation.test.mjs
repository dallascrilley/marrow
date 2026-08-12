import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { processDiscoveredSessions } from "../dist/commands/ingest-backfill.js";
import { createLedger, transitionPhase, upsertSourceSession } from "../dist/db/ledger.js";
import { sourceSessionFixture } from "../dist/models/canonical.js";
import { getParsedArtifactPath } from "../dist/pipeline/parse.js";

const runtimeOverrideEnvVar = "MARROW_ROOT";

async function withRuntimeRoot(run) {
  const sandboxBase = await mkdtemp(join(tmpdir(), "marrow-ingest-isolation-"));
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

test("processDiscoveredSessions continues after a per-session failure", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();

    const badUpsert = upsertSourceSession(database, {
      ...sourceSessionFixture,
      conversation_id: "demo:bad",
      ingest_status: "discovered",
      session_id: "bad-session",
      source_hash: "sha256:bad",
      source_path: "/nonexistent/bad.jsonl",
    });
    const goodUpsert = upsertSourceSession(database, {
      ...sourceSessionFixture,
      conversation_id: "demo:good",
      ingest_status: "discovered",
      session_id: "good-session",
      source_hash: "sha256:good",
      source_path: "/nonexistent/good.jsonl",
    });

    const badEntry = {
      ledger: {
        sourceChanged: badUpsert.sourceChanged,
        sourceSession: badUpsert.sourceSession,
      },
    };
    const goodEntry = {
      ledger: {
        sourceChanged: goodUpsert.sourceChanged,
        sourceSession: goodUpsert.sourceSession,
      },
    };

    const result = await processDiscoveredSessions(database, [badEntry, goodEntry], false, false);

    assert.equal(result.sessions.length, 0);
    assert.equal(result.failed_count, 2);
    assert.equal(result.failures.length, 2);
    assert.ok(result.failures[0]?.error.length > 0);
    assert.ok(result.failures[1]?.error.length > 0);
  });
});

test("processDiscoveredSessions reports archive cleanup failure without losing archive success", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();
    try {
      const upsert = upsertSourceSession(database, {
        ...sourceSessionFixture,
        conversation_id: "demo:cleanup-failure",
        ingest_status: "discovered",
        session_id: "cleanup-failure",
        source_hash: "sha256:cleanup-failure",
        source_path: "/nonexistent/cleanup-failure.jsonl",
      });
      const parsedPath = getParsedArtifactPath(upsert.sourceSession.session_id);
      await mkdir(dirname(parsedPath), { recursive: true });
      await writeFile(parsedPath, "[]\n", "utf8");
      transitionPhase(database, {
        phaseName: "parsed",
        phaseState: "completed",
        sourceHash: upsert.sourceSession.source_hash,
        sourceSessionId: upsert.sourceSession.id,
      });

      const result = await processDiscoveredSessions(
        database,
        [
          {
            ledger: {
              sourceChanged: upsert.sourceChanged,
              sourceSession: upsert.sourceSession,
            },
          },
        ],
        true,
        false,
        undefined,
        {
          runArchivePhase: async () => ({
            deletionCandidateState: "ready",
            parsedIntermediateCleanupError: "injected parsed cleanup failure",
            parsedIntermediateDeleted: false,
            reportPath: "/tmp/report.json",
            safeToDelete: true,
          }),
        },
      );

      assert.equal(result.sessions.length, 1, "durable archive result remains successful");
      assert.equal(result.failed_count, 1);
      assert.deepEqual(result.failures, [
        {
          error: "parsed intermediate cleanup failed: injected parsed cleanup failure",
          session_id: "cleanup-failure",
        },
      ]);
      assert.equal(
        result.sessions[0].archived.parsedIntermediateCleanupError,
        "injected parsed cleanup failure",
      );
    } finally {
      database.close();
    }
  });
});
