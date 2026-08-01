import { lstat, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { pathExists } from "../_common/fs.js";
import { hashFileContents } from "../_common/hash.js";
import type {
  PiDiscoveryResult,
  PiTranscriptDiscovery,
  PiTranscriptFormat,
} from "./intermediate.js";
import { derivePiWorkspaceMapping, readPiSessionMeta } from "./workspace-map.js";

export const piTranscriptExtensions = [".jsonl"] as const;

export type DiscoverPiInputsOptions = {
  homeDir?: string;
  includeTestSessions?: boolean;
  piSessionsRoot?: string;
};

export type PiDiscoverSkipReason = "ephemeral_path" | "test_session_name";

/**
 * Discover every Pi session file on disk. The layout is:
 *
 *     ~/.pi/agent/sessions/<encoded-cwd>/<iso>_<uuid>.jsonl
 *
 * The walker descends one level per workspace dir and collects every
 * `.jsonl` file as a session. Symlinks and dotfiles are skipped. For each
 * session the walker reads the leading `session` record (line 0, or after an
 * OMP `title` pad line) to populate the workspace mapping; the full file is
 * streamed later by the parse phase.
 *
 * Override the sessions root with `options.piSessionsRoot` or env
 * `ASD_PI_SESSIONS_ROOT` / `PI_SESSIONS_ROOT` (e.g. `~/.omp/agent/sessions`).
 */
export async function discoverPiInputs(
  options: DiscoverPiInputsOptions = {},
): Promise<PiDiscoveryResult> {
  const homeDir = resolve(options.homeDir ?? homedir());
  // ASD_PI_SESSIONS_ROOT (or PI_SESSIONS_ROOT) lets operators point at OMP
  // (~/.omp/agent/sessions) or other Pi-compatible trees without code changes.
  const envSessionsRoot =
    process.env.ASD_PI_SESSIONS_ROOT?.trim() || process.env.PI_SESSIONS_ROOT?.trim();
  const piSessionsRoot = resolve(
    options.piSessionsRoot ??
      (envSessionsRoot && envSessionsRoot.length > 0
        ? envSessionsRoot
        : join(homeDir, ".pi", "agent", "sessions")),
  );
  const sessionPaths = await discoverSessionPaths(piSessionsRoot);
  const transcripts: PiTranscriptDiscovery[] = [];
  let skippedEphemeralPath = 0;
  let skippedTestSessionName = 0;

  for (const sessionPath of sessionPaths) {
    const skip = shouldSkipPiSessionPath(sessionPath, {
      includeTestSessions: options.includeTestSessions === true,
    });
    if (skip !== null) {
      if (skip === "ephemeral_path") {
        skippedEphemeralPath += 1;
      } else {
        skippedTestSessionName += 1;
      }
      continue;
    }

    const [metadata, sourceHash, sessionMeta] = await Promise.all([
      stat(sessionPath),
      hashFileContents(sessionPath),
      readPiSessionMeta(sessionPath),
    ]);
    const workspaceMapping = derivePiWorkspaceMapping(sessionPath, sessionMeta);

    transcripts.push({
      ...workspaceMapping,
      modifiedAt: metadata.mtime.toISOString(),
      sizeBytes: metadata.size,
      sourceFormat: normalizeTranscriptFormat(sessionPath),
      sourceHash,
      sourcePath: sessionPath,
    });
  }

  if (skippedEphemeralPath > 0 || skippedTestSessionName > 0) {
    void skippedEphemeralPath;
    void skippedTestSessionName;
  }

  return { transcripts };
}

export function shouldSkipPiSessionPath(
  sessionPath: string,
  options: { includeTestSessions: boolean },
): PiDiscoverSkipReason | null {
  if (options.includeTestSessions) {
    return null;
  }

  const sessionFileName = basename(sessionPath, extname(sessionPath));
  const workspaceSlug = basename(join(sessionPath, ".."));
  if (isPiTestSessionBasename(sessionFileName) || isPiTestSessionBasename(workspaceSlug)) {
    return "test_session_name";
  }

  return null;
}

function isPiTestSessionBasename(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    value.startsWith("pi-test-") ||
    value.startsWith("pi-branching-test-") ||
    value.startsWith("pi-compaction-test-") ||
    normalized.includes("pi-test")
  );
}

async function discoverSessionPaths(piSessionsRoot: string): Promise<string[]> {
  if (!(await pathExists(piSessionsRoot))) {
    return [];
  }

  const discoveredPaths: string[] = [];
  const workspaceEntries = await readdir(piSessionsRoot, { withFileTypes: true });
  workspaceEntries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of workspaceEntries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory()) continue;

    const workspaceDir = join(piSessionsRoot, entry.name);
    await collectSessionFiles(workspaceDir, discoveredPaths);
  }

  return discoveredPaths.sort((left, right) => left.localeCompare(right));
}

async function collectSessionFiles(
  directoryPath: string,
  discoveredPaths: string[],
): Promise<void> {
  const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
  directoryEntries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of directoryEntries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    if (!entry.isFile()) continue;

    const extension = extname(entry.name).toLowerCase();
    if (!piTranscriptExtensions.includes(extension as (typeof piTranscriptExtensions)[number])) {
      continue;
    }

    const entryPath = join(directoryPath, entry.name);
    const fileStats = await lstat(entryPath);
    if (fileStats.isFile()) {
      discoveredPaths.push(entryPath);
    }
  }
}

function normalizeTranscriptFormat(_filePath: string): PiTranscriptFormat {
  return "jsonl";
}
