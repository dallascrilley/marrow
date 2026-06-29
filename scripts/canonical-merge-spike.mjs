#!/usr/bin/env node
// U5a spike: does canonical-key merging recover a cross-session reinforcement
// signal the exact-hash id misses? Measures the *opportunity* directly —
// distinct exact ids vs. distinct canonical keys — within each project and
// across the whole corpus. No production code path required.
//
// Read-only. Idempotent. Touches no live state.
//
// Verdict logic (plan U5a): if canonical keys collapse meaningfully fewer
// buckets than exact ids (>= 25% singleton reduction) AND that yields any
// reinforced (>1 observation) instinct, the merge is worth wiring on. If the
// key collapses nothing, the singleton problem is upstream (insights don't
// recur), not a dedup-key problem — leave the gate alone.
//
// Usage:
//   npm run build && node scripts/canonical-merge-spike.mjs
//   node scripts/canonical-merge-spike.mjs --json > spike.json

import { readdir } from "node:fs/promises";

import { getRuntimePath } from "../dist/config/paths.js";
import { loadAllSessionBundles } from "../dist/v2/instinct/bundle.js";
import { canonicalKey } from "../dist/v2/instinct/id.js";

const args = process.argv.slice(2);
const wantJson = args.includes("--json");

const projectsRoot = getRuntimePath("instinctsProjects");
const projectIds = await listProjectIds(projectsRoot);

let totalCreates = 0;
let distinctIds = 0; // per-project sum of distinct exact ids (baseline buckets)
let distinctKeys = 0; // per-project sum of distinct canonical keys (merged buckets)
let projectsWithMergeOpportunity = 0;

// Cross-project: the promotion queue groups by exact id and needs >=2 projects.
const projectsByExactId = new Map();
const projectsByCanonicalKey = new Map();
const exampleOpportunities = [];

for (const projectId of projectIds) {
  const bundles = await loadAllSessionBundles(projectId);
  const ids = new Set();
  const keyToIds = new Map();

  for (const bundle of bundles) {
    for (const delta of bundle.deltas) {
      if (delta.op !== "create") continue;
      totalCreates += 1;
      ids.add(delta.instinct_id);
      const key = canonicalKey(delta.trigger, delta.finding);
      if (!keyToIds.has(key)) keyToIds.set(key, new Set());
      keyToIds.get(key).add(delta.instinct_id);

      addTo(projectsByExactId, delta.instinct_id, projectId);
      addTo(projectsByCanonicalKey, key, projectId);
    }
  }

  distinctIds += ids.size;
  distinctKeys += keyToIds.size;

  let hasOpportunity = false;
  for (const [key, idSet] of keyToIds) {
    if (idSet.size > 1) {
      hasOpportunity = true;
      if (exampleOpportunities.length < 10) {
        exampleOpportunities.push({ project: projectId, key, distinct_ids: idSet.size });
      }
    }
  }
  if (hasOpportunity) projectsWithMergeOpportunity += 1;
}

const crossProjectByExactId = countMulti(projectsByExactId);
const crossProjectByCanonicalKey = countMulti(projectsByCanonicalKey);

const singletonReduction = distinctIds === 0 ? 0 : (distinctIds - distinctKeys) / distinctIds;

const out = {
  captured_at: new Date().toISOString(),
  projects_scanned: projectIds.length,
  total_create_deltas: totalCreates,
  within_project: {
    distinct_exact_ids: distinctIds,
    distinct_canonical_keys: distinctKeys,
    bucket_reduction_pct: Number((singletonReduction * 100).toFixed(2)),
    projects_with_merge_opportunity: projectsWithMergeOpportunity,
  },
  cross_project: {
    // How many insights appear in >= 2 distinct projects (the promotion gate).
    instincts_in_2plus_projects_by_exact_id: crossProjectByExactId,
    instincts_in_2plus_projects_by_canonical_key: crossProjectByCanonicalKey,
  },
  promote_criteria: {
    bucket_reduction_ge_25pct: singletonReduction >= 0.25,
    any_within_project_opportunity: projectsWithMergeOpportunity > 0,
    any_cross_project_canonical_signal: crossProjectByCanonicalKey > 0,
  },
  example_opportunities: exampleOpportunities,
};

if (wantJson) {
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
} else {
  prettyPrint(out);
}

// ---------- helpers ----------

async function listProjectIds(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function addTo(map, key, projectId) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(projectId);
}

function countMulti(map) {
  let n = 0;
  for (const projects of map.values()) if (projects.size >= 2) n += 1;
  return n;
}

function prettyPrint(o) {
  const lines = [];
  lines.push("U5a canonical-merge spike");
  lines.push(`captured: ${o.captured_at}`);
  lines.push(`projects scanned: ${o.projects_scanned}  create-deltas: ${o.total_create_deltas}`);
  lines.push("");
  lines.push("within-project buckets:");
  lines.push(`  distinct exact ids:      ${o.within_project.distinct_exact_ids}`);
  lines.push(`  distinct canonical keys: ${o.within_project.distinct_canonical_keys}`);
  lines.push(`  bucket reduction:        ${o.within_project.bucket_reduction_pct}%`);
  lines.push(`  projects w/ opportunity: ${o.within_project.projects_with_merge_opportunity}`);
  lines.push("");
  lines.push("cross-project (the promotion gate needs >= 2 projects):");
  lines.push(
    `  shared by exact id:      ${o.cross_project.instincts_in_2plus_projects_by_exact_id}`,
  );
  lines.push(
    `  shared by canonical key: ${o.cross_project.instincts_in_2plus_projects_by_canonical_key}`,
  );
  lines.push("");
  lines.push(
    `PROMOTE? reduction>=25%=${o.promote_criteria.bucket_reduction_ge_25pct} ` +
      `within=${o.promote_criteria.any_within_project_opportunity} ` +
      `cross=${o.promote_criteria.any_cross_project_canonical_signal}`,
  );
  if (o.example_opportunities.length > 0) {
    lines.push("");
    lines.push("Example within-project merge opportunities:");
    for (const e of o.example_opportunities) {
      lines.push(`  ${e.project}: ${e.distinct_ids} ids -> "${e.key.slice(0, 50)}"`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}
