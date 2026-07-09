import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getRuntimePath } from "../config/paths.js";
import { validateSuggestedStatement } from "../pipeline/prompt-sanitize.js";
import type { WorkflowCandidate } from "./schema.js";

export const workflowDraftTargets = ["rule", "skill", "doc"] as const;

export type WorkflowDraftTarget = (typeof workflowDraftTargets)[number];

export type WorkflowDraftResult = {
  apply_report_path: string;
  candidate_id: string;
  draft_path: string;
  dry_run: true;
  target: WorkflowDraftTarget;
  validation_flags: string[];
};

export function isWorkflowDraftTarget(value: string): value is WorkflowDraftTarget {
  return workflowDraftTargets.includes(value as WorkflowDraftTarget);
}

export async function writeWorkflowDraft(
  candidate: WorkflowCandidate,
  target: WorkflowDraftTarget,
): Promise<WorkflowDraftResult> {
  const validationFlags = validateSuggestedStatement(candidate.guidance);
  if (validationFlags.length > 0) {
    throw new Error(`Workflow candidate guidance failed validation: ${validationFlags.join(", ")}`);
  }

  const draftPath = join(
    getRuntimePath("reports"),
    "workflow-drafts",
    `${candidate.candidate_id}-${target}.md`,
  );
  const reportPath = join(
    getRuntimePath("reports"),
    "workflow-drafts",
    `${candidate.candidate_id}-${target}.json`,
  );
  const result: WorkflowDraftResult = {
    apply_report_path: reportPath,
    candidate_id: candidate.candidate_id,
    draft_path: draftPath,
    dry_run: true,
    target,
    validation_flags: validationFlags,
  };

  await mkdir(dirname(draftPath), { recursive: true });
  await writeFile(draftPath, `${renderDraft(candidate, target)}\n`, "utf8");
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

function renderDraft(candidate: WorkflowCandidate, target: WorkflowDraftTarget): string {
  return [
    `# Workflow ${target} draft: ${candidate.candidate_id}`,
    "",
    `- Candidate: ${candidate.candidate_id}`,
    `- Rule: ${candidate.rule_id}`,
    `- Cluster: ${candidate.cluster}`,
    `- Confidence: ${candidate.confidence}`,
    `- Recommendation: ${candidate.recommendation}`,
    `- Risk: ${candidate.risk}`,
    "",
    "## Trigger",
    "",
    candidate.trigger,
    "",
    "## Guidance",
    "",
    candidate.guidance,
    "",
    "## Evidence",
    "",
    `Supporting: ${candidate.supporting_count}; contradicting: ${candidate.contradicting_count}; total: ${candidate.evidence_count}`,
    "",
    ...candidate.evidence_sessions.map(
      (item) =>
        `- ${item.asd_session_id} (${item.evidence_kind}, ${item.matched_rule_id}): ${item.excerpt}`,
    ),
  ].join("\n");
}
