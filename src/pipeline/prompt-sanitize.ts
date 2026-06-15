/** Max bytes stored in learning evidence arrays (UTF-8). */
export const DEFAULT_EVIDENCE_MAX_BYTES = 512;

const attachedFilesPattern = /<attached_files>[\s\S]*?<\/attached_files>/gi;
const codeSelectionPattern = /<code_selection\b[^>]*>[\s\S]*?<\/code_selection>/gi;
const pluginInfoPattern = /<plugin_info\b[^>]*>[\s\S]*?<\/plugin_info>/gi;
const skillBlockPattern = /<skill\b[^>]*>[\s\S]*?(?:<\/skill>|$)/gi;
const skillFilePathPattern = /(?:^|\s)[^\s]*\/SKILL\.md\b/gi;
const taggedBlockPattern =
  /<(instructions|environment_context|cursor_commands|skill|system[-_]reminder|command-message|command-name|command-args|task-notification|local-command-(?:stdout|stderr)|user-prompt-submit-hook|bash-(?:input|stdout|stderr)|user_info|rules|agent_skills|mcp_instructions|open_and_recently_viewed_files|git_status|agent_transcripts|attached_files|code_selection|plugin_info)\b[^>]*>[\s\S]*?<\/\1>/gi;
const genericXmlTagPattern = /<\/?[a-z_:-]+(?:\s+[^>]*)?>/gi;

const instructionsFileHeaderPattern = /^#\s*(?:AGENTS|CLAUDE)\.md\b/i;
const instructionsFileNoticePattern = /^(?:AGENTS|CLAUDE)\.md\s+instructions\s+for\b/i;
const wrapperNoticePattern =
  /^(?:system[-_]reminder|environment_context|command-message|command-name|command-args|task-notification|local-command-(?:stdout|stderr)|user-prompt-submit-hook|bash-(?:input|stdout|stderr))\b/i;

const noSignalPatterns: readonly RegExp[] = [
  /^(?:hello|hi|hey|ping|test)\b[!.?]*$/i,
  /^say\s+one\b/i,
  /^what\s+is\s+2\s*\+\s*2\??$/i,
  /^first\s+message\b/i,
  /^\[?(?:redacted\s+)?user\s+message(?:\s+unavailable)?\]?$/i,
  /^(?:thanks|thank you|thx|ty)\b[!.?]*$/i,
  /^(?:ok|okay|k|yep|yes|no|nope)\b[!.?]*$/i,
  /^(?:good|great|cool|nice)\b[!.?]*$/i,
  /^what(?:'s| is) (?:your|the) name\??$/i,
  /^who are you\??$/i,
  /^are you there\??$/i,
  /^can you hear me\??$/i,
  /^\?+$/,
];

/**
 * Strip harness/boot context from a raw user prompt. Does not truncate.
 */
export function sanitizeUserPrompt(raw: string): string {
  let value = raw.replace(/\r/g, "\n");
  value = value.replace(attachedFilesPattern, " ");
  value = value.replace(codeSelectionPattern, " ");
  value = value.replace(pluginInfoPattern, " ");
  value = value.replace(skillBlockPattern, " ");
  value = value.replace(skillFilePathPattern, " ");
  value = value.replace(taggedBlockPattern, " ");

  const userQuery = extractTaggedSection(value, "user_query");
  if (userQuery !== null) {
    value = userQuery;
  }

  value = value.replace(genericXmlTagPattern, " ");
  value = collapseBlankLines(value).trim();
  return value;
}

/**
 * Sanitize assistant/event text that may embed harness or skill metadata.
 */
export function sanitizeHarnessLeakText(raw: string): string {
  const sanitized = sanitizeUserPrompt(raw);
  if (sanitized.length === 0) {
    return "";
  }

  const lines = sanitized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isHarnessOrBootLine(line) && !isSkillHarnessLine(line));

  return lines.join("\n").trim();
}

/**
 * Returns task text after harness removal, or null if nothing substantive remains.
 */
