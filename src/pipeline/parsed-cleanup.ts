import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { access, link, lstat, mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { getRuntimePath } from "../config/paths.js";
import {
  type ParsedIntermediateCleanupCandidate,
  revalidateParsedIntermediateCleanupCandidate,
  revalidateParsedIntermediateCleanupCandidateRetention,
} from "../read/lifecycle-inventory.js";
import {
  getParsedStagingArtifactPath,
  getStagingQuarantineRoot,
  getStagingRoot,
  requireStagingRoot,
} from "../storage/staging.js";

const parsedCleanupQuarantineDirectoryName = "parsed-cleanup-quarantine";

export type ParsedIntermediateCleanupQuarantine = {
  legacy_quarantine_path?: string;
  original_path: string;
  quarantine_path: string;
  quarantine_directory_device?: number;
  quarantine_directory_inode?: number;
};

export type ParsedIntermediateCleanupResult = {
  candidates: ParsedIntermediateCleanupCandidate[];
  deleted: ParsedIntermediateCleanupCandidate[];
  quarantines: ParsedIntermediateCleanupQuarantine[];
  skipped: string[];
};

export type ParsedIntermediateCleanupFileSystem = {
  access: typeof access;
  link?: typeof link;
  lstat?: typeof lstat;
  onQuarantineLookup?: (originalPath: string) => Promise<void> | void;
  open?: typeof open;
  realpath?: typeof realpath;
  rename: typeof rename;
  stat: typeof stat;
  unlink: typeof unlink;
};

type ResolvedParsedIntermediateCleanupFileSystem = {
  access: typeof access;
  lstat: typeof lstat;
  onQuarantineLookup?: (originalPath: string) => Promise<void> | void;
  open: typeof open;
  realpath: typeof realpath;
  rename: typeof rename;
  stat: typeof stat;
  unlink: typeof unlink;
  usesNativeLstat: boolean;
  usesNativeRename: boolean;
  usesNativeUnlink: boolean;
};

type TrustedQuarantineDirectory = {
  device: number;
  handle: FileHandle;
  helper?: DescriptorHelperClient;
  inode: number;
  path: string;
};

type CleanupFileMetadata = Awaited<ReturnType<typeof lstat>> & {
  mtimeNs?: bigint;
};

type SourceDirectoryIdentity = {
  device: number;
  inode: number;
};

type DescriptorHelperClient = {
  child: ReturnType<typeof spawn>;
  closed: boolean;
  failure?: Error;
  pending: Array<{
    reject: (error: Error) => void;
    resolve: (value: unknown) => void;
  }>;
  stderr: string;
  stdoutBuffer: string;
};

const descriptorHelperPath = fileURLToPath(
  new URL("../../scripts/parsed-cleanup-fs.py", import.meta.url),
);

export class ParsedIntermediateCleanupError extends Error {
  readonly result: ParsedIntermediateCleanupResult;

  constructor(cause: unknown, result: ParsedIntermediateCleanupResult) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ParsedIntermediateCleanupError";
    this.result = result;
  }
}

/**
 * Apply one immutable, preselected candidate snapshot. Each exact path is revalidated
 * directly; this function never performs another runtime inventory walk.
 */
