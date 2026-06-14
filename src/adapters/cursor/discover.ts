import { lstat, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { pathExists } from "../_common/fs.js";
import { hashFileContents } from "../_common/hash.js";
import { type CursorWorkspaceMapping, deriveCursorWorkspaceMapping } from "./workspace-map.js";

export const cursorTranscriptExtensions = [".jsonl", ".txt"] as const;

export type CursorTranscriptFormat = "jsonl" | "txt";

export type CursorTranscriptDiscovery = CursorWorkspaceMapping & {
  modifiedAt: string;
  sizeBytes: number;
  sourceFormat: CursorTranscriptFormat;
  sourceHash: string;
  sourcePath: string;
};

export type CursorSupportDatabaseKind = "global-state" | "tracking";

export type CursorSupportDatabaseDiscovery = {
  kind: CursorSupportDatabaseKind;
  path: string;
};

export type CursorDiscoveryResult = {
  supportDatabases: readonly CursorSupportDatabaseDiscovery[];
  transcripts: readonly CursorTranscriptDiscovery[];
};

export type DiscoverCursorInputsOptions = {
  cursorProjectsRoot?: string;
  cursorUserStateRoot?: string;
  homeDir?: string;
};

export async function discoverCursorInputs(
  options: DiscoverCursorInputsOptions = {},
): Promise<CursorDiscoveryResult> {
  const homeDir = resolve(options.homeDir ?? homedir());
  const cursorProjectsRoot = resolve(
    options.cursorProjectsRoot ?? join(homeDir, ".cursor", "projects"),
  );
  const cursorUserStateRoot = resolve(
    options.cursorUserStateRoot ??
      join(homeDir, "Library", "Application Support", "Cursor", "User"),
  );
  const transcriptPaths = await discoverTranscriptPaths(cursorProjectsRoot);
  const transcripts = await Promise.all(
    transcriptPaths.map(async (transcriptPath) => {
      const [metadata, sourceHash, workspaceMapping] = await Promise.all([
        stat(transcriptPath),
        hashFileContents(transcriptPath),
        deriveCursorWorkspaceMapping(transcriptPath, { cursorProjectsRoot }),
      ]);

      return {
        ...workspaceMapping,
        modifiedAt: metadata.mtime.toISOString(),
        sizeBytes: metadata.size,
        sourceFormat: normalizeTranscriptFormat(transcriptPath),
        sourceHash,
        sourcePath: transcriptPath,
      };
    }),
  );
  const supportDatabases = await discoverSupportDatabases(cursorUserStateRoot);

  return {
    supportDatabases,
    transcripts,
  };
}

async function discoverTranscriptPaths(cursorProjectsRoot: string): Promise<string[]> {
  if (!(await pathExists(cursorProjectsRoot))) {
    return [];
  }

  const discoveredPaths: string[] = [];
  await walkCursorProjects(cursorProjectsRoot, discoveredPaths);
  return discoveredPaths.sort((left, right) => left.localeCompare(right));
}

async function walkCursorProjects(directoryPath: string, discoveredPaths: string[]): Promise<void> {
  const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
  directoryEntries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of directoryEntries) {
    const entryPath = join(directoryPath, entry.name);

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      if (entry.name === "agent-transcripts") {
        await collectTranscriptFiles(entryPath, discoveredPaths);
      } else {
        await walkCursorProjects(entryPath, discoveredPaths);
      }
    }
  }
}

async function collectTranscriptFiles(
  directoryPath: string,
  discoveredPaths: string[],
): Promise<void> {
  const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
  directoryEntries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of directoryEntries) {
    const entryPath = join(directoryPath, entry.name);

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      await collectTranscriptFiles(entryPath, discoveredPaths);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const extension = extname(entry.name).toLowerCase();

    if (
      !cursorTranscriptExtensions.includes(extension as (typeof cursorTranscriptExtensions)[number])
    ) {
      continue;
    }

    const fileStats = await lstat(entryPath);

    if (fileStats.isFile()) {
      discoveredPaths.push(entryPath);
    }
  }
}

async function discoverSupportDatabases(
  cursorUserStateRoot: string,
): Promise<CursorSupportDatabaseDiscovery[]> {
  const discoveries: CursorSupportDatabaseDiscovery[] = [];
  const globalStatePath = join(cursorUserStateRoot, "globalStorage", "state.vscdb");

  if (await pathExists(globalStatePath)) {
    discoveries.push({
      kind: "global-state",
      path: globalStatePath,
    });
  }

  const workspaceStorageRoot = join(cursorUserStateRoot, "workspaceStorage");

  if (!(await pathExists(workspaceStorageRoot))) {
    return discoveries;
  }

  const workspaceEntries = await readdir(workspaceStorageRoot, { withFileTypes: true });
  workspaceEntries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of workspaceEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }

    const trackingDatabasePath = join(workspaceStorageRoot, entry.name, "state.vscdb");

    if (await pathExists(trackingDatabasePath)) {
      discoveries.push({
        kind: "tracking",
        path: trackingDatabasePath,
      });
    }
  }

  return discoveries;
}

function normalizeTranscriptFormat(filePath: string): CursorTranscriptFormat {
  const extension = extname(filePath).toLowerCase();

  if (extension === ".jsonl") {
    return "jsonl";
  }

  return "txt";
}