export function extractSubstantivePrompt(raw: string): string | null {
  const sanitized = sanitizeUserPrompt(raw);
  if (sanitized.length === 0) {
    return null;
  }

  const lines = sanitized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const substantiveLines = lines.filter(
    (line) => !isHarnessOrBootLine(line) && !isSkillHarnessLine(line),
  );
  if (substantiveLines.length === 0) {
    return null;
  }

  return substantiveLines.join("\n").trim();
}

export function isHarnessOrBootLine(line: string): boolean {
  const normalized = line.trim();
  if (normalized.length === 0) {
    return true;
  }

  if (
    instructionsFileHeaderPattern.test(normalized) ||
    instructionsFileNoticePattern.test(normalized)
  ) {
    return true;
  }

  if (wrapperNoticePattern.test(normalized)) {
    return true;
  }

  if (/^turn_aborted$/i.test(normalized)) {
    return true;
  }

  if (/^Caveat:/i.test(normalized)) {
    return true;
  }

  if (/^\[Request interrupted by user\b/i.test(normalized)) {
    return true;
  }

  if (/^\[Image:[^\]]+\]$/i.test(normalized)) {
    return true;
  }

  if (/^Follow project (?:rules|standards)\.?$/i.test(normalized)) {
    return true;
  }

  if (/^<\/?[a-z_:-]+/i.test(normalized)) {
    return true;
  }

  if (/^(?:instructions|environment_context|cursor_commands)\b/i.test(normalized)) {
    return true;
  }

  if (isSkillHarnessLine(normalized)) {
    return true;
  }

  if (
    /^✓/.test(normalized) ||
    /^Test Files\b/i.test(normalized) ||
    /^Duration\b/i.test(normalized)
  ) {
    return true;
  }

  return false;
}

export function capEvidenceText(
  text: string,
  maxBytes: number = DEFAULT_EVIDENCE_MAX_BYTES,
): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return "";
  }

  const bytes = Buffer.from(normalized, "utf8");
  if (bytes.length <= maxBytes) {
    return normalized;
  }

  const ellipsis = "…";
  const ellipsisBytes = Buffer.byteLength(ellipsis, "utf8");
  const budget = Math.max(0, maxBytes - ellipsisBytes);
  let end = budget;
  while (end > 0 && ((bytes.at(end) ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }

  return `${bytes.subarray(0, end).toString("utf8").trimEnd()}${ellipsis}`;
}

export function learningEvidenceFromPrompt(
  rawPrompt: string,
  ...extra: readonly string[]
): string[] {
  const substantive = extractSubstantivePrompt(rawPrompt);
  const promptEvidence = substantive !== null ? capEvidenceText(substantive) : "";
  const items = promptEvidence.length > 0 ? [promptEvidence, ...extra] : [...extra];
  return uniqueNonEmpty(
    items
      .map((item) => capEvidenceText(sanitizeHarnessLeakText(item)))
      .filter((item) => item.length > 0 && !looksLikeSkillHarnessLeak(item)),
  );
}

/**
 * Rebuild a learning title from a sanitized statement when the title body still
 * carries harness markup (e.g. leftover `<skill>` in spec-decision topics).
 */
export function sanitizeLearningTitle(
  title: string,
  statement: string,
  maxBodyLength: number,
): string {
  const cleanStatement = sanitizeHarnessLeakText(statement);
  if (cleanStatement.length === 0) {
    return "";
  }

  const colonIndex = title.indexOf(":");
  if (colonIndex < 0) {
    return truncateInline(cleanStatement, maxBodyLength);
  }

  const prefix = title.slice(0, colonIndex).trim();
  if (/<\/?skill\b/i.test(title)) {
    return `${prefix}: ${truncateInline(cleanStatement, maxBodyLength)}`;
  }

  const body = sanitizeLearningStatement(sanitizeHarnessLeakText(title.slice(colonIndex + 1)));
  const bodyIsClean =
    body.length > 0 &&
    !looksLikeSkillHarnessLeak(body) &&
    !/<\/?skill\b/i.test(body) &&
    !/\*\*/g.test(body) &&
    !/\|/g.test(body) &&
    !/#\s+/g.test(body);

  return `${prefix}: ${truncateInline(bodyIsClean ? body : cleanStatement, maxBodyLength)}`;
}

export function isNoSignalPrompt(raw: string): boolean {
  const substantive = extractSubstantivePrompt(raw);
  if (substantive === null) {
    return true;
  }

  const singleLine = substantive.replace(/\s+/g, " ").trim();
  if (singleLine.length === 0) {
    return true;
  }

  if (isShortConversationalNoSignal(singleLine)) {
    return true;
  }

  for (const pattern of noSignalPatterns) {
    if (pattern.test(singleLine)) {
      return true;
    }
  }

  return false;
}

/**
 * True when every substantive user turn is no-signal (typical 1–3 turn Pi/Codex smoke).
 */
export function isTinyNoSignalSession(turns: ReadonlyArray<{ user_prompt: string }>): boolean {
  if (turns.length === 0 || turns.length > 3) {
    return false;
  }

  let substantiveTurnCount = 0;

  for (const turn of turns) {
    const substantive = extractSubstantivePrompt(turn.user_prompt);
    if (substantive === null) {
      continue;
    }

    substantiveTurnCount += 1;

    if (!isNoSignalPrompt(substantive)) {
      return false;
    }
  }

  return substantiveTurnCount === 0 || substantiveTurnCount <= 3;
}

export function looksLikeSkillHarnessLeak(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return false;
  }

  if (/<\/?skill\b/i.test(normalized)) {
    return true;
  }

  if (/\bBase directory for this skill\b/i.test(normalized)) {
    return true;
  }

  if (/\/SKILL\.md\b/i.test(normalized)) {
    return true;
  }

  if (/^(?:using|i am using)\s+(?:the\s+)?[\w-]+\s+skill\b/i.test(normalized)) {
    return true;
  }

  return isSkillHarnessLine(normalized);
}

