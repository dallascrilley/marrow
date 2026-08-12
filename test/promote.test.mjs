import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { saveInstinct } from "../dist/v2/instinct/store.js";
import { refreshPromotionQueue } from "../dist/v2/promotion/queue.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(testDir);
const cliPath = join(projectRoot, "dist", "cli.js");
const runtimeOverrideEnvVar = "MARROW_ROOT";
const fixedNow = "2026-06-25T00:00:00.000Z";
const matureObservations = [
  { session: "sess-1", reinforcing: true, at: "2026-05-20T00:00:00.000Z" },
  { session: "sess-2", reinforcing: true, at: "2026-05-28T00:00:00.000Z" },
  { session: "sess-3", reinforcing: true, at: "2026-06-05T00:00:00.000Z" },
];

function makeInstinct(projectId, confidence) {
  return {
    schema_version: 1,
    id: "prefer-pnpm-aaaaaaaa",
    trigger: "When installing packages",
    finding: "Use pnpm in this repo.",
    confidence,
    domain: "tooling",
    maturity: "established",
    scope: "project",
    project_id: projectId,
    source: {
      first_session: `${projectId}-sess-1`,
      first_observed_at: "2026-05-20T00:00:00.000Z",
      source_refs: [],
      observations: matureObservations,
    },
    related: [],
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-20T00:00:00.000Z",
    last_promoted_at: null,
  };
}

async function withRuntime(run) {
  const root = await mkdtemp(join(tmpdir(), "marrow-promote-cli-"));
  const prior = process.env[runtimeOverrideEnvVar];
  process.env[runtimeOverrideEnvVar] = root;
  try {
    await run(root);
  } finally {
    if (prior === undefined) {
      delete process.env[runtimeOverrideEnvVar];
    } else {
      process.env[runtimeOverrideEnvVar] = prior;
    }
    await rm(root, { recursive: true, force: true });
  }
}

test("promote review lists queued cross-project promotion candidates", async () => {
  await withRuntime(async (root) => {
    await saveInstinct("proj-alpha001", makeInstinct("proj-alpha001", 0.84));
    await saveInstinct("proj-beta0002", makeInstinct("proj-beta0002", 0.88));
    await refreshPromotionQueue(fixedNow);

    const result = spawnSync(process.execPath, [cliPath, "promote", "review"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, [runtimeOverrideEnvVar]: root },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.summary, "1 instinct(s) queued for cross-project promotion.");
    assert.equal(payload.entries.length, 1);
    assert.equal(payload.entries[0].instinct_id, "prefer-pnpm-aaaaaaaa");
    assert.equal(payload.entries[0].trigger, "When installing packages");
    assert.equal(payload.entries[0].project_count, 2);
  });
});
