import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { hashToProjectId } from "../../dist/v2/project/resolve.js";

const LEGACY_PROJECT_KEY = "agent-session-distillery";
const RESOLVED_PROJECT_ID = hashToProjectId(LEGACY_PROJECT_KEY);

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(dirname(testDir));
const cliPath = join(projectRoot, "dist", "cli.js");
const runtimeOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";
const vaultRootEnvVar = "ASD_VAULT_ROOT";

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

async function writeReviewedMemoryJsonl(runtimeRoot, records) {
  const exportDir = join(runtimeRoot, "exports", "wiki-memory");
  await mkdir(exportDir, { recursive: true });
  const path = join(exportDir, "reviewed-memory.jsonl");
  const contents =
    records.length === 0 ? "" : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  await writeFile(path, contents, "utf8");
  return path;
}

function makeRecord(suffix, overrides = {}) {
  return {
    schema_version: "asd.wiki_memory.v1",
    id: `sha256:${"0".repeat(63)}${suffix}`,
    kind: "project_learning",
    project: { key: LEGACY_PROJECT_KEY, root: null },
    title: `Decision ${suffix}`,
    body: `Body for record ${suffix}.`,
    evidence: {
      learning_id: `lid-${suffix}`,
      promotion_basis: "pb",
      evidence: [`Evidence for record ${suffix}.`],
      source_refs: [
        {
          source_path: `/tmp/session-${suffix}.jsonl`,
          source_hash: `sha256:session-${suffix}`,
          session_id: `session-${suffix}`,
          turn_id: `turn-${suffix}`,
          event_id: `event-${suffix}`,
          line: 1,
        },
      ],
    },
    review: {
      verdict: "keep",
      confidence: "medium",
      source: "reviewed-export",
    },
    created_at: "1970-01-01T00:00:01.000Z",
    ...overrides,
  };
}

