import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { listPipelineStatus } from "../read/operations.js";
import { computeReachability } from "../v2/metrics/reachability.js";
import { summarizeRecallEvents } from "../v2/metrics/recall-events.js";

export async function executeStats(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const [reachability, recall] = await Promise.all([
    computeReachability(),
    summarizeRecallEvents(),
  ]);

  context.output.info(
    JSON.stringify(
      {
        pipeline: listPipelineStatus(database),
        // The number that matters: instincts a future agent can actually reach,
        // and how often recall has surfaced them — not just artifacts produced.
        reachability,
        recall,
      },
      null,
      2,
    ),
  );

  return 0;
}
