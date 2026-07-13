import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runtimeRootOverrideEnvVar } from "../dist/config/paths.js";
import { createLedger } from "../dist/db/ledger.js";
import { buildOperatorHealthModel } from "../dist/read/operator-health.js";

async function withRuntimeRoot(run) {
  const previousRoot = process.env[runtimeRootOverrideEnvVar];
  const runtimeRoot = await mkdtemp(join(tmpdir(), "asd-operator-health-"));
  process.env[runtimeRootOverrideEnvVar] = runtimeRoot;

  try {
    await run();
  } finally {
    if (previousRoot === undefined) {
      delete process.env[runtimeRootOverrideEnvVar];
    } else {
      process.env[runtimeRootOverrideEnvVar] = previousRoot;
    }
    await rm(runtimeRoot, { force: true, recursive: true });
  }
}

const now = new Date("2026-07-12T12:00:00.000Z");

function makeDependencies(overrides = {}) {
  return {
    assessPipelineGate: async () => ({
      ingest: { by_source: {}, pending_sessions: 0, skipped: true },
      llm_budget: {
        allowed: true,
        max_per_window: "50/24h",
        remaining: 50,
        state_path: "/tmp/count-budget.json",
        used_in_window: 0,
        window_ms: 86_400_000,
        window_started_at: "2026-07-11T12:00:00.000Z",
      },
      usd_budget: {
        allowed: true,
        max_usd_per_window: "1/24h",
        max_usd: 1,
        remaining_usd: 1,
        spent_usd: 0,
        state_path: "/tmp/telemetry.jsonl",
        window_ms: 86_400_000,
        window_started_at: "2026-07-11T12:00:00.000Z",
      },
      llm_review: { pending_learnings: 0, pending_sessions: 0 },
      recommendations: {
        run_check: false,
        run_ingest: false,
        run_review_learnings: false,
        skip_check_reason: null,
        skip_review_learnings_reason: "no_unreviewed_project_learnings",
      },
      session_integrity: { findings_by_code: {}, ok: true, total_findings: 0 },
    }),
    assessProviderPreflight: async () => ({
      checks: [],
      llm_budget: {},
      model: "openrouter/auto",
      ok: true,
      route_blocked_by_data_policy: false,
      summary: "Provider ready.",
      usd_budget: {},
    }),
    computeReachability: async () => ({
      global_produced: 0,
      global_reachable: 0,
      produced: 2,
      projects_total: 1,
      projects_with_reachable: 1,
      reachable: 2,
      reachable_ratio: 1,
      source: "bundle-replay",
    }),
    listPipelineStatus: () => ({
      blockedReasons: {},
      deletionCandidates: {},
      reviewQueue: {},
      sessionsByLifecycle: {},
      totalSessions: 2,
    }),
    listRuntimeLifecycleInventory: async () => ({
      artifacts: [],
      filters: { older_than_days: null, state: null },
      runtime_root: "/tmp/asd",
      total: { bytes: 1024, count: 2 },
    }),
    readApplyLedger: async () => [
      {
        affected_sessions: ["session-a"],
        apply_id: "apply-a",
        batch_id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        batch_path: "/tmp/batch.json",
        outputs: [],
        recorded_at: "2026-07-12T11:00:00.000Z",
        reviewed_at: "2026-07-12T11:00:00.000Z",
        schema_version: "llm-learning-review-apply-ledger-v1",
        status: "applied",
      },
    ],
    readReviewWatermark: async () => ({
      entry_count: 2,
      last_learning_id: "learning-a",
      last_reviewed_at: "2026-07-12T11:00:00.000Z",
    }),
    summarizeRecallEvents: async () => ({
      distinct_projects: 1,
      fires_delivered: 1,
      last_fire_at: "2026-07-12T11:30:00.000Z",
      total_fires: 1,
    }),
    ...overrides,
  };
}

test("operator health composes a healthy snapshot without duplicate readers", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();
    try {
      const health = await buildOperatorHealthModel(database, {
        dependencies: makeDependencies(),
        now,
      });

      assert.equal(health.status, "healthy");
      assert.equal(health.review.freshness, "fresh");
      assert.equal(health.recall.failed_fires, 0);
      assert.equal(health.storage.pressure, "normal");
      assert.equal(health.recommendation.command, "asd stats");
    } finally {
      database.close();
    }
  });
});

