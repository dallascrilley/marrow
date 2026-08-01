import { createReadStream } from "node:fs";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline";

import { parseJsonLine } from "../_common/jsonl.js";
import { pickFirstString, readValueAtPath } from "../_common/text-extract.js";
import type { PiSessionMeta, PiWorkspaceMapping } from "./intermediate.js";

// Compared after stripDotPrefix(".pi" → "pi", ".omp" → "omp").
const PI_SESSIONS_DIRNAME_MARKER = "pi";
const OMP_SESSIONS_DIRNAME_MARKER = "omp";
const PI_AGENT_DIRNAME_MARKER = "agent";
const PI_SESSIONS_LEAF_DIRNAME_MARKER = "sessions";

/**
 * Read the `session` record from a Pi/OMP session JSONL file and pull the
 * workspace-mapping fields plus sidecar metadata. Returns null when no
 * `session` line is found in the leading preamble.
 *
 * Classic Pi files start with `session` on line 0. OMP (oh-my-pi) files often
 * write a `title` pad line first, then `session` — scan the first few
 * non-empty lines so both layouts resolve a content-derived cwd.
 *
 * The adapter prefers this content-derived cwd over the path-encoded
 * workspace slug because the path encoding can collide if a workspace
 * itself contains `--`.
 */
export async function readPiSessionMeta(sessionPath: string): Promise<PiSessionMeta | null> {
  const stream = createReadStream(sessionPath, { encoding: "utf8" });
  const lines = createInterface({ crlfDelay: Infinity, input: stream });

  let result: PiSessionMeta | null = null;
  let nonEmptyLinesSeen = 0;
  const maxPreambleLines = 16;

  try {
    for await (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.length === 0) continue;

      nonEmptyLinesSeen += 1;
      const parsed = parseJsonLine(line, sessionPath, nonEmptyLinesSeen, "Pi session JSONL");
      if (parsed.type === "session") {
        const versionValue = readValueAtPath(parsed, ["version"]);
        const version = typeof versionValue === "number" ? versionValue : null;

        result = {
          cwd: pickFirstString(parsed, [["cwd"]]),
          id: pickFirstString(parsed, [["id"]]),
          timestamp: pickFirstString(parsed, [["timestamp"]]),
          version,
        };
        break;
      }

      // Skip known pad/preamble types (OMP title line). Give up on unexpected
      // preambles or after the scan budget so multi-MB files stay cheap.
      if (parsed.type !== "title" || nonEmptyLinesSeen >= maxPreambleLines) {
        break;
      }
    }
  } finally {
    lines.close();
    stream.close();
  }

  return result;
}

/**
 * Derive a Pi workspace mapping from a session file path plus its
 * `session_meta` (read once by the discovery walker). Prefers the content-
 * derived cwd; falls back to decoding the path-encoded workspace slug when
 * line 0 is missing.
 */
export function derivePiWorkspaceMapping(
  sessionPath: string,
  sessionMeta: PiSessionMeta | null,
): PiWorkspaceMapping {
  const absoluteSessionPath = resolve(sessionPath);
  const piSessionPath = absoluteSessionPath;
  const workspaceSlug = extractWorkspaceSlug(absoluteSessionPath);
  const decodedFromPath = decodeWorkspaceSlug(workspaceSlug);
  const workspacePath = sessionMeta?.cwd ?? decodedFromPath;

  return {
    piSessionPath,
    projectKey: deriveProjectKey(workspacePath, workspaceSlug),
    workspacePath,
    workspaceSlug,
  };
}

function extractWorkspaceSlug(absoluteSessionPath: string): string {
  const segments = absoluteSessionPath.split(/[\\/]/).filter((segment) => segment.length > 0);

  for (let index = 0; index < segments.length - 3; index += 1) {
    // Look for `.pi/agent/sessions/<slug>/...` or `.omp/agent/sessions/...`.
    // macOS sees `.pi` / `.omp` as a leading hidden segment.
    const segment = segments[index];
    const rootName = segment !== undefined ? stripDotPrefix(segment) : "";
    if (
      segment !== undefined &&
      (rootName === PI_SESSIONS_DIRNAME_MARKER || rootName === OMP_SESSIONS_DIRNAME_MARKER) &&
      segments[index + 1] === PI_AGENT_DIRNAME_MARKER &&
      segments[index + 2] === PI_SESSIONS_LEAF_DIRNAME_MARKER
    ) {
      return segments[index + 3] ?? "";
    }
  }

  // Fallback: take the parent dir of the session file. Useful for fixture
  // layouts that don't sit under `.pi/agent/sessions/`.
  return segments.at(-2) ?? "";
}

function stripDotPrefix(value: string): string {
  return value.startsWith(".") ? value.slice(1) : value;
}

/**
 * Decode Pi's leading-and-trailing `--` framed workspace slug back to an
 * absolute path. Returns null when the slug doesn't carry the framing.
 */
function decodeWorkspaceSlug(workspaceSlug: string): string | null {
  if (workspaceSlug.length === 0) return null;
  if (!workspaceSlug.startsWith("--") || !workspaceSlug.endsWith("--")) return null;

  const inner = workspaceSlug.slice(2, -2);
  if (inner.length === 0) return null;
  return `/${inner.split("-").join("/")}`;
}

function deriveProjectKey(workspacePath: string | null, workspaceSlug: string): string {
  const fallback = sanitizeFallback(workspaceSlug);
  if (!workspacePath) return fallback;

  const trimmed = workspacePath.replace(/[\\/]+$/u, "");
  const segments = trimmed.split(/[\\/]/).filter((segment) => segment.length > 0);
  const last = segments.at(-1);
  return last && last.length > 0 ? last : fallback;
}

function sanitizeFallback(workspaceSlug: string): string {
  const trimmed = workspaceSlug.replace(/^-+|-+$/g, "");
  return trimmed.length > 0 ? trimmed : basename(workspaceSlug, ".jsonl") || "unknown";
}
