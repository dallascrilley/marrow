import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, dirname, join, relative, resolve, sep } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { getRuntimePath, stagingRootOverrideEnvVar } from "../config/paths.js";
import { requireStagingRoot } from "../storage/staging.js";
import { loadPendingParsedIntermediateCleanup } from "./parsed-cleanup-receipts.js";

const markerName = ".asd-staging-root.json";
const markerKind = "agent-session-distillery-staging";
const markerVersion = 1;
const artifactNames = new Set(["parsed-records.json", "reduced-session.json"]);

type SourceIdentity = {
  bytes: number;
  device: number;
  inode: number;
  modified_at_nanoseconds: string;
};

export type StagingMigrationFile = SourceIdentity & {
  destination_path: string;
  hash: string;
  relative_path: string;
  source_path: string;
  status: "copy" | "skip";
};

export type StagingMigrationResult = {
  apply: boolean;
  copied_count: number;
  destination_root: string;
  environment: { AGENT_SESSION_DISTILLERY_STAGING_ROOT: string };
  files: StagingMigrationFile[];
  manifest_path: string | null;
  receipt_path: string | null;
  skipped_count: number;
  source_root: string;
  total_bytes: number;
};

export async function runStagingMigration(
  input: {
    apply: boolean;
    now?: Date;
    to: string;
  },
  dependencies: {
    loadPending?: typeof loadPendingParsedIntermediateCleanup;
    statfs?: typeof statfs;
  } = {},
): Promise<StagingMigrationResult> {
  const sourceRoot = await requireStagingRoot("read");
  const destinationRoot = await validateDestination(input.to, sourceRoot);
  const pending = await (dependencies.loadPending ?? loadPendingParsedIntermediateCleanup)();
  if (pending.pendingReceiptCount > 0 || pending.conflicts.length > 0) {
    throw new Error(
      `staging migration blocked by pending parsed cleanup receipts: ${pending.pendingReceiptCount}`,
    );
  }

  const files = await inspectSourceFiles(sourceRoot, destinationRoot);
  const bytesToCopy = files
    .filter((file) => file.status === "copy")
    .reduce((sum, file) => sum + file.bytes, 0);
  const capacity = await (dependencies.statfs ?? statfs)(destinationRoot);
  const availableBytes = Number(capacity.bavail) * Number(capacity.bsize);
  if (bytesToCopy > availableBytes) {
    throw new Error(
      `insufficient destination capacity: need ${bytesToCopy} bytes, have ${availableBytes} bytes`,
    );
  }

  const baseResult = {
    destination_root: destinationRoot,
    environment: { [stagingRootOverrideEnvVar]: destinationRoot } as {
      AGENT_SESSION_DISTILLERY_STAGING_ROOT: string;
    },
    files,
    source_root: sourceRoot,
    total_bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
  if (!input.apply) {
    return {
      apply: false,
      copied_count: 0,
      manifest_path: null,
      receipt_path: null,
      skipped_count: files.filter((file) => file.status === "skip").length,
      ...baseResult,
    };
  }

  await writeOwnershipMarker(destinationRoot, sourceRoot);
  await removeIncompleteTemporaryFiles(destinationRoot);
  const completed: StagingMigrationFile[] = [];
  for (const file of files) {
    if (file.status === "copy") {
      await copyOne(file);
    }
    completed.push({ ...file, status: "skip" });
  }

  const now = input.now ?? new Date();
  const id = `${now.toISOString().replaceAll(":", "-")}-${randomUUID()}`;
  const reportDirectory = join(getRuntimePath("reports"), "storage-migrations");
  const manifestPath = join(reportDirectory, `staging-migration-${id}.jsonl`);
  const receiptPath = join(reportDirectory, `staging-migration-${id}.json`);
  await mkdir(reportDirectory, { recursive: true });
  await writeAtomic(manifestPath, `${completed.map((file) => JSON.stringify(file)).join("\n")}\n`);
  const result: StagingMigrationResult = {
    apply: true,
    copied_count: files.filter((file) => file.status === "copy").length,
    manifest_path: manifestPath,
    receipt_path: receiptPath,
    skipped_count: files.filter((file) => file.status === "skip").length,
    ...baseResult,
  };
  await writeAtomic(
    receiptPath,
    `${JSON.stringify({ ...result, completed_at: now.toISOString(), files: completed }, null, 2)}\n`,
  );
  return result;
}

async function validateDestination(requested: string, sourceRoot: string): Promise<string> {
  if (!isAbsolute(requested)) {
    throw new Error("storage migrate-staging --to requires an absolute path");
  }
  const destinationRoot = resolve(requested);
  const metadata = await lstat(destinationRoot).catch((error) => {
    throw new Error(`staging migration destination is unavailable: ${destinationRoot}`, {
      cause: error,
    });
  });
  if (metadata.isSymbolicLink()) {
    throw new Error(
      `staging migration destination must not be a symbolic link: ${destinationRoot}`,
    );
  }
  if (!metadata.isDirectory()) {
    throw new Error(`staging migration destination must be a directory: ${destinationRoot}`);
  }
  if ((await realpath(destinationRoot)) !== destinationRoot) {
    throw new Error(
      `staging migration destination must not traverse symbolic links: ${destinationRoot}`,
    );
  }
  const sourceCanonical = await realpath(sourceRoot);
  const fromSource = relative(sourceCanonical, destinationRoot);
  if (
    destinationRoot === sourceCanonical ||
    (fromSource.length > 0 && fromSource !== ".." && !fromSource.startsWith(`..${sep}`))
  ) {
    throw new Error("staging migration destination must not equal or nest inside the source");
  }

  const entries = await readdir(destinationRoot, { withFileTypes: true });
  const marker = entries.find((entry) => entry.name === markerName);
  if (entries.length > 0 && marker === undefined) {
    throw new Error(
      "staging migration destination must be empty or contain an ASD ownership marker",
    );
  }
  if (marker !== undefined) {
    if (!marker.isFile()) {
      throw new Error("invalid ASD staging ownership marker");
    }
    const value = JSON.parse(await readFile(join(destinationRoot, markerName), "utf8")) as {
      kind?: unknown;
      source_root?: unknown;
      version?: unknown;
    };
    if (
      value.kind !== markerKind ||
      value.version !== markerVersion ||
      typeof value.source_root !== "string"
    ) {
      throw new Error("invalid ASD staging ownership marker");
    }
    const markerSource = await realpath(value.source_root).catch(() => null);
    if (markerSource !== sourceCanonical) {
      throw new Error(`ASD staging ownership marker source mismatch: expected ${sourceCanonical}`);
    }
    await validateOwnedDestinationEntries(destinationRoot);
  }
  return destinationRoot;
}

async function inspectSourceFiles(
  sourceRoot: string,
  destinationRoot: string,
): Promise<StagingMigrationFile[]> {
  const files: StagingMigrationFile[] = [];
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = join(sourceRoot, entry.name);
    if (entry.name === ".parsed-cleanup-quarantine") {
      if (!entry.isDirectory() || (await readdir(entryPath)).length > 0) {
        throw new Error(`unsupported staging entry: ${entryPath}`);
      }
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`unsupported staging entry: ${entryPath}`);
    }
    const sessionCanonical = await realpath(entryPath);
    if (relative(sourceRoot, sessionCanonical) !== entry.name) {
      throw new Error(`unsupported staging entry: ${entryPath}`);
    }
    const artifacts = await readdir(entryPath, { withFileTypes: true });
    for (const artifact of artifacts.sort((left, right) => left.name.localeCompare(right.name))) {
      const sourcePath = join(entryPath, artifact.name);
      if (!artifactNames.has(artifact.name) || !artifact.isFile() || artifact.isSymbolicLink()) {
        throw new Error(`unsupported staging entry: ${sourcePath}`);
      }
      const before = await sourceIdentity(sourcePath);
      const hash = await hashFile(sourcePath);
      await assertSourceIdentity(sourcePath, before);
      const relativePath = join(entry.name, artifact.name);
      const destinationPath = join(destinationRoot, relativePath);
      const destinationHash = await hashFileIfPresent(destinationPath);
      if (destinationHash !== null && destinationHash !== hash) {
        throw new Error(`destination artifact hash mismatch: ${destinationPath}`);
      }
      files.push({
        ...before,
        destination_path: destinationPath,
        hash,
        relative_path: relativePath,
        source_path: sourcePath,
        status: destinationHash === hash ? "skip" : "copy",
      });
    }
  }
  const sourceRelativePaths = new Set(files.map((file) => file.relative_path));
  for (const destinationRelativePath of await listDestinationArtifacts(destinationRoot)) {
    if (!sourceRelativePaths.has(destinationRelativePath)) {
      throw new Error(
        `destination contains an artifact absent from source: ${join(destinationRoot, destinationRelativePath)}`,
      );
    }
  }
  return files;
}

