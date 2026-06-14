import { lstat, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { pathExists } from "../_common/fs.js";
import { hashFileContents } from "../_common/hash.js";
import type {
  ClaudeCodeDiscoveryResult,
  ClaudeCodeTranscriptDiscovery,
  ClaudeCodeTranscriptFormat,
} from "./intermediate.js";
import {
  type DeriveClaudeCodeWorkspaceMappingOptions,
  deriveClaudeCodeWorkspaceMapping,
} from "./workspace-map.js";

export const claudeCodeTranscriptExtensions = [".jsonl"] as const;

export type DiscoverClaudeCodeInputsOptions = {
  claudeCodeProjectsRoot?: string;
  homeDir?: string;
};

/**
 * Discover all Claude Code transcript files on disk. The layout is:
 *
 *     ~/.claude/projects/<encoded-workspace>/<session-uuid>.jsonl
 *
 * The walker descends one level per workspace dir and collects every
 * `.jsonl` file as a session. Symlinks and dotfiles are skipped.
 */
export async function discoverClaudeCodeInputs(
  options: DiscoverClaudeCodeInputsOptions = {},
): Promise<ClaudeCodeDiscoveryResult> {
  const homeDir = resolve(options.homeDir ?? homedir());
  const claudeCodeProjectsRoot = resolve(
    options.claudeCodeProjectsRoot ?? join(homeDir, ".claude", "projects"),
  );
  const transcriptPaths = await discoverTranscriptPaths(claudeCodeProjectsRoot);
  const transcripts = await Promise.all(
    transcriptPaths.map(async (transcriptPath) => {
      const [metadata, sourceHash, workspaceMapping] = await Promise.all([
        stat(transcriptPath),
        hashFileContents(transcriptPath),
        deriveClaudeCodeWorkspaceMapping(transcriptPath, {
          claudeCodeProjectsRoot,
        } satisfies DeriveClaudeCodeWorkspaceMappingOptions),
      ]);

      return {
        ...workspaceMapping,
        modifiedAt: metadata.mtime.toISOString(),
        sizeBytes: metadata.size,
        sourceFormat: normalizeTranscriptFormat(transcriptPath),
        sourceHash,
        sourcePath: transcriptPath,
      } satisfies ClaudeCodeTranscriptDiscovery;
    }),
  );

  return { transcripts };
}

async function discoverTranscriptPaths(projectsRoot: string): Promise<string[]> {
  if (!(await pathExists(projectsRoot))) {
    return [];
  }

  const discoveredPaths: string[] = [];
  const workspaceEntries = await readdir(projectsRoot, { withFileTypes: true });
  workspaceEntries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of workspaceEntries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory()) continue;

    const workspaceDir = join(projectsRoot, entry.name);
    await collectTranscriptFiles(workspaceDir, discoveredPaths);
  }

  return discoveredPaths.sort((left, right) => left.localeCompare(right));
}

async function collectTranscriptFiles(
  directoryPath: string,
  discoveredPaths: string[],
): Promise<void> {
  const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
  directoryEntries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of directoryEntries) {
    if (entry.isSymbolicLink()) continue;
    if (!entry.isFile()) continue;

    const extension = extname(entry.name).toLowerCase();
    if (
      !claudeCodeTranscriptExtensions.includes(
        extension as (typeof claudeCodeTranscriptExtensions)[number],
      )
    ) {
      continue;
    }

    const entryPath = join(directoryPath, entry.name);
    const fileStats = await lstat(entryPath);
    if (fileStats.isFile()) {
      discoveredPaths.push(entryPath);
    }
  }
}

function normalizeTranscriptFormat(_filePath: string): ClaudeCodeTranscriptFormat {
  return "jsonl";
}
