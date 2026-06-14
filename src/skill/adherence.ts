import type { Turn } from "../models/canonical.js";
import type { SummaryEvidenceInput } from "./resolve-skill.js";
import { findSkillEvidenceInSummary } from "./resolve-skill.js";

export type SkillChecklistItem = {
  line: string;
  matchKey: string;
};

export type SessionAdherenceScore = {
  asd_session_id: string;
  checklist_hits: string[];
  checklist_total: number;
  evidence_fields: string[];
  failures: string[];
  invoked_in_transcript: boolean;
  score: number;
  topic: string;
};

export function parseSkillChecklist(markdown: string): SkillChecklistItem[] {
  const withoutFrontmatter = markdown.replace(/^---[\s\S]*?---\s*/u, "");
  const items: SkillChecklistItem[] = [];

  for (const rawLine of withoutFrontmatter.split("\n")) {
    const line = rawLine.trim();
    const bulletMatch = line.match(/^(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s+)?(.+)$/u);
    if (!bulletMatch?.[1]) {
      continue;
    }

    const text = bulletMatch[1].replace(/`/g, "").trim();
    if (text.length < 8) {
      continue;
    }

    items.push({
      line: text,
      matchKey: normalizeMatchKey(text),
    });
  }

  return items;
}

export function reducedSessionText(turns: readonly Turn[]): string {
  return turns
    .flatMap((turn) => [turn.user_prompt, turn.assistant_summary])
    .join("\n")
    .toLowerCase();
}

export function sessionInvokesSkill(text: string, skillId: string): boolean {
  const normalized = text.toLowerCase();
  const variants = [
    skillId.toLowerCase(),
    skillId.toLowerCase().replaceAll("-", " "),
    skillId.toLowerCase().replaceAll("-", "_"),
  ];

  return variants.some((variant) => normalized.includes(variant));
}

export function scoreSessionAdherence(input: {
  asdSessionId: string;
  checklist: readonly SkillChecklistItem[];
  reducedText: string;
  skillId: string;
  summary: SummaryEvidenceInput;
  topic: string;
}): SessionAdherenceScore | null {
  const evidenceFields = findSkillEvidenceInSummary(input.skillId, input.summary);
  const invokedInTranscript = sessionInvokesSkill(input.reducedText, input.skillId);

  if (evidenceFields.length === 0 && !invokedInTranscript) {
    return null;
  }

  const checklistHits = input.checklist
    .filter((item) => checklistItemMatches(input.reducedText, item))
    .map((item) => item.line);

  const failures = [...input.summary.what_failed, ...input.summary.user_learnings].filter((entry) =>
    sessionInvokesSkill(entry, input.skillId),
  );

  const checklistCoverage =
    input.checklist.length === 0 ? 1 : checklistHits.length / input.checklist.length;
  const invocationScore = invokedInTranscript || evidenceFields.length > 0 ? 1 : 0;
  const failurePenalty = failures.length > 0 ? 0 : 1;
  const score = Number(
    (0.4 * invocationScore + 0.4 * checklistCoverage + 0.2 * failurePenalty).toFixed(3),
  );

  return {
    asd_session_id: input.asdSessionId,
    checklist_hits: checklistHits,
    checklist_total: input.checklist.length,
    evidence_fields: evidenceFields,
    failures,
    invoked_in_transcript: invokedInTranscript,
    score,
    topic: input.topic,
  };
}

export function buildSkillSuggestions(input: {
  checklist: readonly SkillChecklistItem[];
  sessions: readonly SessionAdherenceScore[];
}): string[] {
  if (input.sessions.length === 0) {
    return [
      "No indexed sessions mention this skill in summaries or reduced transcripts. Run export-index after ingest, or broaden skill description triggers.",
    ];
  }

  const suggestions: string[] = [];
  const hitCounts = new Map<string, number>();

  for (const item of input.checklist) {
    hitCounts.set(item.line, 0);
  }

  for (const session of input.sessions) {
    for (const hit of session.checklist_hits) {
      hitCounts.set(hit, (hitCounts.get(hit) ?? 0) + 1);
    }
  }

  for (const [line, count] of hitCounts) {
    const rate = count / input.sessions.length;
    if (count === 0) {
      suggestions.push(
        `Never observed in corpus: "${line}" — add an example or demote if optional.`,
      );
      continue;
    }

    if (rate < 0.25) {
      suggestions.push(
        `Rarely followed (${Math.round(rate * 100)}% of relevant sessions): "${line}" — clarify when this step applies.`,
      );
    }
  }

  const summaryOnly = input.sessions.filter(
    (session) => session.evidence_fields.length > 0 && !session.invoked_in_transcript,
  ).length;
  if (summaryOnly > 0) {
    suggestions.push(
      `${summaryOnly} session(s) mention the skill in distilled summaries but not in reduced turns — strengthen SKILL.md description/trigger wording.`,
    );
  }

  const withFailures = input.sessions.filter((session) => session.failures.length > 0);
  if (withFailures.length > 0) {
    suggestions.push(
      `${withFailures.length} session(s) recorded failures while using this skill — add a pitfalls section with those patterns.`,
    );
  }

  if (suggestions.length === 0) {
    suggestions.push(
      "Checklist steps appear consistently across relevant sessions; no heuristic gaps flagged.",
    );
  }

  return suggestions;
}

function normalizeMatchKey(text: string): string {
  const words = significantWords(text);
  if (words.length === 0) {
    return text.toLowerCase().slice(0, 40);
  }

  return words.slice(0, 6).join(" ");
}

function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/gu, " ")
    .split(/\s+/u)
    .filter((word) => word.length >= 4);
}

function checklistItemMatches(haystack: string, item: SkillChecklistItem): boolean {
  if (haystack.includes(item.matchKey)) {
    return true;
  }

  const words = significantWords(item.line);
  if (words.length === 0) {
    return false;
  }

  const hits = words.filter((word) => haystack.includes(word));
  const threshold = Math.max(2, Math.ceil(words.length * 0.5));
  return hits.length >= threshold;
}
