import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
	discoverPiInputs,
	shouldSkipPiSessionPath,
} from "../dist/adapters/pi/discover.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(testDir);
const fixtureSessionsRoot = join(projectRoot, "test", "fixtures", "pi", "sessions");

test("discovers the smoke fixture and attributes the workspace via cwd", async () => {
	const result = await discoverPiInputs({
		piSessionsRoot: fixtureSessionsRoot,
	});
	assert.equal(result.transcripts.length, 1);
	const transcript = result.transcripts[0];
	assert.equal(transcript.projectKey, "demo");
	assert.equal(transcript.workspacePath, "/Users/example/Code/demo");
	assert.equal(transcript.workspaceSlug, "--Users-example-Code-demo--");
	assert.equal(transcript.sourceFormat, "jsonl");
	assert.ok(transcript.sourceHash.startsWith("sha256:"));
	assert.ok(transcript.sourcePath.endsWith(".jsonl"));
});

test("returns an empty list when the sessions root is missing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "asd-pi-empty-"));
	try {
		const result = await discoverPiInputs({
			piSessionsRoot: join(dir, "no-such-root"),
		});
		assert.deepEqual(result.transcripts, []);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("shouldSkipPiSessionPath skips pi-test basenames under var/folders by default", () => {
	const path =
		"/var/folders/xx/yy/T/pi-sessions/--Users-example-Code-demo--/2026_pi-test-abc.jsonl";
	assert.equal(
		shouldSkipPiSessionPath(path, { includeTestSessions: false }),
		"test_session_name",
	);
	assert.equal(shouldSkipPiSessionPath(path, { includeTestSessions: true }), null);
});

test("shouldSkipPiSessionPath does not skip production paths in macOS temp sandboxes", () => {
	const path =
		"/var/folders/xx/yy/T/asd-pi-int-abc/home/.pi/agent/sessions/--Users-example-Code-demo--/2026-05-18T00-28-01-780Z_019e387b.jsonl";
	assert.equal(shouldSkipPiSessionPath(path, { includeTestSessions: false }), null);
});

test("shouldSkipPiSessionPath skips pi-test session basenames by default", () => {
	const path =
		"/Users/example/.pi/agent/sessions/--Users-example-Code-demo--/pi-test-smoke.jsonl";
	assert.equal(
		shouldSkipPiSessionPath(path, { includeTestSessions: false }),
		"test_session_name",
	);
});
