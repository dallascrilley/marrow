import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	createLedger,
	getDeletionCandidateBySessionId,
	getSourceSessionBySessionId,
} from "../../dist/db/ledger.js";

const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";
const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(dirname(testDir));
const cliPath = join(projectRoot, "dist", "cli.js");
const liveRegressionRoot = join(
	projectRoot,
	"test",
	"fixtures",
	"cursor",
	"live-regression",
);

const fixtureSessions = [
	{
		fixtureName: "6edabde1-32b9-47cb-b4e8-0e5884f98a14.jsonl",
		sessionId: "6edabde1-32b9-47cb-b4e8-0e5884f98a14",
		slug: "Users-dallascrilley-codex-worktrees-83a1-studio-tools",
		relativeTarget:
			"6edabde1-32b9-47cb-b4e8-0e5884f98a14/6edabde1-32b9-47cb-b4e8-0e5884f98a14.jsonl",
	},
	{
		fixtureName: "0fc0a884-3413-44fa-bdd4-77984f40e413.jsonl",
		sessionId: "0fc0a884-3413-44fa-bdd4-77984f40e413",
		slug: "Users-dallascrilley-codex-worktrees-83a1-studio-tools",
		relativeTarget:
			"0fc0a884-3413-44fa-bdd4-77984f40e413/0fc0a884-3413-44fa-bdd4-77984f40e413.jsonl",
	},
	{
		fixtureName: "6e8197bb-269e-43a8-bc58-e965468c3f82.jsonl",
		sessionId: "6e8197bb-269e-43a8-bc58-e965468c3f82",
		slug: "Users-dallascrilley-codex-worktrees-83a1-studio-tools",
		relativeTarget:
			"6e8197bb-269e-43a8-bc58-e965468c3f82/6e8197bb-269e-43a8-bc58-e965468c3f82.jsonl",
	},
	{
		fixtureName: "17070617-45b1-4a0d-ab57-e218f45e6fc9.jsonl",
		sessionId: "17070617-45b1-4a0d-ab57-e218f45e6fc9",
		slug: "Users-dallascrilley-Code-vmix-to-premiere-xml",
		relativeTarget:
			"17070617-45b1-4a0d-ab57-e218f45e6fc9/17070617-45b1-4a0d-ab57-e218f45e6fc9.jsonl",
	},
	{
		fixtureName: "2477b32c-27f6-4c56-b81c-75ab3e6938d8.jsonl",
		sessionId: "2477b32c-27f6-4c56-b81c-75ab3e6938d8",
		slug: "Users-dallascrilley-Code-studio-tools",
		relativeTarget:
			"2477b32c-27f6-4c56-b81c-75ab3e6938d8/2477b32c-27f6-4c56-b81c-75ab3e6938d8.jsonl",
	},
	{
		fixtureName: "2dc7df27-6993-4113-9ad0-d27d5e2c2143.jsonl",
		sessionId: "2dc7df27-6993-4113-9ad0-d27d5e2c2143",
		slug: "Users-dallascrilley-Code-studio-tools",
		relativeTarget:
			"2dc7df27-6993-4113-9ad0-d27d5e2c2143/2dc7df27-6993-4113-9ad0-d27d5e2c2143.jsonl",
	},
	{
		fixtureName: "58d2e1f7-50af-4cd5-921c-962c1b061d9d.jsonl",
		sessionId: "58d2e1f7-50af-4cd5-921c-962c1b061d9d",
		slug: "Users-dallascrilley-Code-studio-tools",
		relativeTarget:
			"58d2e1f7-50af-4cd5-921c-962c1b061d9d/58d2e1f7-50af-4cd5-921c-962c1b061d9d.jsonl",
	},
	{
		fixtureName: "9c6686c3-7663-495b-bd35-8e31b5a231df.jsonl",
		sessionId: "9c6686c3-7663-495b-bd35-8e31b5a231df",
		slug: "Users-dallascrilley-Code-studio-tools",
		relativeTarget:
			"9c6686c3-7663-495b-bd35-8e31b5a231df/9c6686c3-7663-495b-bd35-8e31b5a231df.jsonl",
	},
	{
		fixtureName: "d2d8b0e7-3fae-4506-927b-8f80a301ccb0.jsonl",
		sessionId: "d2d8b0e7-3fae-4506-927b-8f80a301ccb0",
		slug: "Users-dallascrilley-Code-studio-tools",
		relativeTarget:
			"d2d8b0e7-3fae-4506-927b-8f80a301ccb0/d2d8b0e7-3fae-4506-927b-8f80a301ccb0.jsonl",
	},
	{
		fixtureName: "faa99040-0737-4728-837e-9b017393476a-subagent.jsonl",
		sessionId: "faa99040-0737-4728-837e-9b017393476a-subagent",
		slug: "Users-dallascrilley-Code-worktrees-example-studio-trigger-real-video-validation",
		relativeTarget:
			"f6d87e78-5a74-48d2-bc79-5d2ee93f37db/subagents/faa99040-0737-4728-837e-9b017393476a-subagent.jsonl",
	},
];

