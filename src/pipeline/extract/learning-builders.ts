import type {
  ConfidenceLevel,
  EvidenceType,
  Learning,
  LearningKind,
  SourceRef,
  SourceSession,
} from "../../models/canonical.js";

export function createLearning(input: {
  confidence: ConfidenceLevel;
  evidence: string[];
  evidenceType: EvidenceType;
  kind: LearningKind;
  learningId: string;
  promotionBasis: string;
  scope: Learning["scope"];
  scopeKey: string;
  sourceRefs: SourceRef[];
  statement: string;
  title: string;
  trigger: string;
  skillRefs?: string[];
  technologies?: string[];
}): Learning {
  return {
    confidence: input.confidence,
    evidence: input.evidence,
    evidence_type: input.evidenceType,
    kind: input.kind,
    learning_id: input.learningId,
    promotion_basis: input.promotionBasis,
    scope: input.scope,
    scope_key: input.scopeKey,
    skill_ref: input.skillRefs ?? [],
    source_refs: input.sourceRefs,
    statement: input.statement,
    technologies: input.technologies ?? [],
    title: input.title,
    trigger: input.trigger,
  } satisfies Learning;
}

export function createSourceRef(
  sourceSession: SourceSession,
  options: {
    eventId?: string;
    line?: number | null;
    turnId?: string;
  },
): SourceRef {
  return {
    event_id: options.eventId ?? null,
    line: options.line ?? null,
    session_id: sourceSession.session_id,
    source_hash: sourceSession.source_hash,
    source_path: sourceSession.source_path,
    turn_id: options.turnId ?? null,
  };
}

export function dedupeLearnings(learnings: readonly Learning[]): Learning[] {
  const seen = new Set<string>();
  const uniqueLearnings: Learning[] = [];

  for (const learning of learnings) {
    const dedupeKey = `${learning.scope}:${learning.kind}:${learning.statement.toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    uniqueLearnings.push(learning);
  }

  return uniqueLearnings;
}
