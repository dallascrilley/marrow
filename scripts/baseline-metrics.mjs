#!/usr/bin/env node
// Capture baseline metrics for v1 asd state so the v2 refactor has
// concrete before/after numbers.
//
// Read-only. Idempotent. Safe to run anytime.
//
// Usage:
//   node scripts/baseline-metrics.mjs
//   node scripts/baseline-metrics.mjs --root /tmp/asd-demo
//   node scripts/baseline-metrics.mjs --json > baseline.json

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const wantJson = args.includes("--json");
const rootArg = parseOption("--root");
const runtimeRoot =
  rootArg ??
  process.env.AGENT_SESSION_DISTILLERY_ROOT ??
  join(process.env.HOME ?? "", ".agent-session-distillery");

const vaultRoot = process.env.ASD_VAULT_ROOT ?? join(process.env.HOME ?? "", "vault");

const out = {
  captured_at: new Date().toISOString(),
  runtime_root: runtimeRoot,
  vault_root: vaultRoot,
  runtime: await measureRuntime(runtimeRoot),
  vault: await measureVault(vaultRoot),
};

if (wantJson) {
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
} else {
  prettyPrint(out);
}

// ---------- helpers ----------

function parseOption(name) {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return undefined;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function measureRuntime(root) {
  if (!(await exists(root))) {
    return { present: false };
  }
  const dirs = ["deletes", "knowledge", "ledger", "reports", "sources", "staging", "summaries"];
  const result = { present: true };
  for (const d of dirs) {
    result[d] = await measureDir(join(root, d));
  }

  // Heuristic: count distinct sessions = files in sources/ + summaries/.
  const distinctSessions = new Set();
  await collectFileStems(join(root, "sources"), distinctSessions);
  await collectFileStems(join(root, "summaries"), distinctSessions);
  result.distinct_sessions = distinctSessions.size;

  return result;
}

async function measureVault(root) {
  const projectsDir = join(root, "wiki", "projects");
  if (!(await exists(projectsDir))) {
    return { present: false };
  }
  const entries = await readdir(projectsDir, { withFileTypes: true });
  const projects = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const learnings = [];
  for (const p of projects) {
    const learningsDir = join(projectsDir, p, "asd-learnings");
    if (!(await exists(learningsDir))) continue;
    const m = await measureDir(learningsDir);
    learnings.push({ project: p, ...m });
  }
  return {
    present: true,
    projects_with_learnings: learnings.length,
    learnings_per_project: learnings,
  };
}

async function measureDir(path) {
  if (!(await exists(path))) {
    return { present: false, file_count: 0, total_bytes: 0 };
  }
  let fileCount = 0;
  let totalBytes = 0;
  let largestBytes = 0;
  await walk(path, async (entryPath) => {
    const s = await stat(entryPath);
    if (s.isFile()) {
      fileCount += 1;
      totalBytes += s.size;
      if (s.size > largestBytes) largestBytes = s.size;
    }
  });
  return {
    present: true,
    file_count: fileCount,
    total_bytes: totalBytes,
    largest_file_bytes: largestBytes,
    mean_bytes: fileCount > 0 ? Math.round(totalBytes / fileCount) : 0,
  };
}

async function walk(path, visit) {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(path, e.name);
    if (e.isDirectory()) {
      await walk(full, visit);
    } else {
      await visit(full);
    }
  }
}

async function collectFileStems(path, set) {
  if (!(await exists(path))) return;
  await walk(path, async (full) => {
    const name = full.split("/").pop() ?? "";
    const stem = name.replace(/\.[^.]+$/, "");
    if (stem) set.add(stem);
  });
}

function prettyPrint(o) {
  const lines = [];
  lines.push("agent-session-distillery — baseline metrics");
  lines.push(`captured: ${o.captured_at}`);
  lines.push("");
  lines.push(`runtime root: ${o.runtime_root}`);
  if (!o.runtime.present) {
    lines.push("  (not present)");
  } else {
    lines.push(`  distinct sessions: ${o.runtime.distinct_sessions}`);
    for (const k of [
      "deletes",
      "knowledge",
      "ledger",
      "reports",
      "sources",
      "staging",
      "summaries",
    ]) {
      const m = o.runtime[k];
      if (!m?.present) {
        lines.push(`  ${k.padEnd(10)} (absent)`);
        continue;
      }
      lines.push(
        `  ${k.padEnd(10)} files=${String(m.file_count).padStart(5)} ` +
          `total=${formatBytes(m.total_bytes).padStart(8)} ` +
          `mean=${formatBytes(m.mean_bytes).padStart(7)} ` +
          `largest=${formatBytes(m.largest_file_bytes)}`,
      );
    }
  }
  lines.push("");
  lines.push(`vault root: ${o.vault_root}`);
  if (!o.vault.present) {
    lines.push("  (no projects/ dir)");
  } else {
    lines.push(`  projects with asd-learnings: ${o.vault.projects_with_learnings}`);
    for (const p of o.vault.learnings_per_project) {
      lines.push(
        `    ${p.project.padEnd(40)} files=${String(p.file_count).padStart(4)} total=${formatBytes(p.total_bytes)}`,
      );
    }
  }
  lines.push("");
  lines.push("Re-run after each v2 milestone. Diff the JSON form to track change.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(2)}M`;
}
