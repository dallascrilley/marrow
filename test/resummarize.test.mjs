import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSessionIndex } from "../dist/commands/export-index.js";
import { createLedger, listSourceSessions, upsertSourceSession } from "../dist/db/ledger.js";
import { sourceSessionFixture, turnSchema } from "../dist/models/canonical.js";
import { resummarizeSessions } from "../dist/pipeline/resummarize.js";
import { isLowSignalTopic, summarizeSession } from "../dist/pipeline/summarize.js";
import { writeSessionManifest } from "../dist/writers/manifest-writer.js";
import { writeSessionSummary } from "../dist/writers/summary-writer.js";

const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";

test("isLowSignalTopic flags bare skill slugs and wrapper-only topics", () => {
  assert.equal(isLowSignalTopic("brainstorming"), true);
  assert.equal(isLowSignalTopic("whats-next"), true);
  assert.equal(isLowSignalTopic("Fix export-index contract topic provenance"), false);
});

test("summarizeSession skips skill-wrapper-only user prompts for topic", () => {
  const sourceSession = {
    ...sourceSessionFixture,
    project_key: "agent-session-distillery",
    session_id: "skill-wrapper-skip",
  };
  const turns = [
    turnSchema.parse({
      assistant_summary: "Used brainstorming skill.",
      commands_seen: [],
      ended_at: "2026-05-22T20:10:00.000Z",
      files_touched: [],
      index: 0,
      session_id: sourceSession.session_id,
      started_at: "2026-05-22T20:09:00.000Z",
      tool_stub_count: 0,
      turn_id: `${sourceSession.session_id}:turn-0000`,
      user_prompt:
        '<skill name="brainstorming" location="/tmp/brainstorming/SKILL.md">Explore options before building.</skill>',
      verification_seen: false,
    }),
    turnSchema.parse({
      assistant_summary: "Implemented session index export.",
      commands_seen: [],
      ended_at: "2026-05-22T20:11:00.000Z",
      files_touched: ["src/commands/export-index.ts"],
      index: 1,
      session_id: sourceSession.session_id,
      started_at: "2026-05-22T20:10:30.000Z",
      tool_stub_count: 0,
      turn_id: `${sourceSession.session_id}:turn-0001`,
      user_prompt: "Add export-index command for Tether session search.",
      verification_seen: false,
    }),
  ];

  const summary = summarizeSession({ events: [], sourceSession, turns });
  assert.equal(summary.topic, "Add export-index command for Tether session search.");
});

