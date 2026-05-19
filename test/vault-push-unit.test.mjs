import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	atomicWriteFile,
	contentHashOf,
	loadManifest,
	pageBasenameFromId,
	projectSubtreePath,
	pushAll,
	readWikiMemoryJsonl,
	renderBody,
	renderFrontmatter,
	sanitiseProjectKey,
	sanitiseWikiText,
	serialiseManifest,
} from "../dist/pipeline/vault-push.js";

const sampleId =
	"sha256:0000000000000000000000000000000000000000000000000000000000000001";

function sampleRecord(overrides = {}) {
	return {
		schema_version: "asd.wiki_memory.v1",
		id: sampleId,
		kind: "project_learning",
		project: { key: "agent-session-distillery", root: null },
		title: "Keep the wiki import boundary narrow",
		body: "Use a versioned JSONL export contract between distillery and the wiki importer.",
		evidence: {
			learning_id: "session-1:project:decision:event-1",
			promotion_basis: "Explicit implementation decision.",
			evidence: ["The integration design selected a hybrid export/import boundary."],
			source_refs: [
				{
					source_path: "/tmp/session-1.jsonl",
					source_hash: "sha256:session-1",
					session_id: "session-1",
					turn_id: "turn-1",
					event_id: "event-1",
					line: 42,
				},
			],
		},
		review: {
			verdict: "keep",
			confidence: "high",
			source: "reviewed-export",
		},
		created_at: "1970-01-01T00:00:42.000Z",
		...overrides,
	};
}

test("sanitiseProjectKey strips path traversal and falls back to 'unknown'", () => {
	assert.equal(sanitiseProjectKey("foo"), "foo");
	assert.equal(sanitiseProjectKey("foo/bar"), "foobar");
	assert.equal(sanitiseProjectKey("../etc/passwd"), "etcpasswd");
	assert.equal(sanitiseProjectKey(".."), "unknown");
	assert.equal(sanitiseProjectKey(""), "unknown");
	assert.equal(sanitiseProjectKey(".hidden"), "hidden");
});

test("sanitiseWikiText replaces em dash and spaced double-hyphen with comma+space", () => {
	assert.equal(sanitiseWikiText("a — b"), "a, b");
	assert.equal(sanitiseWikiText("a—b"), "a, b");
	assert.equal(sanitiseWikiText("a -- b"), "a, b");
	assert.equal(sanitiseWikiText("--no-overwrite"), "--no-overwrite");
	assert.equal(sanitiseWikiText("foo-bar-baz"), "foo-bar-baz");
	assert.equal(sanitiseWikiText("a—b -- c — d"), "a, b, c, d");
});

test("pageBasenameFromId strips the sha256 prefix", () => {
	assert.equal(pageBasenameFromId(sampleId), sampleId.slice("sha256:".length));
	assert.equal(pageBasenameFromId("sha256:abc"), "abc");
});

test("renderFrontmatter emits stable YAML with single-quoted scalars and ordered keys", () => {
	const yaml = renderFrontmatter(sampleRecord());
	assert.ok(yaml.startsWith("---\n"));
	assert.ok(yaml.endsWith("---\n"));
	assert.match(yaml, /^id: 'sha256:0+1'$/m);
	assert.match(yaml, /^source: 'asd'$/m);
	assert.match(yaml, /^project: 'agent-session-distillery'$/m);
	assert.match(yaml, /^review_source: 'reviewed-export'$/m);
	assert.match(yaml, /^tags:\n {2}- 'asd'\n {2}- 'asd\/agent-session-distillery'$/m);
	assert.match(yaml, /^ {4}line: 42$/m);
	assert.match(yaml, /^ {2}- source_path: '\/tmp\/session-1\.jsonl'$/m);
});

test("renderFrontmatter handles zero source_refs without breaking YAML", () => {
	const record = sampleRecord({
		evidence: {
			learning_id: "lid",
			promotion_basis: "pb",
			evidence: [],
			source_refs: [],
		},
	});
	const yaml = renderFrontmatter(record);
	assert.match(yaml, /^source_refs:\n {2}\[\]$/m);
});

test("renderFrontmatter emits 'null' (not 'null'-string) for nullable source_ref fields", () => {
	// Real learnings from the canonical pipeline can have turn_id, event_id,
	// and line all null on the source_refs entry (e.g. learnings derived from
	// turn-level signals without a single anchor event). The push schema and
	// the YAML emitter must round-trip those nulls.
	const record = sampleRecord({
		evidence: {
			learning_id: "lid",
			promotion_basis: "pb",
			evidence: [],
			source_refs: [
				{
					source_path: "/tmp/sample.jsonl",
					source_hash: "sha256:sample",
					session_id: "session-x",
					turn_id: null,
					event_id: null,
					line: null,
				},
			],
		},
	});
	const yaml = renderFrontmatter(record);
	assert.match(yaml, /^ {4}turn_id: null$/m);
	assert.match(yaml, /^ {4}event_id: null$/m);
	assert.match(yaml, /^ {4}line: null$/m);
});

