#!/usr/bin/env node
/**
 * One-time maintenance: heal retention receipts that falsely report
 * `no_durable_learnings`.
 *
 * Why: receipts written before the ADR-0002 project-id migration can carry a
 * stale `no_durable_learnings` reason even though a non-empty project-knowledge
 * file exists for the session under an older project key. Retention reads the
 * learning file by the session's *current* `project_key`, so the mismatch makes
 * a session with real durable learnings look empty.
 *
 * This script builds a single session-id -> learning-file index (one pass over
 * `knowledge/projects`), then rewrites only the receipts whose
 * `no_durable_learnings` flag is contradicted by that index. It does not touch
 * the per-session retention hot path.
 *
 * Usage:
 *   node scripts/heal-stale-learning-receipts.mjs [--root <runtime>] [--apply]
 *
 * Dry-run by default: prints which receipts would change. Pass --apply to
 * rewrite them (sets project_learnings_written=true, safe_to_delete=true,
 * clears reason_if_not).
 */
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const rootOverride = parseOption("--root");

const runtimeRoot = resolve(
  rootOverride ?? process.env.MARROW_ROOT ?? join(process.env.HOME ?? "", ".marrow"),
);

const knowledgeProjects = join(runtimeRoot, "knowledge", "projects");
const receiptsDir = join(runtimeRoot, "deletes", "receipts");

// 1. Index: session-id -> true when a non-empty project learning file exists
//    under ANY project key. Single pass over knowledge/projects.
const sessionsWithLearning = new Set();
for (const projectKey of await safeReaddir(knowledgeProjects)) {
  const projectDir = join(knowledgeProjects, projectKey);
  for (const fileName of await safeReaddir(projectDir)) {
    if (!fileName.endsWith(".jsonl")) {
      continue;
    }
    const filePath = join(projectDir, fileName);
    let size = 0;
    try {
      size = (await stat(filePath)).size;
    } catch {
      continue;
    }
    if (size > 0) {
      sessionsWithLearning.add(fileName.slice(0, -".jsonl".length));
    }
  }
}

// 2. Scan receipts; heal the contradicted ones.
let scanned = 0;
let healed = 0;
const sample = [];

for (const fileName of await safeReaddir(receiptsDir)) {
  if (!fileName.endsWith(".json")) {
    continue;
  }
  const filePath = join(receiptsDir, fileName);
  scanned += 1;

  let receipt;
  try {
    receipt = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    continue;
  }

  const reason = receipt.reason_if_not ?? "";
  if (!reason.includes("no_durable_learnings")) {
    continue;
  }
  if (!sessionsWithLearning.has(receipt.session_id)) {
    continue;
  }

  healed += 1;
  if (sample.length < 20) {
    sample.push(receipt.session_id);
  }

  if (apply) {
    receipt.project_learnings_written = true;
    receipt.safe_to_delete = true;
    receipt.reason_if_not = "";
    await writeFile(filePath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  }
}

console.log(
  JSON.stringify(
    {
      apply,
      runtimeRoot,
      sessionsWithLearning: sessionsWithLearning.size,
      receiptsScanned: scanned,
      healed,
      sample,
    },
    null,
    2,
  ),
);

async function safeReaddir(path) {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

function parseOption(flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}
