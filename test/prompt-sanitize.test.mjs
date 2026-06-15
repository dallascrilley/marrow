import assert from "node:assert/strict";
import test from "node:test";

import {
  capEvidenceText,
  DEFAULT_EVIDENCE_MAX_BYTES,
  extractSubstantivePrompt,
  firstSubstantivePromptFromTurns,
  isHarnessOrBootLine,
  isNoSignalPrompt,
  isTinyNoSignalSession,
  learningEvidenceFromPrompt,
  looksLikeAssistantProcessChatter,
  looksLikeSkillHarnessLeak,
  sanitizeHarnessLeakText,
  sanitizeLearningTitle,
  sanitizeUserPrompt,
  stripAssistantFraming,
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
  const evidence = learningEvidenceFromPrompt("# AGENTS.md instructions for demo", "pnpm test");
  assert.deepEqual(evidence, ["pnpm test"]);
});

test("isNoSignalPrompt detects tiny test prompts", () => {
  assert.equal(isNoSignalPrompt("Hello"), true);
  assert.equal(isNoSignalPrompt("What is 2+2?"), true);
  assert.equal(isNoSignalPrompt("Say one"), true);
  assert.equal(isNoSignalPrompt("Thanks!"), true);
  assert.equal(isNoSignalPrompt("Refactor retention.ts to classify no-signal sessions."), false);
});

test("sanitizeUserPrompt strips skill blocks and SKILL.md paths", () => {
  const raw = [
    "<skill>dogfood</skill>",
    "Keep vault-push carve-out scoped to asd-learnings/.",
    "See ~/.cursor/skills/dogfood/SKILL.md for triggers.",
  ].join("\n");

  const sanitized = sanitizeUserPrompt(raw);
  assert.match(sanitized, /vault-push carve-out/);
  assert.doesNotMatch(sanitized, /<skill/i);
  assert.doesNotMatch(sanitized, /SKILL\.md/i);
});

test("sanitizeHarnessLeakText removes skill preamble lines", () => {
  const raw = [
    "Use when the user asks to dogfood a workflow.",
    "Decision: scope vault writes to asd-learnings/ only.",
  ].join("\n");

  const sanitized = sanitizeHarnessLeakText(raw);
  assert.match(sanitized, /scope vault writes/);
  assert.doesNotMatch(sanitized, /Use when/i);
});

test("extractSubstantivePrompt drops Base directory skill preamble", () => {
  const raw = [
    "Base directory for this skill: /Users/me/.cursor/skills/overseer",
    "Run pnpm test in agent-session-distillery before vault push.",
  ].join("\n");

  const substantive = extractSubstantivePrompt(raw);
  assert.match(substantive, /pnpm test/);
  assert.doesNotMatch(substantive, /Base directory for this skill/i);
});

test("learningEvidenceFromPrompt omits skill preamble evidence", () => {
  const evidence = learningEvidenceFromPrompt(
    [
      "Base directory for this skill: /tmp/skills/foo",
      "Verify memory push-wiki only writes asd-learnings/.",
    ].join("\n"),
  );

  assert.equal(evidence.length, 1);
  assert.match(evidence[0], /memory push-wiki/);
  assert.doesNotMatch(evidence[0], /Base directory/i);
});

test("sanitizeLearningTitle rebuilds when title body has skill tags", () => {
  const title = sanitizeLearningTitle(
    "Decision: Refer to docs/spec.md for <skill>plan</skill> architecture decisions.",
    "Refer to docs/spec.md for sherry content architecture decisions.",
    60,
  );

  assert.match(title, /^Decision:/);
  assert.doesNotMatch(title, /<skill/i);
  assert.match(title, /sherry content/i);
});

test("looksLikeSkillHarnessLeak flags skill metadata", () => {
  assert.equal(looksLikeSkillHarnessLeak("<skill>plan</skill> topic"), true);
  assert.equal(looksLikeSkillHarnessLeak("Prefer sqlite WAL for ledger durability."), false);
});

test("isTinyNoSignalSession accepts multi-turn smoke without durable task", () => {
  assert.equal(isTinyNoSignalSession([{ user_prompt: "Hello" }, { user_prompt: "Say one" }]), true);
  assert.equal(
    isTinyNoSignalSession([
      { user_prompt: "Hello" },
      { user_prompt: "Make these tests go faster in src/foo.test.ts" },
    ]),
    false,
  );
});

test("looksLikeAssistantProcessChatter flags observed bad phrases", () => {
  assert.equal(looksLikeAssistantProcessChatter("This is converging beautifully."), true);
  assert.equal(
    looksLikeAssistantProcessChatter("Good — and that's a genuinely important loosening."),
    true,
  );
  assert.equal(
    looksLikeAssistantProcessChatter("Handoff written to .agents-state/handoff.md."),
    true,
  );
  assert.equal(looksLikeAssistantProcessChatter("Cold-read check passed."), true);
  assert.equal(looksLikeAssistantProcessChatter("Verified: all tests pass."), true);
  assert.equal(looksLikeAssistantProcessChatter("Done — fixed the reducer race."), true);
  assert.equal(
    looksLikeAssistantProcessChatter("Summary of what changed: added retry logic."),
    true,
  );
  assert.equal(looksLikeAssistantProcessChatter("Use sqlite WAL for ledger durability."), false);
  assert.equal(
    looksLikeAssistantProcessChatter("Decision: scope vault writes to asd-learnings/."),
    false,
  );
});

test("stripAssistantFraming removes completion wrappers", () => {
  assert.equal(stripAssistantFraming("Verified: tests pass."), "tests pass.");
  assert.equal(stripAssistantFraming("Done — fixed the reducer race."), "fixed the reducer race.");
  assert.equal(
    stripAssistantFraming("Good — that locks the carve-out."),
    "that locks the carve-out.",
  );
  assert.equal(
    stripAssistantFraming("**Done:** wired the budget hook. **Verified:** `./scripts/qa`."),
    "wired the budget hook. `./scripts/qa`.",
  );
  assert.equal(
    stripAssistantFraming("Summary of what changed: added retry logic."),
    "added retry logic.",
  );
});
