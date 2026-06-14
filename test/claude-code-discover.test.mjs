import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { discoverClaudeCodeInputs } from "../dist/adapters/claude-code/discover.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(testDir);
const fixturesRoot = join(projectRoot, "test", "fixtures", "claude-code", "projects");

test("discovers the smoke fixture session and attributes the workspace", async () => {
  const result = await discoverClaudeCodeInputs({
    claudeCodeProjectsRoot: fixturesRoot,
  });
  assert.equal(result.transcripts.length, 1);
  const transcript = result.transcripts[0];
  assert.equal(transcript.projectKey, "demo");
  assert.equal(transcript.workspacePath, "/Users/example/Code/demo");
  assert.equal(transcript.workspaceSlug, "-Users-example-Code-demo");
  assert.equal(transcript.sourceFormat, "jsonl");
  assert.ok(transcript.sourceHash.startsWith("sha256:"));
  assert.ok(transcript.sourcePath.endsWith("session-fixture-0001.jsonl"));
  assert.ok(transcript.sizeBytes > 0);
});

test("returns an empty list when the projects root is missing", async () => {
  const result = await discoverClaudeCodeInputs({
    claudeCodeProjectsRoot: join(fixturesRoot, "no-such-root"),
  });
  assert.deepEqual(result.transcripts, []);
});
