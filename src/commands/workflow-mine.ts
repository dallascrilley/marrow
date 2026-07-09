import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { mineWorkflowCandidates } from "../workflow/mine.js";
import type { WorkflowCandidate } from "../workflow/schema.js";

export async function executeWorkflowMine(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const options = parseWorkflowMineArgs(context.args);
  const result = await mineWorkflowCandidates({
    database,
    days: options.days,
    limit: options.limit,
    source: options.source,
  });

  if (options.json) {
    context.output.info(JSON.stringify(result, null, 2));
    return 0;
  }

  context.output.info(
    `Workflow candidates: ${result.candidates.length} (${result.sessions_scanned} sessions scanned, ${result.days} days${result.source ? `, source=${result.source}` : ""})`,
  );

  for (const candidate of result.candidates) {
    context.output.info(formatCandidate(candidate));
  }

  return 0;
}

function parseWorkflowMineArgs(args: string[]): {
  days: number;
  json: boolean;
  limit: number;
  source: string | null;
} {
  let days = 7;
  let json = false;
  let limit = 20;
  let source: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--days" || arg.startsWith("--days=")) {
      const value = arg === "--days" ? args[index + 1] : arg.slice("--days=".length);
      if (!value || value.startsWith("--")) {
        throw new Error("--days requires a value");
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error("--days must be a positive integer");
      }
      days = parsed;
      if (arg === "--days") index += 1;
      continue;
    }

    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const value = arg === "--limit" ? args[index + 1] : arg.slice("--limit=".length);
      if (!value || value.startsWith("--")) {
        throw new Error("--limit requires a value");
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error("--limit must be a positive integer");
      }
      limit = parsed;
      if (arg === "--limit") index += 1;
      continue;
    }

    if (arg === "--source" || arg.startsWith("--source=")) {
      const value = arg === "--source" ? args[index + 1] : arg.slice("--source=".length);
      if (!value || value.startsWith("--")) {
        throw new Error("--source requires a value");
      }
      source = value;
      if (arg === "--source") index += 1;
      continue;
    }

    throw new Error(`Unknown flag: ${arg}`);
  }

  return { days, json, limit, source };
}

function formatCandidate(candidate: WorkflowCandidate): string {
  const evidence = candidate.evidence_sessions
    .map((item) => `${item.asd_session_id}:${item.evidence_kind}`)
    .join(", ");

  return [
    "",
    `${candidate.candidate_id}\t${candidate.confidence}\t${candidate.recommendation}\t${candidate.artifact_kind}\t${candidate.cluster}`,
    `Trigger: ${candidate.trigger}`,
    `Guidance: ${candidate.guidance}`,
    `Evidence: ${evidence}`,
  ].join("\n");
}
