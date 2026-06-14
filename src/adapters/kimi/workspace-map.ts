import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { KimiWorkspaceMapping } from "./intermediate.js";

const kimiConfigPath = "~/.kimi/kimi.json";

type KimiConfig = {
  work_dirs?: Array<{
    path: string;
    kaos?: string;
    last_session_id?: string | null;
  }>;
};

/**
 * Derive workspace mapping for a Kimi session path.
 *
 * Kimi stores sessions at:
 *   ~/.kimi/sessions/<md5-workspace-path>/<session-uuid>/wire.jsonl
 *
 * The parent directory name is the MD5 hex digest of the workspace path.
 * We read ~/.kimi/kimi.json to build a reverse mapping, and fall back to
 * treating the md5 slug as an opaque workspace identifier.
 */
export async function deriveKimiWorkspaceMapping(
  sessionPath: string,
  options: { kimiConfigPath?: string } = {},
): Promise<KimiWorkspaceMapping> {
  const resolvedConfigPath = options.kimiConfigPath ?? resolveHome(kimiConfigPath);
  const workspaceSlug = extractWorkspaceSlug(sessionPath);
  const workspacePath = await resolveWorkspacePath(workspaceSlug, resolvedConfigPath);

  return {
    projectKey: workspacePath ?? workspaceSlug,
    workspacePath: workspacePath ?? null,
    workspaceSlug,
  };
}

function extractWorkspaceSlug(sessionPath: string): string {
  // Path shape: ~/.kimi/sessions/<workspace-slug>/<session-uuid>/wire.jsonl
  const parts = sessionPath.split(/[/\\]/);
  // Find the index after "sessions"
  const sessionsIndex = parts.findIndex((p) => p === "sessions");
  if (sessionsIndex >= 0 && sessionsIndex + 1 < parts.length) {
    return parts[sessionsIndex + 1]!;
  }
  return "unknown";
}

async function resolveWorkspacePath(
  workspaceSlug: string,
  configPath: string,
): Promise<string | null> {
  try {
    const config = JSON.parse(await readFile(configPath, "utf8")) as KimiConfig;
    const workDirs = config.work_dirs ?? [];

    for (const entry of workDirs) {
      if (!entry.path) continue;
      const md5Hash = await md5Hex(entry.path);
      if (md5Hash === workspaceSlug) {
        return entry.path;
      }
    }
  } catch {
    // Config missing or unreadable — fall through to null
  }

  return null;
}

function resolveHome(path: string): string {
  if (path.startsWith("~/")) {
    return join(process.env.HOME ?? process.env.USERPROFILE ?? "/tmp", path.slice(2));
  }
  return path;
}

function md5Hex(value: string): string {
  return createHash("md5").update(value, "utf8").digest("hex");
}
