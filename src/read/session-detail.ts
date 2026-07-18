import { readFile } from "node:fs/promises";

import type { Summary, Turn } from "../models/canonical.js";
import { summarySchema, turnSchema } from "../models/canonical.js";
import { getReducedArtifactPath } from "../pipeline/reduce.js";
import { preflightStagingReadRoot } from "../storage/staging.js";
import { getSessionSummaryJsonPath } from "../writers/summary-writer.js";
import type { SessionIndexRecord } from "./session-index.js";
import { buildSessionIndex, readSessionIndexFile } from "./session-index.js";

export type ArtifactReadResult<T> = { found: true; value: T } | { found: false; value: null };

export type SessionDetail = {
  index: SessionIndexRecord;
  summary: Summary | null;
  reduced_turns: Turn[];
};

export async function getSessionDetailForRecord(
  record: SessionIndexRecord,
): Promise<SessionDetail> {
  const [summary, reduced] = await Promise.all([
    readSessionSummary(record.asd_session_id),
    readReducedTurns(record.asd_session_id),
  ]);

  return {
    index: record,
    summary: summary.value ?? null,
    reduced_turns: reduced.value ?? [],
  };
}

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
  await preflightStagingReadRoot();
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
  // Read the persisted index if present. When it is missing we build once, and
  // that fresh build is authoritative — no second build is warranted.
  let records: SessionIndexRecord[];
  let builtFromScratch = false;
  try {
    records = await readSessionIndexFile();
  } catch {
    records = await buildSessionIndex();
    builtFromScratch = true;
  }

  let record = records.find((entry) => entry.asd_session_id === asdSessionId);

  // The on-disk index can be present but stale (missing a genuinely new
  // session). Rebuild once to catch that — but skip it when we already built
  // from scratch above, so getSessionDetail never builds the index twice.
  if (!record && !builtFromScratch) {
    record = (await buildSessionIndex()).find((entry) => entry.asd_session_id === asdSessionId);
  }

  if (!record) {
    return null;
  }

  return getSessionDetailForRecord(record);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
