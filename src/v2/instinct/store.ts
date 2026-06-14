import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { projectInstinctsDir, projectInstinctsRoot } from "../project/resolve.js";
import type { Instinct } from "./schema.js";
import { parseInstinctYaml, serializeInstinct } from "./yaml-io.js";

export async function ensureProjectInstinctLayout(projectId: string): Promise<void> {
  await mkdir(projectInstinctsDir(projectId), { recursive: true });
  await mkdir(join(projectInstinctsRoot(projectId), "sessions"), {
    recursive: true,
  });
}

export function instinctFilePath(projectId: string, instinctId: string): string {
  return join(projectInstinctsDir(projectId), `${instinctId}.yaml`);
}

export async function loadInstinct(
  projectId: string,
  instinctId: string,
): Promise<Instinct | null> {
  try {
    const contents = await readFile(instinctFilePath(projectId, instinctId), "utf8");
    return parseInstinctYaml(contents);
  } catch {
    return null;
  }
}

export async function listInstinctIds(projectId: string): Promise<string[]> {
  try {
    const entries = await readdir(projectInstinctsDir(projectId));
    return entries
      .filter((name) => name.endsWith(".yaml"))
      .map((name) => name.replace(/\.yaml$/u, ""));
  } catch {
    return [];
  }
}

export async function loadAllInstincts(projectId: string): Promise<Map<string, Instinct>> {
  const map = new Map<string, Instinct>();
  for (const id of await listInstinctIds(projectId)) {
    const instinct = await loadInstinct(projectId, id);
    if (instinct) {
      map.set(id, instinct);
    }
  }
  return map;
}

export async function saveInstinct(projectId: string, instinct: Instinct): Promise<void> {
  await ensureProjectInstinctLayout(projectId);
  const target = instinctFilePath(projectId, instinct.id);
  const temp = `${target}.tmp`;
  await writeFile(temp, serializeInstinct(instinct), "utf8");
  await rename(temp, target);
}

export async function saveAllInstincts(
  projectId: string,
  instincts: Map<string, Instinct>,
): Promise<void> {
  await ensureProjectInstinctLayout(projectId);
  const existingIds = await listInstinctIds(projectId);
  const keepIds = new Set(instincts.keys());
  for (const id of existingIds) {
    if (!keepIds.has(id)) {
      await unlink(instinctFilePath(projectId, id));
    }
  }
  for (const instinct of instincts.values()) {
    await saveInstinct(projectId, instinct);
  }
}
