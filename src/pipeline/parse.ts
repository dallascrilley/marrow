import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { parseClaudeCodeTranscript } from "../adapters/claude-code/parse-transcript.js";
import { parseCodexCliTranscript } from "../adapters/codex-cli/parse-transcript.js";
import { parseCursorTranscript } from "../adapters/cursor/parse-transcript.js";
import type {
  ParseTranscriptOptions,
  ParseTranscriptResult,
  TranscriptRecord
} from "../adapters/_common/intermediate.js";
import type { CursorTranscriptRecord } from "../adapters/cursor/intermediate.js";
import {
  getPhaseCheckpoint,
  insertRunHistory,
  transitionPhase
} from "../db/ledger.js";
import { getRuntimePath } from "../config/paths.js";
import type { SourceSessionRow } from "../db/queries.js";

export type ParsePhaseResult = {
  artifactPath: string;
  recordCount: number;
  records: CursorTranscriptRecord[];
  resumed: boolean;
};

export async function runParsePhase(input: {
  database: DatabaseSync;
  resume?: boolean;
  sourceSession: SourceSessionRow;
}): Promise<ParsePhaseResult> {
  const artifactPath = getParsedArtifactPath(input.sourceSession.session_id);
  const checkpoint = getPhaseCheckpoint(input.database, input.sourceSession.id, "parsed");

  if (
    input.resume === true &&
    checkpoint?.phase_state === "completed" &&
    checkpoint.source_hash === input.sourceSession.source_hash &&
    (await fileExists(artifactPath))
  ) {
    const resumedRecords = JSON.parse(await readFile(artifactPath, "utf8")) as CursorTranscriptRecord[];
    return {
      artifactPath,
      recordCount: resumedRecords.length,
      records: resumedRecords,
      resumed: true
    };
  }

  try {
    const parsed = await parseBySourceTool(input.sourceSession.source_tool, {
      sourceHash: input.sourceSession.source_hash,
      sourcePath: input.sourceSession.source_path
    });
    await writeJsonArtifact(artifactPath, parsed.records);
    const detailsJson = JSON.stringify({
      artifact_path: artifactPath,
      record_count: parsed.records.length,
      source_path: input.sourceSession.source_path
    });
    const run = insertRunHistory(input.database, {
      detailsJson,
      finishedAt: new Date().toISOString(),
      phaseName: "parsed",
      phaseState: "completed",
      sessionId: input.sourceSession.session_id,
      sourceHash: input.sourceSession.source_hash,
      sourceSessionId: input.sourceSession.id
    });

    transitionPhase(input.database, {
      detailsJson,
      phaseName: "parsed",
      phaseState: "completed",
      runId: run.id,
      sourceHash: input.sourceSession.source_hash,
      sourceSessionId: input.sourceSession.id
    });

    return {
      artifactPath,
      recordCount: parsed.records.length,
      records: parsed.records,
      resumed: false
    };
  } catch (error) {
    const detailsJson = JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      source_path: input.sourceSession.source_path
    });
    const run = insertRunHistory(input.database, {
      detailsJson,
      finishedAt: new Date().toISOString(),
      phaseName: "parsed",
      phaseState: "failed",
      sessionId: input.sourceSession.session_id,
      sourceHash: input.sourceSession.source_hash,
      sourceSessionId: input.sourceSession.id
    });
    transitionPhase(input.database, {
      detailsJson,
      phaseName: "parsed",
      phaseState: "failed",
      runId: run.id,
      sourceHash: input.sourceSession.source_hash,
      sourceSessionId: input.sourceSession.id
    });
    throw error;
  }
}

export function getParsedArtifactPath(sessionId: string): string {
  return join(getRuntimePath("staging"), sessionId, "parsed-records.json");
}

async function writeJsonArtifact(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    return isMissingFileError(error) ? false : Promise.reject(error);
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

async function parseBySourceTool(
  sourceTool: string,
  options: ParseTranscriptOptions
): Promise<ParseTranscriptResult> {
  switch (sourceTool) {
    case "cursor":
      return parseCursorTranscript(options);
    case "claude-code":
      return parseClaudeCodeTranscript(options);
    case "codex-cli":
      return parseCodexCliTranscript(options);
    default:
      throw new Error(`Unsupported source_tool: ${sourceTool}`);
  }
}
