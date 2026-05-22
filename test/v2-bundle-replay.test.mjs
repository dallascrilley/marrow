import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { replayBundles, saveSessionBundle } from "../dist/v2/instinct/bundle.js";
import { sessionBundleSchema } from "../dist/v2/instinct/schema.js";

test("replayBundles folds create deltas into instinct map", async () => {
  const previousRoot = process.env.AGENT_SESSION_DISTILLERY_ROOT;
  const runtimeRoot = await mkdtemp(join(tmpdir(), "asd-v2-bundle-"));
  process.env.AGENT_SESSION_DISTILLERY_ROOT = runtimeRoot;

  try {
    const projectId = "abc123def456";
    const now = "2026-05-19T12:00:00Z";
    const bundle = sessionBundleSchema.parse({
      schema_version: 1,
      session_id: "sess-golden",
      project_id: projectId,
      source_adapter: "cursor",
      source_transcript: "/tmp/sess-golden.jsonl",
      ingested_at: now,
      reviewed_at: now,
      reviewer: "test",
      diary: "Golden bundle diary.",
      deltas: [
        {
          op: "create",
          instinct_id: "prefer-pnpm-over-npm-11111111",
          trigger: "When installing dependencies",
          finding: "Use pnpm for installs in this repo.",
          domain: "tooling",
          initial_confidence: 0.65,
        },
      ],
      extraction_cost: null,
    });

    await saveSessionBundle(bundle);
    const instincts = await replayBundles(projectId);

    assert.equal(instincts.size, 1);
    const instinct = instincts.get("prefer-pnpm-over-npm-11111111");
    assert.ok(instinct);
    assert.equal(instinct.maturity, "candidate");
    assert.ok(instinct.confidence >= 0.3);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.AGENT_SESSION_DISTILLERY_ROOT;
    } else {
      process.env.AGENT_SESSION_DISTILLERY_ROOT = previousRoot;
    }
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
