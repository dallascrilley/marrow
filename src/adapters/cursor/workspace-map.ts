import { access, readFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

export type CursorWorkspaceMapping = {
  cursorProjectPath: string;
  projectKey: string;
  workspacePath: string | null;
  workspaceSlug: string;
};

export type DeriveCursorWorkspaceMappingOptions = {
  cursorProjectsRoot?: string;
};

const workspaceHintFileNames = [
  "workspace.json",
  "workspace-path.txt",
  "workspace.txt",
  "project.json",
  "metadata.json"
] as const;

export async function deriveCursorWorkspaceMapping(
  transcriptPath: string,
  options: DeriveCursorWorkspaceMappingOptions = {}
): Promise<CursorWorkspaceMapping> {
  const absoluteTranscriptPath = resolve(transcriptPath);
  const cursorProjectsRoot = options.cursorProjectsRoot
    ? resolve(options.cursorProjectsRoot)
    : inferCursorProjectsRoot(absoluteTranscriptPath);
  const relativePath = absoluteTranscriptPath.slice(cursorProjectsRoot.length + 1);
  const relativeSegments = relativePath.split(/[\\/]/).filter((segment) => segment.length > 0);

  if (relativeSegments.length < 3) {
    throw new Error(`Transcript path is not nested under a Cursor project: ${absoluteTranscriptPath}`);
  }

  const [workspaceSlug, ...remainingSegments] = relativeSegments;

  if (!workspaceSlug || !remainingSegments.includes("agent-transcripts")) {
    throw new Error(`Transcript path is not nested under a Cursor project: ${absoluteTranscriptPath}`);
  }

  const cursorProjectPath = join(cursorProjectsRoot, workspaceSlug);
  const workspacePath = await resolveWorkspacePath(cursorProjectPath, workspaceSlug);

  return {
    cursorProjectPath,
    projectKey: deriveProjectKey(workspaceSlug, workspacePath),
    workspacePath,
    workspaceSlug
  };
}

function inferCursorProjectsRoot(transcriptPath: string): string {
  const marker = `${join(".cursor", "projects")}${transcriptPath.includes("\\") ? "\\" : "/"}`;
  const markerIndex = transcriptPath.indexOf(marker);

  if (markerIndex < 0) {
    throw new Error(`Could not infer Cursor projects root from transcript path: ${transcriptPath}`);
  }

  return transcriptPath.slice(0, markerIndex + marker.length - 1);
}

async function resolveWorkspacePath(
  cursorProjectPath: string,
  workspaceSlug: string
): Promise<string | null> {
  const slugCandidate = await normalizeWorkspaceCandidate(decodeWorkspaceSlug(workspaceSlug));

  if (slugCandidate) {
    return slugCandidate;
  }

  for (const hintFileName of workspaceHintFileNames) {
    const hintPath = join(cursorProjectPath, hintFileName);
    const hintedWorkspacePath = await readWorkspaceHint(hintPath);

    if (hintedWorkspacePath) {
      return hintedWorkspacePath;
    }
  }

  return null;
}

async function readWorkspaceHint(hintPath: string): Promise<string | null> {
  try {
    const raw = await readFile(hintPath, "utf8");
    const trimmed = raw.trim();

    if (trimmed.length === 0) {
      return null;
    }

    const parsedCandidate = await normalizeWorkspaceCandidate(extractWorkspaceCandidate(trimmed));
    return parsedCandidate;
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }

    throw error;
  }
}

function extractWorkspaceCandidate(value: string): string | null {
  try {
    return findAbsolutePathCandidate(JSON.parse(value));
  } catch {
    return findAbsolutePathInText(value);
  }
}

function findAbsolutePathCandidate(value: unknown): string | null {
  if (typeof value === "string") {
    return findAbsolutePathInText(value);
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const candidate = findAbsolutePathCandidate(entry);

      if (candidate) {
        return candidate;
      }
    }

    return null;
  }

  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      const candidate = findAbsolutePathCandidate(entry);

      if (candidate) {
        return candidate;
      }
    }
  }

  return null;
}

function findAbsolutePathInText(value: string): string | null {
  const posixMatch = value.match(/\/[^\s"'`]+/);

  if (posixMatch) {
    return posixMatch[0];
  }

  const windowsMatch = value.match(/[A-Za-z]:\\[^\s"'`]+/);
  return windowsMatch ? windowsMatch[0] : null;
}

async function normalizeWorkspaceCandidate(candidate: string | null): Promise<string | null> {
  if (!candidate || !isAbsolutePathLike(candidate)) {
    return null;
  }

  const normalized = resolve(candidate);

  try {
    await access(normalized);
    return normalized;
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }

    throw error;
  }
}

function deriveProjectKey(workspaceSlug: string, workspacePath: string | null): string {
  const preferredSource = workspacePath ?? decodeWorkspaceSlug(workspaceSlug);
  const normalized = preferredSource
    .replace(/[\\/]+$/u, "")
    .split(/[\\/]/)
    .filter((segment) => segment.length > 0)
    .at(-1);

  if (!normalized) {
    return workspaceSlug;
  }

  const extension = extname(normalized);
  return extension === ".code-workspace" ? basename(normalized, extension) : normalized;
}

function decodeWorkspaceSlug(workspaceSlug: string): string {
  try {
    return decodeURIComponent(workspaceSlug);
  } catch {
    return workspaceSlug;
  }
}

function isAbsolutePathLike(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\\/.test(value);
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
