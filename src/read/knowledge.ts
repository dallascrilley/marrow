import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { getRuntimePath } from "../config/paths.js";
import { listSourceSessions } from "../db/ledger.js";
import type { Learning } from "../models/canonical.js";
import { mergeProjectKnowledgeDirectory } from "../pipeline/project-knowledge-merge.js";
import type { Instinct } from "../v2/instinct/schema.js";
import { loadAllInstincts } from "../v2/instinct/store.js";
import { resolveProjectIdForLegacyKey } from "../v2/project/resolve.js";

export type KnowledgeProjectRecord = {
  project_id: string;
  source: "deterministic-export" | "reviewed-export";
  learnings: Learning[];
};

export type KnowledgeSnapshot = {
  instincts: Instinct[];
  projects: KnowledgeProjectRecord[];
  total_instincts: number;
  total_learnings: number;
};

export async function listKnowledgeSnapshot(database: DatabaseSync): Promise<KnowledgeSnapshot> {
  const sessions = listSourceSessions(database);
  const reviewedRoot = join(getRuntimePath("root"), "knowledge", "projects-reviewed");
  const deterministicRoot = getRuntimePath("knowledgeProjects");
  const useReviewed = await directoryExists(reviewedRoot);
  const projectRoot = useReviewed ? reviewedRoot : deterministicRoot;
  const projectDirs = await readDirectoryNames(projectRoot);
  const projects: KnowledgeProjectRecord[] = [];
  const instincts: Instinct[] = [];
  const reviewSource = useReviewed ? "reviewed-export" : "deterministic-export";

  for (const legacyKey of projectDirs.sort()) {
    const projectId = await resolveProjectIdForLegacyKey(legacyKey, sessions);
    const merged = await mergeProjectKnowledgeDirectory(join(projectRoot, legacyKey));
    const projectLearnings = merged.merged.filter((learning) => learning.scope === "project");
    projects.push({
      project_id: projectId,
      source: reviewSource,
      learnings: projectLearnings,
    });
    instincts.push(...(await loadAllInstincts(projectId)).values());
  }

  projects.sort((left, right) => left.project_id.localeCompare(right.project_id));
  instincts.sort((left, right) => right.updated_at.localeCompare(left.updated_at));

  return {
    instincts,
    projects,
    total_instincts: instincts.length,
    total_learnings: projects.reduce((sum, project) => sum + project.learnings.length, 0),
  };
}

async function readDirectoryNames(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path);
    return entries.length > 0;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
