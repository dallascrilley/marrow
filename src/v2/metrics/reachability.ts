import { readdir } from "node:fs/promises";

import { getRuntimePath } from "../../config/paths.js";
import { replayBundles } from "../instinct/bundle.js";
import { loadGlobalInstincts, shouldIncludeInRollup } from "../vault/render-memory.js";

/**
 * The headline asd metric: not how many instincts were produced, but how many a
 * future agent can actually reach. "Reachable" mirrors the render selection
 * predicate (`shouldIncludeInRollup`) over the same bundle-replay source render
 * uses, so the count is exactly what would land in a curated `MEMORY.md`.
 */
export type ReachabilitySnapshot = {
  /** Instinct source: bundle replay, the same path `renderProjectMemoryToVault` reads. */
  source: "bundle-replay";
  /** Total project instincts across every project. */
  produced: number;
  /** Project instincts passing the render-selection predicate. */
  reachable: number;
  /** reachable / produced, rounded to 4 dp; 0 when nothing produced. */
  reachable_ratio: number;
  /** Project directories scanned. */
  projects_total: number;
  /** Projects with at least one reachable instinct. */
  projects_with_reachable: number;
  /** Global-scope instincts produced (rendered to the `_global` rollup). */
  global_produced: number;
  /** Global-scope instincts passing the predicate. */
  global_reachable: number;
};

async function listProjectIds(): Promise<string[]> {
  try {
    const entries = await readdir(getRuntimePath("instinctsProjects"), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export async function computeReachability(): Promise<ReachabilitySnapshot> {
  const projectIds = await listProjectIds();

  let produced = 0;
  let reachable = 0;
  let projectsWithReachable = 0;

  for (const projectId of projectIds) {
    const instincts = [...(await replayBundles(projectId)).values()];
    produced += instincts.length;
    const projectReachable = instincts.filter(shouldIncludeInRollup).length;
    reachable += projectReachable;
    if (projectReachable > 0) projectsWithReachable += 1;
  }

  const globalInstincts = await loadGlobalInstincts();
  const globalReachable = globalInstincts.filter(shouldIncludeInRollup).length;

  return {
    source: "bundle-replay",
    produced,
    reachable,
    reachable_ratio: produced === 0 ? 0 : Number((reachable / produced).toFixed(4)),
    projects_total: projectIds.length,
    projects_with_reachable: projectsWithReachable,
    global_produced: globalInstincts.length,
    global_reachable: globalReachable,
  };
}
