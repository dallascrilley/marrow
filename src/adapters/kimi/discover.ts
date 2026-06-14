import { lstat, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathExists } from "../_common/fs.js";
import { hashFileContents } from "../_common/hash.js";
import type { KimiDiscoveryResult, KimiTranscriptDiscovery } from "./intermediate.js";
import { deriveKimiWorkspaceMapping } from "./workspace-map.js";

export const kimiTranscriptExtensions = [".jsonl"] as const;

export type DiscoverKimiInputsOptions = {
  homeDir?: string;
  kimiSessionsRoot?: string;
};

/**
 * Discover every Kimi session file on disk. The layout is:
 *
 *     ~/.kimi/sessions/<md5-workspace-path>/<session-uuid>/wire.jsonl
 *
 * The walker descends two levels: workspace-slug directories, then
 * session-uuid directories, looking for `wire.jsonl` files.
 * Symlinks and dotfiles are skipped.
 */
export async function discoverKimiInputs(
  options: DiscoverKimiInputsOptions = {},
): Promise<KimiDiscoveryResult> {
  const homeDir = resolve(options.homeDir ?? homedir());
  const kimiSessionsRoot = resolve(options.kimiSessionsRoot ?? join(homeDir, ".kimi", "sessions"));
  const sessionPaths = await discoverSessionPaths(kimiSessionsRoot);
  const transcripts: KimiTranscriptDiscovery[] = [];

  for (const sessionPath of sessionPaths) {
    const [metadata, sourceHash, workspaceMapping] = await Promise.all([
      stat(sessionPath),
      hashFileContents(sessionPath),
      deriveKimiWorkspaceMapping(sessionPath),
    ]);

    transcripts.push({
      ...workspaceMapping,
      modifiedAt: metadata.mtime.toISOString(),
      sessionId: basename(dirname(sessionPath)),
      sizeBytes: metadata.size,
      sourceFormat: normalizeTranscriptFormat(sessionPath),
      sourceHash,
      sourcePath: sessionPath,
    });
  }

  return { transcripts };
}

async function discoverSessionPaths(kimiSessionsRoot: string): Promise<string[]> {
  if (!(await pathExists(kimiSessionsRoot))) {
    return [];
  }

  const discoveredPaths: string[] = [];
  const workspaceEntries = await readdir(kimiSessionsRoot, {
    withFileTypes: true,
  });
  workspaceEntries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of workspaceEntries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory()) continue;

    const workspaceDir = join(kimiSessionsRoot, entry.name);
    await collectSessionFiles(workspaceDir, discoveredPaths);
  }

  return discoveredPaths.sort((left, right) => left.localeCompare(right));
}

async function collectSessionFiles(workspaceDir: string, discoveredPaths: string[]): Promise<void> {
  const sessionEntries = await readdir(workspaceDir, { withFileTypes: true });
  sessionEntries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of sessionEntries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory()) continue;

    const sessionDir = join(workspaceDir, entry.name);
    const wirePath = join(sessionDir, "wire.jsonl");

    try {
      const fileStats = await lstat(wirePath);
      if (fileStats.isFile()) {
        discoveredPaths.push(wirePath);
      }
    } catch {
      // wire.jsonl doesn't exist in this session dir — skip
    }
  }
}

function normalizeTranscriptFormat(_filePath: string): "jsonl" {
  return "jsonl";
}
