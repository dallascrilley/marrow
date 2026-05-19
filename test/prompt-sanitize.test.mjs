import test from "node:test";
import assert from "node:assert/strict";

import {
	capEvidenceText,
	DEFAULT_EVIDENCE_MAX_BYTES,
	extractSubstantivePrompt,
	firstSubstantivePromptFromTurns,
	isHarnessOrBootLine,
	isNoSignalPrompt,
	learningEvidenceFromPrompt,
	sanitizeUserPrompt,
} from "../dist/pipeline/prompt-sanitize.js";

test("sanitizeUserPrompt strips harness blocks and prefers user_query", () => {
	const raw = [
		"<cursor_commands>",
		"--- Cursor Command: plan ---",
		"</cursor_commands>",
		"<user_query>",
		"Fix retention gating for tiny sessions.",
		"</user_query>",
		"<attached_files>secret</attached_files>",
	].join("\n");

	const sanitized = sanitizeUserPrompt(raw);
	assert.match(sanitized, /Fix retention gating/);
	assert.doesNotMatch(sanitized, /cursor_commands/i);
	assert.doesNotMatch(sanitized, /attached_files/i);
});

test("extractSubstantivePrompt rejects AGENTS.md boot preambles", () => {
	const raw = [
		"# AGENTS.md instructions for agent-session-distillery",
		"<INSTRUCTIONS>",
		"Follow project standards.",
		"</INSTRUCTIONS>",
	].join("\n");

	assert.equal(extractSubstantivePrompt(raw), null);
	assert.ok(isHarnessOrBootLine("# AGENTS.md instructions for demo"));
});

test("extractSubstantivePrompt keeps real task after harness turn", () => {
	const raw = [
		"<INSTRUCTIONS>",
		"You are a coding agent.",
		"</INSTRUCTIONS>",
		"Run npm test and fix the failing reducer test.",
	].join("\n");

	const substantive = extractSubstantivePrompt(raw);
	assert.match(substantive, /npm test/);
});

test("firstSubstantivePromptFromTurns skips harness-only first turn", () => {
	const prompt = firstSubstantivePromptFromTurns([
		{ user_prompt: "# AGENTS.md instructions for demo-repo" },
		{ user_prompt: "Ship the vault-push carve-out documentation." },
	]);

	assert.match(prompt, /vault-push/);
});

test("capEvidenceText enforces byte cap", () => {
	const longText = "x".repeat(800);
	const capped = capEvidenceText(longText, DEFAULT_EVIDENCE_MAX_BYTES);
	assert.ok(Buffer.byteLength(capped, "utf8") <= DEFAULT_EVIDENCE_MAX_BYTES);
	assert.match(capped, /…$/);
});

test("learningEvidenceFromPrompt omits empty harness-only prompt", () => {
	const evidence = learningEvidenceFromPrompt(
		"# AGENTS.md instructions for demo",
		"pnpm test",
	);
	assert.deepEqual(evidence, ["pnpm test"]);
});

test("isNoSignalPrompt detects tiny test prompts", () => {
	assert.equal(isNoSignalPrompt("Hello"), true);
	assert.equal(isNoSignalPrompt("What is 2+2?"), true);
	assert.equal(isNoSignalPrompt("Say one"), true);
	assert.equal(
		isNoSignalPrompt("Refactor retention.ts to classify no-signal sessions."),
		false,
	);
});
