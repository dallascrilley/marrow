import type { Learning, SourceSession } from "../../models/canonical.js";
import type { SupportedSource } from "../../pipeline/discover.js";
import { replayBundles, saveSessionBundle } from "../instinct/bundle.js";
import { buildSessionBundleFromLearnings } from "../instinct/from-learning.js";
import { saveAllInstincts } from "../instinct/store.js";
import { resolveProjectIdForSession } from "../project/resolve.js";

/**
 * Writes reviewed learnings into the per-project instinct store.
 *
 * This function intentionally does not refresh the global promotion queue.
 * Batch callers that receive any `bundleWritten: true` result must call
 * `refreshPromotionQueue` once after the batch, so applying N reviewed sessions
 * performs one cross-project promotion scan instead of N scans.
 */
export async function syncReviewedLearningsToInstinctStore(input: {
  session: SourceSession;
  learnings: readonly Learning[];
  sourceAdapter: SupportedSource;
  reviewedAt: string;
  reviewer: string | null;
}): Promise<{ bundleWritten: boolean; instinctCount: number; projectId: string }> {
  if (input.learnings.length === 0) {
    const projectId = (await resolveProjectIdForSession(input.session)).id;
    return { bundleWritten: false, instinctCount: 0, projectId };
  }

  const projectId = (await resolveProjectIdForSession(input.session)).id;
  const bundle = buildSessionBundleFromLearnings({
    ...input,
    projectId,
  });
  await saveSessionBundle(bundle);

  const instincts = await replayBundles(projectId);
  await saveAllInstincts(projectId, instincts);

  return { bundleWritten: true, instinctCount: instincts.size, projectId };
}
