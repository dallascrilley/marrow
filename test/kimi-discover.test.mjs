import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { discoverKimiInputs } from "../dist/adapters/kimi/discover.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureSessionsRoot = join(testDir, "fixtures", "kimi", "sessions");

test("discoverKimiInputs finds wire.jsonl sessions", async () => {
  const result = await discoverKimiInputs({
    kimiSessionsRoot: fixtureSessionsRoot,
  });

  assert.equal(result.transcripts.length, 1);
  const transcript = result.transcripts[0];
  assert.ok(transcript.sourcePath.endsWith("wire.jsonl"));
  assert.equal(transcript.sourceFormat, "jsonl");
  assert.equal(transcript.workspaceSlug, "6d146076ef0a6aa290cf3370faef0249");
  assert.ok(transcript.sizeBytes > 0);
  assert.ok(transcript.modifiedAt.length > 0);
  assert.ok(transcript.sourceHash.startsWith("sha256:"));
});

test("discoverKimiInputs returns empty array when root missing", async () => {
  const result = await discoverKimiInputs({
    kimiSessionsRoot: "/nonexistent/kimi/sessions",
  });

  assert.equal(result.transcripts.length, 0);
});
