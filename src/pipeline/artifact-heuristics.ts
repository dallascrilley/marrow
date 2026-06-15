import type { Summary } from "../models/canonical.js";

/**
 * Shared, deterministic heuristics used both upstream (while extracting or
 * summarizing) and downstream (while auditing). Keeping the rules in one place
 * guarantees that artifacts filtered after writing are also filtered before
 * they are written.
 */

/** True when text reads like assistant process narration rather than a durable outcome. */
export function isProcessChatterText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }

  return /\b(?:let me|i(?:'|’)ll|i need to|checking|exploring)\b/i.test(value);
}

/** True when text still contains harness wrapper tags that should not reach output. */
export function hasWrapperTags(value: string): boolean {
  return /<(?:attached_files|code_selection|plugin_info|skill)\b/i.test(value);
}

/** True when a summary has no durable signal and no actionable next step. */
export function isLowSignalSummary(summary: Summary): boolean {
  return (
    !hasUsefulSummarySignal(summary) && summary.next_step === "No explicit next step recorded."
  );
}

/** True when any summary field carries durable project or user signal. */
export function hasUsefulSummarySignal(summary: Summary): boolean {
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
