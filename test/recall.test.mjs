import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { hashToProjectId } from "../dist/v2/project/resolve.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(testDir);
const cliPath = join(projectRoot, "dist", "cli.js");

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

async function seedVaultMemory(vaultRoot, projectId, files) {
  const dir = join(vaultRoot, "wiki", "projects", projectId);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf8");
  }
}

const MEMORY_BODY = `---
tags: [marrow, memory, curated]
generated_at: 2026-06-29T07:40:12.416Z
---

# Project memory (curated)

- **debugging** (established, 0.71): Match database query result types with expected function arguments.
- **workflow** (candidate, 0.62): Run the local CI gate before pushing.
`;

test("recall prints curated MEMORY.md lines for the resolved project", async () => {
  const work = await mkdtemp(join(tmpdir(), "marrow-recall-work-"));
  const vault = await mkdtemp(join(tmpdir(), "marrow-recall-vault-"));
  try {
    const projectId = hashToProjectId(work);
    await seedVaultMemory(vault, projectId, { "MEMORY.md": MEMORY_BODY });

    const result = runCli(["recall", "--cwd", work, "--vault-root", vault]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Match database query result types/);
    assert.match(result.stdout, /Run the local CI gate before pushing/);
    // YAML frontmatter must be stripped from the injected block.
    assert.doesNotMatch(result.stdout, /generated_at:/);
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test("recall appends present topic files under their own headings", async () => {
  const work = await mkdtemp(join(tmpdir(), "marrow-recall-work-"));
  const vault = await mkdtemp(join(tmpdir(), "marrow-recall-vault-"));
  try {
    const projectId = hashToProjectId(work);
    await seedVaultMemory(vault, projectId, {
      "MEMORY.md": MEMORY_BODY,
      "pitfalls.md": "- Avoid empty env/ directories.\n",
    });

    const result = runCli(["recall", "--cwd", work, "--vault-root", vault]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /pitfalls/i);
    assert.match(result.stdout, /Avoid empty env\/ directories/);
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test("recall fails open with empty output when no memory exists", async () => {
  const work = await mkdtemp(join(tmpdir(), "marrow-recall-work-"));
  const vault = await mkdtemp(join(tmpdir(), "marrow-recall-vault-"));
  try {
    const result = runCli(["recall", "--cwd", work, "--vault-root", vault]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "");
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test("recall fails open for a header-only MEMORY.md with no instinct bullets", async () => {
  const work = await mkdtemp(join(tmpdir(), "marrow-recall-work-"));
  const vault = await mkdtemp(join(tmpdir(), "marrow-recall-vault-"));
  try {
    const projectId = hashToProjectId(work);
    // Exactly what render writes for a project with zero reachable instincts:
    // frontmatter + heading + boilerplate, but no `- ` bullets.
    const headerOnly = `---
tags: [marrow, memory, curated]
---

# Project memory (curated)

Regenerated from atomic instincts. Session-level audit pages live under \`marrow-learnings/\`.
`;
    await seedVaultMemory(vault, projectId, { "MEMORY.md": headerOnly });

    const result = runCli(["recall", "--cwd", work, "--vault-root", vault]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "");
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test("recall truncates at a line boundary when over --max-bytes", async () => {
  const work = await mkdtemp(join(tmpdir(), "marrow-recall-work-"));
  const vault = await mkdtemp(join(tmpdir(), "marrow-recall-vault-"));
  try {
    const projectId = hashToProjectId(work);
    const longBody = `${MEMORY_BODY}${Array.from({ length: 200 }, (_, i) => `- line ${i} ${"x".repeat(40)}`).join("\n")}\n`;
    await seedVaultMemory(vault, projectId, { "MEMORY.md": longBody });

    const result = runCli(["recall", "--cwd", work, "--vault-root", vault, "--max-bytes", "500"]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      Buffer.byteLength(result.stdout, "utf8") <= 700,
      `expected truncated output, got ${Buffer.byteLength(result.stdout, "utf8")} bytes`,
    );
    assert.match(result.stdout, /truncated/i);
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});