export function isSkillWrapperOnlyPrompt(raw: string): boolean {
  const substantive = extractSubstantivePrompt(raw);
  if (substantive === null) {
    return true;
  }

  const lines = substantive
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return true;
  }

  return lines.every(
    (line) =>
      isHarnessOrBootLine(line) || isSkillHarnessLine(line) || looksLikeSkillHarnessLeak(line),
  );
}

export function firstSubstantivePromptFromTurns(
  turns: ReadonlyArray<{ user_prompt: string }>,
): string | null {
  for (const turn of turns) {
    if (isSkillWrapperOnlyPrompt(turn.user_prompt)) {
      continue;
    }

    const substantive = extractSubstantivePrompt(turn.user_prompt);
    if (substantive !== null && !isNoSignalPrompt(substantive)) {
      return substantive;
    }
  }

  return null;
}

function extractTaggedSection(value: string, tagName: string): string | null {
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = value.match(pattern);
  return match?.[1]?.trim() || null;
}

function collapseBlankLines(value: string): string {
  return value.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

function isSkillHarnessLine(line: string): boolean {
  const normalized = line.trim();
  if (normalized.length === 0) {
    return false;
  }

  return (
    /^<\/?skill\b/i.test(normalized) ||
    /\/SKILL\.md\b/i.test(normalized) ||
    /^Base directory for this skill\b/i.test(normalized) ||
    /^Skill (?:file|directory|location)\b/i.test(normalized) ||
    /^Use when\b/i.test(normalized) ||
    /^Triggers?\b/i.test(normalized) ||
    /^Description:\s/i.test(normalized) ||
    /^(?:Using|I am using) (?:the )?[\w-]+\s+skill\b/i.test(normalized) ||
    /^Read (?:the )?`[^`]*\/SKILL\.md`/i.test(normalized)
  );
}

function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function isShortConversationalNoSignal(line: string): boolean {
  if (line.length > 48) {
    return false;
  }

  if (
    /\b(?:fix|implement|refactor|debug|error|failing|tests?|build|commit|pr|merge)\b/i.test(line)
  ) {
    return false;
  }

  if (/[`$\\/]/.test(line)) {
    return false;
  }

  if (!/^[\w\s'?,!.+-]+$/i.test(line)) {
    return false;
  }

  for (const pattern of noSignalPatterns) {
    if (pattern.test(line)) {
      return true;
    }
  }

  return line.length <= 24;
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    unique.push(trimmed);
  }

  return unique;
}

