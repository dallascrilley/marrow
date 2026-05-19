import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";

import { parseJsonLine } from "../_common/jsonl.js";
import { pickFirstString, readValueAtPath } from "../_common/text-extract.js";
import type {
  CodexCliRolloutTreeRoot,
  CodexCliSessionMeta,
  CodexCliWorkspaceMapping
} from "./intermediate.js";

/**
 * Read the `session_meta` line (line 0) from a Codex rollout file and pull
 * the workspace-mapping fields plus the sidecar metadata. Returns null when
 * the file is empty, doesn't start with a `session_meta` line, or doesn't
 * include a usable `payload.cwd`.
 *
 * The Codex layout is date-partitioned, not workspace-partitioned, so the
 * adapter must inspect file contents to derive a workspace. This helper is
 * lightweight: it reads only the first non-empty line.
 */
export async function readCodexCliSessionMeta(
  rolloutPath: string
): Promise<CodexCliSessionMeta | null> {
  const stream = createReadStream(rolloutPath, { encoding: "utf8" });
  const lines = createInterface({ crlfDelay: Infinity, input: stream });

  let result: CodexCliSessionMeta | null = null;

  try {
    for await (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.length === 0) continue;

      const parsed = parseJsonLine(line, rolloutPath, 1, "Codex CLI rollout JSONL");
      if (parsed.type !== "session_meta") {
        return null;
      }

      const payload = readValueAtPath(parsed, ["payload"]);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return null;
      }

      const subagent = readValueAtPath(payload, ["source", "subagent"]);
      const depth =
        subagent && typeof subagent === "object" && !Array.isArray(subagent)
          ? subagent.depth
          : null;

      result = {
        cliVersion: pickFirstString(payload, [["cli_version"]]),
        cwd: pickFirstString(payload, [["cwd"]]),
        id: pickFirstString(payload, [["id"]]),
        originator: pickFirstString(payload, [["originator"]]),
        parentThreadId:
          subagent && typeof subagent === "object" && !Array.isArray(subagent)
            ? pickFirstString(subagent, [["parent_thread_id"]])
            : null,
        agentNickname:
          subagent && typeof subagent === "object" && !Array.isArray(subagent)
            ? pickFirstString(subagent, [["agent_nickname"]])
            : null,
        agentRole:
          subagent && typeof subagent === "object" && !Array.isArray(subagent)
            ? pickFirstString(subagent, [["agent_role"]])
            : null,
        subagentDepth: typeof depth === "number" ? depth : null,
        timestamp: pickFirstString(payload, [["timestamp"]])
      };
      break;
    }
  } finally {
    lines.close();
    stream.close();
  }

  return result;
}

/**
 * Derive a Codex CLI workspace mapping from a rollout file. Reads the
 * `session_meta` line and uses `payload.cwd` as the canonical workspace
 * path. The project key is the last segment of the cwd path.
 *
 * The mapping always returns a populated structure: when no `cwd` is
 * available, `workspacePath` is null and `projectKey` falls back to the
 * filename UUID so the pipeline can still ingest the session under a
 * deterministic key.
 */
export async function deriveCodexCliWorkspaceMapping(
  rolloutPath: string,
  rolloutTreeRoot: CodexCliRolloutTreeRoot,
  sessionMeta: CodexCliSessionMeta | null
): Promise<CodexCliWorkspaceMapping> {
  const workspacePath = sessionMeta?.cwd ?? null;
  const filenameWithoutExt = basename(rolloutPath, ".jsonl");
  const projectKey = deriveProjectKey(workspacePath, filenameWithoutExt);

  return {
    projectKey,
    rolloutPath,
    rolloutTreeRoot,
    workspacePath,
    workspaceSlug: workspacePath ?? filenameWithoutExt
  };
}

function deriveProjectKey(workspacePath: string | null, fallback: string): string {
  if (!workspacePath) return sanitizeFallback(fallback);

  const trimmed = workspacePath.replace(/[\\/]+$/u, "");
  const segments = trimmed.split(/[\\/]/).filter((segment) => segment.length > 0);
  const last = segments.at(-1);
  return last && last.length > 0 ? last : sanitizeFallback(fallback);
}

function sanitizeFallback(value: string): string {
  return value.length > 0 ? value : "unknown";
}