export async function applyParsedIntermediateCleanup(
  database: DatabaseSync,
  snapshot: readonly ParsedIntermediateCleanupCandidate[],
  fileSystem: ParsedIntermediateCleanupFileSystem = {
    access,
    link,
    lstat,
    open,
    realpath,
    rename,
    stat,
    unlink,
  },
  plannedQuarantines: readonly ParsedIntermediateCleanupQuarantine[] = [],
): Promise<ParsedIntermediateCleanupResult> {
  const resolvedFileSystem = resolveCleanupFileSystem(fileSystem);
  const candidates = snapshot.map((candidate) => ({ ...candidate }));
  const deleted: ParsedIntermediateCleanupCandidate[] = [];
  let quarantines = new Map<string, ParsedIntermediateCleanupQuarantine>();
  const skipped: string[] = [];
  const recoveredDeletedPaths = new Set<string>();
  let trustedDirectory: TrustedQuarantineDirectory | undefined;

  try {
    quarantines = indexQuarantines(plannedQuarantines);
    if (quarantines.size > 0) {
      trustedDirectory = await openTrustedQuarantineDirectory(
        resolvedFileSystem,
        true,
        requireSingleQuarantineRoot([...quarantines.values()]),
      );
      for (const mapping of quarantines.values()) {
        assertMappingQuarantineDirectoryIdentity(mapping, trustedDirectory);
        mapping.quarantine_directory_device = trustedDirectory.device;
        mapping.quarantine_directory_inode = trustedDirectory.inode;
      }
    }
    await recoverPendingQuarantines(
      database,
      candidates,
      quarantines,
      resolvedFileSystem,
      trustedDirectory,
      deleted,
      recoveredDeletedPaths,
    );

    for (const candidate of candidates) {
      if (recoveredDeletedPaths.has(candidate.path)) {
        continue;
      }
      const current = await revalidateParsedIntermediateCleanupCandidate(
        database,
        candidate,
        resolvedFileSystem,
      );
      if (current === undefined) {
        skipped.push(candidate.path);
        quarantines.delete(candidate.path);
        continue;
      }

      const mapping = quarantines.get(current.path);
      if (mapping === undefined) {
        throw new Error(`missing planned quarantine mapping for ${current.path}`);
      }
      if (trustedDirectory === undefined) {
        throw new Error(`missing trusted quarantine directory for ${current.path}`);
      }
      await assertTrustedQuarantinePath(mapping, resolvedFileSystem, trustedDirectory);
      const sourceDirectoryMetadata = await assertSafeSessionDirectory(
        current.path,
        current.session_id,
        resolvedFileSystem,
      );
      await resolvedFileSystem.onQuarantineLookup?.(current.path);
      try {
        await renameIntoTrustedQuarantine(
          current.path,
          current,
          mapping,
          resolvedFileSystem,
          trustedDirectory,
          {
            device: Number(sourceDirectoryMetadata.dev),
            inode: Number(sourceDirectoryMetadata.ino),
          },
        );
      } catch (error) {
        if (isMissingPathError(error)) {
          skipped.push(candidate.path);
          quarantines.delete(mapping.original_path);
          continue;
        }
        throw error;
      }

      const metadata = await assertAnchoredCleanupPath(
        mapping,
        current.session_id,
        resolvedFileSystem,
        trustedDirectory,
      );
      if (!sameFileIdentity(current, metadata)) {
        throw new Error(`quarantined file identity changed for ${mapping.original_path}`);
      }

      await assertSafeSessionDirectory(
        mapping.original_path,
        current.session_id,
        resolvedFileSystem,
      );
      await assertTrustedQuarantinePath(mapping, resolvedFileSystem, trustedDirectory);
      await unlinkTrustedQuarantine(mapping, resolvedFileSystem, trustedDirectory);
      quarantines.delete(mapping.original_path);
      deleted.push(current);
    }
  } catch (error) {
    throw new ParsedIntermediateCleanupError(error, {
      candidates,
      deleted,
      quarantines: [...quarantines.values()],
      skipped,
    });
  } finally {
    if (trustedDirectory !== undefined) {
      await closeTrustedQuarantineDirectory(trustedDirectory).catch(() => undefined);
    }
  }

  if (quarantines.size > 0) {
    throw new ParsedIntermediateCleanupError(
      new Error("parsed cleanup completed with unresolved quarantine mappings"),
      { candidates, deleted, quarantines: [...quarantines.values()], skipped },
    );
  }

  return { candidates, deleted, quarantines: [], skipped };
}

