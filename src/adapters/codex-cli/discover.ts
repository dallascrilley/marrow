import { lstat, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";

import { hashFileContents } from "../_common/hash.js";
import { pathExists } from "../_common/fs.js";
import type {
  CodexCliDiscoveryResult,
  CodexCliRolloutTreeRoot,
  CodexCliTranscriptDiscovery,
  CodexCliTranscriptFormat
} from "./intermediate.js";
import {
  deriveCodexCliWorkspaceMapping,
  readCodexCliSessionMeta
} from "./workspace-map.js";

export const codexCliTranscriptExtensions = [".jsonl"] as const;

export type DiscoverCodexCliInputsOptions = {
  codexHome?: string;
  homeDir?: string;
};

/**
 * Discover every Codex CLI rollout file on disk. The walker visits two
 * roots:
 *
 *     ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl
 *     ~/.codex/archived_sessions/rollout-*.jsonl
 *
 * The first is date-partitioned; the second is flat. Both produce
 * `rollout-*.jsonl` files in the same format. For each rollout the walker
 * reads only the `session_meta` line (line 0) to populate the workspace
 * mapping; the full file is streamed later by the parse phase.
 */
export async function discoverCodexCliInputs(
  options: DiscoverCodexCliInputsOptions = {}
): Promise<CodexCliDiscoveryResult> {
  const homeDir = resolve(options.homeDir ?? homedir());
  const codexHome = resolve(options.codexHome ?? join(homeDir, ".codex"));
  const sessionsRoot = join(codexHome, "sessions");
  const archivedRoot = join(codexHome, "archived_sessions");

  const datePartitionedPaths = await discoverDatePartitionedRollouts(sessionsRoot);
  const flatPaths = await discoverFlatRollouts(archivedRoot);

  const allPaths: Array<{ path: string; root: CodexCliRolloutTreeRoot }> = [
    ...datePartitionedPaths.map((path) => ({ path, root: "sessions" as const })),
    ...flatPaths.map((path) => ({ path, root: "archived_sessions" as const }))
  ];

  const transcripts = await Promise.all(
    allPaths.map(async ({ path, root }) => {
      const [metadata, sourceHash, sessionMeta] = await Promise.all([
        stat(path),
        hashFileContents(path),
        readCodexCliSessionMeta(path)
      ]);
      const workspaceMapping = await deriveCodexCliWorkspaceMapping(path, root, sessionMeta);

      return {
        ...workspaceMapping,
        modifiedAt: metadata.mtime.toISOString(),
        sizeBytes: metadata.size,
        sourceFormat: normalizeTranscriptFormat(path),
        sourceHash,
        sourcePath: path
      } satisfies CodexCliTranscriptDiscovery;
    })
  );

  return { transcripts };
}

const yearDirPattern = /^\d{4}$/;
const twoDigitDirPattern = /^\d{2}$/;

async function discoverDatePartitionedRollouts(sessionsRoot: string): Promise<string[]> {
  if (!(await pathExists(sessionsRoot))) {
    return [];
  }

  const discovered: string[] = [];
  const yearEntries = await readdir(sessionsRoot, { withFileTypes: true });
  yearEntries.sort((left, right) => left.name.localeCompare(right.name));

  for (const yearEntry of yearEntries) {
    if (!isDateDir(yearEntry, yearDirPattern)) continue;
    const yearDir = join(sessionsRoot, yearEntry.name);

    const monthEntries = await readdir(yearDir, { withFileTypes: true });
    monthEntries.sort((left, right) => left.name.localeCompare(right.name));

    for (const monthEntry of monthEntries) {
      if (!isDateDir(monthEntry, twoDigitDirPattern)) continue;
      const monthDir = join(yearDir, monthEntry.name);

      const dayEntries = await readdir(monthDir, { withFileTypes: true });
      dayEntries.sort((left, right) => left.name.localeCompare(right.name));

      for (const dayEntry of dayEntries) {
        if (!isDateDir(dayEntry, twoDigitDirPattern)) continue;
        const dayDir = join(yearDir, monthEntry.name, dayEntry.name);
        await collectRolloutFiles(dayDir, discovered);
      }
    }
  }

  discovered.sort((left, right) => left.localeCompare(right));
  return discovered;
}

async function discoverFlatRollouts(archivedRoot: string): Promise<string[]> {
  if (!(await pathExists(archivedRoot))) {
    return [];
  }

  const discovered: string[] = [];
  await collectRolloutFiles(archivedRoot, discovered);
  discovered.sort((left, right) => left.localeCompare(right));
  return discovered;
}

function isDateDir(entry: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }, pattern: RegExp): boolean {
  if (entry.isSymbolicLink()) return false;
  if (!entry.isDirectory()) return false;
  return pattern.test(entry.name);
}

async function collectRolloutFiles(directoryPath: string, discoveredPaths: string[]): Promise<void> {
  const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
  directoryEntries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of directoryEntries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith("rollout-")) continue;

    const extension = extname(entry.name).toLowerCase();
    if (!codexCliTranscriptExtensions.includes(extension as (typeof codexCliTranscriptExtensions)[number])) {
      continue;
    }

    const entryPath = join(directoryPath, entry.name);
    const fileStats = await lstat(entryPath);
    if (fileStats.isFile()) {
      discoveredPaths.push(entryPath);
    }
  }
}

function normalizeTranscriptFormat(_filePath: string): CodexCliTranscriptFormat {
  return "jsonl";
}
