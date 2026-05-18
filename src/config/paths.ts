import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const runtimeRootOverrideEnvVar = "AGENT_SESSION_DISTILLERY_ROOT";

const runtimePathSuffixes = {
  root: "",
  archives: "archives",
  deletes: "deletes",
  index: "index",
  knowledgeProjects: "knowledge/projects",
  knowledgeUsers: "knowledge/user",
  ledger: "ledger",
  manifests: "sources/manifests",
  reports: "reports",
  reviews: "reviews",
  staging: "staging",
  summaries: "summaries/by-session",
  wikiMemoryExports: "exports/wiki-memory"
} as const;

export type RuntimePathName = keyof typeof runtimePathSuffixes;

export function getRuntimeRoot(): string {
  const override = process.env[runtimeRootOverrideEnvVar];
  return override && override.length > 0
    ? override
    : join(homedir(), ".agent-session-distillery");
}

export function getRuntimePath(name: RuntimePathName): string {
  const suffix = runtimePathSuffixes[name];
  return suffix.length > 0 ? join(getRuntimeRoot(), suffix) : getRuntimeRoot();
}

export async function ensureRuntimePath(name: RuntimePathName): Promise<string> {
  const targetPath = getRuntimePath(name);
  await mkdir(targetPath, { recursive: true });
  return targetPath;
}