test("operator health prioritizes deterministic remediation for degraded states", async () => {
  const scenarios = [
    {
      name: "no memory",
      overrides: {
        computeReachability: async () => ({
          global_produced: 0,
          global_reachable: 0,
          produced: 0,
          projects_total: 0,
          projects_with_reachable: 0,
          reachable: 0,
          reachable_ratio: 0,
          source: "bundle-replay",
        }),
      },
      expectedCommand: "asd recall --cwd .",
      expectedReason: "no_reachable_memory",
    },
    {
      name: "stale review",
      overrides: {
        readReviewWatermark: async () => ({
          entry_count: 2,
          last_learning_id: "learning-a",
          last_reviewed_at: "2026-06-01T11:00:00.000Z",
        }),
      },
      expectedCommand: "asd quality review-learnings --if-new",
      expectedReason: "review_stale",
    },
    {
      name: "pending review",
      overrides: {
        assessPipelineGate: async () => ({
          ...(await makeDependencies().assessPipelineGate()),
          llm_review: { pending_learnings: 2, pending_sessions: 1 },
        }),
      },
      expectedCommand: "asd quality review-learnings --if-new",
      expectedReason: "pending_review",
    },
    {
      name: "budget blocked",
      overrides: {
        assessPipelineGate: async () => ({
          ...(await makeDependencies().assessPipelineGate()),
          llm_budget: {
            ...(await makeDependencies().assessPipelineGate()).llm_budget,
            allowed: false,
            remaining: 0,
          },
          recommendations: {
            ...(await makeDependencies().assessPipelineGate()).recommendations,
            skip_review_learnings_reason: "llm_budget_exhausted",
          },
        }),
      },
      expectedCommand: "asd quality cost-report",
      expectedReason: "llm_budget_exhausted",
    },
    {
      name: "recall failure",
      overrides: {
        summarizeRecallEvents: async () => ({
          distinct_projects: 2,
          fires_delivered: 1,
          last_fire_at: "2026-07-12T11:30:00.000Z",
          total_fires: 2,
        }),
      },
      expectedCommand: "asd recall --cwd .",
      expectedReason: "recall_failures",
    },
    {
      name: "storage pressure",
      overrides: {
        listRuntimeLifecycleInventory: async () => ({
          artifacts: [
            {
              bytes: 9 * 1024 * 1024 * 1024,
              count: 4,
              kind: "staging_parsed",
              lifecycle_state: "deletion_candidate",
              newest_at: "2026-07-12T11:00:00.000Z",
              oldest_at: "2026-06-01T11:00:00.000Z",
              reason: "Safe candidate.",
              retention: "reclaimable",
            },
          ],
          filters: { older_than_days: null, state: null },
          runtime_root: "/tmp/asd",
          total: { bytes: 9 * 1024 * 1024 * 1024, count: 4 },
        }),
      },
      expectedCommand: "asd storage inventory --older-than-days 30",
      expectedReason: "storage_pressure",
    },
  ];

  for (const scenario of scenarios) {
    await withRuntimeRoot(async () => {
      const database = await createLedger();
      try {
        const health = await buildOperatorHealthModel(database, {
          dependencies: makeDependencies(scenario.overrides),
          now,
        });

        assert.equal(health.status, "degraded", scenario.name);
        assert.equal(health.recommendation.command, scenario.expectedCommand, scenario.name);
        assert.equal(health.recommendation.reason, scenario.expectedReason, scenario.name);
        assert.ok(health.reasons.includes(scenario.expectedReason), scenario.name);
      } finally {
        database.close();
      }
    });
  }
});

test("operator health invokes the pipeline gate without ingest discovery", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();
    try {
      let receivedOptions;
      await buildOperatorHealthModel(database, {
        dependencies: makeDependencies({
          assessPipelineGate: async (_database, options) => {
            receivedOptions = options;
            return makeDependencies().assessPipelineGate();
          },
        }),
        now,
      });

      assert.deepEqual(receivedOptions, { skipIngest: true });
    } finally {
      database.close();
    }
  });
});

test("operator health invokes each composed reader once", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();
    try {
      const base = makeDependencies();
      const calls = {
        apply: 0,
        gate: 0,
        pipeline: 0,
        provider: 0,
        reachability: 0,
        recall: 0,
        review: 0,
        storage: 0,
      };
      await buildOperatorHealthModel(database, {
        dependencies: {
          ...base,
          assessPipelineGate: async (...args) => {
            calls.gate += 1;
            return base.assessPipelineGate(...args);
          },
          assessProviderPreflight: async () => {
            calls.provider += 1;
            return base.assessProviderPreflight();
          },
          computeReachability: async () => {
            calls.reachability += 1;
            return base.computeReachability();
          },
          listPipelineStatus: (...args) => {
            calls.pipeline += 1;
            return base.listPipelineStatus(...args);
          },
          listRuntimeLifecycleInventory: async (...args) => {
            calls.storage += 1;
            return base.listRuntimeLifecycleInventory(...args);
          },
          readApplyLedger: async () => {
            calls.apply += 1;
            return base.readApplyLedger();
          },
          readReviewWatermark: async () => {
            calls.review += 1;
            return base.readReviewWatermark();
          },
          summarizeRecallEvents: async () => {
            calls.recall += 1;
            return base.summarizeRecallEvents();
          },
        },
        now,
      });

      assert.deepEqual(calls, {
        apply: 1,
        gate: 1,
        pipeline: 1,
        provider: 1,
        reachability: 1,
        recall: 1,
        review: 1,
        storage: 1,
      });
    } finally {
      database.close();
    }
  });
});

test("operator health counts global and project reachability together", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();
    try {
      const globalOnly = await buildOperatorHealthModel(database, {
        dependencies: makeDependencies({
          computeReachability: async () => ({
            global_produced: 1,
            global_reachable: 1,
            produced: 0,
            projects_total: 0,
            projects_with_reachable: 0,
            reachable: 0,
            reachable_ratio: 0,
            source: "bundle-replay",
          }),
        }),
        now,
      });
      assert.equal(globalOnly.status, "healthy");
      assert.equal(globalOnly.reasons.includes("no_reachable_memory"), false);

      const unreachable = await buildOperatorHealthModel(database, {
        dependencies: makeDependencies({
          computeReachability: async () => ({
            global_produced: 0,
            global_reachable: 0,
            produced: 2,
            projects_total: 1,
            projects_with_reachable: 0,
            reachable: 0,
            reachable_ratio: 0,
            source: "bundle-replay",
          }),
        }),
        now,
      });
      assert.equal(unreachable.status, "degraded");
      assert.ok(unreachable.reasons.includes("no_reachable_memory"));
    } finally {
      database.close();
    }
  });
});

test("operator health does not probe the provider unless explicitly supplied", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();
    const previousApiKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "";
    try {
      const dependencies = makeDependencies();
      delete dependencies.assessProviderPreflight;
      const health = await buildOperatorHealthModel(database, { dependencies, now });

      assert.equal(health.provider, null);
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = previousApiKey;
      }
      database.close();
    }
  });
});
