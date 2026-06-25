import type { Learning, SourceSession } from "../../models/canonical.js";
import type { SupportedSource } from "../../pipeline/discover.js";
import { replayBundles, saveSessionBundle } from "../instinct/bundle.js";
import { buildSessionBundleFromLearnings } from "../instinct/from-learning.js";
import { saveAllInstincts } from "../instinct/store.js";
import { resolveProjectIdForSession } from "../project/resolve.js";
import { refreshPromotionQueue } from "../promotion/queue.js";

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
  await refreshPromotionQueue(input.reviewedAt);

  return { bundleWritten: true, instinctCount: instincts.size, projectId };
}
