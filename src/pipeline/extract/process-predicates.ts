import { isProcessChatterText } from "../artifact-heuristics.js";

export function looksLikeRawCompletionBlock(value: string): boolean {
  return (
    /\*\*(?:Done|Verified|Changed|Changes|Implemented|Summary of changes):\*\*/i.test(value) ||
    /summary of what was done/i.test(value)
  );
}

export function looksLikeProcessNarration(value: string): boolean {
  const normalized = value.trim().toLowerCase();

  return (
    isProcessChatterText(value) ||
    /\b(?:let me|i(?:'|’)m checking|i(?:'|’)ll check|i need to check|checking whether|now let me|clarifying)\b/i.test(
      value,
    ) ||
    /\b(?:would be like|what(?:'|’)s next\?|continue workflow|recommended\)|generation runs, but)\b/i.test(
      normalized,
    ) ||
    /\bi can detect\b/i.test(value) ||
    normalized.startsWith("summary of what was done")
  );
}

export function isProcessText(summary: string): boolean {
  if (isProcessChatterText(summary)) {
    return true;
  }

  const normalized = summary.trim().toLowerCase();

  const processPrefixes = [
    "reading ",
    "loading ",
    "creating a ",
    "implementing ",
    "adding ",
    "updating ",
    "now i have enough context",
    "now i understand",
    "now i see",
    "first, the ",
    "i see - there's",
    "i see - the",
    "i need to add",
    "i need to update",
    "i need to fix",
    "rust compiles and",
    "the toast infrastructure",
    "the command infrastructure",
    "--- ## ",
  ];

  for (const prefix of processPrefixes) {
    if (normalized.startsWith(prefix)) {
      return true;
    }
  }

  return false;
}

export function looksLikeCompletionNotFailure(summary: string): boolean {
  const normalized = summary.trim().toLowerCase();

  if (normalized.startsWith("**done:**")) {
    return true;
  }

  if (
    normalized.startsWith("## ") &&
    !normalized.includes("error") &&
    !normalized.includes("fail")
  ) {
    return true;
  }

  if (
    /\bverified\b.+(?:against|with|using)\b/i.test(normalized) &&
    !/\b(?:error|fail|exception)\b/i.test(normalized)
  ) {
    return true;
  }

  if (
    normalized.startsWith("summary of what's done:") ||
    normalized.startsWith("summary of what’s done:")
  ) {
    return true;
  }

  if (normalized.startsWith("--- ## ") && /\bbatch \d+ complete\b/i.test(normalized)) {
    return true;
  }

  return false;
}
