import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { mineWorkflowCandidates } from "../dist/workflow/mine.js";

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