function runCli(args, env) {
	return spawnSync(process.execPath, [cliPath, ...args], {
		cwd: projectRoot,
		encoding: "utf8",
		env: {
			...process.env,
			...env,
		},
	});
}

test("live regression corpus exercises real Cursor ingestion and preserves ready vs blocked quality states", async () => {
	const sandboxRoot = await mkdtemp(join(tmpdir(), "asd-live-regression-"));
	const runtimeRoot = join(sandboxRoot, "runtime");
	const homeDir = join(sandboxRoot, "home");
	const previousHome = process.env.HOME;
	const previousRuntimeRoot = process.env[runtimeOverrideEnvVar];

	process.env.HOME = homeDir;
	process.env[runtimeOverrideEnvVar] = runtimeRoot;

	try {
		for (const fixture of fixtureSessions) {
			const projectRootPath = join(
				homeDir,
				".cursor",
				"projects",
				fixture.slug,
			);
			const transcriptDestination = join(
				projectRootPath,
				"agent-transcripts",
				fixture.relativeTarget,
			);
			const fixtureContents = await readFile(
				join(liveRegressionRoot, fixture.fixtureName),
				"utf8",
			);

			await mkdir(projectRootPath, { recursive: true });
			await writeFile(
				join(projectRootPath, "workspace.json"),
				`${JSON.stringify({ workspacePath: join(homeDir, "Code", fixture.slug) }, null, 2)}\n`,
				"utf8",
			);
			await mkdir(dirname(transcriptDestination), { recursive: true });
			await writeFile(transcriptDestination, fixtureContents, "utf8");
		}

		const ingestResult = runCli(["ingest", "backfill", "--source", "cursor"], {
			HOME: homeDir,
			[runtimeOverrideEnvVar]: runtimeRoot,
		});
		assert.equal(ingestResult.status, 0, ingestResult.stderr);

		const ingestSummary = JSON.parse(ingestResult.stdout);
		assert.equal(ingestSummary.discovered_count, fixtureSessions.length);
		assert.equal(ingestSummary.processed_count, fixtureSessions.length);

		const richSession = ingestSummary.sessions.find(
			(session) =>
				session.session_id === "6e8197bb-269e-43a8-bc58-e965468c3f82",
		);
		assert.ok(richSession);
		assert.ok(richSession.turns >= 3);
		assert.equal(richSession.archived.safeToDelete, true);

		const reviewSession = ingestSummary.sessions.find(
			(session) =>
				session.session_id === "0fc0a884-3413-44fa-bdd4-77984f40e413",
		);
		assert.ok(reviewSession);
		assert.equal(reviewSession.archived.safeToDelete, false);

		const shortSession = ingestSummary.sessions.find(
			(session) =>
				session.session_id === "6edabde1-32b9-47cb-b4e8-0e5884f98a14",
		);
		assert.ok(shortSession);
		assert.equal(shortSession.turns, 1);
		assert.equal(shortSession.archived.safeToDelete, false);

		const database = await createLedger();

		try {
			const reviewCandidate = getDeletionCandidateBySessionId(
				database,
				"0fc0a884-3413-44fa-bdd4-77984f40e413",
			);
			assert.ok(reviewCandidate);
			assert.equal(reviewCandidate.candidate_state, "pending_artifacts");
			assert.equal(reviewCandidate.safe_to_delete, 0);

			const richCandidate = getDeletionCandidateBySessionId(
				database,
				"6e8197bb-269e-43a8-bc58-e965468c3f82",
			);
			assert.ok(richCandidate);
			assert.equal(richCandidate.candidate_state, "ready");
			assert.equal(richCandidate.safe_to_delete, 1);

			const blockedCandidate = getDeletionCandidateBySessionId(
				database,
				"6edabde1-32b9-47cb-b4e8-0e5884f98a14",
			);
			assert.ok(blockedCandidate);
			assert.equal(blockedCandidate.candidate_state, "pending_artifacts");
			assert.match(blockedCandidate.reason, /summary_low_signal/);

			for (const sessionId of [
				"2477b32c-27f6-4c56-b81c-75ab3e6938d8",
				"2dc7df27-6993-4113-9ad0-d27d5e2c2143",
				"58d2e1f7-50af-4cd5-921c-962c1b061d9d",
				"9c6686c3-7663-495b-bd35-8e31b5a231df",
			]) {
				const learnedCandidate = getDeletionCandidateBySessionId(
					database,
					sessionId,
				);
				assert.ok(
					learnedCandidate,
					`expected deletion candidate for ${sessionId}`,
				);
				assert.equal(learnedCandidate.candidate_state, "ready", sessionId);
				assert.equal(learnedCandidate.safe_to_delete, 1, sessionId);
			}

			const noisyPlanningCandidate = getDeletionCandidateBySessionId(
				database,
				"d2d8b0e7-3fae-4506-927b-8f80a301ccb0",
			);
			assert.ok(noisyPlanningCandidate);
			assert.equal(noisyPlanningCandidate.candidate_state, "pending_artifacts");
			assert.match(noisyPlanningCandidate.reason, /no_durable_learnings/);

			const subagentSession = getSourceSessionBySessionId(
				database,
				"faa99040-0737-4728-837e-9b017393476a-subagent",
			);
			assert.ok(subagentSession);
		} finally {
			database.close();
		}

		const summaryMarkdown = await readFile(
			join(
				runtimeRoot,
				"summaries",
				"by-session",
				"6e8197bb-269e-43a8-bc58-e965468c3f82",
				"summary.md",
			),
			"utf8",
		);
		assert.match(summaryMarkdown, /PR #71 Review/);
		assert.doesNotMatch(summaryMarkdown, /## What Worked\n- None noted\./);
		assert.doesNotMatch(summaryMarkdown, /<attached_files>|<code_selection/);
		assert.match(
			summaryMarkdown,
			/Completed all 7 blocking\/strongly-recommended fixes/,
		);
		assert.match(summaryMarkdown, /No open next step recorded\./);
		assert.match(summaryMarkdown, /`\.\/scripts\/qa`/);

		const explainBlocked = runCli(
			["explain", "6edabde1-32b9-47cb-b4e8-0e5884f98a14"],
			{
				HOME: homeDir,
				[runtimeOverrideEnvVar]: runtimeRoot,
			},
		);
		assert.equal(explainBlocked.status, 0, explainBlocked.stderr);
		assert.match(explainBlocked.stdout, /summary_low_signal/);

		const statsResult = runCli(["stats"], {
			HOME: homeDir,
			[runtimeOverrideEnvVar]: runtimeRoot,
		});
		assert.equal(statsResult.status, 0, statsResult.stderr);
		assert.match(statsResult.stdout, /blockedReasons/);
		assert.match(statsResult.stdout, /summary_low_signal/);
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}

		if (previousRuntimeRoot === undefined) {
			delete process.env[runtimeOverrideEnvVar];
		} else {
			process.env[runtimeOverrideEnvVar] = previousRuntimeRoot;
		}

		await rm(sandboxRoot, { force: true, recursive: true });
	}
});
