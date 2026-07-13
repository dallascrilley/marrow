import { randomUUID } from "node:crypto";
import { access, rename, stat, unlink } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

import {
  listParsedIntermediateCleanupCandidates,
  type ParsedIntermediateCleanupCandidate,
  type ParsedIntermediateCleanupOptions,
} from "../read/lifecycle-inventory.js";

export type ParsedIntermediateCleanupResult = {
  candidates: ParsedIntermediateCleanupCandidate[];
  deleted: ParsedIntermediateCleanupCandidate[];
  quarantined: string[];
  skipped: string[];
};

export type ParsedIntermediateCleanupFileSystem = {
  access: typeof access;
  rename: typeof rename;
  stat: typeof stat;
  unlink: typeof unlink;
};

export class ParsedIntermediateCleanupError extends Error {
  readonly result: ParsedIntermediateCleanupResult;

  constructor(cause: unknown, result: ParsedIntermediateCleanupResult) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ParsedIntermediateCleanupError";
    this.result = result;
  }
}

export async function applyParsedIntermediateCleanup(
  database: DatabaseSync,
  options: ParsedIntermediateCleanupOptions & { sessionIds?: readonly string[] },
  fileSystem: ParsedIntermediateCleanupFileSystem = { access, rename, stat, unlink },
): Promise<ParsedIntermediateCleanupResult> {
  const sessionIds = options.sessionIds === undefined ? null : new Set(options.sessionIds);
  const candidates = (await listParsedIntermediateCleanupCandidates(database, options)).filter(
    (candidate) => sessionIds === null || sessionIds.has(candidate.session_id),
  );
  const deleted: ParsedIntermediateCleanupCandidate[] = [];
  const quarantined = new Map<string, string>();
  const skipped: string[] = [];

  try {
    for (const candidate of candidates) {
      const current = await findCurrentCandidate(database, candidate, options, sessionIds);
      if (current === undefined) {
        skipped.push(candidate.path);
        continue;
      }

      const quarantinePath = `${current.path}.asd-cleanup-${randomUUID()}.quarantine`;
      try {
        await fileSystem.rename(current.path, quarantinePath);
      } catch (error) {
        if (isMissingPathError(error)) {
          skipped.push(candidate.path);
          continue;
        }
        throw error;
      }
      quarantined.set(quarantinePath, current.path);

      const metadata = await fileSystem.stat(quarantinePath);
      if (!sameFileIdentity(current, metadata)) {
        skipped.push(candidate.path);
        if (await restoreQuarantinedFile(quarantinePath, current.path, fileSystem)) {
          quarantined.delete(quarantinePath);
        }
        continue;
      }

      await fileSystem.unlink(quarantinePath);
      quarantined.delete(quarantinePath);
      deleted.push(current);
    }
  } catch (error) {
    for (const [quarantinePath, originalPath] of quarantined) {
      try {
        if (await restoreQuarantinedFile(quarantinePath, originalPath, fileSystem)) {
          quarantined.delete(quarantinePath);
        }
      } catch {
        // Preserve the quarantine path in the structured failure result for recovery.
      }
    }
    throw new ParsedIntermediateCleanupError(error, {
      candidates,
      deleted,
      quarantined: [...quarantined.keys()],
      skipped,
    });
  }

  return {
    candidates,
    deleted,
    quarantined: [...quarantined.keys()],
    skipped,
  };
}

async function findCurrentCandidate(
  database: DatabaseSync,
  expected: ParsedIntermediateCleanupCandidate,
  options: ParsedIntermediateCleanupOptions,
  sessionIds: ReadonlySet<string> | null,
): Promise<ParsedIntermediateCleanupCandidate | undefined> {
  const candidates = await listParsedIntermediateCleanupCandidates(database, options);
  return candidates.find(
    (candidate) =>
      (sessionIds === null || sessionIds.has(candidate.session_id)) &&
      sameCandidateIdentity(expected, candidate),
  );
}

async function restoreQuarantinedFile(
  quarantinePath: string,
  originalPath: string,
  fileSystem: ParsedIntermediateCleanupFileSystem,
): Promise<boolean> {
  try {
    await fileSystem.access(originalPath);
    return false;
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
  await fileSystem.rename(quarantinePath, originalPath);
  return true;
}

function sameCandidateIdentity(
  left: ParsedIntermediateCleanupCandidate,
  right: ParsedIntermediateCleanupCandidate,
): boolean {
  return (
    left.bytes === right.bytes &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.lifecycle_state === right.lifecycle_state &&
    left.modified_at === right.modified_at &&
    left.path === right.path &&
    left.session_id === right.session_id
  );
}

function sameFileIdentity(
  candidate: ParsedIntermediateCleanupCandidate,
  metadata: Awaited<ReturnType<typeof stat>>,
): boolean {
  return (
    candidate.bytes === metadata.size &&
    candidate.device === metadata.dev &&
    candidate.inode === metadata.ino &&
    candidate.modified_at === metadata.mtime.toISOString()
  );
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
