import type { Learning, SourceSession } from "../../models/canonical.js";
import type { SupportedSource } from "../../pipeline/discover.js";
import { instinctIdFromTriggerFinding } from "./id.js";
import { CONFIDENCE_MIN, type CreateDelta, type Domain, type SessionBundle } from "./schema.js";

const CONFIDENCE_BY_LEVEL: Record<Learning["confidence"], number> = {
  high: 0.7,
  medium: 0.55,
  low: 0.4,
};

export function domainFromLearning(learning: Learning): Domain {
  switch (learning.kind) {
    case "verification_rule":
      return "testing";
    case "failure_mode":
      return "debugging";
    case "pattern":
      return "code-style";
    case "workflow":
      return "workflow";
    case "preference":
      return "tooling";
    case "decision":
      return "workflow";
    default:
      return "workflow";
  }
}

export function createDeltaFromLearning(learning: Learning): CreateDelta {
  // Use the extracted precondition; fall back to the title only if a legacy
  // learning predates trigger extraction (tier-1 classification contract).
  const trigger = learning.trigger.trim() || learning.title.trim();
  const finding = learning.statement.trim();
  return {
    op: "create",
    instinct_id: instinctIdFromTriggerFinding(trigger, finding),
    trigger,
    finding,
    domain: domainFromLearning(learning),
    initial_confidence: Math.max(
      CONFIDENCE_MIN,
      CONFIDENCE_BY_LEVEL[learning.confidence] ?? CONFIDENCE_MIN,
    ),
  };
}

export function buildSessionBundleFromLearnings(input: {
  session: SourceSession;
  projectId: string;
  learnings: readonly Learning[];
  sourceAdapter: SupportedSource;
  reviewedAt: string;
  reviewer: string | null;
}): SessionBundle {
  const deltas = input.learnings.map((learning) => createDeltaFromLearning(learning));
  const diaryLines = input.learnings.map(
    (learning) => `- ${learning.title}: ${learning.statement}`,
  );

  return {
    schema_version: 1,
    session_id: input.session.session_id,
    project_id: input.projectId,
    source_adapter: mapSourceAdapter(input.sourceAdapter),
    source_transcript: input.session.source_path,
    ingested_at: input.reviewedAt,
    reviewed_at: input.reviewedAt,
    reviewer: input.reviewer,
    diary:
      diaryLines.length > 0
        ? `Approved learnings from session ${input.session.session_id}:\n${diaryLines.join("\n")}`
        : `No approved learnings for session ${input.session.session_id}.`,
    deltas,
    extraction_cost: null,
  };
}

function mapSourceAdapter(source: SupportedSource): SessionBundle["source_adapter"] {
  switch (source) {
    case "cursor":
      return "cursor";
    case "codex-cli":
      return "codex-cli";
    case "kimi":
      return "kimi";
    case "pi":
      return "pi";
    case "claude-code":
      return "claude-code";
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}
