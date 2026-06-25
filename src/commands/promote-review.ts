import type { CommandContext } from "../cli.js";
import { readPromotionQueue } from "../v2/promotion/queue.js";

export async function executePromoteReview(context: CommandContext): Promise<number> {
  const entries = await readPromotionQueue();
  context.output.info(JSON.stringify({ entries }, null, 2));
  return 0;
}