async function recoverPendingQuarantines(
  database: DatabaseSync,
  candidates: readonly ParsedIntermediateCleanupCandidate[],
  quarantines: Map<string, ParsedIntermediateCleanupQuarantine>,
  fileSystem: ResolvedParsedIntermediateCleanupFileSystem,
  trustedDirectory: TrustedQuarantineDirectory | undefined,
  deleted: ParsedIntermediateCleanupCandidate[],
  recoveredDeletedPaths: Set<string>,
): Promise<void> {
  const candidatesByPath = new Map(candidates.map((candidate) => [candidate.path, candidate]));
  for (const mapping of quarantines.values()) {
    const candidate = candidatesByPath.get(mapping.original_path);
    if (
      candidate === undefined ||
      trustedDirectory === undefined ||
      !isCleanupOwnedQuarantine(mapping.quarantine_path)
    ) {
      throw new Error(`unrecognized parsed cleanup quarantine mapping: ${mapping.quarantine_path}`);
    }

    await migrateLegacyQuarantineIfNeeded(
      database,
      candidate,
      mapping,
      fileSystem,
      trustedDirectory,
    );
    await assertTrustedQuarantinePath(mapping, fileSystem, trustedDirectory);
    const quarantineMetadata = await lstatTrustedQuarantineIfPresent(
      mapping,
      fileSystem,
      trustedDirectory,
    );
    if (quarantineMetadata === undefined) {
      // This is either a newly planned mapping or an already-completed mutation.
      // Candidate revalidation below distinguishes those states without widening discovery.
      continue;
    }
    if (quarantineMetadata.isSymbolicLink() || !quarantineMetadata.isFile()) {
      throw new Error(`unsafe parsed cleanup path: ${mapping.quarantine_path}`);
    }

    await assertTrustedQuarantinePath(mapping, fileSystem, trustedDirectory);
    await assertSafeSessionDirectory(mapping.original_path, candidate.session_id, fileSystem);
    const originalMetadata = await lstatIfPresent(mapping.original_path, fileSystem);
    if (originalMetadata !== undefined) {
      if (!sameFileSystemIdentity(originalMetadata, quarantineMetadata)) {
        throw new Error(`quarantine recovery conflict for ${mapping.original_path}`);
      }
      await assertTrustedQuarantinePath(mapping, fileSystem, trustedDirectory);
      await unlinkTrustedQuarantine(mapping, fileSystem, trustedDirectory);
      continue;
    }

    if (
      !sameFileIdentity(candidate, quarantineMetadata) ||
      !(await revalidateParsedIntermediateCleanupCandidateRetention(
        database,
        candidate,
        fileSystem,
      ))
    ) {
      throw new Error(`quarantine recovery conflict for ${mapping.original_path}`);
    }
    await assertSafeSessionDirectory(mapping.original_path, candidate.session_id, fileSystem);
    await assertTrustedQuarantinePath(mapping, fileSystem, trustedDirectory);
    await unlinkTrustedQuarantine(mapping, fileSystem, trustedDirectory);
    quarantines.delete(mapping.original_path);
    deleted.push(candidate);
    recoveredDeletedPaths.add(candidate.path);
  }
}

async function migrateLegacyQuarantineIfNeeded(
  database: DatabaseSync,
  candidate: ParsedIntermediateCleanupCandidate,
  mapping: ParsedIntermediateCleanupQuarantine,
  fileSystem: ResolvedParsedIntermediateCleanupFileSystem,
  trustedDirectory: TrustedQuarantineDirectory,
): Promise<void> {
  const legacyPath = mapping.legacy_quarantine_path;
  if (legacyPath === undefined) {
    return;
  }
  if (!isLegacyCleanupOwnedQuarantine(mapping.original_path, legacyPath)) {
    throw new Error(`unrecognized legacy parsed cleanup quarantine mapping: ${legacyPath}`);
  }

  await assertTrustedQuarantinePath(mapping, fileSystem, trustedDirectory);
  const [centralMetadata, legacyMetadata] = await Promise.all([
    lstatTrustedQuarantineIfPresent(mapping, fileSystem, trustedDirectory),
    lstatIfPresent(legacyPath, fileSystem),
  ]);
  if (centralMetadata !== undefined && legacyMetadata !== undefined) {
    throw new Error(`ambiguous legacy quarantine migration for ${mapping.original_path}`);
  }
  if (centralMetadata !== undefined) {
    if (centralMetadata.isSymbolicLink() || !sameFileIdentity(candidate, centralMetadata)) {
      throw new Error(`legacy quarantine migration conflict for ${mapping.original_path}`);
    }
    delete mapping.legacy_quarantine_path;
    return;
  }
  if (
    legacyMetadata === undefined ||
    legacyMetadata.isSymbolicLink() ||
    !legacyMetadata.isFile() ||
    !sameFileIdentity(candidate, legacyMetadata)
  ) {
    throw new Error(`legacy quarantine migration conflict for ${mapping.original_path}`);
  }

  const sourceDirectoryMetadata = await assertSafeSessionDirectory(
    mapping.original_path,
    candidate.session_id,
    fileSystem,
  );
  const originalMetadata = await lstatIfPresent(mapping.original_path, fileSystem);
  if (originalMetadata !== undefined && !sameFileSystemIdentity(originalMetadata, legacyMetadata)) {
    throw new Error(`legacy quarantine migration conflict for ${mapping.original_path}`);
  }
  if (
    !(await revalidateParsedIntermediateCleanupCandidateRetention(database, candidate, fileSystem))
  ) {
    throw new Error(`legacy quarantine migration conflict for ${mapping.original_path}`);
  }

  await assertTrustedQuarantinePath(mapping, fileSystem, trustedDirectory);
  await renameIntoTrustedQuarantine(legacyPath, candidate, mapping, fileSystem, trustedDirectory, {
    device: Number(sourceDirectoryMetadata.dev),
    inode: Number(sourceDirectoryMetadata.ino),
  });
  const migratedMetadata = await lstatTrustedQuarantine(mapping, fileSystem, trustedDirectory);
  await assertTrustedQuarantinePath(mapping, fileSystem, trustedDirectory);
  await assertSafeSessionDirectory(mapping.original_path, candidate.session_id, fileSystem);
  if (!sameFileIdentity(candidate, migratedMetadata)) {
    throw new Error(`legacy quarantine migration conflict for ${mapping.original_path}`);
  }
  delete mapping.legacy_quarantine_path;
}

