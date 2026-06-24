import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getSessionDetail } from "../dist/read/session-detail.js";

const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";

async function withRuntime(run) {
  const sandboxBase = await mkdtemp(join(tmpdir(), "asd-read-detail-"));
  const runtimeRoot = join(sandboxBase, "runtime-root");
  const previousOverride = process.env[runtimeOverrideEnvVar];

  process.env[runtimeOverrideEnvVar] = runtimeRoot;

  try {
    await run(runtimeRoot);
  } finally {
    if (previousOverride === undefined) {
      delete process.env[runtimeOverrideEnvVar];
    } else {
      process.env[runtimeOverrideEnvVar] = previousOverride;
    }

    await rm(sandboxBase, { force: true, recursive: true });
  }
}

async function seedIndex(runtimeRoot, sessionId) {
  await mkdir(join(runtimeRoot, "index"), { recursive: true });
  await writeFile(
    join(runtimeRoot, "index", "session-index.jsonl"),
    `${JSON.stringify({
      v: 1,
      source_path: "/tmp/source.jsonl",
      source_uuid: "source-uuid",
      source_tool: "cursor",
      asd_session_id: sessionId,
      topic: "Dashboard detail topic",
      topic_source: "deterministic",
      next_step: "Keep going",
      summary_json_path: join(runtimeRoot, "summaries", "by-session", sessionId, "summary.json"),
      updated_at: "2026-06-24T00:00:00.000Z",
    })}\n`,
    "utf8",
  );
}

test("getSessionDetail returns index, parsed summary, and reduced turns", async () => {
  await withRuntime(async (runtimeRoot) => {
    const sessionId = "detail-session";
    await seedIndex(runtimeRoot, sessionId);
    await mkdir(join(runtimeRoot, "summaries", "by-session", sessionId), { recursive: true });
    await mkdir(join(runtimeRoot, "staging", sessionId), { recursive: true });

    await writeFile(
      join(runtimeRoot, "summaries", "by-session", sessionId, "summary.json"),
      `${JSON.stringify({
        session_id: sessionId,
        topic: "Detail summary topic",
        topic_source: "deterministic",
        what_worked: [],
        what_failed: [],
        what_was_decided: [],
        useful_commands: [],
        files_of_interest: [],
        next_step: "Ship it",
        project_learnings: [],
        user_learnings: [],
        deletion_readiness: "ready",
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(runtimeRoot, "staging", sessionId, "reduced-session.json"),
      `${JSON.stringify({
        turns: [
          {
            assistant_summary: "Implemented dashboard readers.",
            commands_seen: [],
            ended_at: "2026-06-24T00:10:00.000Z",
            files_touched: ["src/read/session-detail.ts"],
            index: 0,
            session_id: sessionId,
            started_at: "2026-06-24T00:09:00.000Z",
            tool_stub_count: 0,
            turn_id: `${sessionId}:turn-0000`,
            user_prompt: "Add typed detail readers.",
            verification_seen: true,
          },
        ],
      })}\n`,
      "utf8",
    );

    const detail = await getSessionDetail(sessionId);

    assert.ok(detail);
    assert.equal(detail.index.asd_session_id, sessionId);
    assert.equal(detail.summary?.topic, "Detail summary topic");
    assert.equal(detail.reduced_turns.length, 1);
  });
});

test("getSessionDetail returns empty reduced_turns when the reduced artifact is missing", async () => {
  await withRuntime(async (runtimeRoot) => {
    const sessionId = "detail-session-missing-reduced";
    await seedIndex(runtimeRoot, sessionId);
    await mkdir(join(runtimeRoot, "summaries", "by-session", sessionId), { recursive: true });
    await writeFile(
      join(runtimeRoot, "summaries", "by-session", sessionId, "summary.json"),
      `${JSON.stringify({
        session_id: sessionId,
        topic: "Summary without reduced artifact",
        topic_source: "deterministic",
        what_worked: [],
        what_failed: [],
        what_was_decided: [],
        useful_commands: [],
        files_of_interest: [],
        next_step: "Regenerate reduced artifact",
        project_learnings: [],
        user_learnings: [],
        deletion_readiness: "pending_artifacts",
      })}\n`,
      "utf8",
    );

    const detail = await getSessionDetail(sessionId);

    assert.ok(detail);
    assert.deepEqual(detail.reduced_turns, []);
  });
});
