import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { replayBundles, saveSessionBundle } from "../dist/v2/instinct/bundle.js";
import { sessionBundleSchema } from "../dist/v2/instinct/schema.js";
import { saveAllInstincts, listInstinctIds } from "../dist/v2/instinct/store.js";
import { renderProjectMemoryToVault } from "../dist/v2/vault/render-memory.js";

test("bundle replay → saveAllInstincts prune → vault MEMORY.md includes candidate rollup", async () => {
  const previousRoot = process.env.AGENT_SESSION_DISTILLERY_ROOT;
  const sandbox = await mkdtemp(join(tmpdir(), "asd-v2-pipe-"));
  const runtimeRoot = join(sandbox, "runtime");
  const vaultRoot = join(sandbox, "vault");
  process.env.AGENT_SESSION_DISTILLERY_ROOT = runtimeRoot;

  try {
    const projectId = "pipeproj000001";
    const instinctId = "prefer-pnpm-over-npm-11111111";
    const now = "2026-05-19T12:00:00Z";

    await saveSessionBundle(
      sessionBundleSchema.parse({
        schema_version: 1,
        session_id: "sess-pipe",
        project_id: projectId,
        source_adapter: "cursor",
        source_transcript: "/tmp/sess-pipe.jsonl",
        ingested_at: now,
        reviewed_at: now,
        reviewer: "test",
        diary: "Pipeline test bundle.",
        deltas: [
          {
            op: "create",
            instinct_id: instinctId,
            trigger: "When installing dependencies",
            finding: "Use pnpm for installs in this repo.",
            domain: "tooling",
            initial_confidence: 0.65,
          },
          {
            op: "reinforce",
            instinct_id: instinctId,
            delta: { confidence: 0 },
          },
          {
            op: "reinforce",
            instinct_id: instinctId,
            delta: { confidence: 0 },
          },
        ],
        extraction_cost: null,
      }),
    );

    const replayed = await replayBundles(projectId);
    await saveAllInstincts(projectId, replayed);

    const stalePath = join(
      runtimeRoot,
      "instincts",
      projectId,
      "instincts",
      "stale-instinct-dddddddd.yaml",
    );
    await writeFile(
      stalePath,
      "schema_version: 1\nid: stale-instinct-dddddddd\n",
      "utf8",
    );
    await saveAllInstincts(projectId, replayed);

    const ids = await listInstinctIds(projectId);
    assert.equal(ids.includes(instinctId), true);
    assert.equal(ids.includes("stale-instinct-dddddddd"), false);

    const rendered = await renderProjectMemoryToVault({
      projectId,
      vaultRoot,
    });
    assert.equal(rendered.includedCount, 1);
    const memory = await readFile(rendered.memoryPath, "utf8");
    assert.match(memory, /Use pnpm for installs/);
    assert.match(memory, /candidate/);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.AGENT_SESSION_DISTILLERY_ROOT;
    } else {
      process.env.AGENT_SESSION_DISTILLERY_ROOT = previousRoot;
    }
    await rm(sandbox, { recursive: true, force: true });
  }
});
