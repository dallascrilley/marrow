import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { hashToProjectId } from "../../dist/v2/project/resolve.js";

const fixtureWorkspacePath = "/Users/example/Code/demo";
const expectedProjectKey = hashToProjectId(fixtureWorkspacePath);

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(dirname(testDir));
const cliPath = join(projectRoot, "dist", "cli.js");
const fixtureProjectsRoot = join(
	projectRoot,
	"test",
	"fixtures",
	"claude-code",
	"projects",
);
const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";

function runCli(args, env = {}) {
	return spawnSync(process.execPath, [cliPath, ...args], {
		cwd: projectRoot,
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
}

test("ingest backfill --source claude-code processes the smoke fixture end-to-end", async () => {
	const sandbox = await mkdtemp(join(tmpdir(), "asd-cc-int-"));
	const home = join(sandbox, "home");
	const runtimeRoot = join(sandbox, "runtime");

	try {
		const targetProjectsRoot = join(home, ".claude", "projects");
		await mkdir(targetProjectsRoot, { recursive: true });
		await cp(fixtureProjectsRoot, targetProjectsRoot, { recursive: true });

		const result = runCli(["ingest", "backfill", "--source", "claude-code"], {
			HOME: home,
			[runtimeOverrideEnvVar]: runtimeRoot,
		});
		assert.equal(result.status, 0, result.stderr);

		const payload = JSON.parse(result.stdout);
		assert.equal(payload.source, "claude-code");
		assert.equal(payload.discovered_count, 1);
		assert.equal(payload.sessions.length, 1);
		const session = payload.sessions[0];
		assert.equal(session.project_key, expectedProjectKey);
		assert.equal(session.session_id, "session-fixture-0001");
		assert.ok(session.summary_path.endsWith("summary.json"));

		const summary = JSON.parse(await readFile(session.summary_path, "utf8"));
		assert.equal(summary.session_id, "session-fixture-0001");

		const summariesDir = join(runtimeRoot, "summaries", "by-session", "session-fixture-0001");
		const summaryFiles = await readdir(summariesDir);
		assert.ok(summaryFiles.includes("summary.json"));
		assert.ok(summaryFiles.includes("summary.md"));
	} finally {
		await rm(sandbox, { force: true, recursive: true });
	}
});
