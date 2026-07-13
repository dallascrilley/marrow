import assert from "node:assert/strict";
import test from "node:test";

import { formatOperatorHealth, healthExitCode } from "../dist/commands/health.js";

function health(overrides = {}) {
  return {
    pipeline: {
      gate: {
        ingest: { by_source: {}, pending_sessions: 0, skipped: true },
        llm_budget: {
          allowed: true,
          max_per_window: "50/24h",
          remaining: 49,
          state_path: "/tmp/llm-budget.json",
          used_in_window: 1,
          window_ms: 86_400_000,
          window_started_at: "2026-07-12T00:00:00.000Z",
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
        usd_budget: {
          allowed: true,
          max_usd_per_window: "1/24h",
          max_usd: 1,
          spent_usd: 0.12,
          remaining_usd: 0.88,
          state_path: "/tmp/llm-telemetry.jsonl",
          window_ms: 86_400_000,
          window_started_at: "2026-07-12T00:00:00.000Z",
        },
      },
      pending_learnings: 0,
      pending_sessions: 0,
      status: { phaseCounts: {}, sessionsByLifecycle: {}, totalSessions: 0 },
    },
    provider: null,
    reasons: [],
    recall: {
      events: {
        distinct_projects: 1,
        fires_delivered: 2,
        last_delivered_at: "2026-07-12T12:00:00.000Z",
        last_fire_at: "2026-07-12T12:00:00.000Z",
        total_fires: 2,
      },
      failed_fires: 0,
      reachability: {
        global_produced: 0,
        global_reachable: 0,
        produced: 2,
        projects_total: 1,
        projects_with_reachable: 1,
        reachable: 2,
        reachable_ratio: 1,
        source: "bundle-replay",
      },
    },
    recommendation: { command: "asd stats", reason: "healthy" },
    review: {
      freshness: "fresh",
      latest_apply: null,
      reviewed: {
        entry_count: 1,
        last_learning_id: "learning-1",
        last_reviewed_at: "2026-07-12T11:00:00.000Z",
      },
    },
    status: "healthy",
    storage: {
      inventory: {
        artifacts: [],
        filters: { older_than_days: null, state: null },
        runtime_root: "/tmp/asd",
        total: { bytes: 1_024, count: 2 },
      },
      pressure: "normal",
      pressure_threshold_bytes: 5 * 1024 * 1024 * 1024,
      reclaimable_bytes: 128,
    },
    ...overrides,
  };
}

test("health formatter answers the operator questions without probing the provider", () => {
  const output = formatOperatorHealth(health());

  assert.match(output, /System health: healthy/);
  assert.match(output, /Last successful delivery: 2026-07-12T12:00:00.000Z \(2\/2 delivered\)/);
  assert.match(output, /Current blockers: none/);
  assert.match(output, /Review freshness: fresh/);
  assert.match(output, /LLM budget: 49 remaining of 50\/24h; USD: \$0.88 remaining of 1\/24h/);
  assert.match(output, /Storage pressure: normal \(1.0 KiB total; 128 B reclaimable\)/);
  assert.match(output, /Provider: not checked \(optional; run `asd doctor provider`\)/);
  assert.match(output, /Next: asd stats/);
});

test("health exit codes distinguish healthy, degraded, and unverifiable states", () => {
  assert.equal(healthExitCode("healthy"), 0);
  assert.equal(healthExitCode("degraded"), 1);
  assert.equal(healthExitCode("unverifiable"), 2);
});
