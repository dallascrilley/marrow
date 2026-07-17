import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { learningFixture } from "../dist/models/canonical.js";
import { dedupeUserRecords, runBackfill } from "../scripts/dedupe-user-knowledge.mjs";

function userLearning(statement, learningId) {
  return {
    ...learningFixture,
    learning_id: learningId,
    scope: "user",
    scope_key: "operator",
    kind: "preference",
    statement,
  };
}

async function writeFixtureRuntime() {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-user-dedupe-"));
  const scopeRoot = join(sandbox, "knowledge", "user", "operator");
  await mkdir(scopeRoot, { recursive: true });
  const firstPath = join(scopeRoot, "a.jsonl");
  const secondPath = join(scopeRoot, "b.jsonl");
  await writeFile(
    firstPath,
    `${JSON.stringify(userLearning("Always run tests.", "learning-a"))}\n`,
    "utf8",
  );
  await writeFile(
    secondPath,
    `${JSON.stringify(userLearning(" always   run tests! ", "learning-b"))}\n${JSON.stringify(userLearning("Prefer focused tests.", "learning-c"))}\n`,
    "utf8",
  );
  return { firstPath, secondPath, root: sandbox };
}

test("dedupeUserRecords collapses normalized user preference variants", () => {
  const result = dedupeUserRecords([
    userLearning("Always run tests.", "learning-a"),
    userLearning(" always   run tests! ", "learning-b"),
    { ...userLearning("Always run tests.", "learning-c"), kind: "workflow" },
  ]);

  assert.equal(result.inputCount, 3);
  assert.equal(result.outputCount, 2);
  assert.equal(result.duplicateCount, 1);
});

test("runBackfill dry-run reports cross-file duplicates without mutating files", async () => {
  const fixture = await writeFixtureRuntime();
  const beforeFirst = await readFile(fixture.firstPath, "utf8");
  const beforeSecond = await readFile(fixture.secondPath, "utf8");

  const result = await runBackfill({ root: fixture.root });

  assert.equal(result.applied, false);
  assert.equal(result.before.records, 3);
  assert.equal(result.after.records, 2);
  assert.equal(result.duplicate_count, 1);
  assert.equal(result.duplicate_rate, 1 / 3);
  assert.equal(await readFile(fixture.firstPath, "utf8"), beforeFirst);
  assert.equal(await readFile(fixture.secondPath, "utf8"), beforeSecond);
});

test("runBackfill apply rewrites duplicates after full preflight", async () => {
  const fixture = await writeFixtureRuntime();

  const result = await runBackfill({ apply: true, root: fixture.root });

  assert.equal(result.applied, true);
  assert.equal((await readFile(fixture.firstPath, "utf8")).trim().split("\n").length, 1);
  assert.equal((await readFile(fixture.secondPath, "utf8")).trim().split("\n").length, 1);
});

test("runBackfill rejects invalid records before applying any rewrite", async () => {
  const fixture = await writeFixtureRuntime();
  const invalidPath = join(fixture.root, "knowledge", "user", "operator", "z-invalid.jsonl");
  await writeFile(invalidPath, '{"not":"a learning"}\n', "utf8");
  const beforeFirst = await readFile(fixture.firstPath, "utf8");
  const beforeSecond = await readFile(fixture.secondPath, "utf8");

  await assert.rejects(runBackfill({ apply: true, root: fixture.root }), /Invalid learning record/);

  assert.equal(await readFile(fixture.firstPath, "utf8"), beforeFirst);
  assert.equal(await readFile(fixture.secondPath, "utf8"), beforeSecond);
});
