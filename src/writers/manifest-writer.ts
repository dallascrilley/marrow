import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getRuntimePath } from "../config/paths.js";
import type { Event, SourceSession, Turn } from "../models/canonical.js";

export type SessionProvenanceManifest = {
  artifact_paths: {
    project_knowledge_jsonl_path: string | null;
    retention_receipt_path: string;
    summary_json_path: string;
    summary_markdown_path: string;
    user_knowledge_jsonl_path: string | null;
  };
  generated_at: string;
  session: SourceSession;
  source_span: {
    event_count: number;
    first_turn_id: string | null;
    last_turn_id: string | null;
    line_end: number | null;
    line_start: number | null;
    turn_count: number;
  };
  version: 1;
};

export type ManifestWriteResult = {
  created: boolean;
  manifest: SessionProvenanceManifest;
  path: string;
};

export function getSessionManifestPath(sessionId: string): string {
  return join(getRuntimePath("manifests"), `${sessionId}.json`);
}

export function getSessionManifestPathForRevision(sessionId: string, sourceHash: string): string {
  const revision =
    sourceHash
      .replace(/^sha256:/, "")
      .replace(/[^a-z0-9_-]/gi, "")
      .slice(0, 12) || "unknown";
  return join(getRuntimePath("manifests"), `${sessionId}.${revision}.json`);
}

export async function writeSessionManifest(input: {
  artifactPaths: SessionProvenanceManifest["artifact_paths"];
  events: readonly Event[];
  generatedAt?: string;
  /**
   * Opt-in for deliberate operator-initiated regeneration flows
   * (pipeline reextract/rereduce). The manifest embeds session metadata that
   * the flow itself advances (e.g. ingest_status), so a re-run legitimately
   * produces different contents and must supersede; normal ingest leaves this
   * off and keeps the immutability guard.
   */
  overwriteIfDifferent?: boolean;
  sourceSession: SourceSession;
  turns: readonly Turn[];
}): Promise<ManifestWriteResult> {
  const manifest = buildManifest(input);
  const path = getSessionManifestPathForRevision(
    input.sourceSession.session_id,
    input.sourceSession.source_hash,
  );
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;

  await mkdir(dirname(path), { recursive: true });
  const existing = await readExistingFile(path);

  if (existing !== null) {
    if (existing !== serialized && input.overwriteIfDifferent !== true) {
      throw new Error(`Immutable manifest already exists with different contents: ${path}`);
    }

    if (existing !== serialized) {
      await writeFile(path, serialized, "utf8");
    }

    return {
      created: false,
      manifest,
      path,
    };
  }

  await writeFile(path, serialized, "utf8");
  return {
    created: true,
    manifest,
    path,
  };
}

function buildManifest(input: {
  artifactPaths: SessionProvenanceManifest["artifact_paths"];
  events: readonly Event[];
  generatedAt?: string;
  sourceSession: SourceSession;
  turns: readonly Turn[];
}): SessionProvenanceManifest {
  const lineNumbers = input.events
    .flatMap((event) => [event.source_offsets.start_line, event.source_offsets.end_line])
    .filter((value): value is number => typeof value === "number");

  return {
    artifact_paths: input.artifactPaths,
    generated_at: input.generatedAt ?? input.sourceSession.updated_at,
    session: input.sourceSession,
    source_span: {
      event_count: input.events.length,
      first_turn_id: input.turns[0]?.turn_id ?? null,
      last_turn_id: input.turns[input.turns.length - 1]?.turn_id ?? null,
      line_end: lineNumbers.length > 0 ? Math.max(...lineNumbers) : null,
      line_start: lineNumbers.length > 0 ? Math.min(...lineNumbers) : null,
      turn_count: input.turns.length,
    },
    version: 1,
  };
}

async function readExistingFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