async function copyOne(file: StagingMigrationFile): Promise<void> {
  await assertSourceIdentity(file.source_path, file);
  await mkdir(dirname(file.destination_path), { recursive: true });
  const temporaryPath = `${file.destination_path}.asd-migrate-${process.pid}-${randomUUID()}.tmp`;
  const hash = createHash("sha256");
  try {
    await pipeline(
      createReadStream(file.source_path),
      new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
    );
    const copiedHash = `sha256:${hash.digest("hex")}`;
    if (copiedHash !== file.hash) {
      throw new Error(`source changed while copying: ${file.source_path}`);
    }
    const handle = await open(temporaryPath, constants.O_RDWR);
    await handle.sync();
    await handle.close();
    await assertSourceIdentity(file.source_path, file);
    await rename(temporaryPath, file.destination_path);
    if ((await hashFile(file.destination_path)) !== file.hash) {
      throw new Error(`destination artifact hash mismatch: ${file.destination_path}`);
    }
    await syncDirectory(dirname(file.destination_path));
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function validateOwnedDestinationEntries(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === markerName && entry.isFile()) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`unsupported staging migration destination entry: ${join(root, entry.name)}`);
    }
    for (const artifact of await readdir(join(root, entry.name), { withFileTypes: true })) {
      const allowedTemporary = /^.+\.asd-migrate-\d+-[0-9a-f-]+\.tmp$/i.test(artifact.name);
      if ((!artifactNames.has(artifact.name) && !allowedTemporary) || !artifact.isFile()) {
        throw new Error(
          `unsupported staging migration destination entry: ${join(root, entry.name, artifact.name)}`,
        );
      }
    }
  }
}

