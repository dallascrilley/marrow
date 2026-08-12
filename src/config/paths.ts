import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const runtimeRootOverrideEnvVar = "MARROW_ROOT";
export const stagingRootOverrideEnvVar = "MARROW_STAGING_ROOT";

/**
 * Pre-rename names for the same two overrides. Marrow was called
 * agent-session-distillery until v1.1.0; anyone who exported the old variables
 * in a shell profile, launch agent or CI job keeps working. The new name wins
 * when both are set.
 */
const legacyEnvVarAliases: Readonly<Record<string, string>> = {
  MARROW_ROOT: "AGENT_SESSION_DISTILLERY_ROOT",
  MARROW_STAGING_ROOT: "AGENT_SESSION_DISTILLERY_STAGING_ROOT",
};

/** Read an override, falling back to its pre-rename name. */
export function readOverrideEnvVar(name: string): string | undefined {
  const current = process.env[name];
  if (current !== undefined && current.length > 0) {
    return current;
  }
  const legacyName = legacyEnvVarAliases[name];
  const legacy = legacyName ? process.env[legacyName] : undefined;
  return legacy !== undefined && legacy.length > 0 ? legacy : undefined;
}

const runtimePathSuffixes = {
  root: "",
  archives: "archives",
  deletes: "deletes",
  emuloExports: "exports/emulo",
  index: "index",
  knowledgeProjects: "knowledge/projects",
  knowledgeUsers: "knowledge/user",
  ledger: "ledger",
  manifests: "sources/manifests",
  reports: "reports",
  reviews: "reviews",
  staging: "staging",
  summaries: "summaries/by-session",
  wikiMemoryExports: "exports/wiki-memory",
  instinctsProjects: "instincts",
  instinctsGlobal: "instincts-global",
} as const;

export type RuntimePathName = keyof typeof runtimePathSuffixes;

export function getRuntimeRoot(): string {
  return readOverrideEnvVar(runtimeRootOverrideEnvVar) ?? join(homedir(), ".marrow");
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
