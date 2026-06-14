import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parsePiTranscript } from "../dist/adapters/pi/parse-transcript.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(testDir);
const fixturePath = join(
  projectRoot,
  "test",
  "fixtures",
  "pi",
  "sessions",
  "--Users-example-Code-demo--",
  "2026-05-18T00-28-01-780Z_019e387b-8d74-7c8b-9578-ff8d1151ae4f.jsonl",
);

test("composite rawType joins top-level type with message.role", async () => {
  const result = await parsePiTranscript({
    sourceHash: "sha256:test",
    sourcePath: fixturePath,
  });

  const types = result.records.map((record) => record.rawType);
  assert.deepEqual(types, [
    "session",
    "model_change",
    "thinking_level_change",
    "custom_message",
    "message/user",
    "message/assistant",
    "message/toolResult",
  ]);
});

test("role-based classifier produces user/assistant/tool_result kinds", async () => {
  const result = await parsePiTranscript({
    sourceHash: "sha256:test",
    sourcePath: fixturePath,
  });
  const kinds = result.records.map((record) => record.kind);
  assert.deepEqual(kinds, [
    "event",
    "event",
    "event",
    "event",
    "user_message",
    "assistant_message",
    "tool_result_stub",
  ]);
});

test("user content array unwraps to a single string", async () => {
  const result = await parsePiTranscript({
    sourceHash: "sha256:test",
    sourcePath: fixturePath,
  });
  const userRecord = result.records.find((record) => record.kind === "user_message");
  assert.ok(userRecord);
  assert.equal(userRecord.messageText, "Use `npm test` to verify the pi demo before shipping.");
  assert.deepEqual(userRecord.commandStrings, ["npm test"]);
});

test("assistant message body unwraps text blocks (thinking + text + toolCall)", async () => {
  const result = await parsePiTranscript({
    sourceHash: "sha256:test",
    sourcePath: fixturePath,
  });
  const asstRecord = result.records.find((record) => record.kind === "assistant_message");
  assert.ok(asstRecord);
  assert.match(asstRecord.messageText, /pi demo's test suite/);
  // Recursive unwrap pulls the `thinking` text too in phase 1; verify it's present:
  assert.match(asstRecord.messageText, /plan the run/);
  assert.ok(asstRecord.filePaths.includes("/Users/example/Code/demo/src"));
});

test("toolResult record carries toolCallId and toolName on toolUse stub", async () => {
  const result = await parsePiTranscript({
    sourceHash: "sha256:test",
    sourcePath: fixturePath,
  });
  const toolResult = result.records.find((record) => record.kind === "tool_result_stub");
  assert.ok(toolResult?.toolUse);
  assert.equal(toolResult.toolUse.callId, "call-1");
  assert.equal(toolResult.toolUse.name, "shell");
});

test("sessionMeta sidecar is populated from line 0", async () => {
  const result = await parsePiTranscript({
    sourceHash: "sha256:test",
    sourcePath: fixturePath,
  });
  assert.ok(result.sessionMeta);
  assert.equal(result.sessionMeta.cwd, "/Users/example/Code/demo");
  assert.equal(result.sessionMeta.id, "019e387b-8d74-7c8b-9578-ff8d1151ae4f");
  assert.equal(result.sessionMeta.version, 3);
});
