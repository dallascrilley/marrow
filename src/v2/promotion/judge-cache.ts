import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { getRuntimeRoot } from "../../config/paths.js";
import { type GlobalJudgeVerdict, globalJudgeVerdictSchema } from "./judge.js";

export const JUDGE_CACHE_FILENAME = "promote-judge-cache.json";

/**
 * Persistent cache of judge verdicts so re-runs of `promote judge` don't
 * re-spend on candidates already judged. The deterministic candidate set
 * excludes only *promoted* (global) ids, so without this cache every re-run
 * re-judges every previously-*rejected* candidate. Entries are keyed on
 * content hash + model + prompt version, so a rewritten instinct, a different
 * model, or a bumped prompt correctly forces a re-judge.
 */
const cacheEntrySchema = z.object({
  verdict: globalJudgeVerdictSchema,
  model: z.string(),
  prompt_version: z.string(),
  at: z.string(),
});

const cacheFileSchema = z.object({
  entries: z.record(z.string(), cacheEntrySchema).default({}),
});

export type JudgeCacheEntry = z.infer<typeof cacheEntrySchema>;
export type JudgeCache = Map<string, JudgeCacheEntry>;

export function getJudgeCachePath(): string {
  return join(getRuntimeRoot(), JUDGE_CACHE_FILENAME);
}

/** Compose the cache key from content hash + model + prompt version. */
export function judgeCacheKey(contentHash: string, model: string, promptVersion: string): string {
  return `${contentHash}:${model}:${promptVersion}`;
}

export async function loadJudgeCache(path = getJudgeCachePath()): Promise<JudgeCache> {
  try {
    const parsed = cacheFileSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    if (!parsed.success) return new Map();
    return new Map(Object.entries(parsed.data.entries));
  } catch {
    return new Map();
  }
}

export async function saveJudgeCache(cache: JudgeCache, path = getJudgeCachePath()): Promise<void> {
  await mkdir(getRuntimeRoot(), { recursive: true });
  const entries = Object.fromEntries(cache);
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify({ entries }, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

export function setCachedVerdict(
  cache: JudgeCache,
  key: string,
  verdict: GlobalJudgeVerdict,
  model: string,
  promptVersion: string,
  at: string,
): void {
  cache.set(key, { verdict, model, prompt_version: promptVersion, at });
}
