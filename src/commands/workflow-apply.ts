import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import {
  isWorkflowDraftTarget,
  type WorkflowDraftTarget,
  writeWorkflowDraft,
} from "../workflow/draft.js";
import { mineWorkflowCandidates } from "../workflow/mine.js";

const APPLY_LOOKUP_LIMIT = Number.MAX_SAFE_INTEGER;

type ApplyOptions = {
  candidateId: string;
  days: number;
  dryRun: boolean;
  source: string | null;
  target: WorkflowDraftTarget;
};

export async function executeWorkflowApply(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const options = parseApplyOptions(context.args);
  if (!options.dryRun) {
    throw new Error("workflow apply currently supports draft-only --dry-run mode");
  }

  const result = await mineWorkflowCandidates({
    database,
    days: options.days,
    includeDecided: true,
    limit: APPLY_LOOKUP_LIMIT,
    source: options.source,
  });
  const candidate = result.candidates.find((item) => item.candidate_id === options.candidateId);
  if (!candidate) {
    throw new Error(`Workflow candidate not found: ${options.candidateId}`);
  }
  if (candidate.status === "already_encoded") {
    throw new Error(
      `Workflow candidate is already encoded in ${candidate.encoded_in ?? "an instinct"}`,
    );
  }
  if (candidate.decision?.decision === "dismiss") {
    throw new Error(
      "Workflow candidate has been dismissed; use workflow adopt/defer before applying",
    );
  }

  const draft = await writeWorkflowDraft(candidate, options.target);
  context.output.info(JSON.stringify(draft, null, 2));
  return 0;
}

function parseApplyOptions(args: string[]): ApplyOptions {
  const candidateId = args[0];
  if (!candidateId || candidateId.startsWith("--")) {
    throw new Error("workflow apply requires a candidate id");
  }

  let days = 7;
  let dryRun = false;
  let source: string | null = null;
  let target: WorkflowDraftTarget | undefined;

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--days" || arg?.startsWith("--days=")) {
      const value = arg === "--days" ? args[index + 1] : arg.slice("--days=".length);
      if (!value || value.startsWith("--")) throw new Error("--days requires a value");
      days = Number.parseInt(value, 10);
      if (!Number.isFinite(days) || days < 1) throw new Error("--days must be a positive integer");
      if (arg === "--days") index += 1;
      continue;
    }
    if (arg === "--source" || arg?.startsWith("--source=")) {
      const value = arg === "--source" ? args[index + 1] : arg.slice("--source=".length);
      if (!value || value.startsWith("--")) throw new Error("--source requires a value");
      source = value;
      if (arg === "--source") index += 1;
      continue;
    }
    if (arg === "--target" || arg?.startsWith("--target=")) {
      const value = arg === "--target" ? args[index + 1] : arg.slice("--target=".length);
      if (!value || value.startsWith("--")) throw new Error("--target requires a value");
      if (!isWorkflowDraftTarget(value)) throw new Error("--target must be rule, skill, or doc");
      target = value;
      if (arg === "--target") index += 1;
      continue;
    }
    throw new Error(`Unknown flag: ${arg}`);
  }

  if (!target) {
    throw new Error("workflow apply requires --target rule|skill|doc");
  }

  return { candidateId, days, dryRun, source, target };
}
