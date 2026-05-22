import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

test("stub dispatch succeeds and reports the prepared runtime path", async () => {
	const runtimeRoot = await mkdtemp(join(tmpdir(), "asd-dispatch-"));

	try {
		const result = runCli(["search", "alpha"], {
			[runtimeOverrideEnvVar]: runtimeRoot,
		});

		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /^search alpha/m);
		assert.match(
			result.stdout,
			new RegExp(
				`Runtime path ready: ${runtimeRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/index`,
			),
		);
		assert.match(result.stdout, /Command scaffolded for Task 1\./);
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

		const reviewsPath = join(runtimeRoot, "reviews");
		const reviewsStats = await stat(reviewsPath);
		assert.ok(reviewsStats.isDirectory());

		const runtimeEntries = await readdir(runtimeRoot);
		assert.deepEqual(runtimeEntries, ["ledger", "reviews"]);

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
