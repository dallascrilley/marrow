import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getRuntimePath } from "../../config/paths.js";
import type { Instinct } from "./schema.js";
import { parseInstinctYaml, serializeInstinct } from "./yaml-io.js";

/**
 * The cross-project global instinct store (`scope: global`). Promotion writes
 * here; render (`renderGlobalMemoryToVault`) and the MCP global-scope query read
 * here. Kept separate from the per-project store so a global instinct's
 * `project_id` is empty and it is never bucketed under any single project.
 */
export function globalInstinctDir(): string {
  return getRuntimePath("instinctsGlobal");
}

export function globalInstinctFilePath(instinctId: string): string {
  return join(globalInstinctDir(), `${instinctId}.yaml`);
}

export async function loadGlobalInstinctIds(): Promise<string[]> {
  try {
    const entries = await readdir(globalInstinctDir());
    return entries
      .filter((name) => name.endsWith(".yaml"))
      .map((name) => name.replace(/\.yaml$/u, ""));
  } catch {
    return [];
  }
}

export async function loadGlobalInstinct(instinctId: string): Promise<Instinct | null> {
  try {
    const contents = await readFile(globalInstinctFilePath(instinctId), "utf8");
    return parseInstinctYaml(contents);
  } catch {
    return null;
  }
}

/** Atomically write one `scope: global` instinct to the global store. */
export async function saveGlobalInstinct(instinct: Instinct): Promise<void> {
  if (instinct.scope !== "global") {
    throw new Error(
      `saveGlobalInstinct requires scope "global", got "${instinct.scope}" for ${instinct.id}`,
    );
  }
  await mkdir(globalInstinctDir(), { recursive: true });
  const target = globalInstinctFilePath(instinct.id);
  const temp = `${target}.tmp`;
  await writeFile(temp, serializeInstinct(instinct), "utf8");
  await rename(temp, target);
}
