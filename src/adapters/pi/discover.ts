import { lstat, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";

import { hashFileContents } from "../_common/hash.js";
import { pathExists } from "../_common/fs.js";
import type {
  PiDiscoveryResult,
  PiTranscriptDiscovery,
  PiTranscriptFormat
} from "./intermediate.js";
import { derivePiWorkspaceMapping, readPiSessionMeta } from "./workspace-map.js";

export const piTranscriptExtensions = [".jsonl"] as const;

export type DiscoverPiInputsOptions = {
  homeDir?: string;
  piSessionsRoot?: string;
};

/**
 * Discover every Pi session file on disk. The layout is:
 *
 *     ~/.pi/agent/sessions/<encoded-cwd>/<iso>_<uuid>.jsonl
 *
 * The walker descends one level per workspace dir and collects every
 * `.jsonl` file as a session. Symlinks and dotfiles are skipped. For each
 * session the walker reads only the `session` line (line 0) to populate
 * the workspace mapping; the full file is streamed later by the parse
 * phase.
 */
export async function discoverPiInputs(
  options: DiscoverPiInputsOptions = {}
): Promise<PiDiscoveryResult> {
  const homeDir = resolve(options.homeDir ?? homedir());
  const piSessionsRoot = resolve(
    options.piSessionsRoot ?? join(homeDir, ".pi", "agent", "sessions")
  );
  const sessionPaths = await discoverSessionPaths(piSessionsRoot);
  const transcripts = await Promise.all(
    sessionPaths.map(async (sessionPath) => {
      const [metadata, sourceHash, sessionMeta] = await Promise.all([
        stat(sessionPath),
        hashFileContents(sessionPath),
        readPiSessionMeta(sessionPath)
      ]);
      const workspaceMapping = derivePiWorkspaceMapping(sessionPath, sessionMeta);

      return {
        ...workspaceMapping,
        modifiedAt: metadata.mtime.toISOString(),
        sizeBytes: metadata.size,
        sourceFormat: normalizeTranscriptFormat(sessionPath),
        sourceHash,
        sourcePath: sessionPath
      } satisfies PiTranscriptDiscovery;
    })
  );

  return { transcripts };
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

async function collectSessionFiles(directoryPath: string, discoveredPaths: string[]): Promise<void> {
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
