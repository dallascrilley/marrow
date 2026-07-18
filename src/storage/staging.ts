import { constants } from "node:fs";
import { access, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { getRuntimePath, stagingRootOverrideEnvVar } from "../config/paths.js";

const parsedArtifactName = "parsed-records.json";
const reducedArtifactName = "reduced-session.json";
const stagingQuarantineDirectoryName = ".parsed-cleanup-quarantine";

export type StagingRootAccess = "read" | "write";

export type StagingRootInspection = {
  available: boolean;
  configured: boolean;
  device: number | null;
  error: string | null;
  root: string;
  writable: boolean;
};

export function getStagingRoot(): string {
  const root = getRuntimePath("staging");
  if (isStagingRootConfigured() && !isAbsolute(root)) {
    throw new Error(`${stagingRootOverrideEnvVar} must be an absolute path`);
  }
  return resolve(root);
}

export async function inspectStagingRoot(
  requiredAccess: StagingRootAccess = "read",
): Promise<StagingRootInspection> {
  const configured = isStagingRootConfigured();
  let root: string;
  try {
    root = getStagingRoot();
  } catch (error) {
    const requestedRoot = process.env[stagingRootOverrideEnvVar] ?? getRuntimePath("staging");
    return unavailableInspection(requestedRoot, configured, error);
  }

  try {
    const rootIdentity = await lstat(root);
    if (rootIdentity.isSymbolicLink()) {
      throw new Error(`staging root must not traverse symbolic links: ${root}`);
    }
    if (!rootIdentity.isDirectory()) {
      throw new Error(`staging root must be a directory: ${root}`);
    }
    const canonicalRoot = await realpath(root);
    if (canonicalRoot !== root) {
      throw new Error(`staging root must not traverse symbolic links: ${root}`);
    }

    await access(root, constants.R_OK | constants.X_OK);
    const writable = await isWritableDirectory(root);
    if (requiredAccess === "write" && !writable) {
      throw new Error(`staging root is not writable: ${root}`);
    }

    return {
      available: true,
      configured,
      device: (await stat(root)).dev,
      error: null,
      root,
      writable,
    };
  } catch (error) {
    return unavailableInspection(root, configured, normalizeStagingRootError(error, root));
  }
}

export async function requireStagingRoot(
  requiredAccess: StagingRootAccess = "read",
): Promise<string> {
  const inspection = await inspectStagingRoot(requiredAccess);
  if (!inspection.available) {
    throw new Error(inspection.error ?? `staging root is unavailable: ${inspection.root}`);
  }
  return inspection.root;
}

export async function ensureStagingRoot(): Promise<string> {
  if (!isStagingRootConfigured()) {
    await mkdir(getStagingRoot(), { recursive: true });
  }
  return requireStagingRoot("write");
}

export function getParsedStagingArtifactPath(sessionId: string): string {
  return getStagingArtifactPath(sessionId, parsedArtifactName);
}

export function getReducedStagingArtifactPath(sessionId: string): string {
  return getStagingArtifactPath(sessionId, reducedArtifactName);
}

export function getStagingQuarantineRoot(): string {
  return join(getStagingRoot(), stagingQuarantineDirectoryName);
}

function getStagingArtifactPath(sessionId: string, artifactName: string): string {
  assertStagingSessionId(sessionId);
  return join(getStagingRoot(), sessionId, artifactName);
}

function assertStagingSessionId(sessionId: string): void {
  if (
    sessionId.length === 0 ||
    sessionId === "." ||
    sessionId === ".." ||
    sessionId.includes("/") ||
    sessionId.includes("\\") ||
    sessionId.includes("\0")
  ) {
    throw new Error(`invalid staging session id: ${JSON.stringify(sessionId)}`);
  }
}

function isStagingRootConfigured(): boolean {
  const configuredRoot = process.env[stagingRootOverrideEnvVar];
  return configuredRoot !== undefined && configuredRoot.length > 0;
}

async function isWritableDirectory(root: string): Promise<boolean> {
  try {
    await access(root, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function unavailableInspection(
  root: string,
  configured: boolean,
  error: unknown,
): StagingRootInspection {
  return {
    available: false,
    configured,
    device: null,
    error: error instanceof Error ? error.message : String(error),
    root,
    writable: false,
  };
}

function normalizeStagingRootError(error: unknown, root: string): Error {
  if (isMissingPathError(error)) {
    return new Error(`staging root is unavailable: ${root}`);
  }
  if (isPermissionError(error)) {
    return new Error(`staging root is not accessible: ${root}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return isNodeError(error) && error.code === "ENOENT";
}

function isPermissionError(error: unknown): error is NodeJS.ErrnoException {
  return isNodeError(error) && (error.code === "EACCES" || error.code === "EPERM");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