export function planParsedIntermediateCleanupQuarantines(
  candidates: readonly ParsedIntermediateCleanupCandidate[],
  pendingQuarantines: readonly ParsedIntermediateCleanupQuarantine[] = [],
  quarantineRoot = getParsedCleanupQuarantineRoot(),
): ParsedIntermediateCleanupQuarantine[] {
  const planned = pendingQuarantines.map((mapping) => ({ ...mapping }));
  const mappedOriginals = new Set(planned.map((mapping) => mapping.original_path));
  for (const candidate of candidates) {
    if (mappedOriginals.has(candidate.path)) {
      continue;
    }
    planned.push({
      original_path: candidate.path,
      quarantine_path: join(quarantineRoot, `${randomUUID()}.quarantine`),
    });
    mappedOriginals.add(candidate.path);
  }
  return planned;
}

export async function prepareParsedIntermediateCleanupQuarantines(
  mappings: readonly ParsedIntermediateCleanupQuarantine[],
  fileSystem: ParsedIntermediateCleanupFileSystem = {
    access,
    link,
    lstat,
    open,
    realpath,
    rename,
    stat,
    unlink,
  },
): Promise<ParsedIntermediateCleanupQuarantine[]> {
  if (mappings.length === 0) {
    return [];
  }
  const resolvedFileSystem = resolveCleanupFileSystem(fileSystem);
  const trustedDirectory = await openTrustedQuarantineDirectory(
    resolvedFileSystem,
    false,
    requireSingleQuarantineRoot(mappings),
  );
  try {
    return mappings.map((mapping) => {
      if (!isCleanupOwnedQuarantine(mapping.quarantine_path)) {
        throw new Error(
          `unrecognized parsed cleanup quarantine mapping: ${mapping.quarantine_path}`,
        );
      }
      assertMappingQuarantineDirectoryIdentity(mapping, trustedDirectory);
      return {
        ...mapping,
        quarantine_directory_device: trustedDirectory.device,
        quarantine_directory_inode: trustedDirectory.inode,
      };
    });
  } finally {
    await closeTrustedQuarantineDirectory(trustedDirectory);
  }
}

async function assertAnchoredCleanupPath(
  mapping: ParsedIntermediateCleanupQuarantine,
  sessionId: string,
  fileSystem: ResolvedParsedIntermediateCleanupFileSystem,
  trustedDirectory: TrustedQuarantineDirectory,
): Promise<CleanupFileMetadata> {
  try {
    await assertTrustedQuarantinePath(mapping, fileSystem, trustedDirectory);
    const metadata = await lstatTrustedQuarantine(mapping, fileSystem, trustedDirectory);
    await assertSafeSessionDirectory(mapping.original_path, sessionId, fileSystem);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`unsafe parsed cleanup path: ${mapping.quarantine_path}`);
    }
    return metadata;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("unsafe parsed cleanup path:")) {
      throw error;
    }
    throw new Error(`unsafe parsed cleanup path: ${mapping.quarantine_path}`, { cause: error });
  }
}

