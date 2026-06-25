import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createLedger,
  transitionPhase,
  upsertReviewQueueEntry,
  upsertSourceSession,
} from "../dist/db/ledger.js";
import { sourceSessionFixture } from "../dist/models/canonical.js";
import { getExplainBundle, listPipelineStatus, listReviewItems } from "../dist/read/operations.js";

const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";

async function withRuntime(run) {
  const sandboxBase = await mkdtemp(join(tmpdir(), "asd-read-ops-"));
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

test("operations readers expose pipeline status, review items, and explain bundle", async () => {
  await withRuntime(async () => {
    const database = await createLedger();

    try {
      const inserted = upsertSourceSession(database, {
        ...sourceSessionFixture,
        project_key: "dashboard",
        session_id: "ops-session",
        source_hash: "sha256:ops-session",
      });

      transitionPhase(database, {
        phaseName: "parsed",
        phaseState: "completed",
        sourceSessionId: inserted.sourceSession.id,
      });
      upsertReviewQueueEntry(database, {
        currentLifecycleState: inserted.sourceSession.current_lifecycle_state,
        projectKey: inserted.sourceSession.project_key,
        queueState: "pending",
        reason: "Needs review",
        reviewKind: "summary",
        sessionId: inserted.sourceSession.session_id,
        sourceHash: inserted.sourceSession.source_hash,
        sourceSessionId: inserted.sourceSession.id,
      });

      const status = listPipelineStatus(database);
      const reviewItems = listReviewItems(database);
      const explain = await getExplainBundle(database, inserted.sourceSession.session_id);

      assert.equal(status.totalSessions, 1);
      assert.equal(reviewItems.length, 1);
      assert.equal(explain.session.session_id, inserted.sourceSession.session_id);
      assert.equal(explain.phase_checkpoints.length, 1);
      assert.equal(explain.summary_preview, null);
    } finally {
      database.close();
    }
  });
});
