import type { Learning } from "../models/canonical.js";
import { isLowSignalTopic } from "./summarize.js";

// Why a learning was dropped before any paid LLM review. `low_signal_session`
// means the whole source session was junk (its summary topic is low-signal, e.g.
// a chief-of-staff heartbeat), so none of its learnings are worth reviewing.
export type PreLlmSkipReason = "low_signal" | "duplicate" | "low_signal_session";

export type PreLlmSkip = {
  learning_id: string;
  session_id: string;
  reason: PreLlmSkipReason;
};

export type LearningPartition = {
  toReview: Learning[];
  skipped: PreLlmSkip[];
};

// Normalize a statement for duplicate detection: collapse whitespace and
// case-fold so cosmetic differences don't masquerade as distinct learnings.
function normalizeStatement(statement: string): string {
  return statement.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Split a session's learnings into those worth paying an LLM to review and those
 * the deterministic heuristics already condemn. Two pure savings:
 *  - low-signal/test-session noise (reuses `isLowSignalTopic`, the same junk/
 *    harness/boot/test-prompt detection the audit uses) — these would be
 *    rejected anyway, so reviewing them is wasted spend.
 *  - exact-duplicate statements — deduped against `seenStatements`, which the
 *    caller threads across the whole run so cross-session repeats are caught too.
 *
 * `seenStatements` is mutated in place with each kept statement's normalized key.
 */
export function partitionLearningsForReview(
  learnings: readonly Learning[],
  sessionId: string,
  seenStatements: Set<string>,
): LearningPartition {
  const toReview: Learning[] = [];
  const skipped: PreLlmSkip[] = [];

  for (const learning of learnings) {
    if (isLowSignalTopic(learning.statement)) {
      skipped.push({
        learning_id: learning.learning_id,
        session_id: sessionId,
        reason: "low_signal",
      });
      continue;
    }

    const key = normalizeStatement(learning.statement);
    if (seenStatements.has(key)) {
      skipped.push({
        learning_id: learning.learning_id,
        session_id: sessionId,
        reason: "duplicate",
      });
      continue;
    }

    seenStatements.add(key);
    toReview.push(learning);
  }

  return { toReview, skipped };
}
