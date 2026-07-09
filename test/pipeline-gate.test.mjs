import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createLedger } from "../dist/db/ledger.js";
import { learningFixture } from "../dist/models/canonical.js";
import { countPendingLlmReview } from "../dist/pipeline/pipeline-gate.js";
import { getProjectKnowledgeSessionPath } from "../dist/writers/knowledge-writer.js";

const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";
const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(testDir);
const cliPath = join(projectRoot, "dist", "cli.js");

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });
}

async function withRuntimeRoot(run) {
  const sandboxBase = await mkdtemp(join(tmpdir(), "asd-pipeline-gate-"));
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

test("countPendingLlmReview ignores per-run sidecar and counts only ledger-reviewed ids", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const projectKey = "agent-session-distillery";
    const sessionId = "gate-session";
    const projectPath = getProjectKnowledgeSessionPath(projectKey, sessionId);
    await mkdir(join(projectPath, ".."), { recursive: true });
    await writeFile(
      projectPath,
      `${JSON.stringify({
        ...learningFixture,
        learning_id: "gate-session:project:one",
        scope_key: projectKey,
      })}\n${JSON.stringify({
        ...learningFixture,
        learning_id: "gate-session:project:two",
        scope_key: projectKey,
      })}\n`,
      "utf8",
    );

    const pending = await countPendingLlmReview();
    assert.equal(pending.pending_sessions, 1);
    assert.equal(pending.pending_learnings, 2);

    const sidecarPath = join(runtimeRoot, "reports", "llm-learning-review.jsonl");
    await mkdir(join(sidecarPath, ".."), { recursive: true });
    await writeFile(
      sidecarPath,
      `${JSON.stringify({
        learning_id: "gate-session:project:one",
        session_id: sessionId,
      })}\n`,
      "utf8",
    );

    const afterSidecar = await countPendingLlmReview();
    assert.equal(afterSidecar.pending_sessions, 1);
    assert.equal(afterSidecar.pending_learnings, 2);
  });
});

test("countPendingLlmReview treats review ledger ids as reviewed", async () => {
  await withRuntimeRoot(async (runtimeRoot) => {
    const projectKey = "agent-session-distillery";
    const sessionId = "ledger-gate-session";
    const projectPath = getProjectKnowledgeSessionPath(projectKey, sessionId);
    await mkdir(join(projectPath, ".."), { recursive: true });
    await writeFile(
      projectPath,
      `${JSON.stringify({
        ...learningFixture,
        learning_id: "ledger-gate-session:project:one",
        scope_key: projectKey,
      })}\n${JSON.stringify({
        ...learningFixture,
        learning_id: "ledger-gate-session:project:two",
        scope_key: projectKey,
      })}\n`,
      "utf8",
    );

    const ledgerPath = join(runtimeRoot, "reports", "llm-learning-review-ledger.jsonl");
    await mkdir(join(ledgerPath, ".."), { recursive: true });
    await writeFile(
      ledgerPath,
      `${JSON.stringify({
        learning_id: "ledger-gate-session:project:one",
        verdict: "reject",
        reviewed_at: "2026-07-06T00:00:00.000Z",
        session_id: sessionId,
      })}\n`,
      "utf8",
    );

    const pending = await countPendingLlmReview();
    assert.equal(pending.pending_sessions, 1);
    assert.equal(pending.pending_learnings, 1);
  });
});

test("assessPipelineGate reports budget and review recommendations", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();

    try {
      const { assessPipelineGate } = await import("../dist/pipeline/pipeline-gate.js");
      const report = await assessPipelineGate(database, {
        maxPer: "3/24h",
        sources: ["pi"],
      });

      assert.equal(typeof report.ingest.pending_sessions, "number");
      assert.equal(report.llm_budget.max_per_window, "3/24h");
      assert.equal(typeof report.llm_review.pending_learnings, "number");
      assert.equal(typeof report.recommendations.run_review_learnings, "boolean");
      assert.equal(report.session_integrity.ok, true);
      assert.equal(report.session_integrity.total_findings, 0);
      assert.equal(report.recommendations.run_check, false);
      assert.equal(report.recommendations.skip_check_reason, null);
    } finally {
      database.close();
    }
  });
});

test("assessPipelineGate skip-ingest avoids adapter discovery scans", async () => {
  await withRuntimeRoot(async () => {
    const database = await createLedger();

    try {
      const { assessPipelineGate } = await import("../dist/pipeline/pipeline-gate.js");
      const report = await assessPipelineGate(database, {
        maxPer: "3/24h",
        skipIngest: true,
      });

      assert.equal(report.ingest.skipped, true);
      assert.equal(report.ingest.pending_sessions, 0);
      assert.deepEqual(report.ingest.by_source, {});
      assert.equal(report.recommendations.run_ingest, false);
    } finally {
      database.close();
    }
  });
});

test("pipeline gate --max-per overrides the default and reports the override", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-pipeline-gate-cli-"));
  const runtimeRoot = join(sandbox, "runtime-root");

  try {
    const result = runCli(["pipeline", "gate", "--max-per", "10/24h", "--skip-ingest"], {
      [runtimeOverrideEnvVar]: runtimeRoot,
    });

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.llm_budget.max_per_window, "10/24h");
    assert.equal(report.llm_budget.allowed, true);
    assert.equal(report.usd_budget.max_usd_per_window, "1/24h");
  } finally {
    await rm(sandbox, { force: true, recursive: true });
  }
});
