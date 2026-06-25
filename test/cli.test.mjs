import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(testDir);
const cliPath = join(projectRoot, "dist", "cli.js");
const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });
}

test("asd --help lists every Task 1 command", () => {
  const result = runCli(["--help"]);

  assert.equal(result.status, 0, result.stderr);

  const output = result.stdout;
  const expectedCommands = [
    "ingest backfill",
    "ingest sync",
    "quality audit",
    "quality review-learnings",
    "quality apply-learning-review",
    "quality resummarize",
    "pipeline gate",
    "review queue",
    "review show",
    "archive run",
    "delete candidates",
    "delete apply",
    "search",
    "memory export-wiki",
    "export-index",
    "stats",
    "explain",
  ];

  for (const command of expectedCommands) {
    assert.match(output, new RegExp(command.replace(" ", "\\s+")));
  }
});

test("unknown command exits non-zero and prints help", () => {
  const result = runCli(["bogus"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: bogus/);
  assert.match(result.stdout, /Usage: asd/);
});

test("missing subcommand exits non-zero and prints available subcommands", () => {
  const result = runCli(["ingest"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown or missing subcommand for ingest/);
  assert.match(result.stderr, /backfill/);
  assert.match(result.stderr, /sync/);
  assert.match(result.stdout, /Usage: asd/);
});

test("search finds sessions in the exported session index", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-search-"));
  const runtimeRoot = join(sandbox, "runtime-root");
  const indexDir = join(runtimeRoot, "index");
  const indexPath = join(indexDir, "session-index.jsonl");

  try {
    await mkdir(indexDir, { recursive: true });
    await writeFile(
      indexPath,
      `${[
        JSON.stringify({
          v: 1,
          source_path: "/tmp/codex.jsonl",
          source_uuid: "019e516f-5f85-7550-a1b9-adcbab812b33",
          source_tool: "codex-cli",
          asd_session_id: "codex-session",
          topic: "Add export-index command for Tether session search.",
          topic_source: "deterministic",
          next_step: "Ship search command.",
          summary_json_path: join(
            runtimeRoot,
            "summaries",
            "by-session",
            "codex-session",
            "summary.json",
          ),
          updated_at: "2026-05-22T20:00:00.000Z",
        }),
        JSON.stringify({
          v: 1,
          source_path: "/tmp/claude.jsonl",
          source_uuid: "019e5000-0000-7000-9000-000000000001",
          source_tool: "claude-code",
          asd_session_id: "claude-session",
          topic: "Review the launch proof.",
          topic_source: "llm",
          next_step: "Follow up on missing evidence.",
          summary_json_path: join(
            runtimeRoot,
            "summaries",
            "by-session",
            "claude-session",
            "summary.json",
          ),
          updated_at: "2026-05-22T21:00:00.000Z",
        }),
      ].join("\n")}\n`,
      "utf8",
    );

    const result = runCli(["search", "export-index"], {
      [runtimeOverrideEnvVar]: runtimeRoot,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /codex-session/);
    assert.match(result.stdout, /Add export-index command for Tether session search\./);
    assert.doesNotMatch(result.stdout, /claude-session/);

    const jsonResult = runCli(["search", "claude", "--json"], {
      [runtimeOverrideEnvVar]: runtimeRoot,
    });

    assert.equal(jsonResult.status, 0, jsonResult.stderr);
    const payload = JSON.parse(jsonResult.stdout.trim());
    assert.equal(payload.length, 1);
    assert.equal(payload[0].asd_session_id, "claude-session");

    const emptyResult = runCli(["search", "missing-topic"], {
      [runtimeOverrideEnvVar]: runtimeRoot,
    });

    assert.equal(emptyResult.status, 0, emptyResult.stderr);
    assert.match(emptyResult.stdout, /No sessions matched "missing-topic"\./);
  } finally {
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("search without query exits non-zero", () => {
  const result = runCli(["search"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /search requires a query argument/);
});

test("search reports missing session index", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "asd-search-missing-index-"));

  try {
    const result = runCli(["search", "topic"], {
      [runtimeOverrideEnvVar]: runtimeRoot,
    });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Session index not found/);
    assert.match(result.stderr, /export-index/);
  } finally {
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("runtime-path creation is isolated by the root override", async () => {
  const sandboxBase = await mkdtemp(join(tmpdir(), "asd-runtime-"));
  const runtimeRoot = join(sandboxBase, "runtime-root");

  try {
    const beforeEntries = await readdir(sandboxBase);
    assert.deepEqual(beforeEntries, []);

    const result = runCli(["review", "queue"], {
      [runtimeOverrideEnvVar]: runtimeRoot,
    });

    assert.equal(result.status, 0, result.stderr);

    const runtimeEntries = await readdir(runtimeRoot);
    assert.deepEqual(runtimeEntries, ["ledger"]);

    const sandboxEntries = await readdir(sandboxBase);
    assert.deepEqual(sandboxEntries, ["runtime-root"]);
  } finally {
    await rm(sandboxBase, { force: true, recursive: true });
  }
});

test("export-index writes a consolidated v1 JSONL from manifests and summaries", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-session-index-"));
  const runtimeRoot = join(sandbox, "runtime-root");

  try {
    const manifestDir = join(runtimeRoot, "sources", "manifests");
    const summaryDir = join(runtimeRoot, "summaries", "by-session");
    await mkdir(manifestDir, { recursive: true });
    await mkdir(join(summaryDir, "codex-session"), { recursive: true });
    await mkdir(join(summaryDir, "claude-session"), { recursive: true });

    const codexSummaryPath = join(summaryDir, "codex-session", "summary.json");
    const claudeSummaryPath = join(summaryDir, "claude-session", "summary.json");
    const codexSourcePath = join(
      sandbox,
      ".codex",
      "sessions",
      "2026",
      "05",
      "22",
      "rollout-2026-05-22T15-45-14-019e516f-5f85-7550-a1b9-adcbab812b33.jsonl",
    );
    const claudeSourcePath = join(
      sandbox,
      ".claude",
      "projects",
      "-Users-example-Code-demo",
      "019e5000-0000-7000-9000-000000000001.jsonl",
    );

    await writeFile(
      codexSummaryPath,
      `${JSON.stringify({
        session_id: "codex-session",
        topic: "Read the handoff and complete tasks.",
        what_worked: [],
        what_failed: [],
        what_was_decided: [],
        useful_commands: [],
        files_of_interest: [],
        next_step: "No open next step recorded.",
        project_learnings: [],
        user_learnings: [],
        deletion_readiness: "ready",
      })}\n`,
      "utf8",
    );
    await writeFile(
      claudeSummaryPath,
      `${JSON.stringify({
        session_id: "claude-session",
        topic: "Review the launch proof.",
        topic_source: "llm",
        what_worked: [],
        what_failed: [],
        what_was_decided: [],
        useful_commands: [],
        files_of_interest: [],
        next_step: "Follow up on missing evidence.",
        project_learnings: [],
        user_learnings: [],
        deletion_readiness: "not_ready",
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(manifestDir, "codex-session.json"),
      `${JSON.stringify({
        artifact_paths: {
          project_knowledge_jsonl_path: null,
          retention_receipt_path: join(runtimeRoot, "reports", "codex-receipt.json"),
          summary_json_path: codexSummaryPath,
          summary_markdown_path: join(summaryDir, "codex-session", "summary.md"),
          user_knowledge_jsonl_path: null,
        },
        generated_at: "2026-05-22T20:00:00.000Z",
        session: {
          source_tool: "codex-cli",
          source_format: "jsonl",
          source_path: codexSourcePath,
          source_hash: "sha256:codex",
          workspace_path: "/Users/example/Code/demo",
          project_key: "demo",
          session_id: "codex-session",
          conversation_id: "demo:codex-session",
          started_at: "2026-05-22T19:59:00.000Z",
          updated_at: "2026-05-22T20:00:00.000Z",
          ingest_status: "summarized",
          retention_status: "kept",
        },
        source_span: {
          event_count: 0,
          first_turn_id: null,
          last_turn_id: null,
          line_end: null,
          line_start: null,
          turn_count: 1,
        },
        version: 1,
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(manifestDir, "claude-session.json"),
      `${JSON.stringify({
        artifact_paths: {
          project_knowledge_jsonl_path: null,
          retention_receipt_path: join(runtimeRoot, "reports", "claude-receipt.json"),
          summary_json_path: claudeSummaryPath,
          summary_markdown_path: join(summaryDir, "claude-session", "summary.md"),
          user_knowledge_jsonl_path: null,
        },
        generated_at: "2026-05-22T21:00:00.000Z",
        session: {
          source_tool: "claude-code",
          source_format: "jsonl",
          source_path: claudeSourcePath,
          source_hash: "sha256:claude",
          workspace_path: "/Users/example/Code/demo",
          project_key: "demo",
          session_id: "claude-session",
          conversation_id: "demo:claude-session",
          started_at: "2026-05-22T20:59:00.000Z",
          updated_at: "2026-05-22T21:00:00.000Z",
          ingest_status: "summarized",
          retention_status: "kept",
        },
        source_span: {
          event_count: 0,
          first_turn_id: null,
          last_turn_id: null,
          line_end: null,
          line_start: null,
          turn_count: 1,
        },
        version: 1,
      })}\n`,
      "utf8",
    );

    const result = runCli(["export-index"], {
      [runtimeOverrideEnvVar]: runtimeRoot,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Exported 2 session index records\./);

    const exportPath = join(runtimeRoot, "index", "session-index.jsonl");
    const records = (await readFile(exportPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 2);

    const codexRecord = records.find((record) => record.source_tool === "codex-cli");
    assert.equal(codexRecord.source_path, codexSourcePath);
    assert.equal(codexRecord.source_uuid, "019e516f-5f85-7550-a1b9-adcbab812b33");
    assert.equal(codexRecord.asd_session_id, "codex-session");
    assert.equal(codexRecord.topic, "Read the handoff and complete tasks.");
    assert.equal(codexRecord.topic_source, "deterministic");
    assert.equal(codexRecord.summary_json_path, codexSummaryPath);

    const claudeRecord = records.find((record) => record.source_tool === "claude-code");
    assert.equal(claudeRecord.source_path, claudeSourcePath);
    assert.equal(claudeRecord.source_uuid, "019e5000-0000-7000-9000-000000000001");
    assert.equal(claudeRecord.topic_source, "llm");
    assert.equal(claudeRecord.next_step, "Follow up on missing evidence.");
  } finally {
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("export-index dedupes legacy and revision manifests by identity keeping newest", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-session-index-dedupe-"));
  const runtimeRoot = join(sandbox, "runtime-root");

  try {
    const manifestDir = join(runtimeRoot, "sources", "manifests");
    const summaryDir = join(runtimeRoot, "summaries", "by-session", "dup-session");
    await mkdir(manifestDir, { recursive: true });
    await mkdir(summaryDir, { recursive: true });

    const sourcePath = join(sandbox, "source", "dup-session.jsonl");
    const olderSummaryPath = join(summaryDir, "older-summary.json");
    const newerSummaryPath = join(summaryDir, "newer-summary.json");
    const sourceSession = {
      source_tool: "cursor",
      source_format: "jsonl",
      source_path: sourcePath,
      source_hash: "sha256:older",
      workspace_path: "/Users/example/Code/demo",
      project_key: "demo",
      session_id: "dup-session",
      conversation_id: "demo:dup-session",
      started_at: "2026-05-22T19:00:00.000Z",
      updated_at: "2026-05-22T19:00:00.000Z",
      ingest_status: "summarized",
      retention_status: "kept",
    };

    await writeFile(
      olderSummaryPath,
      `${JSON.stringify({
        session_id: "dup-session",
        topic: "Older summary topic.",
        what_worked: [],
        what_failed: [],
        what_was_decided: [],
        useful_commands: [],
        files_of_interest: [],
        next_step: "No open next step recorded.",
        project_learnings: [],
        user_learnings: [],
        deletion_readiness: "ready",
      })}\n`,
      "utf8",
    );
    await writeFile(
      newerSummaryPath,
      `${JSON.stringify({
        session_id: "dup-session",
        topic: "Newer summary topic.",
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
      })}\n`,
      "utf8",
    );

    await writeFile(
      join(manifestDir, "dup-session.json"),
      `${JSON.stringify({
        artifact_paths: {
          project_knowledge_jsonl_path: null,
          retention_receipt_path: join(runtimeRoot, "reports", "dup-receipt.json"),
          summary_json_path: olderSummaryPath,
          summary_markdown_path: join(summaryDir, "older-summary.md"),
          user_knowledge_jsonl_path: null,
        },
        generated_at: "2026-05-22T20:00:00.000Z",
        session: sourceSession,
        source_span: {
          event_count: 0,
          first_turn_id: null,
          last_turn_id: null,
          line_end: null,
          line_start: null,
          turn_count: 1,
        },
        version: 1,
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(manifestDir, "dup-session.older.json"),
      `${JSON.stringify({
        artifact_paths: {
          project_knowledge_jsonl_path: null,
          retention_receipt_path: join(runtimeRoot, "reports", "dup-receipt.json"),
          summary_json_path: newerSummaryPath,
          summary_markdown_path: join(summaryDir, "newer-summary.md"),
          user_knowledge_jsonl_path: null,
        },
        generated_at: "2026-05-22T21:00:00.000Z",
        session: { ...sourceSession, source_hash: "sha256:newer" },
        source_span: {
          event_count: 0,
          first_turn_id: null,
          last_turn_id: null,
          line_end: null,
          line_start: null,
          turn_count: 1,
        },
        version: 1,
      })}\n`,
      "utf8",
    );

    const result = runCli(["export-index"], {
      [runtimeOverrideEnvVar]: runtimeRoot,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Exported 1 session index record/);

    const exportPath = join(runtimeRoot, "index", "session-index.jsonl");
    const records = (await readFile(exportPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].asd_session_id, "dup-session");
    assert.equal(records[0].topic, "Newer summary topic.");
    assert.equal(records[0].topic_source, "deterministic");
  } finally {
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("quality resummarize upgrades a low-signal topic via CLI", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-resummarize-cli-"));
  const runtimeRoot = join(sandbox, "runtime-root");
  const { createLedger, upsertSourceSession } = await import("../dist/db/ledger.js");
  const { writeSessionSummary } = await import("../dist/writers/summary-writer.js");
  const { writeSessionManifest } = await import("../dist/writers/manifest-writer.js");
  const { turnSchema } = await import("../dist/models/canonical.js");

  try {
    process.env[runtimeOverrideEnvVar] = runtimeRoot;
    const database = await createLedger();
    const sessionId = "cli-resummarize-fixture";
    const sourcePath = join(sandbox, "fixture.jsonl");
    await writeFile(sourcePath, '{"type":"session"}\n', "utf8");

    const upserted = upsertSourceSession(database, {
      conversation_id: `demo:${sessionId}`,
      ingest_status: "archived",
      project_key: "demo",
      retention_status: "kept",
      session_id: sessionId,
      source_format: "jsonl",
      source_hash: "sha256:cli-resummarize",
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

    await writeSessionManifest({
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

    const reducedArtifact = join(runtimeRoot, "staging", sessionId, "reduced-session.json");
    await mkdir(join(runtimeRoot, "staging", sessionId), { recursive: true });
    await writeFile(
      reducedArtifact,
      JSON.stringify({
        events: [],
        turns: [
          turnSchema.parse({
            assistant_summary: "Shipped export-index.",
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

    const result = runCli(["quality", "resummarize", "--session-id", sessionId], {
      [runtimeOverrideEnvVar]: runtimeRoot,
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.processed_count, 1);
    assert.equal(payload.failed_count, 0);
    assert.equal(payload.sessions[0].topic, "Add export-index command for Tether session search.");

    const upgraded = JSON.parse(await readFile(summary.summaryPath, "utf8"));
    assert.equal(upgraded.topic, "Add export-index command for Tether session search.");
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("quality resummarize --low-signal-only skips high-signal topics via CLI", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-resummarize-cli-filter-"));
  const runtimeRoot = join(sandbox, "runtime-root");
  const { createLedger, upsertSourceSession } = await import("../dist/db/ledger.js");
  const { writeSessionSummary } = await import("../dist/writers/summary-writer.js");
  const { writeSessionManifest } = await import("../dist/writers/manifest-writer.js");
  const { turnSchema } = await import("../dist/models/canonical.js");

  async function seed(database, sessionId, topic, userPrompt) {
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
    await writeSessionManifest({
      artifactPaths: {
        project_knowledge_jsonl_path: null,
        retention_receipt_path: join(runtimeRoot, "reports", `${sessionId}.json`),
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
    const reducedArtifact = join(runtimeRoot, "staging", sessionId, "reduced-session.json");
    await mkdir(join(runtimeRoot, "staging", sessionId), { recursive: true });
    await writeFile(
      reducedArtifact,
      JSON.stringify({
        events: [],
        turns: [
          turnSchema.parse({
            assistant_summary: "Shipped export-index.",
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
  }

  try {
    process.env[runtimeOverrideEnvVar] = runtimeRoot;
    const database = await createLedger();
    await seed(
      database,
      "cli-low",
      "brainstorming",
      "Add export-index command for Tether session search.",
    );
    await seed(
      database,
      "cli-high",
      "Fix export-index contract topic provenance",
      "Fix export-index contract topic provenance",
    );

    const result = runCli(["quality", "resummarize", "--low-signal-only"], {
      [runtimeOverrideEnvVar]: runtimeRoot,
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.processed_count, 1);
    assert.equal(payload.skipped_count, 1);
    assert.equal(payload.skipped[0]?.reason, "high_signal_topic");
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("quality resummarize --export-index refreshes session-index.jsonl via CLI", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-resummarize-cli-export-"));
  const runtimeRoot = join(sandbox, "runtime-root");
  const { createLedger, upsertSourceSession } = await import("../dist/db/ledger.js");
  const { writeSessionSummary } = await import("../dist/writers/summary-writer.js");
  const { writeSessionManifest } = await import("../dist/writers/manifest-writer.js");
  const { turnSchema } = await import("../dist/models/canonical.js");

  try {
    process.env[runtimeOverrideEnvVar] = runtimeRoot;
    const database = await createLedger();
    const sessionId = "cli-export-index";
    const sourcePath = join(sandbox, "fixture.jsonl");
    await writeFile(sourcePath, '{"type":"session"}\n', "utf8");
    const upserted = upsertSourceSession(database, {
      conversation_id: `demo:${sessionId}`,
      ingest_status: "archived",
      project_key: "demo",
      retention_status: "kept",
      session_id: sessionId,
      source_format: "jsonl",
      source_hash: "sha256:cli-export-index",
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
    await writeSessionManifest({
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
    const reducedArtifact = join(runtimeRoot, "staging", sessionId, "reduced-session.json");
    await mkdir(join(runtimeRoot, "staging", sessionId), { recursive: true });
    await writeFile(
      reducedArtifact,
      JSON.stringify({
        events: [],
        turns: [
          turnSchema.parse({
            assistant_summary: "Shipped export-index.",
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

    const result = runCli(["quality", "resummarize", "--session-id", sessionId, "--export-index"], {
      [runtimeOverrideEnvVar]: runtimeRoot,
    });

    assert.equal(result.status, 0, result.stderr);
    const exportPath = join(runtimeRoot, "index", "session-index.jsonl");
    const records = (await readFile(exportPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const record = records.find((entry) => entry.asd_session_id === sessionId);
    assert.equal(record.topic, "Add export-index command for Tether session search.");
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("quality resummarize --dry-run reports would_process_count via CLI", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-resummarize-cli-dry-"));
  const runtimeRoot = join(sandbox, "runtime-root");
  const { createLedger, upsertSourceSession } = await import("../dist/db/ledger.js");
  const { writeSessionSummary } = await import("../dist/writers/summary-writer.js");
  const { writeSessionManifest } = await import("../dist/writers/manifest-writer.js");
  const { turnSchema } = await import("../dist/models/canonical.js");

  try {
    process.env[runtimeOverrideEnvVar] = runtimeRoot;
    const database = await createLedger();
    const sessionId = "cli-dry-run";
    const sourcePath = join(sandbox, "fixture.jsonl");
    await writeFile(sourcePath, '{"type":"session"}\n', "utf8");
    const upserted = upsertSourceSession(database, {
      conversation_id: `demo:${sessionId}`,
      ingest_status: "archived",
      project_key: "demo",
      retention_status: "kept",
      session_id: sessionId,
      source_format: "jsonl",
      source_hash: "sha256:cli-dry-run",
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
    await writeSessionManifest({
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
    await mkdir(join(runtimeRoot, "staging", sessionId), { recursive: true });
    await writeFile(
      join(runtimeRoot, "staging", sessionId, "reduced-session.json"),
      JSON.stringify({
        events: [],
        turns: [
          turnSchema.parse({
            assistant_summary: "Shipped export-index.",
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
    const before = JSON.parse(await readFile(summary.summaryPath, "utf8"));

    const result = runCli(["quality", "resummarize", "--low-signal-only", "--dry-run"], {
      [runtimeOverrideEnvVar]: runtimeRoot,
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.dry_run, true);
    assert.equal(payload.would_process_count, 1);
    assert.equal(payload.processed_count, 0);
    const after = JSON.parse(await readFile(summary.summaryPath, "utf8"));
    assert.equal(after.topic, before.topic);
  } finally {
    delete process.env[runtimeOverrideEnvVar];
    await rm(sandbox, { force: true, recursive: true });
  }
});
