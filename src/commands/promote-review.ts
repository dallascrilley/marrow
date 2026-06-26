import type { CommandContext } from "../cli.js";
import { readPromotionQueue } from "../v2/promotion/queue.js";

export async function executePromoteReview(context: CommandContext): Promise<number> {
  const entries = await readPromotionQueue();
  // Lead with a human-readable line so the JSON is scannable at a glance;
  // `entries` stays the machine-readable payload consumers parse.
  const summary =
    entries.length === 0
      ? "No instincts are queued for cross-project promotion."
      : `${entries.length} instinct(s) queued for cross-project promotion.`;
  context.output.info(JSON.stringify({ summary, entries }, null, 2));
  return 0;
}
