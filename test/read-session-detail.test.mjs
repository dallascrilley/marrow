import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getSessionDetail, getSessionDetailForRecord } from "../dist/read/session-detail.js";
import { getSessionManifestPathForRevision } from "../dist/writers/manifest-writer.js";

const runtimeOverrideEnvVar = "MARROW_ROOT";

async function withRuntime(run) {
  const sandboxBase = await mkdtemp(join(tmpdir(), "marrow-read-detail-"));
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

test("getSessionDetailForRecord reuses a supplied index record without reading the index file", async () => {
  await withRuntime(async (runtimeRoot) => {
    const sessionId = "detail-session-direct-record";
    await mkdir(join(runtimeRoot, "summaries", "by-session", sessionId), { recursive: true });
    await mkdir(join(runtimeRoot, "staging", sessionId), { recursive: true });

    await writeFile(
      join(runtimeRoot, "summaries", "by-session", sessionId, "summary.json"),
      `${JSON.stringify({
        session_id: sessionId,
        topic: "Direct record summary",
        topic_source: "deterministic",
        what_worked: [],
        what_failed: [],
        what_was_decided: [],
        useful_commands: [],
        files_of_interest: [],
        next_step: "Use the supplied record",
        project_learnings: [],
        user_learnings: [],
        deletion_readiness: "ready",
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(runtimeRoot, "staging", sessionId, "reduced-session.json"),
      `${JSON.stringify({
        turns: [],
      })}\n`,
      "utf8",
    );

    const detail = await getSessionDetailForRecord({
      v: 1,
      source_path: "/tmp/source.jsonl",
      source_uuid: "source-uuid-direct",
      source_tool: "cursor",
      asd_session_id: sessionId,
      topic: "Direct record topic",
      topic_source: "deterministic",
      next_step: "Use the supplied record",
      summary_json_path: join(runtimeRoot, "summaries", "by-session", sessionId, "summary.json"),
      updated_at: "2026-06-24T00:00:00.000Z",
    });

    assert.equal(detail.index.asd_session_id, sessionId);
    assert.equal(detail.summary?.topic, "Direct record summary");
    assert.deepEqual(detail.reduced_turns, []);
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

test("getSessionDetail falls back to rebuilt index when cached index is stale", async () => {
  await withRuntime(async (runtimeRoot) => {
    const staleSessionId = "stale-index-session";
    const liveSessionId = "rebuilt-detail-session";
    const sourcePath = join(runtimeRoot, "fixtures", `${liveSessionId}.jsonl`);
    const summaryPath = join(runtimeRoot, "summaries", "by-session", liveSessionId, "summary.json");
    const manifestPath = getSessionManifestPathForRevision(
      liveSessionId,
      "sha256:rebuiltindex1234",
    );

    await seedIndex(runtimeRoot, staleSessionId);
    await mkdir(join(runtimeRoot, "fixtures"), { recursive: true });
    await mkdir(join(runtimeRoot, "summaries", "by-session", liveSessionId), { recursive: true });
    await mkdir(join(runtimeRoot, "sources", "manifests"), { recursive: true });
    await mkdir(join(runtimeRoot, "staging", liveSessionId), { recursive: true });

    await writeFile(sourcePath, '{"type":"session"}\n', "utf8");
    await writeFile(
      summaryPath,
      `${JSON.stringify({
        session_id: liveSessionId,
        topic: "Recovered from rebuilt index",
        topic_source: "deterministic",
        what_worked: [],
        what_failed: [],
        what_was_decided: [],
        useful_commands: [],
        files_of_interest: [],
        next_step: "Use the rebuilt index entry.",
        project_learnings: [],
        user_learnings: [],
        deletion_readiness: "ready",
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(runtimeRoot, "staging", liveSessionId, "reduced-session.json"),
      `${JSON.stringify({
        turns: [
          {
            assistant_summary: "Recovered session detail from rebuilt index.",
            commands_seen: [],
            ended_at: "2026-06-24T00:10:00.000Z",
            files_touched: [],
            index: 0,
            session_id: liveSessionId,
            started_at: "2026-06-24T00:09:00.000Z",
            tool_stub_count: 0,
            turn_id: `${liveSessionId}:turn-0000`,
            user_prompt: "Inspect the survivor directly.",
            verification_seen: false,
          },
        ],
      })}\n`,
      "utf8",
    );
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        artifact_paths: {
          project_knowledge_jsonl_path: null,
          retention_receipt_path: join(runtimeRoot, "deletes", "receipts", `${liveSessionId}.json`),
          summary_json_path: summaryPath,
          summary_markdown_path: join(
            runtimeRoot,
            "summaries",
            "by-session",
            liveSessionId,
            "summary.md",
          ),
          user_knowledge_jsonl_path: null,
        },
        generated_at: "2026-06-24T00:02:00.000Z",
        session: {
          conversation_id: `demo:${liveSessionId}`,
          ingest_status: "discovered",
          project_key: "demo",
          retention_status: "kept",
          session_id: liveSessionId,
          source_format: "jsonl",
          source_hash: "sha256:rebuiltindex1234",
          source_path: sourcePath,
          source_tool: "cursor",
          started_at: "2026-06-24T00:00:00.000Z",
          updated_at: "2026-06-24T00:01:00.000Z",
          workspace_path: "Users-example-Code-demo",
        },
        source_span: {
          event_count: 1,
          first_turn_id: `${liveSessionId}:turn-0000`,
          last_turn_id: `${liveSessionId}:turn-0000`,
          line_end: 1,
          line_start: 1,
          turn_count: 1,
        },
        version: 1,
      })}\n`,
      "utf8",
    );

    const detail = await getSessionDetail(liveSessionId);

    assert.ok(detail);
    assert.equal(detail.index.asd_session_id, liveSessionId);
    assert.equal(detail.summary?.topic, "Recovered from rebuilt index");
    assert.equal(detail.reduced_turns.length, 1);
  });
});

test("getSessionDetail builds the index from manifests when no index file exists", async () => {
  await withRuntime(async (runtimeRoot) => {
    // No seedIndex(): the on-disk session-index.jsonl is absent, so the read
    // throws and getSessionDetail must build once from the manifest — and that
    // single build is authoritative (no redundant second build).
    const sessionId = "no-index-file-session";
    const sourcePath = join(runtimeRoot, "fixtures", `${sessionId}.jsonl`);
    const summaryPath = join(runtimeRoot, "summaries", "by-session", sessionId, "summary.json");
    const manifestPath = getSessionManifestPathForRevision(sessionId, "sha256:noindexfile12345");

    await mkdir(join(runtimeRoot, "fixtures"), { recursive: true });
    await mkdir(join(runtimeRoot, "summaries", "by-session", sessionId), { recursive: true });
    await mkdir(join(runtimeRoot, "sources", "manifests"), { recursive: true });
    await mkdir(join(runtimeRoot, "staging", sessionId), { recursive: true });

    await writeFile(sourcePath, '{"type":"session"}\n', "utf8");
    await writeFile(
      summaryPath,
      `${JSON.stringify({
        session_id: sessionId,
        topic: "Built from manifest without an index file",
        topic_source: "deterministic",
        what_worked: [],
        what_failed: [],
        what_was_decided: [],
        useful_commands: [],
        files_of_interest: [],
        next_step: "Resolve via the freshly built index.",
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
            assistant_summary: "Resolved detail without a persisted index file.",
            commands_seen: [],
            ended_at: "2026-06-24T00:10:00.000Z",
            files_touched: [],
            index: 0,
            session_id: sessionId,
            started_at: "2026-06-24T00:09:00.000Z",
            tool_stub_count: 0,
            turn_id: `${sessionId}:turn-0000`,
            user_prompt: "Inspect without an index.",
            verification_seen: false,
          },
        ],
      })}\n`,
      "utf8",
    );
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        artifact_paths: {
          project_knowledge_jsonl_path: null,
          retention_receipt_path: join(runtimeRoot, "deletes", "receipts", `${sessionId}.json`),
          summary_json_path: summaryPath,
          summary_markdown_path: join(
            runtimeRoot,
            "summaries",
            "by-session",
            sessionId,
            "summary.md",
          ),
          user_knowledge_jsonl_path: null,
        },
        generated_at: "2026-06-24T00:02:00.000Z",
        session: {
          conversation_id: `demo:${sessionId}`,
          ingest_status: "discovered",
          project_key: "demo",
          retention_status: "kept",
          session_id: sessionId,
          source_format: "jsonl",
          source_hash: "sha256:noindexfile12345",
          source_path: sourcePath,
          source_tool: "cursor",
          started_at: "2026-06-24T00:00:00.000Z",
          updated_at: "2026-06-24T00:01:00.000Z",
          workspace_path: "Users-example-Code-demo",
        },
        source_span: {
          event_count: 1,
          first_turn_id: `${sessionId}:turn-0000`,
          last_turn_id: `${sessionId}:turn-0000`,
          line_end: 1,
          line_start: 1,
          turn_count: 1,
        },
        version: 1,
      })}\n`,
      "utf8",
    );

    const detail = await getSessionDetail(sessionId);

    assert.ok(detail);
    assert.equal(detail.index.asd_session_id, sessionId);
    assert.equal(detail.summary?.topic, "Built from manifest without an index file");
    assert.equal(detail.reduced_turns.length, 1);
  });
});