async function assertSafeSessionDirectory(
  originalPath: string,
  sessionId: string,
  fileSystem: ResolvedParsedIntermediateCleanupFileSystem,
): Promise<Awaited<ReturnType<typeof lstat>>> {
  const stagingRoot = getStagingRoot();
  const sessionDirectory = join(stagingRoot, sessionId);
  if (originalPath !== getParsedStagingArtifactPath(sessionId)) {
    throw new Error(`unsafe parsed cleanup path: ${originalPath}`);
  }
  const [sessionMetadata, resolvedStagingRoot, resolvedSessionDirectory] = await Promise.all([
    fileSystem.lstat(sessionDirectory),
    fileSystem.realpath(stagingRoot),
    fileSystem.realpath(sessionDirectory),
  ]);
  if (
    sessionMetadata.isSymbolicLink() ||
    !sessionMetadata.isDirectory() ||
    relative(resolvedStagingRoot, resolvedSessionDirectory) !== sessionId
  ) {
    throw new Error(`unsafe parsed cleanup path: ${originalPath}`);
  }
  return sessionMetadata;
}

async function assertTrustedQuarantinePath(
  mapping: ParsedIntermediateCleanupQuarantine,
  fileSystem: ResolvedParsedIntermediateCleanupFileSystem,
  trustedDirectory: TrustedQuarantineDirectory,
): Promise<void> {
  if (!isCleanupOwnedQuarantine(mapping.quarantine_path)) {
    throw new Error(`unrecognized parsed cleanup quarantine mapping: ${mapping.quarantine_path}`);
  }
  assertMappingQuarantineDirectoryIdentity(mapping, trustedDirectory);
  await verifyTrustedQuarantineDirectory(fileSystem, trustedDirectory);
}

