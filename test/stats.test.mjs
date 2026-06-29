import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { saveSessionBundle } from "../dist/v2/instinct/bundle.js";
import { sessionBundleSchema } from "../dist/v2/instinct/schema.js";
import { hashToProjectId } from "../dist/v2/project/resolve.js";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(projectRoot, "dist", "cli.js");

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

// A create plus two reinforces lifts confidence to 0.5 + 3*0.04 = 0.62, which
// clears the candidate>=0.6 render-selection gate. A lone create pins to 0.54
// and stays unreachable — the exact split the diagnosis is about.
function reachableBundle(projectId) {
  const now = "2026-06-29T12:00:00.000Z";
  return sessionBundleSchema.parse({
    schema_version: 1,
    session_id: "sess-reach",
    project_id: projectId,
    source_adapter: "cursor",
    source_transcript: "/tmp/sess-reach.jsonl",
    ingested_at: now,
    reviewed_at: now,
    reviewer: "test",
    diary: "Reachability fixture.",
    deltas: [
      {
        op: "create",
        instinct_id: "reachable-instinct-aaaa1111",
        trigger: "When wiring read-back",
        finding: "Recall must surface curated memory.",
        domain: "workflow",
        initial_confidence: 0.6,
      },
      { op: "reinforce", instinct_id: "reachable-instinct-aaaa1111", delta: { confidence: 0.04 } },
      { op: "reinforce", instinct_id: "reachable-instinct-aaaa1111", delta: { confidence: 0.04 } },
      {
        op: "create",
        instinct_id: "weak-instinct-bbbb2222",
        trigger: "When extracting once",
        finding: "Single-observation candidates sit at the noise floor.",
        domain: "tooling",
        initial_confidence: 0.5,
      },
    ],
    extraction_cost: null,
  });
}

test("stats reports reachable instincts distinct from produced", async () => {
  const previousRoot = process.env.AGENT_SESSION_DISTILLERY_ROOT;
  const runtimeRoot = await mkdtemp(join(tmpdir(), "asd-stats-root-"));
  process.env.AGENT_SESSION_DISTILLERY_ROOT = runtimeRoot;
  try {
    await saveSessionBundle(reachableBundle("proj1234abcd"));

    const result = runCli(["stats"], { AGENT_SESSION_DISTILLERY_ROOT: runtimeRoot });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);

    assert.equal(parsed.reachability.produced, 2);
    assert.equal(parsed.reachability.reachable, 1);
    assert.equal(parsed.reachability.projects_with_reachable, 1);
    assert.equal(parsed.reachability.reachable_ratio, 0.5);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.AGENT_SESSION_DISTILLERY_ROOT;
    } else {
      process.env.AGENT_SESSION_DISTILLERY_ROOT = previousRoot;
    }
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

const MEMORY_BODY = `---
tags: [asd, memory, curated]
generated_at: 2026-06-29T07:40:12.416Z
---

# Project memory (curated)

- **workflow** (candidate, 0.62): Recall must surface curated memory.
`;

test("recall fires are logged and summarized by stats", async () => {
  const previousRoot = process.env.AGENT_SESSION_DISTILLERY_ROOT;
  const runtimeRoot = await mkdtemp(join(tmpdir(), "asd-stats-recall-"));
  const work = await mkdtemp(join(tmpdir(), "asd-stats-work-"));
  const empty = await mkdtemp(join(tmpdir(), "asd-stats-empty-"));
  const vault = await mkdtemp(join(tmpdir(), "asd-stats-vault-"));
  process.env.AGENT_SESSION_DISTILLERY_ROOT = runtimeRoot;
  try {
    const projectId = hashToProjectId(work);
    const dir = join(vault, "wiki", "projects", projectId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "MEMORY.md"), MEMORY_BODY, "utf8");

    const env = { AGENT_SESSION_DISTILLERY_ROOT: runtimeRoot };
    // One delivered fire (seeded vault) and one empty fire (no memory).
    const delivered = runCli(["recall", "--cwd", work, "--vault-root", vault], env);
    assert.equal(delivered.status, 0, delivered.stderr);
    const missing = runCli(["recall", "--cwd", empty, "--vault-root", vault], env);
    assert.equal(missing.status, 0, missing.stderr);

    const result = runCli(["stats"], env);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);

    assert.equal(parsed.recall.total_fires, 2);
    assert.equal(parsed.recall.fires_delivered, 1);
    assert.equal(parsed.recall.distinct_projects, 2);
    assert.ok(typeof parsed.recall.last_fire_at === "string");
  } finally {
    if (previousRoot === undefined) {
      delete process.env.AGENT_SESSION_DISTILLERY_ROOT;
    } else {
      process.env.AGENT_SESSION_DISTILLERY_ROOT = previousRoot;
    }
    await rm(runtimeRoot, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
    await rm(empty, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});
