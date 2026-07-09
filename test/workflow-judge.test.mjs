import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readWorkflowDecisions } from "../dist/workflow/decisions.js";
import {
  judgeWorkflowCandidate,
  parseWorkflowJudgeVerdict,
  runWorkflowJudge,
  workflowJudgeContentHash,
} from "../dist/workflow/judge.js";

const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";

function summary(sessionId, overrides = {}) {
  return {
    session_id: sessionId,
    topic: "Workflow judge fixture",
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
  const sandbox = await mkdtemp(join(tmpdir(), "asd-workflow-judge-"));
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

function stubFetch(
  verdictJson,
  usage = { cost: 0.00002, prompt_tokens: 40, completion_tokens: 12 },
) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: verdictJson } }], usage }),
  });
}

function candidate(overrides = {}) {
  return {
    artifact_kind: "rule",
    candidate_id: "wf_candidate",
    cluster: "validation",
    rule_id: "validation-explicit-verify",
    contradicting_count: 0,
    confidence: "strong",
    supporting_count: 1,
    evidence_count: 1,
    evidence_sessions: [
      {
        asd_session_id: "wf-judge-1",
        evidence_kind: "explicit_preference",
        excerpt: "Always run script/cibuild before claiming CI is green.",
        matched_rule_id: "validation-explicit-verify",
        source_tool: "cursor",
        topic: "Workflow judge fixture",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
    ],
    guidance: "Always run verification before final summary.",
    recommendation: "adopt",
    risk: "low",
    source_tier: "keyword",
    trigger: "Always verify with script/cibuild before saying it works.",
    ...overrides,
  };
}

test("parseWorkflowJudgeVerdict accepts wrapped JSON and rejects invalid verdicts", () => {
  const parsed = parseWorkflowJudgeVerdict(
    '```json\n{"wording_ok":true,"artifact_kind":"rule","confidence":"strong","reason":"Supported."}\n```',
  );
  assert.equal(parsed.wording_ok, true);
  assert.equal(parsed.artifact_kind, "rule");

  assert.throws(() => parseWorkflowJudgeVerdict("no json"));
  assert.throws(() =>
    parseWorkflowJudgeVerdict(
      '{"wording_ok":true,"artifact_kind":"rule","confidence":"certain","reason":"x"}',
    ),
  );
});

test("judgeWorkflowCandidate calls the model and parses a workflow verdict", async () => {
  const result = await judgeWorkflowCandidate({
    apiKey: "test-key",
    candidate: candidate(),
    fetchImpl: stubFetch(
      '{"wording_ok":true,"artifact_kind":"rule","confidence":"strong","reason":"Evidence supports it."}',
    ),
    model: "openai/gpt-5-nano",
  });

  assert.equal(result.verdict.wording_ok, true);
  assert.equal(result.verdict.confidence, "strong");
  assert.equal(result.usage.model, "openai/gpt-5-nano");
});

test("workflowJudgeContentHash changes when reviewable content changes", () => {
  const first = workflowJudgeContentHash(candidate());
  const same = workflowJudgeContentHash(candidate());
  const changed = workflowJudgeContentHash(
    candidate({ guidance: "Run script/cibuild before review." }),
  );

  assert.equal(first, same);
  assert.notEqual(first, changed);
});

test("runWorkflowJudge appends judged decisions and reuses cache without network", async () => {
  const { runtimeRoot, sandbox } = await writeRuntime([
    {
      sessionId: "wf-judge-1",
      summary: summary("wf-judge-1", {
        what_was_decided: ["Always run script/cibuild before claiming CI is green."],
      }),
      turns: [
        turn("wf-judge-1", {
          user_prompt: "Always verify with script/cibuild before you say it works.",
        }),
      ],
    },
  ]);
  const previousRoot = process.env[runtimeOverrideEnvVar];
  process.env[runtimeOverrideEnvVar] = runtimeRoot;
  try {
    let calls = 0;
    const fetchImpl = async (...args) => {
      calls += 1;
      return stubFetch(
        '{"wording_ok":true,"artifact_kind":"rule","confidence":"strong","reason":"Evidence supports OPENROUTER_API_KEY=secret and /Users/example/project."}',
      )(...args);
    };

    const first = await runWorkflowJudge({
      apiKey: "test-key",
      days: 30,
      fetchImpl,
      limit: 1,
      maxPer: "5/24h",
      maxUsd: "1/24h",
      model: "openai/gpt-5-nano",
    });

    assert.equal(first.judged, 1);
    assert.equal(first.from_cache, 0);
    assert.equal(calls, 1);
    assert.equal(first.judged_candidates[0].verdict.wording_ok, true);

    const ledger = await readWorkflowDecisions();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].decision, "judged");
    assert.match(ledger[0].note, /\[secret-ref\].*\[local-path\]/);

    const second = await runWorkflowJudge({
      apiKey: "test-key",
      days: 30,
      fetchImpl: async () => {
        throw new Error("cache hit should not call fetch");
      },
      limit: 1,
      maxPer: "0/24h",
      maxUsd: "0/24h",
      model: "openai/gpt-5-nano",
    });

    assert.equal(second.judged, 0);
    assert.equal(second.from_cache, 0);
    assert.equal(second.judged_candidates.length, 0);
    assert.equal((await readWorkflowDecisions()).length, 1);
    assert.equal(calls, 1);
  } finally {
    if (previousRoot === undefined) delete process.env[runtimeOverrideEnvVar];
    else process.env[runtimeOverrideEnvVar] = previousRoot;
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("runWorkflowJudge skips paid calls when count budget is exhausted", async () => {
  const { runtimeRoot, sandbox } = await writeRuntime([
    {
      sessionId: "wf-budget-1",
      summary: summary("wf-budget-1", {
        what_was_decided: ["Always run script/cibuild before claiming CI is green."],
      }),
      turns: [turn("wf-budget-1")],
    },
  ]);
  const previousRoot = process.env[runtimeOverrideEnvVar];
  process.env[runtimeOverrideEnvVar] = runtimeRoot;
  try {
    const result = await runWorkflowJudge({
      apiKey: "test-key",
      days: 30,
      fetchImpl: async () => {
        throw new Error("budget-exhausted run should not call fetch");
      },
      limit: 1,
      maxPer: "0/24h",
      maxUsd: "1/24h",
      model: "openai/gpt-5-nano",
    });

    assert.equal(result.stopped_reason, "count_budget_exhausted");
    assert.equal(result.judged, 0);
    assert.equal(result.judged_candidates.length, 0);
  } finally {
    if (previousRoot === undefined) delete process.env[runtimeOverrideEnvVar];
    else process.env[runtimeOverrideEnvVar] = previousRoot;
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("workflow show surfaces judged verdict notes", async () => {
  const { runtimeRoot, sandbox } = await writeRuntime([
    {
      sessionId: "wf-show-judge-1",
      summary: summary("wf-show-judge-1", {
        what_was_decided: ["Always run script/cibuild before claiming CI is green."],
      }),
      turns: [turn("wf-show-judge-1")],
    },
  ]);
  const previousRoot = process.env[runtimeOverrideEnvVar];
  process.env[runtimeOverrideEnvVar] = runtimeRoot;
  try {
    const judged = await runWorkflowJudge({
      apiKey: "test-key",
      days: 30,
      fetchImpl: stubFetch(
        '{"wording_ok":false,"suggested_guidance":"Run script/cibuild before claiming completion.","artifact_kind":"rule","confidence":"medium","reason":"Wording should name the gate."}',
      ),
      limit: 1,
      maxPer: "5/24h",
      maxUsd: "1/24h",
      model: "openai/gpt-5-nano",
    });
    assert.equal(judged.judged_candidates.length, 1);

    const cliPath = join(dirnameFromTest(), "dist", "cli.js");
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(
      process.execPath,
      [cliPath, "workflow", "show", judged.judged_candidates[0].candidate_id, "--days", "30"],
      {
        cwd: dirnameFromTest(),
        encoding: "utf8",
        env: { ...process.env, [runtimeOverrideEnvVar]: runtimeRoot },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Decision: judged/);
    assert.match(result.stdout, /Wording should name the gate/);
  } finally {
    if (previousRoot === undefined) delete process.env[runtimeOverrideEnvVar];
    else process.env[runtimeOverrideEnvVar] = previousRoot;
    await rm(sandbox, { force: true, recursive: true });
  }
});

function dirnameFromTest() {
  return new URL("..", import.meta.url).pathname.replace(/\/$/, "");
}