test("resummarizeSessions upgrades topic without touching manifest bytes", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-resummarize-"));
  const runtimeRoot = join(sandbox, "runtime");
  process.env[runtimeOverrideEnvVar] = runtimeRoot;

  try {
    const database = await createLedger();
    const sessionId = "resummarize-fixture";
    const sourcePath = join(sandbox, "fixture.jsonl");
    await writeFile(sourcePath, '{"type":"session"}\n', "utf8");

    const upserted = upsertSourceSession(database, {
      conversation_id: `demo:${sessionId}`,
      ingest_status: "archived",
      project_key: "demo",
      retention_status: "kept",
      session_id: sessionId,
      source_format: "jsonl",
      source_hash: "sha256:resummarize-fixture",
      source_path: sourcePath,
      source_tool: "cursor",
      started_at: "2026-05-22T19:00:00.000Z",
      updated_at: "2026-05-22T20:00:00.000Z",
      workspace_path: "/Users/example/Code/demo",
    });

    const summary = await writeSessionSummary({
      session_id: sessionId,
      topic: "brainstorming",
      topic_source: "deterministic",
      what_worked: [],
      what_failed: [],
      what_was_decided: [],
      useful_commands: [],
      files_of_interest: [],
      next_step: "No open next step recorded.",
      project_learnings: [],
      user_learnings: [],
      deletion_readiness: "ready",
    });

    const manifestBefore = await writeSessionManifest({
      artifactPaths: {
        project_knowledge_jsonl_path: null,
        retention_receipt_path: join(runtimeRoot, "reports", "receipt.json"),
        summary_json_path: summary.summaryPath,
        summary_markdown_path: summary.markdownPath,
        user_knowledge_jsonl_path: null,
      },
      events: [],
      sourceSession: {
        conversation_id: upserted.sourceSession.conversation_id,
        ingest_status: upserted.sourceSession.ingest_status,
        project_key: upserted.sourceSession.project_key,
        retention_status: upserted.sourceSession.retention_status,
        session_id: sessionId,
        source_format: upserted.sourceSession.source_format,
        source_hash: upserted.sourceSession.source_hash,
        source_path: sourcePath,
        source_tool: upserted.sourceSession.source_tool,
        started_at: upserted.sourceSession.started_at,
        updated_at: upserted.sourceSession.updated_at,
        workspace_path: upserted.sourceSession.workspace_path,
      },
      turns: [],
    });

    const manifestBytesBefore = await readFile(manifestBefore.path, "utf8");

    const reducedArtifact = join(runtimeRoot, "staging", sessionId, "reduced-session.json");
    await mkdir(join(runtimeRoot, "staging", sessionId), { recursive: true });
    await writeFile(
      reducedArtifact,
      JSON.stringify({
        events: [],
        turns: [
          turnSchema.parse({
            assistant_summary: "Implemented export-index.",
            commands_seen: [],
            ended_at: "2026-05-22T20:11:00.000Z",
            files_touched: ["src/commands/export-index.ts"],
            index: 0,
            session_id: sessionId,
            started_at: "2026-05-22T20:10:30.000Z",
            tool_stub_count: 0,
            turn_id: `${sessionId}:turn-0000`,
            user_prompt: "Add export-index command for Tether session search.",
            verification_seen: false,
          }),
        ],
      }),
      "utf8",
    );

    const result = await resummarizeSessions(database, {
      sessionIds: [sessionId],
      llmTopic: false,
    });

    assert.equal(result.processed_count, 1);
    assert.equal(result.skipped_count, 0);
    assert.deepEqual(result.skipped, []);
    assert.equal(result.failed_count, 0);

    const upgraded = JSON.parse(await readFile(summary.summaryPath, "utf8"));
    assert.equal(upgraded.topic, "Add export-index command for Tether session search.");
    assert.equal(await readFile(manifestBefore.path, "utf8"), manifestBytesBefore);

    const indexRecords = await buildSessionIndex();
    const record = indexRecords.find((entry) => entry.asd_session_id === sessionId);
    assert.ok(record);
    assert.equal(record.topic, upgraded.topic);
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("listSourceSessions remains available for resummarize candidate discovery", async () => {
  const database = await createLedger();
  assert.equal(Array.isArray(listSourceSessions(database)), true);
});

async function seedResummarizeFixture({
  database,
  runtimeRoot,
  sandbox,
  sessionId,
  topic,
  userPrompt,
  withManifest = true,
}) {
  const sourcePath = join(sandbox, `${sessionId}.jsonl`);
  await writeFile(sourcePath, '{"type":"session"}\n', "utf8");

  const upserted = upsertSourceSession(database, {
    conversation_id: `demo:${sessionId}`,
    ingest_status: "archived",
    project_key: "demo",
    retention_status: "kept",
    session_id: sessionId,
    source_format: "jsonl",
    source_hash: `sha256:${sessionId}`,
    source_path: sourcePath,
    source_tool: "cursor",
    started_at: "2026-05-22T19:00:00.000Z",
    updated_at: "2026-05-22T20:00:00.000Z",
    workspace_path: "/Users/example/Code/demo",
  });

  const summary = await writeSessionSummary({
    session_id: sessionId,
    topic,
    topic_source: "deterministic",
    what_worked: [],
    what_failed: [],
    what_was_decided: [],
    useful_commands: [],
    files_of_interest: [],
    next_step: "No open next step recorded.",
    project_learnings: [],
    user_learnings: [],
    deletion_readiness: "ready",
  });

  if (withManifest) {
    await writeSessionManifest({
      artifactPaths: {
        project_knowledge_jsonl_path: null,
        retention_receipt_path: join(runtimeRoot, "reports", `${sessionId}-receipt.json`),
        summary_json_path: summary.summaryPath,
        summary_markdown_path: summary.markdownPath,
        user_knowledge_jsonl_path: null,
      },
      events: [],
      sourceSession: {
        conversation_id: upserted.sourceSession.conversation_id,
        ingest_status: upserted.sourceSession.ingest_status,
        project_key: upserted.sourceSession.project_key,
        retention_status: upserted.sourceSession.retention_status,
        session_id: sessionId,
        source_format: upserted.sourceSession.source_format,
        source_hash: upserted.sourceSession.source_hash,
        source_path: sourcePath,
        source_tool: upserted.sourceSession.source_tool,
        started_at: upserted.sourceSession.started_at,
        updated_at: upserted.sourceSession.updated_at,
        workspace_path: upserted.sourceSession.workspace_path,
      },
      turns: [],
    });
  }

  const reducedArtifact = join(runtimeRoot, "staging", sessionId, "reduced-session.json");
  await mkdir(join(runtimeRoot, "staging", sessionId), { recursive: true });
  await writeFile(
    reducedArtifact,
    JSON.stringify({
      events: [],
      turns: [
        turnSchema.parse({
          assistant_summary: "Implemented export-index.",
          commands_seen: [],
          ended_at: "2026-05-22T20:11:00.000Z",
          files_touched: ["src/commands/export-index.ts"],
          index: 0,
          session_id: sessionId,
          started_at: "2026-05-22T20:10:30.000Z",
          tool_stub_count: 0,
          turn_id: `${sessionId}:turn-0000`,
          user_prompt: userPrompt,
          verification_seen: false,
        }),
      ],
    }),
    "utf8",
  );

  return { summary, sourcePath, upserted };
}

test("resummarizeSessions --low-signal-only skips high-signal topics", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-resummarize-filter-"));
  const runtimeRoot = join(sandbox, "runtime");
  process.env[runtimeOverrideEnvVar] = runtimeRoot;

  try {
    const database = await createLedger();
    await seedResummarizeFixture({
      database,
      runtimeRoot,
      sandbox,
      sessionId: "low-signal-session",
      topic: "brainstorming",
      userPrompt: "Add export-index command for Tether session search.",
    });
    await seedResummarizeFixture({
      database,
      runtimeRoot,
      sandbox,
      sessionId: "high-signal-session",
      topic: "Fix export-index contract topic provenance",
      userPrompt: "Fix export-index contract topic provenance",
    });

    const result = await resummarizeSessions(database, {
      lowSignalOnly: true,
    });

    assert.equal(result.processed_count, 1);
    assert.equal(result.skipped_count, 1);
    assert.equal(result.skipped[0]?.reason, "high_signal_topic");
    assert.equal(result.skipped[0]?.session_id, "high-signal-session");
    assert.equal(result.sessions[0]?.session_id, "low-signal-session");
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("resummarizeSessions --low-signal-only + llmTopic uses mocked generator", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-resummarize-llm-"));
  const runtimeRoot = join(sandbox, "runtime");
  process.env[runtimeOverrideEnvVar] = runtimeRoot;

  try {
    const database = await createLedger();
    const sessionId = "llm-resummarize-session";
    await seedResummarizeFixture({
      database,
      runtimeRoot,
      sandbox,
      sessionId,
      topic: "brainstorming",
      userPrompt: "Read .agents-state/handoff.md in this worktree - it is the authoritative spec.",
    });

    const calls = [];
    const result = await resummarizeSessions(database, {
      generateTopic: async (input) => {
        calls.push(input);
        return "handoff spec implementation";
      },
      llmTopic: true,
      lowSignalOnly: true,
      sessionIds: [sessionId],
    });

    assert.equal(result.processed_count, 1);
    assert.equal(calls.length, 1);
    assert.equal(result.sessions[0]?.topic, "handoff spec implementation");
    assert.equal(result.sessions[0]?.topic_source, "llm");
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("resummarizeSessions skips sessions missing manifests without failing batch", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-resummarize-orphan-"));
  const runtimeRoot = join(sandbox, "runtime");
  process.env[runtimeOverrideEnvVar] = runtimeRoot;

  try {
    const database = await createLedger();
    await seedResummarizeFixture({
      database,
      runtimeRoot,
      sandbox,
      sessionId: "orphan-session",
      topic: "brainstorming",
      userPrompt: "Add export-index command for Tether session search.",
      withManifest: false,
    });

    const result = await resummarizeSessions(database, {
      sessionIds: ["orphan-session"],
    });

    assert.equal(result.processed_count, 0);
    assert.equal(result.failed_count, 0);
    assert.equal(result.skipped_count, 1);
    assert.equal(result.skipped[0]?.reason, "missing_manifest");
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("resummarizeSessions --dry-run reports would_process_count without writes", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-resummarize-dry-"));
  const runtimeRoot = join(sandbox, "runtime");
  process.env[runtimeOverrideEnvVar] = runtimeRoot;

  try {
    const database = await createLedger();
    const { summary } = await seedResummarizeFixture({
      database,
      runtimeRoot,
      sandbox,
      sessionId: "dry-run-session",
      topic: "brainstorming",
      userPrompt: "Add export-index command for Tether session search.",
    });
    const before = JSON.parse(await readFile(summary.summaryPath, "utf8"));

    const result = await resummarizeSessions(database, {
      dryRun: true,
      lowSignalOnly: true,
    });

    assert.equal(result.dry_run, true);
    assert.equal(result.would_process_count, 1);
    assert.equal(result.processed_count, 0);
    const after = JSON.parse(await readFile(summary.summaryPath, "utf8"));
    assert.equal(after.topic, before.topic);
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});