const markdownTableRowPattern = /^\s*\|([^\n]+\|)+[^\n]*$/m;
const markdownTableSeparatorPattern = /^\s*\|?\s*:?-+:?\s*\|/m;
const markdownHeadingPattern = /^(#{1,6})\s+([^\n]+)$/gm;
const markdownBlockFencePattern = /^```[\s\S]*?^```/gm;
const markdownUnclosedFencePattern = /^```[\s\S]*$/gm;
const markdownLinkPattern = /\[([^\]]+)\]\([^)]+\)/g;

/**
 * Remove markdown tables, headings, emphasis, block fences, and list bullets,
 * then collapse whitespace. Intended for project-learning statements only.
 */
export function sanitizeLearningStatement(
  value: string,
  options: { preserveNewlines?: boolean } = {},
): string {
  if (!value) return value;
  let cleaned = value;

  // Strip fenced code blocks first so their content doesn't leak.
  cleaned = cleaned.replace(markdownBlockFencePattern, " ");
  cleaned = cleaned.replace(markdownUnclosedFencePattern, " ");

  // Truncate at the start of a markdown table.
  const tableStart = findMarkdownTableStart(cleaned);
  if (tableStart !== -1) {
    cleaned = cleaned.slice(0, tableStart);
  }
  cleaned = cleaned.replace(/\s*\|\s*/g, " ");

  // Strip headings.
  cleaned = cleaned.replace(markdownHeadingPattern, " $2 ");

  // Strip emphasis/italic wrappers while preserving inner content.
  cleaned = cleaned.replace(/(\*\*|__)([^\n]+?)\1/g, " $2 ");
  cleaned = cleaned.replace(/(?<![\w*])\*([^\n\s][^\n]*?)\*(?![\w*])/g, " $1 ");
  cleaned = cleaned.replace(/(?<![\w_])_([^\n\s][^\n]*?)_(?![\w_])/g, " $1 ");

  // Strip markdown links, keeping only the link text.
  cleaned = cleaned.replace(markdownLinkPattern, "$1");

  // Strip list bullets.
  cleaned = cleaned.replace(/^[\s]*[-*+]\s+/gm, " ");

  // Strip common assistant framing tokens.
  cleaned = cleaned
    .replace(
      /^\s*(?:Verified:|Done\s*[-—]|Good\s*[-—]|Summary of changes:|Summary of what changed:|\*\*Verdict:\*\*|Verdict:)\s*/i,
      " ",
    )
    .trim();

  // Collapse whitespace unless asked to keep newlines for downstream dump detection.
  if (options.preserveNewlines) {
    cleaned = cleaned.replace(/[ \t]+/g, " ").trim();
  } else {
    cleaned = cleaned.replace(/\s+/g, " ").trim();
  }

  return cleaned;
}

function findMarkdownTableStart(value: string): number {
  const lines = value.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (markdownTableSeparatorPattern.test(line)) {
      const headingIndex = findPrecedingHeadingIndex(lines, i);
      const startIndex = headingIndex !== -1 ? headingIndex : i;
      return lines.slice(0, startIndex).join("\n").length + (startIndex > 0 ? 1 : 0);
    }
    if (
      markdownTableRowPattern.test(line) &&
      i + 1 < lines.length &&
      markdownTableSeparatorPattern.test(lines[i + 1] ?? "")
    ) {
      const headingIndex = findPrecedingHeadingIndex(lines, i);
      const startIndex = headingIndex !== -1 ? headingIndex : i;
      return lines.slice(0, startIndex).join("\n").length + (startIndex > 0 ? 1 : 0);
    }
  }
  return -1;
}

function findPrecedingHeadingIndex(lines: readonly string[], fromIndex: number): number {
  for (let j = fromIndex - 1; j >= 0 && j >= fromIndex - 4; j--) {
    const line = lines[j] ?? "";
    if (/^\s*$/.test(line)) {
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      return j;
    }
    break;
  }
  return -1;
}
