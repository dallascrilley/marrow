import { basename, resolve } from "node:path";

import type { ClaudeCodeWorkspaceMapping } from "./intermediate.js";

export type DeriveClaudeCodeWorkspaceMappingOptions = {
  claudeCodeProjectsRoot?: string;
};

/**
 * Map a Claude Code transcript path to its workspace identity. The transcript
 * sits directly inside `~/.claude/projects/<encoded-workspace>/`; the workspace
 * dir name is the absolute workspace path with every `/` replaced by `-` plus
 * a leading `-` (the leading `/` of the original path is also encoded as `-`).
 *
 * Decoder: drop the leading `-`, then replace every remaining `-` between
 * segments with `/`. The decoded result is the absolute workspace path.
 *
 * `workspacePath` is the decoded path regardless of whether it currently
 * exists on disk — Claude Code keeps transcripts of deleted projects, and
 * the pipeline still wants to attribute them.
 */
export function deriveClaudeCodeWorkspaceMapping(
  transcriptPath: string,
  options: DeriveClaudeCodeWorkspaceMappingOptions = {}
): ClaudeCodeWorkspaceMapping {
  const absoluteTranscriptPath = resolve(transcriptPath);
  const claudeCodeProjectsRoot = options.claudeCodeProjectsRoot
    ? resolve(options.claudeCodeProjectsRoot)
    : inferClaudeCodeProjectsRoot(absoluteTranscriptPath);
  const relativePath = absoluteTranscriptPath.slice(claudeCodeProjectsRoot.length + 1);
  const relativeSegments = relativePath.split(/[\\/]/).filter((segment) => segment.length > 0);

  if (relativeSegments.length < 2) {
    throw new Error(
      `Transcript path is not nested under a Claude Code project: ${absoluteTranscriptPath}`
    );
  }

  const [workspaceSlug] = relativeSegments;

  if (!workspaceSlug) {
    throw new Error(
      `Transcript path is not nested under a Claude Code project: ${absoluteTranscriptPath}`
    );
  }

  const claudeCodeProjectPath = resolve(claudeCodeProjectsRoot, workspaceSlug);
  const workspacePath = decodeWorkspaceSlug(workspaceSlug);

  return {
    claudeCodeProjectPath,
    projectKey: deriveProjectKey(workspacePath, workspaceSlug),
    workspacePath,
    workspaceSlug
  };
}

function inferClaudeCodeProjectsRoot(transcriptPath: string): string {
  const separator = transcriptPath.includes("\\") ? "\\" : "/";
  const marker = `.claude${separator}projects${separator}`;
  const markerIndex = transcriptPath.indexOf(marker);

  if (markerIndex < 0) {
    throw new Error(
      `Could not infer Claude Code projects root from transcript path: ${transcriptPath}`
    );
  }

  return transcriptPath.slice(0, markerIndex + marker.length - 1);
}

/**
 * Decode the Claude Code workspace slug back to an absolute path. The slug
 * encoding replaces every `/` with `-`, including the leading `/`. The
 * inverse is to drop the leading `-` and replace every other `-` with `/`.
 * Returns `null` only when decoding cannot produce an absolute-looking path.
 */
function decodeWorkspaceSlug(workspaceSlug: string): string | null {
  if (workspaceSlug.length === 0 || !workspaceSlug.startsWith("-")) {
    return null;
  }

  const withoutLeadingDash = workspaceSlug.slice(1);
  const decoded = `/${withoutLeadingDash.split("-").join("/")}`;
  return decoded;
}

function deriveProjectKey(workspacePath: string | null, workspaceSlug: string): string {
  const preferredSource = workspacePath ?? workspaceSlug;
  const normalized = basename(preferredSource);
  return normalized.length > 0 ? normalized : workspaceSlug;
}
