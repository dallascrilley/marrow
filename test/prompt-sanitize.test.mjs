import assert from "node:assert/strict";
import test from "node:test";

import {
  isNoSignalPrompt,
  looksLikeEmbeddedAgentPrompt,
  sanitizeLearningStatement,
} from "../dist/pipeline/prompt-sanitize.js";

test("sanitizeLearningStatement strips bold emphasis", () => {
  assert.equal(
    sanitizeLearningStatement("**Verdict: Approved** The spec is consistent."),
    "Approved The spec is consistent.",
  );
});

test("sanitizeLearningStatement strips italic emphasis", () => {
  assert.equal(
    sanitizeLearningStatement("Use *worker threads* instead of forks"),
    "Use worker threads instead of forks",
  );
});

test("sanitizeLearningStatement truncates markdown tables", () => {
  const raw =
    "Given how far behind main the branches are, **cherry-picking onto fresh branches from main** is usually better than rebasing.\n\n## Rebase vs cherry-pick vs fresh start\n\n| Approach | Effort | Risk | Best when |\n|----------|--------|------|-----------|\n| rebase   | high   | high | short-lived branch |";
  const got = sanitizeLearningStatement(raw);
  assert.ok(!got.includes("|"), "table pipes should be removed");
  assert.ok(!got.includes("Approach"), "table header should be removed");
  assert.match(got, /cherry-picking onto fresh branches from main/);
  assert.ok(got.endsWith("rebasing."), "statement should end before the table");
});

test("sanitizeLearningStatement strips headings", () => {
  assert.equal(
    sanitizeLearningStatement("## Implemented Vitest config pool threads"),
    "Implemented Vitest config pool threads",
  );
});

test("sanitizeLearningStatement strips list bullets", () => {
  assert.equal(
    sanitizeLearningStatement("- pool: 'threads'\n- environment: 'happy-dom'"),
    "pool: 'threads' environment: 'happy-dom'",
  );
});
test("sanitizeLearningStatement strips fenced code blocks", () => {
  assert.equal(
    sanitizeLearningStatement("Use this config.\n```ts\nconst x = 1;\n```"),
    "Use this config.",
  );
});
test("sanitizeLearningStatement strips unclosed fenced code blocks", () => {
  assert.equal(
    sanitizeLearningStatement("Do this locally:\n```bash\ngit stash\n"),
    "Do this locally:",
  );
});
test("sanitizeLearningStatement strips markdown links keeping text", () => {
  assert.equal(
    sanitizeLearningStatement("See [PR #462](https://github.com/example/pull/462) for details."),
    "See PR #462 for details.",
  );
});
test("sanitizeLearningStatement strips assistant framing tokens", () => {
  assert.equal(sanitizeLearningStatement("Verified: the fix works."), "the fix works.");
  assert.equal(sanitizeLearningStatement("Summary of changes: added tests."), "added tests.");
  assert.equal(
    sanitizeLearningStatement("Done — integrated the parser."),
    "integrated the parser.",
  );
});

test("sanitizeLearningStatement preserves underscores inside file paths", () => {
  assert.equal(
    sanitizeLearningStatement("In `sql_dialect.py`, move the dedup rewrite earlier."),
    "In `sql_dialect.py`, move the dedup rewrite earlier.",
  );
  assert.equal(
    sanitizeLearningStatement("Call `_rewrite_clip_delivery_dedup` before the generic strip."),
    "Call `_rewrite_clip_delivery_dedup` before the generic strip.",
  );
});

test("looksLikeEmbeddedAgentPrompt detects foreign system/developer prompts", () => {
  assert.equal(
    looksLikeEmbeddedAgentPrompt("You are a memory extractor for a personal AI design assistant."),
    true,
  );
  assert.equal(
    looksLikeEmbeddedAgentPrompt("Given the user's most recent message, decide what to store."),
    true,
  );
  assert.equal(
    looksLikeEmbeddedAgentPrompt("Respond only with valid JSON containing the entries."),
    true,
  );
  // Interactive turns must not be misclassified.
  assert.equal(looksLikeEmbeddedAgentPrompt("You broke the build, please fix it."), false);
  assert.equal(looksLikeEmbeddedAgentPrompt("add a json export command to the cli"), false);
});

test("isNoSignalPrompt treats embedded agent prompts as no-signal", () => {
  assert.equal(
    isNoSignalPrompt("You are a memory extractor for a personal AI design assistant."),
    true,
  );
  assert.equal(isNoSignalPrompt("i want autocompletions for my git branches"), false);
  assert.equal(isNoSignalPrompt("review open PRs"), false);
  assert.equal(isNoSignalPrompt("review pull requests"), false);
});
