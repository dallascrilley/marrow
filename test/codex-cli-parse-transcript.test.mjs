import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseCodexCliTranscript } from "../dist/adapters/codex-cli/parse-transcript.js";

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

test("classifier joins top-level type and payload.type into composite rawType", async () => {
  const result = await parseCodexCliTranscript({
    sourceHash: "sha256:test",
    sourcePath: fixturePath,
  });

  const types = result.records.map((record) => record.rawType);
  assert.deepEqual(types, [
    "session_meta",
    "event_msg/task_started",
    "response_item/message",
    "turn_context",
    "response_item/reasoning",
    "response_item/message",
    "response_item/function_call",
    "response_item/function_call_output",
    "event_msg/token_count",
  ]);
});

test("user/assistant messages and tool stubs get the right kind", async () => {
  const result = await parseCodexCliTranscript({
    sourceHash: "sha256:test",
    sourcePath: fixturePath,
  });
  const kinds = result.records.map((record) => record.kind);
  assert.deepEqual(kinds, [
    "event",
    "event",
    "user_message",
    "event",
    "event",
    "assistant_message",
    "tool_use_stub",
    "tool_result_stub",
    "event",
  ]);
});

test("user content array unwraps to a single string", async () => {
  const result = await parseCodexCliTranscript({
    sourceHash: "sha256:test",
    sourcePath: fixturePath,
  });
  const userRecord = result.records.find((record) => record.kind === "user_message");
  assert.ok(userRecord);
  assert.equal(
    userRecord.messageText,
    "Use `npm test` to verify the codex-cli demo before shipping.",
  );
  assert.deepEqual(userRecord.commandStrings, ["npm test"]);
});

test("assistant message body and file path extraction", async () => {
  const result = await parseCodexCliTranscript({
    sourceHash: "sha256:test",
    sourcePath: fixturePath,
  });
  const asstRecord = result.records.find((record) => record.kind === "assistant_message");
  assert.ok(asstRecord);
  assert.match(asstRecord.messageText, /codex-cli demo's verification step/);
  assert.ok(asstRecord.filePaths.includes("/Users/example/Code/demo/src"));
});

test("tool_use_stub captures name and call_id; tool_result_stub captures output as inputText", async () => {
  const result = await parseCodexCliTranscript({
    sourceHash: "sha256:test",
    sourcePath: fixturePath,
  });
  const toolUse = result.records.find((record) => record.kind === "tool_use_stub");
  const toolResult = result.records.find((record) => record.kind === "tool_result_stub");
  assert.ok(toolUse?.toolUse);
  assert.equal(toolUse.toolUse.name, "shell");
  assert.equal(toolUse.toolUse.callId, "call-1");
  assert.ok(toolResult?.toolUse);
  assert.equal(toolResult.toolUse.callId, "call-1");
});

test("sessionMeta sidecar is populated from line 0", async () => {
  const result = await parseCodexCliTranscript({
    sourceHash: "sha256:test",
    sourcePath: fixturePath,
  });
  assert.ok(result.sessionMeta);
  assert.equal(result.sessionMeta.cwd, "/Users/example/Code/demo");
  assert.equal(result.sessionMeta.id, "019df127-415e-7b43-a43b-96fc77a98775");
  assert.equal(result.sessionMeta.originator, "codex-cli");
});
