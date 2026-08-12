import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildSessionIndex,
  loadSessionIndexRecords,
  parseSessionIndexJsonl,
  readSessionIndexFile,
} from "../dist/read/session-index.js";

const runtimeOverrideEnvVar = "MARROW_ROOT";

async function withRuntime(run) {
  const sandboxBase = await mkdtemp(join(tmpdir(), "marrow-read-index-"));
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

test("parseSessionIndexJsonl skips blank lines and validates records", () => {
  const contents = `\n${JSON.stringify({
    v: 1,
    source_path: "/tmp/one.jsonl",
    source_uuid: "one",
    source_tool: "cursor",
    asd_session_id: "session-1",
    topic: "Topic one",
    topic_source: "deterministic",
    next_step: "Next one",
    summary_json_path: "/tmp/summary-one.json",
    updated_at: "2026-06-24T00:00:00.000Z",
  })}\n\n${JSON.stringify({
    v: 1,
    source_path: "/tmp/two.jsonl",
    source_uuid: "two",
    source_tool: "claude-code",
    asd_session_id: "session-2",
    topic: "Topic two",
    topic_source: "llm",
    next_step: "Next two",
    summary_json_path: "/tmp/summary-two.json",
    updated_at: "2026-06-24T00:01:00.000Z",
  })}\n`;

  const records = parseSessionIndexJsonl(contents);

  assert.equal(records.length, 2);
  assert.equal(records[0].asd_session_id, "session-1");
  assert.equal(records[1].source_tool, "claude-code");
  assert.throws(
    () => parseSessionIndexJsonl('{"bad":true}\n'),
    (error) => {
      assert.equal(error?.constructor?.name, "ZodError");
      return true;
    },
  );
});

test("readSessionIndexFile reads a sandbox jsonl file", async () => {
  await withRuntime(async (runtimeRoot) => {
    const indexPath = join(runtimeRoot, "index", "session-index.jsonl");
    await mkdir(join(runtimeRoot, "index"), { recursive: true });
    await writeFile(
      indexPath,
      `${JSON.stringify({
        v: 1,
        source_path: "/tmp/one.jsonl",
        source_uuid: "one",
        source_tool: "cursor",
        asd_session_id: "session-1",
        topic: "Topic one",
        topic_source: "deterministic",
        next_step: "Next one",
        summary_json_path: "/tmp/summary-one.json",
        updated_at: "2026-06-24T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const records = await readSessionIndexFile(indexPath);
    assert.equal(records.length, 1);
    assert.equal(records[0].topic, "Topic one");
  });
});

test("loadSessionIndexRecords falls back to buildSessionIndex when index is missing", async () => {
  await withRuntime(async (runtimeRoot) => {
    const sourcePath = join(
      runtimeRoot,
      "fixtures",
      "rollout-019e516f-5f85-7550-a1b9-adcbab812b33.jsonl",
    );
    const summaryPath = join(
      runtimeRoot,
      "summaries",
      "by-session",
      "fallback-session",
      "summary.json",
    );
    const manifestPath = join(runtimeRoot, "sources", "manifests", "fallback-session.json");

    await mkdir(join(runtimeRoot, "fixtures"), { recursive: true });
    await mkdir(join(runtimeRoot, "summaries", "by-session", "fallback-session"), {
      recursive: true,
    });
    await mkdir(join(runtimeRoot, "sources", "manifests"), { recursive: true });
    await writeFile(sourcePath, '{"type":"session"}\n', "utf8");
    await writeFile(
      summaryPath,
      `${JSON.stringify({
        session_id: "fallback-session",
        topic: "Built from manifest",
        topic_source: "deterministic",
        what_worked: [],
        what_failed: [],
        what_was_decided: [],
        useful_commands: [],
        files_of_interest: [],
        next_step: "Keep shipping.",
        project_learnings: [],
        user_learnings: [],
        deletion_readiness: "ready",
      })}\n`,
      "utf8",
    );
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        artifact_paths: {
          summary_json_path: summaryPath,
        },
        generated_at: "2026-06-24T00:02:00.000Z",
        session: {
          conversation_id: "demo:fallback-session",
          ingest_status: "archived",
          project_key: "demo",
          retention_status: "kept",
          session_id: "fallback-session",
          source_format: "jsonl",
          source_hash: "sha256:fallback",
          source_path: sourcePath,
          source_tool: "codex-cli",
          started_at: "2026-06-24T00:00:00.000Z",
          updated_at: "2026-06-24T00:01:00.000Z",
          workspace_path: "/Users/example/Code/demo",
        },
        version: 1,
      })}\n`,
      "utf8",
    );

    const built = await buildSessionIndex();
    const records = await loadSessionIndexRecords({ fallbackToBuild: true });

    assert.equal(records.length, 1);
    assert.deepEqual(records, built);
    assert.equal(records[0].asd_session_id, "fallback-session");
    assert.equal(records[0].source_uuid, "019e516f-5f85-7550-a1b9-adcbab812b33");
  });
});

test("buildSessionIndex excludes sessions listed in excludeSessionIds", async () => {
  await withRuntime(async (runtimeRoot) => {
    async function writeManifest(sessionId, topic, sourcePath) {
      const summaryPath = join(runtimeRoot, "summaries", "by-session", sessionId, "summary.json");
      const manifestPath = join(runtimeRoot, "sources", "manifests", `${sessionId}.json`);

      await mkdir(join(runtimeRoot, "summaries", "by-session", sessionId), { recursive: true });
      await mkdir(join(runtimeRoot, "sources", "manifests"), { recursive: true });
      await writeFile(
        summaryPath,
        `${JSON.stringify({
          session_id: sessionId,
          topic,
          topic_source: "deterministic",
          what_worked: [],
          what_failed: [],
          what_was_decided: [],
          useful_commands: [],
          files_of_interest: [],
          next_step: "Keep shipping.",
          project_learnings: [],
          user_learnings: [],
          deletion_readiness: "ready",
        })}\n`,
        "utf8",
      );
      await writeFile(
        manifestPath,
        `${JSON.stringify({
          artifact_paths: {
            summary_json_path: summaryPath,
          },
          generated_at: "2026-06-24T00:02:00.000Z",
          session: {
            conversation_id: `demo:${sessionId}`,
            ingest_status: "archived",
            project_key: "demo",
            retention_status: "kept",
            session_id: sessionId,
            source_format: "jsonl",
            source_hash: `sha256:${sessionId}`,
            source_path: sourcePath,
            source_tool: "cursor",
            started_at: "2026-06-24T00:00:00.000Z",
            updated_at: "2026-06-24T00:01:00.000Z",
            workspace_path: "/Users/example/Code/demo",
          },
          version: 1,
        })}\n`,
        "utf8",
      );
    }

    await writeManifest(
      "active-session",
      "Active topic",
      join(runtimeRoot, "fixtures", "active.jsonl"),
    );
    await writeManifest(
      "deleted-session",
      "# Instructions (read first)",
      join(runtimeRoot, "fixtures", "deleted.jsonl"),
    );

    const allRecords = await buildSessionIndex();
    assert.equal(allRecords.length, 2);

    const filtered = await buildSessionIndex({
      excludeSessionIds: new Set(["deleted-session"]),
    });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].asd_session_id, "active-session");
  });
});
