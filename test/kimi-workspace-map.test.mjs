import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveKimiWorkspaceMapping } from "../dist/adapters/kimi/workspace-map.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureKimiJson = join(testDir, "fixtures", "kimi", "kimi.json");

const workspaceSlug = "6d146076ef0a6aa290cf3370faef0249";
const sessionPath = join(
	"/home",
	"example",
	".kimi",
	"sessions",
	workspaceSlug,
	"3a2034d0-f75c-4bf5-b010-771ab81ad581",
	"wire.jsonl",
);

test("deriveKimiWorkspaceMapping resolves workspace path from config", async () => {
	const mapping = await deriveKimiWorkspaceMapping(sessionPath, {
		kimiConfigPath: fixtureKimiJson,
	});

	assert.equal(mapping.workspacePath, "/home/example/demo");
	assert.equal(mapping.workspaceSlug, workspaceSlug);
	assert.equal(mapping.projectKey, "/home/example/demo");
});

test("deriveKimiWorkspaceMapping falls back to slug when config missing", async () => {
	const mapping = await deriveKimiWorkspaceMapping(sessionPath, {
		kimiConfigPath: "/nonexistent/config.json",
	});

	assert.equal(mapping.workspacePath, null);
	assert.equal(mapping.workspaceSlug, workspaceSlug);
	assert.equal(mapping.projectKey, workspaceSlug);
});

test("deriveKimiWorkspaceMapping handles unknown slug gracefully", async () => {
	const unknownPath = join(
		"/home",
		"example",
		".kimi",
		"sessions",
		"00000000000000000000000000000000",
		"session-1",
		"wire.jsonl",
	);
	const mapping = await deriveKimiWorkspaceMapping(unknownPath, {
		kimiConfigPath: fixtureKimiJson,
	});

	assert.equal(mapping.workspacePath, null);
	assert.equal(mapping.workspaceSlug, "00000000000000000000000000000000");
	assert.equal(mapping.projectKey, "00000000000000000000000000000000");
});