async function openTrustedQuarantineDirectory(
  fileSystem: ResolvedParsedIntermediateCleanupFileSystem,
  startHelper = true,
  quarantineRoot = getParsedCleanupQuarantineRoot(),
): Promise<TrustedQuarantineDirectory> {
  const quarantineParent = getAllowedQuarantineParent(quarantineRoot);
  if (quarantineParent === undefined) {
    throw new Error(`unsafe parsed cleanup quarantine directory: ${quarantineRoot}`);
  }
  await mkdir(quarantineRoot, { recursive: true });
  const [parentMetadata, quarantineMetadata, resolvedParent, resolvedQuarantineRoot] =
    await Promise.all([
      fileSystem.lstat(quarantineParent),
      fileSystem.lstat(quarantineRoot),
      fileSystem.realpath(quarantineParent),
      fileSystem.realpath(quarantineRoot),
    ]);
  if (
    parentMetadata.isSymbolicLink() ||
    !parentMetadata.isDirectory() ||
    quarantineMetadata.isSymbolicLink() ||
    !quarantineMetadata.isDirectory() ||
    relative(resolvedParent, resolvedQuarantineRoot) !== basename(quarantineRoot)
  ) {
    throw new Error(`unsafe parsed cleanup quarantine directory: ${quarantineRoot}`);
  }
  const handle = await fileSystem.open(
    quarantineRoot,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const handleMetadata = await handle.stat();
    if (
      Number(handleMetadata.dev) !== Number(quarantineMetadata.dev) ||
      Number(handleMetadata.ino) !== Number(quarantineMetadata.ino)
    ) {
      throw new Error(`unsafe parsed cleanup quarantine directory: ${quarantineRoot}`);
    }
    const trustedDirectory: TrustedQuarantineDirectory = {
      device: Number(handleMetadata.dev),
      handle,
      inode: Number(handleMetadata.ino),
      path: quarantineRoot,
    };
    await verifyTrustedQuarantineDirectory(fileSystem, trustedDirectory);
    if (startHelper) {
      trustedDirectory.helper = startDescriptorHelper(trustedDirectory);
    }
    return trustedDirectory;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function verifyTrustedQuarantineDirectory(
  fileSystem: ResolvedParsedIntermediateCleanupFileSystem,
  trustedDirectory: TrustedQuarantineDirectory,
): Promise<void> {
  const quarantineParent = getAllowedQuarantineParent(trustedDirectory.path);
  if (quarantineParent === undefined) {
    throw new Error(`unsafe parsed cleanup quarantine directory: ${trustedDirectory.path}`);
  }
  const [handleMetadata, quarantineMetadata, resolvedParent, resolvedQuarantineRoot] =
    await Promise.all([
      trustedDirectory.handle.stat(),
      fileSystem.lstat(trustedDirectory.path),
      fileSystem.realpath(quarantineParent),
      fileSystem.realpath(trustedDirectory.path),
    ]);
  if (
    Number(handleMetadata.dev) !== trustedDirectory.device ||
    Number(handleMetadata.ino) !== trustedDirectory.inode ||
    quarantineMetadata.isSymbolicLink() ||
    !quarantineMetadata.isDirectory() ||
    Number(quarantineMetadata.dev) !== trustedDirectory.device ||
    Number(quarantineMetadata.ino) !== trustedDirectory.inode ||
    relative(resolvedParent, resolvedQuarantineRoot) !== basename(trustedDirectory.path)
  ) {
    throw new Error(`unsafe parsed cleanup quarantine directory: ${trustedDirectory.path}`);
  }
}

function assertMappingQuarantineDirectoryIdentity(
  mapping: ParsedIntermediateCleanupQuarantine,
  trustedDirectory: TrustedQuarantineDirectory,
): void {
  if (
    (mapping.quarantine_directory_device !== undefined &&
      mapping.quarantine_directory_device !== trustedDirectory.device) ||
    (mapping.quarantine_directory_inode !== undefined &&
      mapping.quarantine_directory_inode !== trustedDirectory.inode)
  ) {
    throw new Error(`quarantine directory identity conflict for ${mapping.original_path}`);
  }
}

async function renameIntoTrustedQuarantine(
  sourcePath: string,
  candidate: ParsedIntermediateCleanupCandidate,
  mapping: ParsedIntermediateCleanupQuarantine,
  fileSystem: ResolvedParsedIntermediateCleanupFileSystem,
  trustedDirectory: TrustedQuarantineDirectory,
  sourceDirectoryIdentity: SourceDirectoryIdentity,
): Promise<void> {
  if (!fileSystem.usesNativeRename) {
    await fileSystem.rename(sourcePath, mapping.quarantine_path);
    return;
  }
  await runDescriptorHelper("rename-into", basename(mapping.quarantine_path), trustedDirectory, {
    source_device: candidate.device,
    source_directory: dirname(sourcePath),
    source_directory_device: sourceDirectoryIdentity.device,
    source_directory_inode: sourceDirectoryIdentity.inode,
    source_inode: candidate.inode,
    ...(candidate.modified_at_nanoseconds === undefined
      ? {}
      : { source_modified_at_nanoseconds: candidate.modified_at_nanoseconds }),
    source_name: basename(sourcePath),
    source_size: candidate.bytes,
  });
}

async function unlinkTrustedQuarantine(
  mapping: ParsedIntermediateCleanupQuarantine,
  fileSystem: ResolvedParsedIntermediateCleanupFileSystem,
  trustedDirectory: TrustedQuarantineDirectory,
): Promise<void> {
  if (!fileSystem.usesNativeUnlink) {
    await fileSystem.unlink(mapping.quarantine_path);
    return;
  }
  await runDescriptorHelper("unlink", basename(mapping.quarantine_path), trustedDirectory);
}

async function lstatTrustedQuarantine(
  mapping: ParsedIntermediateCleanupQuarantine,
  fileSystem: ResolvedParsedIntermediateCleanupFileSystem,
  trustedDirectory: TrustedQuarantineDirectory,
): Promise<CleanupFileMetadata> {
  if (!fileSystem.usesNativeLstat) {
    return fileSystem.lstat(mapping.quarantine_path);
  }
  const value = (await runDescriptorHelper(
    "stat",
    basename(mapping.quarantine_path),
    trustedDirectory,
  )) as {
    device: number;
    inode: number;
    is_file: boolean;
    is_symbolic_link: boolean;
    modified_at: string;
    modified_at_nanoseconds: string;
    size: number;
  };
  return {
    dev: value.device,
    ino: value.inode,
    isFile: () => value.is_file,
    isSymbolicLink: () => value.is_symbolic_link,
    mtime: new Date(value.modified_at),
    mtimeNs: BigInt(value.modified_at_nanoseconds),
    size: value.size,
  } as CleanupFileMetadata;
}

async function lstatTrustedQuarantineIfPresent(
  mapping: ParsedIntermediateCleanupQuarantine,
  fileSystem: ResolvedParsedIntermediateCleanupFileSystem,
  trustedDirectory: TrustedQuarantineDirectory,
): Promise<CleanupFileMetadata | undefined> {
  try {
    return await lstatTrustedQuarantine(mapping, fileSystem, trustedDirectory);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function runDescriptorHelper(
  operation: "rename-into" | "stat" | "unlink",
  name: string,
  trustedDirectory: TrustedQuarantineDirectory,
  extraArgument?: Record<string, unknown>,
): Promise<unknown> {
  const helper = trustedDirectory.helper;
  if (helper === undefined || helper.child.stdin === null) {
    throw new Error("parsed cleanup descriptor helper is unavailable");
  }
  if (helper.failure !== undefined) {
    throw helper.failure;
  }
  return new Promise<unknown>((resolve, reject) => {
    helper.pending.push({ reject, resolve });
    helper.child.stdin?.write(
      `${JSON.stringify({
        ...(extraArgument === undefined ? {} : { extra: extraArgument }),
        name,
        operation,
      })}\n`,
      "utf8",
      (error) => {
        if (error !== null && error !== undefined) {
          const pending = helper.pending.pop();
          pending?.reject(helper.failure ?? error);
        }
      },
    );
  });
}

function startDescriptorHelper(
  trustedDirectory: Omit<TrustedQuarantineDirectory, "helper">,
): DescriptorHelperClient {
  const python = process.env.ASD_PYTHON ?? process.env.PYTHON ?? "python3";
  const child = spawn(python, [descriptorHelperPath, "serve"], {
    stdio: ["pipe", "pipe", "pipe", trustedDirectory.handle.fd],
  });
  if (child.stdin === null || child.stdout === null || child.stderr === null) {
    throw new Error("parsed cleanup descriptor helper did not create output pipes");
  }
  const helper: DescriptorHelperClient = {
    child,
    closed: false,
    pending: [],
    stderr: "",
    stdoutBuffer: "",
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    helper.stdoutBuffer += chunk;
    let newline = helper.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = helper.stdoutBuffer.slice(0, newline);
      helper.stdoutBuffer = helper.stdoutBuffer.slice(newline + 1);
      const pending = helper.pending.shift();
      if (pending !== undefined) {
        try {
          const response = JSON.parse(line) as {
            error?: { code?: string; message?: string };
            ok: boolean;
            result?: unknown;
          };
          if (response.ok) {
            pending.resolve(response.result);
          } else {
            const error = new Error(
              response.error?.message ?? "parsed cleanup descriptor helper failed",
            ) as NodeJS.ErrnoException;
            if (response.error?.code !== undefined) {
              error.code = response.error.code;
            }
            pending.reject(error);
          }
        } catch (error) {
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
      newline = helper.stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: string) => {
    helper.stderr = `${helper.stderr}${chunk}`.slice(-65_536);
  });
  const rejectPending = (error: Error) => {
    for (const pending of helper.pending.splice(0)) {
      pending.reject(error);
    }
  };
  child.once("error", (error) => {
    const helperError = new Error(
      `parsed cleanup descriptor helper unavailable: ${error.message}`,
      {
        cause: error,
      },
    );
    helper.failure = helperError;
    rejectPending(helperError);
  });
  child.once("close", (code) => {
    helper.closed = true;
    if (helper.pending.length > 0) {
      rejectPending(
        new Error(helper.stderr.trim() || `parsed cleanup descriptor helper exited ${code ?? 1}`),
      );
    }
  });
  return helper;
}

async function closeTrustedQuarantineDirectory(
  trustedDirectory: TrustedQuarantineDirectory,
): Promise<void> {
  const helper = trustedDirectory.helper;
  if (
    helper !== undefined &&
    !helper.closed &&
    helper.child.stdin !== null &&
    helper.child.exitCode === null
  ) {
    const closed = new Promise<void>((resolve) => helper.child.once("close", () => resolve()));
    helper.child.stdin.end();
    await closed;
  }
  await trustedDirectory.handle.close();
}

function indexQuarantines(
  plannedQuarantines: readonly ParsedIntermediateCleanupQuarantine[],
): Map<string, ParsedIntermediateCleanupQuarantine> {
  const indexed = new Map<string, ParsedIntermediateCleanupQuarantine>();
  for (const mapping of plannedQuarantines) {
    if (indexed.has(mapping.original_path)) {
      throw new Error(`expected one planned quarantine mapping for ${mapping.original_path}`);
    }
    indexed.set(mapping.original_path, { ...mapping });
  }
  return indexed;
}

function getParsedCleanupQuarantineRoot(): string {
  return join(getRuntimePath("deletes"), parsedCleanupQuarantineDirectoryName);
}

function isCleanupOwnedQuarantine(quarantinePath: string): boolean {
  const quarantineRoot = getQuarantineRootForPath(quarantinePath);
  if (quarantineRoot === undefined) {
    return false;
  }
  const segments = relative(quarantineRoot, quarantinePath).split(sep);
  if (segments.length !== 1) {
    return false;
  }
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.quarantine$/i.test(
    segments[0] ?? "",
  );
}

export async function selectParsedCleanupQuarantineRoot(
  fileSystem: ParsedIntermediateCleanupFileSystem = {
    access,
    link,
    lstat,
    open,
    realpath,
    rename,
    stat,
    unlink,
  },
): Promise<string> {
  const stagingRoot = await requireStagingRoot("write");
  const deletesRoot = getRuntimePath("deletes");
  await mkdir(deletesRoot, { recursive: true });
  const [stagingMetadata, deletesMetadata] = await Promise.all([
    fileSystem.stat(stagingRoot),
    fileSystem.stat(deletesRoot),
  ]);
  return Number(stagingMetadata.dev) === Number(deletesMetadata.dev)
    ? getParsedCleanupQuarantineRoot()
    : getStagingQuarantineRoot();
}

function requireSingleQuarantineRoot(
  mappings: readonly ParsedIntermediateCleanupQuarantine[],
): string {
  const roots = new Set(mappings.map((mapping) => dirname(mapping.quarantine_path)));
  if (roots.size !== 1) {
    throw new Error("parsed cleanup mappings must use one quarantine root");
  }
  const root = [...roots][0];
  if (root === undefined || getAllowedQuarantineParent(root) === undefined) {
    throw new Error(`unrecognized parsed cleanup quarantine mapping: ${root ?? ""}`);
  }
  return root;
}

function getAllowedQuarantineParent(quarantineRoot: string): string | undefined {
  if (quarantineRoot === getParsedCleanupQuarantineRoot()) {
    return getRuntimePath("deletes");
  }
  if (quarantineRoot === getStagingQuarantineRoot()) {
    return getStagingRoot();
  }
  return undefined;
}

function getQuarantineRootForPath(quarantinePath: string): string | undefined {
  const root = dirname(quarantinePath);
  return getAllowedQuarantineParent(root) === undefined ? undefined : root;
}

function isLegacyCleanupOwnedQuarantine(originalPath: string, quarantinePath: string): boolean {
  const prefix = `${originalPath}.marrow-cleanup-`;
  const ending = ".quarantine";
  if (!quarantinePath.startsWith(prefix) || !quarantinePath.endsWith(ending)) {
    return false;
  }
  const id = quarantinePath.slice(prefix.length, -ending.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

async function lstatIfPresent(
  path: string,
  fileSystem: ResolvedParsedIntermediateCleanupFileSystem,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await fileSystem.lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

function sameFileIdentity(
  candidate: ParsedIntermediateCleanupCandidate,
  metadata: CleanupFileMetadata,
): boolean {
  const timestampMatches =
    candidate.modified_at_nanoseconds === undefined
      ? true
      : metadata.mtimeNs === undefined
        ? candidate.modified_at === metadata.mtime.toISOString()
        : candidate.modified_at_nanoseconds === metadata.mtimeNs.toString();
  return (
    candidate.bytes === metadata.size &&
    candidate.device === metadata.dev &&
    candidate.inode === metadata.ino &&
    timestampMatches
  );
}

function sameFileSystemIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function resolveCleanupFileSystem(
  fileSystem: ParsedIntermediateCleanupFileSystem,
): ResolvedParsedIntermediateCleanupFileSystem {
  return {
    access: fileSystem.access,
    lstat: fileSystem.lstat ?? lstat,
    ...(fileSystem.onQuarantineLookup === undefined
      ? {}
      : { onQuarantineLookup: fileSystem.onQuarantineLookup }),
    open: fileSystem.open ?? open,
    realpath: fileSystem.realpath ?? realpath,
    rename: fileSystem.rename,
    stat: fileSystem.stat,
    unlink: fileSystem.unlink,
    usesNativeLstat: fileSystem.lstat === undefined || fileSystem.lstat === lstat,
    usesNativeRename: fileSystem.rename === rename,
    usesNativeUnlink: fileSystem.unlink === unlink,
  };
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