test("readWikiMemoryJsonl accepts source_refs entries with null turn_id/event_id/line", async () => {
	const dir = await mkdtemp(join(tmpdir(), "asd-vp-nullable-"));
	try {
		const path = join(dir, "nullable.jsonl");
		const record = sampleRecord({
			evidence: {
				learning_id: "lid",
				promotion_basis: "pb",
				evidence: [],
				source_refs: [
					{
						source_path: "/tmp/sample.jsonl",
						source_hash: "sha256:sample",
						session_id: "session-x",
						turn_id: null,
						event_id: null,
						line: null,
					},
				],
			},
		});
		await writeFile(path, `${JSON.stringify(record)}\n`, "utf8");
		const records = await readWikiMemoryJsonl(path);
		assert.equal(records.length, 1);
		assert.equal(records[0].evidence.source_refs[0].turn_id, null);
		assert.equal(records[0].evidence.source_refs[0].event_id, null);
		assert.equal(records[0].evidence.source_refs[0].line, null);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("renderFrontmatter single-quote-escapes apostrophes in scalar values", () => {
	const record = sampleRecord({
		evidence: {
			learning_id: "lid",
			promotion_basis: "Couldn't be simpler",
			evidence: [],
			source_refs: [],
		},
	});
	const yaml = renderFrontmatter(record);
	assert.match(yaml, /^promotion_basis: 'Couldn''t be simpler'$/m);
});

test("renderBody renders title H1, body paragraph, and evidence bullets", () => {
	const body = renderBody(sampleRecord());
	assert.equal(
		body,
		"# Keep the wiki import boundary narrow\n" +
			"\n" +
			"Use a versioned JSONL export contract between distillery and the wiki importer.\n" +
			"\n" +
			"## Source evidence\n" +
			"\n" +
			"- The integration design selected a hybrid export/import boundary.\n",
	);
});

test("renderBody sanitises em dashes and spaced double-hyphens in title/body/evidence", () => {
	const record = sampleRecord({
		title: "Boundary — narrow",
		body: "Use export/import -- not direct mutation.",
		evidence: {
			learning_id: "lid",
			promotion_basis: "pb",
			evidence: ["Choice—made explicitly."],
			source_refs: [],
		},
	});
	const body = renderBody(record);
	assert.match(body, /^# Boundary, narrow$/m);
	assert.match(body, /^Use export\/import, not direct mutation\.$/m);
	assert.match(body, /^- Choice, made explicitly\.$/m);
});

test("renderBody omits Source evidence section when evidence array is empty", () => {
	const body = renderBody(
		sampleRecord({
			evidence: {
				learning_id: "lid",
				promotion_basis: "pb",
				evidence: [],
				source_refs: [],
			},
		}),
	);
	assert.doesNotMatch(body, /## Source evidence/);
});

test("contentHashOf is deterministic and prefix-correct", () => {
	const hash = contentHashOf("hello\n");
	assert.match(hash, /^sha256:[a-f0-9]{64}$/);
	assert.equal(contentHashOf("hello\n"), hash);
	assert.notEqual(contentHashOf("hello"), hash);
});

test("atomicWriteFile writes via temp file and renames", async () => {
	const dir = await mkdtemp(join(tmpdir(), "asd-vp-atomic-"));
	try {
		const target = join(dir, "page.md");
		await atomicWriteFile(target, "hello\n");
		assert.equal(await readFile(target, "utf8"), "hello\n");
		await atomicWriteFile(target, "world\n");
		assert.equal(await readFile(target, "utf8"), "world\n");
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("loadManifest returns empty skeleton when file is missing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "asd-vp-manifest-"));
	try {
		const manifestPath = join(dir, "_asd-manifest.json");
		const manifest = await loadManifest(manifestPath, "2026-05-18T00:00:00.000Z");
		assert.equal(manifest.schema_version, "asd.vault_push_manifest.v1");
		assert.equal(manifest.written_by, "asd");
		assert.deepEqual(manifest.records, {});
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("loadManifest throws on malformed JSON instead of silently resetting", async () => {
	const dir = await mkdtemp(join(tmpdir(), "asd-vp-manifest-bad-"));
	try {
		const manifestPath = join(dir, "_asd-manifest.json");
		await writeFile(manifestPath, "{not json", "utf8");
		await assert.rejects(loadManifest(manifestPath, "2026-05-18T00:00:00.000Z"));
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("serialiseManifest sorts records by id and pretty-prints", () => {
	const manifest = {
		schema_version: "asd.vault_push_manifest.v1",
		written_by: "asd",
		last_push_at: "2026-05-18T00:00:00.000Z",
		records: {
			"sha256:b": {
				page: "b.md",
				content_hash: "sha256:bb",
				written_at: "2026-05-18T00:00:00.000Z",
				schema_version: "asd.wiki_memory.v1",
			},
			"sha256:a": {
				page: "a.md",
				content_hash: "sha256:aa",
				written_at: "2026-05-18T00:00:00.000Z",
				schema_version: "asd.wiki_memory.v1",
			},
		},
	};
	const serialised = serialiseManifest(manifest);
	const indexA = serialised.indexOf("sha256:a");
	const indexB = serialised.indexOf("sha256:b");
	assert.ok(indexA > 0);
	assert.ok(indexB > indexA, "sha256:a must come before sha256:b in serialised manifest");
});

test("readWikiMemoryJsonl returns empty array for missing file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "asd-vp-readjsonl-"));
	try {
		const records = await readWikiMemoryJsonl(join(dir, "nope.jsonl"));
		assert.deepEqual(records, []);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("readWikiMemoryJsonl rejects records that don't match the schema", async () => {
	const dir = await mkdtemp(join(tmpdir(), "asd-vp-readjsonl-bad-"));
	try {
		const path = join(dir, "bad.jsonl");
		await writeFile(path, `${JSON.stringify({ id: "not-sha256" })}\n`, "utf8");
		await assert.rejects(readWikiMemoryJsonl(path));
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("projectSubtreePath places asd-learnings under wiki/projects/<sanitised>/", () => {
	assert.equal(
		projectSubtreePath("/vault", "agent-session-distillery"),
		"/vault/wiki/projects/agent-session-distillery/asd-learnings",
	);
	assert.equal(
		projectSubtreePath("/vault", "../escape"),
		"/vault/wiki/projects/escape/asd-learnings",
	);
});

test("pushAll writes pages, populates the manifest, and is idempotent on re-run", async () => {
	const dir = await mkdtemp(join(tmpdir(), "asd-vp-pushall-"));
	try {
		const vaultRoot = join(dir, "vault");
		const now = "2026-05-18T00:00:00.000Z";
		const first = await pushAll({
			noOverwrite: false,
			now,
			records: [sampleRecord()],
			vaultRoot,
		});
		assert.equal(first.total_records, 1);
		assert.equal(first.total_written, 1);
		assert.equal(first.total_skipped_unchanged, 0);

		const second = await pushAll({
			noOverwrite: false,
			now: "2026-05-18T01:00:00.000Z",
			records: [sampleRecord()],
			vaultRoot,
		});
		assert.equal(second.total_records, 1);
		assert.equal(second.total_written, 0, "unchanged record must be a no-op on re-run");
		assert.equal(second.total_skipped_unchanged, 1);

		const projectDir = join(
			vaultRoot,
			"wiki",
			"projects",
			"agent-session-distillery",
			"asd-learnings",
		);
		const manifest = await loadManifest(join(projectDir, "_asd-manifest.json"), now);
		assert.equal(Object.keys(manifest.records).length, 1);
		assert.ok(manifest.records[sampleId]);
		assert.equal(
			manifest.last_push_at,
			now,
			"last_push_at must not advance when nothing changed in the rerun",
		);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("pushAll rewrites when the rendered body changes (new evidence)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "asd-vp-pushall-rewrite-"));
	try {
		const vaultRoot = join(dir, "vault");
		const now = "2026-05-18T00:00:00.000Z";
		await pushAll({
			noOverwrite: false,
			now,
			records: [sampleRecord()],
			vaultRoot,
		});

		const updated = sampleRecord({
			body: "Use a versioned JSONL export contract between distillery and the wiki importer. (Updated.)",
		});
		const result = await pushAll({
			noOverwrite: false,
			now: "2026-05-18T01:00:00.000Z",
			records: [updated],
			vaultRoot,
		});

		assert.equal(result.total_written, 1, "body change must trigger a rewrite");
		assert.equal(result.total_skipped_unchanged, 0);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("pushAll with --no-overwrite skips when the on-disk page hash diverges from the manifest", async () => {
	const dir = await mkdtemp(join(tmpdir(), "asd-vp-pushall-protect-"));
	try {
		const vaultRoot = join(dir, "vault");
		const now = "2026-05-18T00:00:00.000Z";
		await pushAll({
			noOverwrite: false,
			now,
			records: [sampleRecord()],
			vaultRoot,
		});

		const pagePath = join(
			vaultRoot,
			"wiki",
			"projects",
			"agent-session-distillery",
			"asd-learnings",
			`${pageBasenameFromId(sampleId)}.md`,
		);
		const original = await readFile(pagePath, "utf8");
		await writeFile(pagePath, `${original}\nManual operator note.\n`, "utf8");

		const updated = sampleRecord({ body: "New rendering would otherwise overwrite." });
		const result = await pushAll({
			noOverwrite: true,
			now: "2026-05-18T02:00:00.000Z",
			records: [updated],
			vaultRoot,
		});

		assert.equal(result.total_skipped_protected, 1);
		assert.equal(result.total_written, 0);

		const afterPushHash = await readFile(pagePath, "utf8");
		assert.ok(
			afterPushHash.includes("Manual operator note."),
			"manual edit must be preserved when --no-overwrite is in effect",
		);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});
