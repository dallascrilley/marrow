import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveGlobalInstinct } from "../dist/v2/instinct/global-store.js";
import { appendWorkflowDecision } from "../dist/workflow/decisions.js";
import { mineWorkflowCandidates } from "../dist/workflow/mine.js";

function globalInstinct(overrides = {}) {
  return {
    schema_version: 1,
    id: "run-verification-before-claiming-completion-1234abcd",
    trigger: "Before claiming completion",
    finding: "Run verification before claiming completion",
    confidence: 0.8,
    confidence_floor: 0.5,
    domain: "workflow",
    maturity: "proven",
    scope: "global",
    project_id: "",
    source: {
      first_session: "instinct-session",
      first_observed_at: "2026-07-01T00:00:00.000Z",
      source_refs: [],
      observations: [
        { session: "instinct-session", reinforcing: true, at: "2026-07-01T00:00:00.000Z" },
      ],
    },
    related: [],
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    last_promoted_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";

function summary(sessionId, overrides = {}) {
  return {
    session_id: sessionId,
    topic: "Workflow mining fixture",
    topic_source: "deterministic",
    what_worked: [],
    what_failed: [],
    what_was_decided: [],
    useful_commands: [],
    files_of_interest: [],
    next_step: "Continue.",
    project_learnings: [],
    user_learnings: [],
    deletion_readiness: "ready",
    ...overrides,
  };
}

function turn(sessionId, overrides = {}) {
  return {
    assistant_summary: "Implemented the requested change.",
    commands_seen: [],
    ended_at: "2026-07-08T00:01:00.000Z",
    files_touched: [],
    index: 0,
    session_id: sessionId,
    started_at: "2026-07-08T00:00:00.000Z",
    tool_stub_count: 0,
    turn_id: `${sessionId}:turn-0000`,
    user_prompt: "Proceed.",
    verification_seen: false,
    ...overrides,
  };
}

async function writeRuntime(records) {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-workflow-mine-"));
  const runtimeRoot = join(sandbox, "runtime-root");
  const indexDir = join(runtimeRoot, "index");
  await mkdir(indexDir, { recursive: true });
  const indexRecords = [];

  for (const record of records) {
    const summaryDir = join(runtimeRoot, "summaries", "by-session", record.sessionId);
    const stagingDir = join(runtimeRoot, "staging", record.sessionId);
    await mkdir(summaryDir, { recursive: true });
    await mkdir(stagingDir, { recursive: true });
    const summaryPath = join(summaryDir, "summary.json");
    await writeFile(summaryPath, `${JSON.stringify(record.summary)}\n`, "utf8");
    await writeFile(
      join(stagingDir, "reduced-session.json"),
      `${JSON.stringify({ turns: record.turns })}\n`,
      "utf8",
    );
    indexRecords.push({
      v: 1,
      source_path: `/tmp/${record.sessionId}.jsonl`,
      source_uuid: record.sessionId,
      source_tool: record.sourceTool ?? "cursor",
      asd_session_id: record.sessionId,
      topic: record.summary.topic,
      topic_source: record.summary.topic_source,
      next_step: record.summary.next_step,
      summary_json_path: summaryPath,
      updated_at: record.updatedAt ?? "2026-07-08T00:00:00.000Z",
    });
  }

  await writeFile(
    join(indexDir, "session-index.jsonl"),
    `${indexRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );

  return { runtimeRoot, sandbox };
}

test("mineWorkflowCandidates promotes explicit user validation preferences", async () => {
  const { runtimeRoot, sandbox } = await writeRuntime([
    {
      sessionId: "wf-strong-1",
      summary: summary("wf-strong-1", {
        what_was_decided: ["Always run script/cibuild before claiming CI is green."],
      }),
      turns: [
        turn("wf-strong-1", {
          user_prompt: "Always verify with script/cibuild before you say it works.",
        }),
      ],
    },
  ]);

  try {
    process.env[runtimeOverrideEnvVar] = runtimeRoot;
    const result = await mineWorkflowCandidates({ days: 30 });
    const validation = result.candidates.find((candidate) => candidate.cluster === "validation");

    assert.ok(validation);
    assert.equal(validation.confidence, "strong");
    assert.equal(validation.recommendation, "adopt");
    assert.equal(validation.artifact_kind, "rule");
    assert.deepEqual(
      validation.evidence_sessions.map((item) => item.asd_session_id),
      ["wf-strong-1"],
    );
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("mineWorkflowCandidates keys candidate ids on stable rule ids", async () => {
  const { runtimeRoot, sandbox } = await writeRuntime([
    {
      sessionId: "wf-rule-id-1",
      summary: summary("wf-rule-id-1", {
        what_was_decided: ["Always run script/cibuild before claiming CI is green."],
      }),
      turns: [turn("wf-rule-id-1")],
    },
  ]);

  try {
    process.env[runtimeOverrideEnvVar] = runtimeRoot;
    const firstResult = await mineWorkflowCandidates({ days: 30 });
    const firstCandidate = firstResult.candidates.find(
      (candidate) => candidate.rule_id === "validation-explicit-verify",
    );

    assert.ok(firstCandidate);
    assert.equal(firstCandidate.rule_id, "validation-explicit-verify");
    assert.equal(firstCandidate.candidate_id, "wf_cd61247b3c");
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("mineWorkflowCandidates dismisses weak single-session agent patterns", async () => {
  const { runtimeRoot, sandbox } = await writeRuntime([
    {
      sessionId: "wf-weak-1",
      summary: summary("wf-weak-1", {
        what_worked: ["Opened a PR with local notes."],
      }),
      turns: [turn("wf-weak-1")],
    },
  ]);

  try {
    process.env[runtimeOverrideEnvVar] = runtimeRoot;
    const result = await mineWorkflowCandidates({ days: 30 });
    const shipping = result.candidates.find((candidate) => candidate.cluster === "shipping");

    assert.ok(shipping);
    assert.equal(shipping.confidence, "weak");
    assert.equal(shipping.recommendation, "dismiss");
    assert.equal(shipping.artifact_kind, "none");
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("mineWorkflowCandidates asks on contradicted validation guidance", async () => {
  const { runtimeRoot, sandbox } = await writeRuntime([
    {
      sessionId: "wf-contradicted-1",
      summary: summary("wf-contradicted-1", {
        what_was_decided: ["Skip verification for this docs-only update."],
      }),
      turns: [turn("wf-contradicted-1")],
    },
  ]);

  try {
    process.env[runtimeOverrideEnvVar] = runtimeRoot;
    const result = await mineWorkflowCandidates({ days: 30 });
    const validation = result.candidates.find((candidate) => candidate.cluster === "validation");

    assert.ok(validation);
    assert.equal(validation.confidence, "contradicted");
    assert.equal(validation.recommendation, "ask");
    assert.notEqual(validation.recommendation, "adopt");
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("mineWorkflowCandidates signs negated verification as contradiction", async () => {
  const { runtimeRoot, sandbox } = await writeRuntime([
    {
      sessionId: "wf-negated-1",
      summary: summary("wf-negated-1", {
        what_was_decided: ["You never need to verify docs-only edits."],
      }),
      turns: [turn("wf-negated-1")],
    },
  ]);

  try {
    process.env[runtimeOverrideEnvVar] = runtimeRoot;
    const result = await mineWorkflowCandidates({ days: 30 });
    const validation = result.candidates.find((candidate) => candidate.cluster === "validation");

    assert.ok(validation);
    assert.equal(validation.supporting_count, 0);
    assert.equal(validation.contradicting_count, 1);
    assert.equal(validation.evidence_sessions[0].evidence_kind, "contradiction");
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("mineWorkflowCandidates uses contradiction ratio for confidence", async () => {
  const records = Array.from({ length: 9 }, (_, index) => ({
    sessionId: `wf-supported-${index}`,
    summary: summary(`wf-supported-${index}`, {
      what_was_decided: ["Always run verification before claiming completion."],
    }),
    turns: [turn(`wf-supported-${index}`)],
  }));
  records.push({
    sessionId: "wf-one-contradiction",
    summary: summary("wf-one-contradiction", {
      what_was_decided: ["Skip verification for this docs-only update."],
    }),
    turns: [turn("wf-one-contradiction")],
  });
  const { runtimeRoot, sandbox } = await writeRuntime(records);

  try {
    process.env[runtimeOverrideEnvVar] = runtimeRoot;
    const result = await mineWorkflowCandidates({ days: 30 });
    const validation = result.candidates.find((candidate) => candidate.cluster === "validation");

    assert.ok(validation);
    assert.equal(validation.supporting_count, 9);
    assert.equal(validation.contradicting_count, 1);
    assert.equal(validation.confidence, "strong");
    assert.equal(validation.recommendation, "adopt");
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("mineWorkflowCandidates counts a session with contradiction as contradicting only", async () => {
  const { runtimeRoot, sandbox } = await writeRuntime([
    {
      sessionId: "wf-mixed-1",
      summary: summary("wf-mixed-1", {
        what_worked: ["Always run verification before final summary."],
        what_was_decided: ["Skip verification for this docs-only update."],
      }),
      turns: [turn("wf-mixed-1")],
    },
  ]);

  try {
    process.env[runtimeOverrideEnvVar] = runtimeRoot;
    const result = await mineWorkflowCandidates({ days: 30 });
    const validation = result.candidates.find(
      (candidate) => candidate.rule_id === "validation-explicit-verify",
    );

    assert.ok(validation);
    assert.equal(validation.supporting_count, 0);
    assert.equal(validation.contradicting_count, 1);
    assert.equal(validation.confidence, "contradicted");
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("mineWorkflowCandidates keeps excerpts for cross-part matches", async () => {
  const { runtimeRoot, sandbox } = await writeRuntime([
    {
      sessionId: "wf-cross-part-1",
      summary: summary("wf-cross-part-1", {
        what_was_decided: ["Always run"],
        project_learnings: ["verification before claiming completion."],
      }),
      turns: [turn("wf-cross-part-1")],
    },
  ]);

  try {
    process.env[runtimeOverrideEnvVar] = runtimeRoot;
    const result = await mineWorkflowCandidates({ days: 30 });
    const validation = result.candidates.find(
      (candidate) => candidate.rule_id === "validation-explicit-verify",
    );

    assert.ok(validation);
    assert.match(validation.evidence_sessions[0].excerpt, /Always run verification/);
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("mineWorkflowCandidates redacts local paths from marker matching and evidence topics", async () => {
  const { runtimeRoot, sandbox } = await writeRuntime([
    {
      sessionId: "wf-path-1",
      summary: summary("wf-path-1", {
        topic: "Debug /Users/example/private/customer/path failure",
        what_failed: ["Log from /Users/example/private/customer/path mentioned a failure."],
      }),
      turns: [turn("wf-path-1")],
    },
  ]);

  try {
    process.env[runtimeOverrideEnvVar] = runtimeRoot;
    const result = await mineWorkflowCandidates({ days: 30 });
    const serialized = JSON.stringify(result);

    assert.doesNotMatch(serialized, /\/Users\/example\/private/);
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("mineWorkflowCandidates includes sanitized evidence excerpts", async () => {
  const { runtimeRoot, sandbox } = await writeRuntime([
    {
      sessionId: "wf-excerpt-1",
      summary: summary("wf-excerpt-1", {
        what_was_decided: [
          "**Verified:** Always run script/cibuild before claiming CI is green for /Users/example/private/path. | secret | table | API_KEY=abc123",
        ],
      }),
      turns: [turn("wf-excerpt-1")],
    },
  ]);

  try {
    process.env[runtimeOverrideEnvVar] = runtimeRoot;
    const result = await mineWorkflowCandidates({ days: 30 });
    const validation = result.candidates.find((candidate) => candidate.cluster === "validation");

    assert.ok(validation);
    assert.equal(validation.evidence_count, 1);
    assert.equal(validation.evidence_sessions[0].matched_rule_id, validation.rule_id);
    assert.ok(validation.evidence_sessions[0].excerpt.length <= 200);
    assert.doesNotMatch(validation.evidence_sessions[0].excerpt, /\/Users\/example/);
    assert.doesNotMatch(validation.evidence_sessions[0].excerpt, /API_KEY=abc123/);
    assert.doesNotMatch(validation.evidence_sessions[0].excerpt, /\*\*|\|/);
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("mineWorkflowCandidates suppresses already encoded global instincts", async () => {
  const { runtimeRoot, sandbox } = await writeRuntime([
    {
      sessionId: "wf-encoded-1",
      summary: summary("wf-encoded-1", {
        what_was_decided: ["Always run verification before claiming completion."],
      }),
      turns: [turn("wf-encoded-1")],
    },
  ]);

  try {
    process.env[runtimeOverrideEnvVar] = runtimeRoot;
    await saveGlobalInstinct(
      globalInstinct({
        finding: "Run relevant verification before claiming behavior works or work is complete",
        trigger: "Before claiming completion merge readiness or CI status",
      }),
    );
    const result = await mineWorkflowCandidates({ days: 30 });
    const validation = result.candidates.find((candidate) => candidate.cluster === "validation");

    assert.ok(validation);
    assert.equal(validation.status, "already_encoded");
    assert.equal(validation.encoded_in, "run-verification-before-claiming-completion-1234abcd");
    assert.equal(validation.recommendation, "dismiss");
    assert.equal(validation.artifact_kind, "none");
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("mineWorkflowCandidates does not suppress unrelated global instincts", async () => {
  const { runtimeRoot, sandbox } = await writeRuntime([
    {
      sessionId: "wf-unencoded-1",
      summary: summary("wf-unencoded-1", {
        what_was_decided: ["Always run verification before claiming completion."],
      }),
      turns: [turn("wf-unencoded-1")],
    },
  ]);

  try {
    process.env[runtimeOverrideEnvVar] = runtimeRoot;
    await saveGlobalInstinct(
      globalInstinct({
        id: "prefer-small-pull-requests-1234abcd",
        trigger: "When preparing a branch",
        finding: "Prefer small pull requests with focused commits",
      }),
    );
    const result = await mineWorkflowCandidates({ days: 30 });
    const validation = result.candidates.find((candidate) => candidate.cluster === "validation");

    assert.ok(validation);
    assert.equal(validation.status, undefined);
    assert.equal(validation.encoded_in, undefined);
    assert.equal(validation.recommendation, "adopt");
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("mineWorkflowCandidates caps evidence sessions and preserves evidence count", async () => {
  const records = Array.from({ length: 15 }, (_, index) => ({
    sessionId: `wf-cap-${String(index).padStart(2, "0")}`,
    updatedAt: `2026-07-08T00:${String(index).padStart(2, "0")}:00.000Z`,
    summary: summary(`wf-cap-${String(index).padStart(2, "0")}`, {
      what_was_decided: ["Always run verification before final summary."],
    }),
    turns: [turn(`wf-cap-${String(index).padStart(2, "0")}`)],
  }));
  const { runtimeRoot, sandbox } = await writeRuntime(records);

  try {
    process.env[runtimeOverrideEnvVar] = runtimeRoot;
    const result = await mineWorkflowCandidates({ days: 30 });
    const validation = result.candidates.find((candidate) => candidate.cluster === "validation");

    assert.ok(validation);
    assert.equal(validation.evidence_count, 15);
    assert.equal(validation.evidence_sessions.length, 10);
    assert.equal(validation.evidence_sessions[0].asd_session_id, "wf-cap-14");
    assert.equal(validation.evidence_sessions.at(-1).asd_session_id, "wf-cap-05");
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("mineWorkflowCandidates excludes malformed timestamps from day window", async () => {
  const { runtimeRoot, sandbox } = await writeRuntime([
    {
      sessionId: "wf-bad-date-1",
      updatedAt: "not-a-date",
      summary: summary("wf-bad-date-1", {
        what_was_decided: ["Always run verification before final summary."],
      }),
      turns: [turn("wf-bad-date-1")],
    },
  ]);

  try {
    process.env[runtimeOverrideEnvVar] = runtimeRoot;
    const result = await mineWorkflowCandidates({ days: 30 });

    assert.equal(result.sessions_scanned, 0);
    assert.deepEqual(result.candidates, []);
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("mineWorkflowCandidates marks repeated accepted patterns as medium", async () => {
  const { runtimeRoot, sandbox } = await writeRuntime([
    {
      sessionId: "wf-medium-1",
      summary: summary("wf-medium-1", {
        what_worked: ["Opened a PR with concrete CI evidence."],
      }),
      turns: [turn("wf-medium-1")],
    },
    {
      sessionId: "wf-medium-2",
      summary: summary("wf-medium-2", {
        what_worked: ["Prepared the PR with branch and CI notes."],
      }),
      turns: [turn("wf-medium-2")],
    },
  ]);

  try {
    process.env[runtimeOverrideEnvVar] = runtimeRoot;
    const result = await mineWorkflowCandidates({ days: 30 });
    const shipping = result.candidates.find((candidate) => candidate.cluster === "shipping");

    assert.ok(shipping);
    assert.equal(shipping.confidence, "medium");
    assert.equal(shipping.recommendation, "consider");
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("mineWorkflowCandidates emits instinct-tier candidates from global instincts", async () => {
  const { runtimeRoot, sandbox } = await writeRuntime([
    {
      sessionId: "wf-keyword-rank",
      summary: summary("wf-keyword-rank", {
        what_was_decided: ["Always run verification before final summary."],
      }),
      turns: [turn("wf-keyword-rank")],
    },
  ]);

  try {
    process.env[runtimeOverrideEnvVar] = runtimeRoot;
    await saveGlobalInstinct(
      globalInstinct({
        id: "keep-shipping-evidence-concrete-1234abcd",
        finding: "Keep shipping evidence tied to concrete commands and CI state",
        trigger: "When preparing a change for review",
      }),
    );

    const result = await mineWorkflowCandidates({ days: 30 });
    const instinct = result.candidates.find((candidate) => candidate.source_tier === "instinct");

    assert.ok(instinct);
    assert.equal(instinct.confidence, "strong");
    assert.equal(instinct.recommendation, "adopt");
    assert.equal(
      instinct.guidance,
      "Keep shipping evidence tied to concrete commands and CI state",
    );
    assert.equal(instinct.trigger, "When preparing a change for review");
    assert.equal(instinct.evidence_sessions[0].asd_session_id, "instinct-session");
    assert.ok(
      result.candidates.findIndex((candidate) => candidate.source_tier === "instinct") <
        result.candidates.findIndex((candidate) => candidate.source_tier === "keyword"),
    );
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("mineWorkflowCandidates keeps ledger decisions for instinct-tier candidates", async () => {
  const { runtimeRoot, sandbox } = await writeRuntime([]);

  try {
    process.env[runtimeOverrideEnvVar] = runtimeRoot;
    await saveGlobalInstinct(
      globalInstinct({
        id: "review-with-independent-evidence-1234abcd",
        finding: "Use independent review evidence before closing review-gated work",
        maturity: "established",
        trigger: "When closing review-gated work",
      }),
    );

    const first = await mineWorkflowCandidates({ days: 30 });
    const candidate = first.candidates.find((item) => item.source_tier === "instinct");
    assert.ok(candidate);
    assert.equal(candidate.confidence, "medium");

    await appendWorkflowDecision({
      candidate_id: candidate.candidate_id,
      decision: "dismiss",
      rule_id: candidate.rule_id,
    });

    const hidden = await mineWorkflowCandidates({ days: 30 });
    assert.equal(
      hidden.candidates.some((item) => item.candidate_id === candidate.candidate_id),
      false,
    );

    const included = await mineWorkflowCandidates({ days: 30, includeDecided: true });
    const decided = included.candidates.find(
      (item) => item.candidate_id === candidate.candidate_id,
    );
    assert.equal(decided?.decision?.decision, "dismiss");
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});
test("mineWorkflowCandidates applies source and day filters", async () => {
  const { runtimeRoot, sandbox } = await writeRuntime([
    {
      sessionId: "wf-cursor-1",
      sourceTool: "cursor",
      summary: summary("wf-cursor-1", {
        what_was_decided: ["Always run verification before final summary."],
      }),
      turns: [turn("wf-cursor-1")],
    },
    {
      sessionId: "wf-codex-old",
      sourceTool: "codex-cli",
      updatedAt: "2026-06-01T00:00:00.000Z",
      summary: summary("wf-codex-old", {
        what_was_decided: ["Always run verification before final summary."],
      }),
      turns: [turn("wf-codex-old")],
    },
  ]);

  try {
    process.env[runtimeOverrideEnvVar] = runtimeRoot;
    const result = await mineWorkflowCandidates({ days: 30, source: "cursor" });

    assert.equal(result.sessions_scanned, 1);
    assert.equal(result.source, "cursor");
    assert.deepEqual(
      result.candidates[0].evidence_sessions.map((item) => item.asd_session_id),
      ["wf-cursor-1"],
    );
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});
