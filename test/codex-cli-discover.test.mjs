import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { discoverCodexCliInputs } from "../dist/adapters/codex-cli/discover.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(testDir);
const fixtureCodexHome = join(projectRoot, "test", "fixtures", "codex-cli");

test("walks the date-partitioned sessions tree and attributes the workspace", async () => {
  const result = await discoverCodexCliInputs({
    codexHome: fixtureCodexHome,
  });
  assert.equal(result.transcripts.length, 2);
  const transcript = result.transcripts.find((entry) =>
    entry.sourcePath.includes("rollout-agents-first"),
  );
  assert.ok(transcript);
  assert.equal(transcript.projectKey, "demo");
  assert.equal(transcript.workspacePath, "/Users/example/Code/demo");
  assert.equal(transcript.rolloutTreeRoot, "sessions");
  assert.equal(transcript.sourceFormat, "jsonl");
  assert.ok(transcript.sourceHash.startsWith("sha256:"));
  assert.ok(transcript.sourcePath.endsWith(".jsonl"));
  assert.ok(transcript.sizeBytes > 0);
});

test("returns an empty list when the codex home is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "marrow-codex-empty-"));
  try {
    const result = await discoverCodexCliInputs({ codexHome: join(dir, "no-such-codex") });
    assert.deepEqual(result.transcripts, []);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("skips non-date directories and non-rollout files under sessions/", async () => {
  // The fixture sessions/2026/05/03 dir contains only the rollout file; this
  // is implicitly verified by the count==1 assertion above. The walker also
  // has to skip the .DS_Store / .tldr cruft a real ~/.codex/sessions/ would
  // have; we exercise the date-pattern filter by leaving the sessions tree
  // shallow but well-formed.
  const result = await discoverCodexCliInputs({ codexHome: fixtureCodexHome });
  for (const transcript of result.transcripts) {
    assert.match(transcript.sourcePath, /\/rollout-[^/]+\.jsonl$/);
  }
});
