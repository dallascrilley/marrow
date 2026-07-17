#!/usr/bin/env node

import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { learningSchema } from "../dist/models/canonical.js";
import { normalizeUserPreferenceStatement } from "../dist/pipeline/extract.js";

const scriptPath = fileURLToPath(import.meta.url);

export function dedupeUserRecords(records, seen = new Set()) {
  const unique = [];
  let duplicateCount = 0;

  for (const record of records) {
    const normalized = normalizeUserPreferenceStatement(record.statement);
    const key = `${record.scope_key}:${record.kind}:${normalized.toLowerCase()}`;
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }

    seen.add(key);
    unique.push(record);
  }

  return {
    duplicateCount,
    inputCount: records.length,
    outputCount: unique.length,
    records: unique,
    seen,
  };
}

export async function collectUserKnowledgeFiles(root) {
  const knowledgeRoot = join(root, "knowledge", "user");
  const scopes = await readdir(knowledgeRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const files = [];

  for (const scope of scopes
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const entries = await readdir(join(knowledgeRoot, scope.name), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(join(knowledgeRoot, scope.name, entry.name));
      }
    }
  }

  return files.sort();
}

async function readLearningFile(path) {
  const contents = await readFile(path, "utf8");
  const records = [];
  for (const [index, line] of contents.split("\n").entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      records.push(learningSchema.parse(JSON.parse(trimmed)));
    } catch (error) {
      throw new Error(`Invalid learning record at ${basename(path)}:${index + 1}`, {
        cause: error,
      });
    }
  }
  return records;
}

export async function runBackfill({ root, apply = false }) {
  const files = await collectUserKnowledgeFiles(root);
  const before = { files: files.length, records: 0 };
  const after = { records: 0 };
  let duplicates = 0;
  const seen = new Set();
  const plans = [];

  for (const path of files) {
    const records = await readLearningFile(path);
    const result = dedupeUserRecords(records, seen);
    before.records += result.inputCount;
    after.records += result.outputCount;
    duplicates += result.duplicateCount;
    plans.push({
      contents: `${result.records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      path,
      changed: result.duplicateCount > 0,
    });
  }

  if (apply) {
    for (const plan of plans.filter((entry) => entry.changed)) {
      const temporaryPath = `${plan.path}.tmp-${process.pid}`;
      await writeFile(temporaryPath, plan.contents, "utf8");
      await rename(temporaryPath, plan.path);
    }
  }

  return {
    applied: apply,
    before,
    after,
    duplicate_count: duplicates,
    duplicate_rate: before.records === 0 ? 0 : duplicates / before.records,
    files,
  };
}

function parseArgs(argv) {
  const options = {
    apply: false,
    root:
      process.env.AGENT_SESSION_DISTILLERY_ROOT ??
      join(process.env.HOME ?? "", ".agent-session-distillery"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--root requires a path");
      options.root = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

if (process.argv[1] === scriptPath) {
  const options = parseArgs(process.argv.slice(2));
  const result = await runBackfill(options);
  console.log(JSON.stringify(result, null, 2));
  if (!options.apply) {
    console.error("Dry run only. Pass --apply to rewrite duplicate user-learning records.");
  }
}
