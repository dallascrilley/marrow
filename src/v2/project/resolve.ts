import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { getRuntimePath } from "../../config/paths.js";
import { vaultProjectDir } from "../../config/vault-paths.js";
import type { SourceSession } from "../../models/canonical.js";

const execFileAsync = promisify(execFile);

export const PROJECT_ID_HEX_LENGTH = 12;

export type ProjectIdSource = "git-remote" | "path-hash" | "declared-key";

export type ResolvedProjectId = {
  id: string;
  source: ProjectIdSource;
};

export type ResolveProjectIdInput = {
  workspacePath: string | null;
  /** Directory used to locate `.asd-project-key` when workspace is unknown. */
  sessionRoot?: string | null;
};

/**
 * ADR-0002 resolution order: git remote hash → `.asd-project-key` override →
 * workspace path hash (or session-root hash when workspace is unknown).
 */
export async function resolveProjectId(input: ResolveProjectIdInput): Promise<ResolvedProjectId> {
  const workspace = normaliseWorkspacePath(input.workspacePath);
  const sessionRoot = input.sessionRoot?.trim() || null;

  if (workspace) {
    const remote = await readGitOriginRemote(workspace);
    if (remote) {
      return {
        id: hashToProjectId(remote),
        source: "git-remote",
      };
    }

    const declared = await readDeclaredProjectKey(workspace);
    if (declared) {
      return { id: sanitiseDeclaredKey(declared), source: "declared-key" };
    }

    return {
      id: hashToProjectId(workspace),
      source: "path-hash",
    };
  }

  const declared = await readDeclaredProjectKey(sessionRoot);
  if (declared) {
    return { id: sanitiseDeclaredKey(declared), source: "declared-key" };
  }

  return {
    id: hashToProjectId(sessionRoot ?? "unknown-workspace"),
    source: "path-hash",
  };
}

export async function resolveProjectIdForSession(
  session: Pick<SourceSession, "project_key" | "workspace_path">,
): Promise<ResolvedProjectId> {
  return resolveProjectId({
    workspacePath: session.workspace_path,
    sessionRoot: session.workspace_path ?? session.project_key,
  });
}

/** Map export/ledger slug or hash keys to the canonical v2 project id. */
export async function resolveProjectIdForLegacyKey(
  legacyKey: string,
  sessions: readonly Pick<SourceSession, "project_key" | "workspace_path">[],
): Promise<string> {
  const match = sessions.find(
    (session) =>
      session.project_key === legacyKey &&
      session.workspace_path !== null &&
      session.workspace_path.trim().length > 0,
  );
  if (match) {
    return (await resolveProjectIdForSession(match)).id;
  }

  if (/^[0-9a-f]{12}$/u.test(legacyKey)) {
    return legacyKey;
  }

  return (
    await resolveProjectId({
      workspacePath: null,
      sessionRoot: legacyKey,
    })
  ).id;
}

export function normaliseGitRemote(url: string): string {
  let value = url.trim().toLowerCase();
  value = value.replace(/^(?:https?:\/\/|git@|ssh:\/\/)/u, "");
  value = value.replace(/:/u, "/");
  value = value.replace(/\.git$/u, "");
  value = value.replace(/\/+$/u, "");
  return value;
}

export function hashToProjectId(normalisedInput: string): string {
  return createHash("sha256")
    .update(normalisedInput, "utf8")
    .digest("hex")
    .slice(0, PROJECT_ID_HEX_LENGTH);
}

export function projectInstinctsRoot(projectId: string): string {
  return join(getRuntimePath("instinctsProjects"), projectId);
}

export function projectInstinctsDir(projectId: string): string {
  return join(projectInstinctsRoot(projectId), "instincts");
}

export function projectSessionsDir(projectId: string): string {
  return join(projectInstinctsRoot(projectId), "sessions");
}

export { vaultProjectDir };

function normaliseWorkspacePath(workspacePath: string | null): string | null {
  if (!workspacePath || workspacePath.trim().length === 0) {
    return null;
  }
  return resolve(workspacePath.trim());
}

// In-process memoization of the `git remote get-url` probe, keyed on workspace
// path. Ingest discovery resolves a project id for EVERY transcript before the
// skip filter, and many transcripts share one workspace — without this cache
// that was one `git` fork per transcript (thousands per pipeline run). The
// origin remote is stable within a process, so caching is safe; a worktree-long
// command (MCP serve) can call `resetProjectIdCache` if it ever needs a refresh.
// Caching the PROMISE (not the result) means concurrent callers for the same
// path share a single fork instead of racing to spawn duplicate gits.
const gitRemoteCache = new Map<string, Promise<string | null>>();

/** Clear the in-process git-remote cache (test isolation / long-lived refresh). */
export function resetProjectIdCache(): void {
  gitRemoteCache.clear();
}

function readGitOriginRemote(workspacePath: string): Promise<string | null> {
  const cached = gitRemoteCache.get(workspacePath);
  if (cached !== undefined) {
    return cached;
  }
  const pending = (async (): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", workspacePath, "remote", "get-url", "origin"],
        { encoding: "utf8", timeout: 5_000, env: gitProbeEnv() },
      );
      const trimmed = stdout.trim();
      return trimmed.length > 0 ? normaliseGitRemote(trimmed) : null;
    } catch {
      return null;
    }
  })();
  gitRemoteCache.set(workspacePath, pending);
  return pending;
}

/**
 * Strip inherited git env vars so `-C <workspacePath>` repository discovery is
 * honored. Without this, running under a git hook (which exports `GIT_DIR`,
 * `GIT_WORK_TREE`, etc.) makes git ignore `-C` and probe the ambient repo,
 * misresolving the project id to the host repo's origin remote.
 */
function gitProbeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_PREFIX;
  delete env.GIT_COMMON_DIR;
  return env;
}

async function readDeclaredProjectKey(root: string | null | undefined): Promise<string | null> {
  if (!root || root.trim().length === 0) {
    return null;
  }

  try {
    const contents = await readFile(join(resolve(root), ".asd-project-key"), "utf8");
    const trimmed = contents.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function sanitiseDeclaredKey(key: string): string {
  const trimmed = key.trim();
  if (/^[0-9a-f]{12}$/u.test(trimmed)) {
    return trimmed;
  }
  return hashToProjectId(trimmed);
}
