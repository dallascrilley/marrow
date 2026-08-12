import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import {
  getExplainBundle,
  listHarnessComparison,
  listPipelineStatus,
  listReviewItems,
} from "../dist/read/operations.js";

const runtimeOverrideEnvVar = "MARROW_ROOT";

async function withRuntime(run) {
  const sandboxBase = await mkdtemp(join(tmpdir(), "marrow-read-ops-"));
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

test("operations readers expose pipeline status, review items, harness comparison, and explain bundle", async () => {
  await withRuntime(async (runtimeRoot) => {
    const database = await createLedger();

    try {
      const first = upsertSourceSession(database, {
        ...sourceSessionFixture,
        project_key: "dashboard",
        session_id: "ops-session",
        source_hash: "sha256:ops-session",
        source_tool: "cursor",
      });
      const second = upsertSourceSession(database, {
        ...sourceSessionFixture,
        project_key: "dashboard",
        session_id: "ops-session-2",
        source_hash: "sha256:ops-session-2",
        source_tool: "claude-code",
      });

      transitionPhase(database, {
        phaseName: "parsed",
        phaseState: "completed",
        sourceSessionId: first.sourceSession.id,
      });
      upsertReviewQueueEntry(database, {
        currentLifecycleState: first.sourceSession.current_lifecycle_state,
        projectKey: first.sourceSession.project_key,
        queueState: "pending",
        reason: "Needs review",
        reviewKind: "summary",
        sessionId: first.sourceSession.session_id,
        sourceHash: first.sourceSession.source_hash,
        sourceSessionId: first.sourceSession.id,
      });

      await mkdir(join(runtimeRoot, "summaries", "by-session", first.sourceSession.session_id), {
        recursive: true,
      });
      await mkdir(join(runtimeRoot, "summaries", "by-session", second.sourceSession.session_id), {
        recursive: true,
      });
      await writeFile(
        join(
          runtimeRoot,
          "summaries",
          "by-session",
          first.sourceSession.session_id,
          "summary.json",
        ),
        JSON.stringify({
          session_id: first.sourceSession.session_id,
          topic: "Improve dashboard read model",
          topic_source: "deterministic",
          what_worked: ["Shared reader landed."],
          what_failed: [],
          what_was_decided: [],
          useful_commands: [],
          files_of_interest: [],
          next_step: "Ship the panel.",
          project_learnings: ["Keep one read surface."],
          user_learnings: [],
          deletion_readiness: "ready",
        }),
        "utf8",
      );
      await writeFile(
        join(
          runtimeRoot,
          "summaries",
          "by-session",
          second.sourceSession.session_id,
          "summary.json",
        ),
        JSON.stringify({
          session_id: second.sourceSession.session_id,
          topic: "Summarize the current state",
          topic_source: "llm",
          what_worked: ["LLM rescue worked."],
          what_failed: [],
          what_was_decided: [],
          useful_commands: [],
          files_of_interest: [],
          next_step: "Compare harnesses.",
          project_learnings: ["Track harness yield."],
          user_learnings: ["Prefer concise summaries."],
          deletion_readiness: "ready",
        }),
        "utf8",
      );
      await mkdir(join(runtimeRoot, "reports"), { recursive: true });
      await writeFile(
        join(runtimeRoot, "reports", "llm-telemetry.jsonl"),
        `${JSON.stringify({
          "gen_ai.provider.name": "openrouter",
          "gen_ai.operation.name": "learning_review",
          "gen_ai.request.model": "openai/gpt-5-nano",
          "gen_ai.usage.input_tokens": 100,
          "gen_ai.usage.output_tokens": 20,
          "gen_ai.usage.total_tokens": 120,
          "gen_ai.usage.reasoning_tokens": 0,
          "gen_ai.usage.cached_tokens": 0,
          "gen_ai.usage.cost": 0.001,
          "gen_ai.usage.cost_is_known": true,
          "gen_ai.client.operation.duration_ms": 100,
          "asd.cost_source": "upstream",
          "asd.session_id": second.sourceSession.session_id,
          "asd.learning_id": "L1",
          "asd.cache_hit": false,
          "asd.missing_reason": null,
          "asd.batch_size": 1,
          "asd.created_at": "2026-06-24T00:00:00.000Z",
        })}\n`,
        "utf8",
      );

      const status = listPipelineStatus(database);
      const reviewItems = listReviewItems(database);
      const comparison = await listHarnessComparison(database);
      const explain = await getExplainBundle(database, first.sourceSession.session_id);

      assert.equal(status.totalSessions, 2);
      assert.equal(reviewItems.length, 1);
      assert.equal(reviewItems[0]?.queue_state, "pending");
      assert.equal(reviewItems[0]?.review_kind, "summary");
      assert.equal(comparison.by_source_tool.length, 2);
      assert.equal(comparison.by_source_tool[0]?.source_tool, "claude-code");
      assert.equal(comparison.by_source_tool[0]?.llm_rescued_topics, 1);
      assert.equal(comparison.by_source_tool[0]?.total_cost_usd, 0.001);
      assert.equal(comparison.by_source_tool[1]?.source_tool, "cursor");
      assert.equal(comparison.totals.project_learnings, 2);
      assert.equal(explain.session.session_id, first.sourceSession.session_id);
      assert.equal(explain.phase_checkpoints.length, 1);
      assert.equal(explain.summary_preview?.topic, "Improve dashboard read model");
    } finally {
      database.close();
    }
  });
});
