import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { getRuntimePath } from "../config/paths.js";
import {
  listDeletionCandidates,
  markDeletionCandidateApplied,
  transitionPhase,
} from "../db/ledger.js";
import type { DeletionCandidateRow } from "../db/queries.js";

export type AppliedDeletion = {
  session_id: string;
  tombstone_path: string;
};

export async function executeDeleteApply(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const apply = context.args.includes("--apply");
  const ready = listDeletionCandidates(database).filter(
    (candidate) =>
      candidate.safe_to_delete === 1 &&
      (candidate.candidate_state === "ready" ||
        candidate.candidate_state === "discardable_no_signal"),
  );

  if (!apply) {
    context.output.info(JSON.stringify({ apply: false, ready }, null, 2));
    return 0;
  }

  const applied: AppliedDeletion[] = [];

  for (const candidate of ready) {
    applied.push(await applyDeletionCandidate(database, candidate));
  }

  context.output.info(JSON.stringify({ apply: true, applied }, null, 2));
  return 0;
}

export async function applyDeletionCandidate(
  database: DatabaseSync,
  candidate: DeletionCandidateRow,
): Promise<AppliedDeletion> {
  const tombstonePath = join(
    getRuntimePath("deletes"),
    "tombstones",
    `${candidate.session_id}.json`,
  );
  await mkdir(dirname(tombstonePath), { recursive: true });
  await writeFile(
    tombstonePath,
    `${JSON.stringify(
      {
        applied_at: new Date().toISOString(),
        reason: candidate.reason,
        session_id: candidate.session_id,
        source_hash: candidate.source_hash,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  markDeletionCandidateApplied(database, candidate.source_session_id);
  transitionPhase(database, {
    detailsJson: JSON.stringify({
      tombstone_path: tombstonePath,
    }),
    phaseName: "deleted",
    phaseState: "completed",
    sourceHash: candidate.source_hash,
    sourceSessionId: candidate.source_session_id,
  });
  return {
    session_id: candidate.session_id,
    tombstone_path: tombstonePath,
  };
}
