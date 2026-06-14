import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { processDiscoveredSessions } from "../dist/commands/ingest-backfill.js";
import { createLedger, upsertSourceSession } from "../dist/db/ledger.js";
import { sourceSessionFixture } from "../dist/models/canonical.js";

const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";

async function withRuntimeRoot(run) {
  const sandboxBase = await mkdtemp(join(tmpdir(), "asd-ingest-isolation-"));
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
