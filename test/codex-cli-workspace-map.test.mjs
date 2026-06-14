import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  deriveCodexCliWorkspaceMapping,
  readCodexCliSessionMeta,
} from "../dist/adapters/codex-cli/workspace-map.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(testDir);
const fixturePath = join(
  projectRoot,
  "test",
  "fixtures",
  "codex-cli",
  "sessions",
  "2026",
  "05",
  "03",
  "rollout-2026-05-03T23-02-54-019df127-415e-7b43-a43b-96fc77a98775.jsonl",
);

test("reads session_meta from the rollout's line 0", async () => {
  const meta = await readCodexCliSessionMeta(fixturePath);
  assert.ok(meta);
  assert.equal(meta.cwd, "/Users/example/Code/demo");
  assert.equal(meta.id, "019df127-415e-7b43-a43b-96fc77a98775");
  assert.equal(meta.originator, "codex-cli");
  assert.equal(meta.cliVersion, "0.128.0");
  assert.equal(meta.subagentDepth, null);
  assert.equal(meta.parentThreadId, null);
});

test("workspace mapping uses session_meta cwd and derives projectKey from the last segment", async () => {
  const meta = await readCodexCliSessionMeta(fixturePath);
  const mapping = await deriveCodexCliWorkspaceMapping(fixturePath, "sessions", meta);
  assert.equal(mapping.workspacePath, "/Users/example/Code/demo");
  assert.equal(mapping.projectKey, "demo");
  assert.equal(mapping.rolloutTreeRoot, "sessions");
  assert.equal(mapping.rolloutPath, fixturePath);
});

test("workspace mapping falls back to filename when session_meta is null", async () => {
  const mapping = await deriveCodexCliWorkspaceMapping(
    "/tmp/rollout-2026-05-03T23-02-54-fallback-id.jsonl",
    "archived_sessions",
    null,
  );
  assert.equal(mapping.workspacePath, null);
  assert.equal(mapping.projectKey, "rollout-2026-05-03T23-02-54-fallback-id");
});
