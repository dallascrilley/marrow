import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getRuntimePath } from "../config/paths.js";

export type WorkflowDecisionKind = "adopt" | "dismiss" | "defer" | "judged";

export type WorkflowDecision = {
  candidate_id: string;
  decided_at: string;
  decision: WorkflowDecisionKind;
  note?: string;
  rule_id: string;
};

export function workflowDecisionLedgerPath(): string {
  return join(getRuntimePath("reports"), "workflow-decisions.jsonl");
}

export async function appendWorkflowDecision(
  decision: Omit<WorkflowDecision, "decided_at"> & { decided_at?: string },
): Promise<WorkflowDecision> {
  const entry: WorkflowDecision = {
    ...decision,
    decided_at: decision.decided_at ?? new Date().toISOString(),
  };
  const path = workflowDecisionLedgerPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", flag: "a" });
  return entry;
}

export async function readWorkflowDecisions(): Promise<WorkflowDecision[]> {
  try {
    const contents = await readFile(workflowDecisionLedgerPath(), "utf8");
    return contents
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as WorkflowDecision;
          if (
            typeof parsed.candidate_id === "string" &&
            typeof parsed.rule_id === "string" &&
            (parsed.decision === "adopt" ||
              parsed.decision === "dismiss" ||
              parsed.decision === "defer" ||
              parsed.decision === "judged") &&
            typeof parsed.decided_at === "string"
          ) {
            return [parsed];
          }
        } catch {
          return [];
        }
        return [];
      });
  } catch {
    return [];
  }
}

export async function latestWorkflowDecisionMap(): Promise<Map<string, WorkflowDecision>> {
  const latest = new Map<string, WorkflowDecision>();
  for (const decision of await readWorkflowDecisions()) {
    latest.set(decision.candidate_id, decision);
  }
  return latest;
}
