import { readFile } from "node:fs/promises";

import type { Summary, Turn } from "../models/canonical.js";
import { summarySchema, turnSchema } from "../models/canonical.js";
import { getReducedArtifactPath } from "../pipeline/reduce.js";
import { getSessionSummaryJsonPath } from "../writers/summary-writer.js";
import type { SessionIndexRecord } from "./session-index.js";
import { loadSessionIndexRecords } from "./session-index.js";

export type ArtifactReadResult<T> = { found: true; value: T } | { found: false; value: null };

export type SessionDetail = {
  index: SessionIndexRecord;
  summary: Summary | null;
  reduced_turns: Turn[];
};

export async function readSessionSummary(sessionId: string): Promise<ArtifactReadResult<Summary>> {
  try {
    return {
      found: true,
      value: summarySchema.parse(
        JSON.parse(await readFile(getSessionSummaryJsonPath(sessionId), "utf8")),
      ),
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { found: false, value: null };
    }

    throw error;
  }
}

export async function readReducedTurns(sessionId: string): Promise<ArtifactReadResult<Turn[]>> {
  try {
    const parsed = JSON.parse(await readFile(getReducedArtifactPath(sessionId), "utf8")) as {
      turns?: unknown;
    };
    const turns = Array.isArray(parsed.turns)
      ? parsed.turns.map((turn) => turnSchema.parse(turn))
      : [];
    return { found: true, value: turns };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { found: false, value: null };
    }

    throw error;
  }
}

export async function getSessionDetail(asdSessionId: string): Promise<SessionDetail | null> {
  const record = (await loadSessionIndexRecords({ fallbackToBuild: true })).find(
    (entry) => entry.asd_session_id === asdSessionId,
  );

  if (!record) {
    return null;
  }

  const [summary, reduced] = await Promise.all([
    readSessionSummary(asdSessionId),
    readReducedTurns(asdSessionId),
  ]);

  return {
    index: record,
    summary: summary.value ?? null,
    reduced_turns: reduced.value ?? [],
  };
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