async function listDestinationArtifacts(root: string): Promise<string[]> {
  const artifacts: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const artifact of await readdir(join(root, entry.name), { withFileTypes: true })) {
      if (artifact.isFile() && artifactNames.has(artifact.name)) {
        artifacts.push(join(entry.name, artifact.name));
      }
    }
  }
  return artifacts;
}

async function removeIncompleteTemporaryFiles(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    for (const artifact of await readdir(directory, { withFileTypes: true })) {
      if (artifact.isFile() && /^.+\.asd-migrate-\d+-[0-9a-f-]+\.tmp$/i.test(artifact.name)) {
        await rm(join(directory, artifact.name), { force: true });
      }
    }
  }
}

async function writeOwnershipMarker(destinationRoot: string, sourceRoot: string): Promise<void> {
  const path = join(destinationRoot, markerName);
  try {
    await lstat(path);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    await writeAtomic(
      path,
      `${JSON.stringify({ kind: markerKind, source_root: sourceRoot, version: markerVersion }, null, 2)}\n`,
    );
  }
}

async function sourceIdentity(path: string): Promise<SourceIdentity> {
  const metadata = await lstat(path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`unsupported staging entry: ${path}`);
  }
  return {
    bytes: Number(metadata.size),
    device: Number(metadata.dev),
    inode: Number(metadata.ino),
    modified_at_nanoseconds: metadata.mtimeNs.toString(),
  };
}

async function assertSourceIdentity(path: string, expected: SourceIdentity): Promise<void> {
  const current = await sourceIdentity(path);
  if (
    current.bytes !== expected.bytes ||
    current.device !== expected.device ||
    current.inode !== expected.inode ||
    current.modified_at_nanoseconds !== expected.modified_at_nanoseconds
  ) {
    throw new Error(`source changed during staging migration: ${path}`);
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(
    createReadStream(path),
    new Writable({
      write(chunk, _encoding, callback) {
        hash.update(chunk);
        callback();
      },
    }),
  );
  return `sha256:${hash.digest("hex")}`;
}

async function hashFileIfPresent(path: string): Promise<string | null> {
  try {
    return await hashFile(path);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { flag: "wx", mode: 0o600 });
    const handle = await open(temporaryPath, constants.O_RDWR);
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
