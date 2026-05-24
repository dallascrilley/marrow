import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseKimiTranscript } from "../dist/adapters/kimi/parse-transcript.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
	testDir,
	"fixtures",
	"kimi",
	"sessions",
	"6d146076ef0a6aa290cf3370faef0249",
	"3a2034d0-f75c-4bf5-b010-771ab81ad581",
	"wire.jsonl",
);

function parseFixture() {
	return parseKimiTranscript({
		sourceHash: "sha256:test",
		sourcePath: fixturePath,
	});
}

test("parseKimiTranscript reads all records from fixture", async () => {
	const result = await parseFixture();
	assert.equal(result.records.length, 12);
});

test("classifies TurnBegin as user_message", async () => {
	const result = await parseFixture();
	const userMessages = result.records.filter((r) => r.kind === "user_message");
	assert.equal(userMessages.length, 2);

	const firstUser = userMessages[0];
	assert.ok(firstUser.messageText.includes("symlink"));
	assert.equal(firstUser.rawType, "TurnBegin");
});

test("classifies ContentPart as assistant_message", async () => {
	const result = await parseFixture();
	const assistantMessages = result.records.filter(
		(r) => r.kind === "assistant_message",
	);
	assert.equal(assistantMessages.length, 2);

	const firstAssistant = assistantMessages[0];
	assert.ok(firstAssistant.messageText.includes("script"));
	assert.equal(firstAssistant.rawType, "ContentPart");
});

test("classifies ToolCall as tool_use_stub", async () => {
	const result = await parseFixture();
	const toolUses = result.records.filter((r) => r.kind === "tool_use_stub");
	assert.equal(toolUses.length, 2);

	const firstTool = toolUses[0];
	assert.equal(firstTool.toolUse.name, "Shell");
	assert.ok(firstTool.toolUse.callId?.startsWith("tool_"));
	assert.equal(firstTool.rawType, "ToolCall");
});

test("classifies ToolResult as tool_result_stub", async () => {
	const result = await parseFixture();
	const toolResults = result.records.filter(
		(r) => r.kind === "tool_result_stub",
	);
	assert.equal(toolResults.length, 2);

	const firstResult = toolResults[0];
	assert.ok(
		firstResult.messageText.includes("osint") ||
			firstResult.messageText.includes("Done"),
	);
	assert.equal(firstResult.rawType, "ToolResult");
});

test("classifies metadata and status as event", async () => {
	const result = await parseFixture();
	const events = result.records.filter((r) => r.kind === "event");
	// metadata, StepBegin, TurnEnd, StatusUpdate = 4
	assert.equal(events.length, 4);
});

test("extracts commands from tool calls", async () => {
	const result = await parseFixture();
	const toolUses = result.records.filter((r) => r.kind === "tool_use_stub");
	const firstTool = toolUses[0];
	assert.ok(firstTool.commandStrings.some((c) => c.includes("git")));
});

test("extracts file paths from tool results", async () => {
	const result = await parseFixture();
	const toolResults = result.records.filter(
		(r) => r.kind === "tool_result_stub",
	);
	const firstResult = toolResults[0];
	assert.ok(firstResult.filePaths.some((f) => f.includes("skills")));
});

test("sets provenance on every record", async () => {
	const result = await parseFixture();
	for (const record of result.records) {
		assert.ok(record.provenance.lineNumber > 0);
		assert.equal(record.provenance.sourceHash, "sha256:test");
		assert.equal(record.provenance.sourcePath, fixturePath);
	}
});

test("extracts timestamp hints from unix epoch floats", async () => {
	const result = await parseFixture();
	const firstRecord = result.records[1]; // first after metadata
	assert.ok(firstRecord.timestampHint?.includes("T"));
	assert.ok(
		firstRecord.timestampHint?.includes("Z") ||
			firstRecord.timestampHint?.includes("+"),
	);
});

test("handles user_input as content part array", async () => {
	const result = await parseFixture();
	const userMessages = result.records.filter((r) => r.kind === "user_message");
	const arrayInput = userMessages.find((r) => r.messageText === "Run it.");
	assert.ok(arrayInput, "Should parse array-form user_input");
});
