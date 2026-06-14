import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseClaudeCodeTranscript } from "../dist/adapters/claude-code/parse-transcript.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(testDir);
const fixturePath = join(
  projectRoot,
  "test",
  "fixtures",
  "claude-code",
  "projects",
  "-Users-example-Code-demo",
  "session-fixture-0001.jsonl",
);

test("parser classifies every line into the shared discriminator kinds", async () => {
  const result = await parseClaudeCodeTranscript({
    sourceHash: "sha256:test",
    sourcePath: fixturePath,
  });

  const kinds = result.records.map((record) => record.kind);
  const types = result.records.map((record) => record.rawType);

  assert.equal(result.records.length, 6);
  assert.deepEqual(types, [
    "last-prompt",
    "permission-mode",
    "attachment",
    "user",
    "assistant",
    "system",
  ]);
  assert.deepEqual(kinds, [
    "event",
    "event",
    "event",
    "user_message",
    "assistant_message",
    "event",
  ]);
});

test("user message body comes from message.content string", async () => {
  const result = await parseClaudeCodeTranscript({
    sourceHash: "sha256:test",
    sourcePath: fixturePath,
  });
  const userRecord = result.records.find((record) => record.kind === "user_message");
  assert.ok(userRecord);
  assert.equal(userRecord.messageText, "Use `npm test` to verify the demo before shipping.");
  assert.deepEqual(userRecord.commandStrings, ["npm test"]);
});

test("assistant message body unwraps the content array's text block", async () => {
  const result = await parseClaudeCodeTranscript({
    sourceHash: "sha256:test",
    sourcePath: fixturePath,
  });
  const asstRecord = result.records.find((record) => record.kind === "assistant_message");
  assert.ok(asstRecord);
  assert.match(asstRecord.messageText, /demo's test suite/);
  assert.ok(
    asstRecord.filePaths.includes("/Users/example/Code/demo/src"),
    `expected to extract /Users/example/Code/demo/src from the assistant body, got ${JSON.stringify(asstRecord.filePaths)}`,
  );
});

test("provenance captures lineNumber, sourceHash, sourcePath for each record", async () => {
  const result = await parseClaudeCodeTranscript({
    sourceHash: "sha256:test",
    sourcePath: fixturePath,
  });
  const first = result.records[0];
  assert.equal(first.provenance.lineNumber, 1);
  assert.equal(first.provenance.sourceHash, "sha256:test");
  assert.equal(first.provenance.sourcePath, fixturePath);
});