test("memory push-wiki writes one page per JSONL record into the scoped subtree", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-vp-int-"));
  const runtimeRoot = join(sandbox, "runtime");
  const vaultRoot = join(sandbox, "vault");
  try {
    await mkdir(vaultRoot, { recursive: true });
    await writeReviewedMemoryJsonl(runtimeRoot, [makeRecord("1"), makeRecord("2")]);

    const result = runCli(["memory", "push-wiki"], {
      [runtimeOverrideEnvVar]: runtimeRoot,
      [vaultRootEnvVar]: vaultRoot,
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.total_records, 2);
    assert.equal(payload.total_written, 2);

    const projectDir = join(vaultRoot, "wiki", "projects", LEGACY_PROJECT_KEY);
    const subtree = join(projectDir, "asd-learnings");
    const manifest = JSON.parse(await readFile(join(projectDir, "_asd-manifest.json"), "utf8"));
    assert.equal(Object.keys(manifest.records).length, 2);

    const page = await readFile(join(subtree, `${"0".repeat(63)}1.md`), "utf8");
    assert.match(page, /^# Decision 1$/m);
    assert.match(page, /^Body for record 1\.$/m);
    assert.match(page, /^- Evidence for record 1\.$/m);
    assert.match(page, /^source: 'asd'$/m);
  } finally {
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("memory push-wiki is idempotent — second run writes nothing", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-vp-int-idem-"));
  const runtimeRoot = join(sandbox, "runtime");
  const vaultRoot = join(sandbox, "vault");
  try {
    await mkdir(vaultRoot, { recursive: true });
    await writeReviewedMemoryJsonl(runtimeRoot, [makeRecord("1")]);

    runCli(["memory", "push-wiki"], {
      [runtimeOverrideEnvVar]: runtimeRoot,
      [vaultRootEnvVar]: vaultRoot,
    });
    const second = runCli(["memory", "push-wiki"], {
      [runtimeOverrideEnvVar]: runtimeRoot,
      [vaultRootEnvVar]: vaultRoot,
    });
    assert.equal(second.status, 0, second.stderr);
    const payload = JSON.parse(second.stdout);
    assert.equal(payload.total_written, 0);
    assert.equal(payload.total_skipped_unchanged, 1);
  } finally {
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("memory push-wiki exits 0 with a notice when the vault root is missing", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-vp-int-no-vault-"));
  const runtimeRoot = join(sandbox, "runtime");
  try {
    await writeReviewedMemoryJsonl(runtimeRoot, [makeRecord("1")]);

    const result = runCli(["memory", "push-wiki"], {
      [runtimeOverrideEnvVar]: runtimeRoot,
      [vaultRootEnvVar]: join(sandbox, "no-such-vault"),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Vault not present/);
  } finally {
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("memory push-wiki exits 0 with a notice when no reviewed-memory file exists", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-vp-int-no-jsonl-"));
  const runtimeRoot = join(sandbox, "runtime");
  const vaultRoot = join(sandbox, "vault");
  try {
    await mkdir(vaultRoot, { recursive: true });

    const result = runCli(["memory", "push-wiki"], {
      [runtimeOverrideEnvVar]: runtimeRoot,
      [vaultRootEnvVar]: vaultRoot,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /nothing to push/);
  } finally {
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("memory push-wiki --refresh re-runs export-wiki against the runtime", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-vp-int-refresh-"));
  const runtimeRoot = join(sandbox, "runtime");
  const vaultRoot = join(sandbox, "vault");
  try {
    await mkdir(vaultRoot, { recursive: true });
    const knowledgeDir = join(runtimeRoot, "knowledge", "projects", "agent-session-distillery");
    await mkdir(knowledgeDir, { recursive: true });
    await writeFile(
      join(knowledgeDir, "session-1.jsonl"),
      `${JSON.stringify({
        learning_id: "session-1:project:decision:event-1",
        scope: "project",
        scope_key: "agent-session-distillery",
        kind: "decision",
        title: "Refresh-driven page",
        trigger: "When revisiting related design decisions in agent-session-distillery.",
        statement: "Refresh re-runs export-wiki before pushing.",
        evidence: ["The integration uses --refresh to re-export."],
        confidence: "medium",
        evidence_type: "inferred",
        promotion_basis: "Explicit decision recorded in the planning loop.",
        source_refs: [
          {
            source_path: "/tmp/refresh-1.jsonl",
            source_hash: "sha256:refresh-1",
            session_id: "refresh-1",
            turn_id: "turn-1",
            event_id: "event-1",
            line: 7,
          },
        ],
      })}\n`,
      "utf8",
    );

    const result = runCli(["memory", "push-wiki", "--refresh"], {
      [runtimeOverrideEnvVar]: runtimeRoot,
      [vaultRootEnvVar]: vaultRoot,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Exported 1 wiki memory record/);

    const projectDir = join(vaultRoot, "wiki", "projects", RESOLVED_PROJECT_ID);
    const manifest = JSON.parse(await readFile(join(projectDir, "_asd-manifest.json"), "utf8"));
    assert.equal(Object.keys(manifest.records).length, 1);
  } finally {
    await rm(sandbox, { force: true, recursive: true });
  }
});

test("memory push-wiki --no-overwrite preserves manual edits when the on-disk hash diverges", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-vp-int-no-overwrite-"));
  const runtimeRoot = join(sandbox, "runtime");
  const vaultRoot = join(sandbox, "vault");
  try {
    await mkdir(vaultRoot, { recursive: true });
    await writeReviewedMemoryJsonl(runtimeRoot, [makeRecord("1")]);

    runCli(["memory", "push-wiki"], {
      [runtimeOverrideEnvVar]: runtimeRoot,
      [vaultRootEnvVar]: vaultRoot,
    });

    const pagePath = join(
      vaultRoot,
      "wiki",
      "projects",
      "agent-session-distillery",
      "asd-learnings",
      `${"0".repeat(63)}1.md`,
    );
    const before = await readFile(pagePath, "utf8");
    await writeFile(pagePath, `${before}\nHand-edited.\n`, "utf8");

    const updated = makeRecord("1", { body: "Body that would otherwise overwrite." });
    await writeReviewedMemoryJsonl(runtimeRoot, [updated]);

    const result = runCli(["memory", "push-wiki", "--no-overwrite"], {
      [runtimeOverrideEnvVar]: runtimeRoot,
      [vaultRootEnvVar]: vaultRoot,
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.total_skipped_protected, 1);

    const after = await readFile(pagePath, "utf8");
    assert.ok(
      after.includes("Hand-edited."),
      "manual edit must be preserved when --no-overwrite is in effect",
    );
  } finally {
    await rm(sandbox, { force: true, recursive: true });
  }
});
