/**
 * Shared artifact-quality heuristics used by extraction, summarization, and audit.
 *
 * Keep predicates conservative and well-commented. Any change here affects
 * multiple consumers, so add regression tests in both extract-project-learnings
 * and quality-audit suites.
 */

export type SummarySignalFields = {
  files_of_interest: readonly string[];
  next_step: string;
  project_learnings: readonly string[];
  user_learnings: readonly string[];
  useful_commands: readonly string[];
  what_failed: readonly string[];
  what_was_decided: readonly string[];
  what_worked: readonly string[];
};

const processPhrasePattern =
  /^(?:let me|i(?:'|')ll|i will|i need to|i(?:'|')m|checking|exploring|now let me|now i(?:'|')ll|now i(?:'|')m|first, let me|first, i(?:'|')ll|first, i(?:'|')m|now\s+(?:stage|regenerate|check|inspect|read|review|run|verify|commit|add|update|fix|implement|create|write))\b/i;

const completedDurableOutcomePattern =
  /\b(?:fixed|resolved|implemented|updated|added|removed|replaced|merged|pushed|verified with|tests? pass(?:ed)?|build succeeded|all checks passed)\b/i;

/**
 * True when a single line is process-only assistant narration.
 *
 * A line that starts with process wording is chatter unless it contains a
 * completed durable outcome. Mentions of files, commands, or generic concrete
 * terms alone are not enough when the line is still future/action narration.
 */
export function looksLikeProcessChatterLine(line: string): boolean {
  const normalized = line.trim();

  if (normalized.length === 0) {
    return false;
  }

  if (!processPhrasePattern.test(normalized)) {
    return false;
  }

  if (completedDurableOutcomePattern.test(normalized)) {
    return false;
  }
  return true;
}

/**
 * True when any line in the text looks like process-only assistant chatter.
 */
export function isProcessChatterText(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    if (looksLikeProcessChatterLine(line)) {
      return true;
    }
  }

  return false;
}

/**
 * True when any summary field contains process-only assistant chatter.
 */
export function hasProcessChatter(summaryText: string): boolean {
  return isProcessChatterText(summaryText);
}

/**
 * True when the summary carries harness wrapper tags that should not be
 * surfaced to the operator or persisted as knowledge.
 */
export function hasWrapperTags(text: string): boolean {
  return /<(?:attached_files|code_selection|plugin_info|skill)\b/i.test(text);
}

/**
 * True when the summary has no useful durable signal and no explicit next step.
 */
export function isLowSignalSummary(summary: SummarySignalFields): boolean {
  return (
    !hasUsefulSummarySignal(summary) && summary.next_step === "No explicit next step recorded."
  );
}

/**
 * True when at least one summary field contains durable signal.
 */
export function hasUsefulSummarySignal(summary: SummarySignalFields): boolean {
  return (
    summary.what_worked.length > 0 ||
    summary.what_failed.length > 0 ||
    summary.what_was_decided.length > 0 ||
    summary.useful_commands.length > 0 ||
    summary.files_of_interest.length > 0 ||
    summary.project_learnings.length > 0 ||
    summary.user_learnings.length > 0
  );
}

/**
 * True when a next-step value describes an already-completed outcome instead of
 * an open action.
 */
export function looksLikeCompletedOutcome(value: string): boolean {
  return (
    /\b(?:done|completed|implemented|fixed|resolved|merged|pushed)\b/i.test(value) &&
    /\b(?:verified|tests? pass(?:ed)?|all checks passed|0 failures)\b/i.test(value)
  );
}

/**
 * True when a statement is a single-sentence atomic fact.
 *
 * Used to reject multi-sentence assistant narratives that were promoted as
 * decisions or failure modes. Verified-fix patterns are exempted elsewhere.
 */
export function isAtomicStatement(value: string): boolean {
  const normalized = value.trim();
  if (normalized.length === 0) return false;

  // Count sentence terminators that are followed by whitespace or end-of-string.
  // Semicolons do not count as sentence boundaries (they often join clauses in
  // verified-fix statements like "...; verified.").
  const sentenceEnds = normalized.match(/[.!?]+(?:\s|$)/g);
  return sentenceEnds === null || sentenceEnds.length <= 1;
}
