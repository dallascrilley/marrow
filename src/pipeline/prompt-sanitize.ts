/** Max bytes stored in learning evidence arrays (UTF-8). */
export const DEFAULT_EVIDENCE_MAX_BYTES = 512;

const attachedFilesPattern = /<attached_files>[\s\S]*?<\/attached_files>/gi;
const codeSelectionPattern = /<code_selection\b[^>]*>[\s\S]*?<\/code_selection>/gi;
const pluginInfoPattern = /<plugin_info\b[^>]*>[\s\S]*?<\/plugin_info>/gi;
const taggedBlockPattern =
	/<(instructions|environment_context|cursor_commands|skill|system_reminder|user_info|rules|agent_skills|mcp_instructions|open_and_recently_viewed_files|git_status|agent_transcripts|attached_files|code_selection|plugin_info)\b[^>]*>[\s\S]*?<\/\1>/gi;
const genericXmlTagPattern = /<\/?[a-z_:-]+(?:\s+[^>]*)?>/gi;

const agentsMdHeaderPattern = /^#\s*AGENTS\.md\b/i;
const agentsMdInstructionsPattern = /^AGENTS\.md\s+instructions\s+for\b/i;

const noSignalPatterns: readonly RegExp[] = [
	/^(?:hello|hi|hey|ping|test)\b[!.?]*$/i,
	/^say\s+one\b/i,
	/^what\s+is\s+2\s*\+\s*2\??$/i,
	/^first\s+message\b/i,
	/^\[?(?:redacted\s+)?user\s+message(?:\s+unavailable)?\]?$/i,
];

/**
 * Strip harness/boot context from a raw user prompt. Does not truncate.
 */
export function sanitizeUserPrompt(raw: string): string {
	let value = raw.replace(/\r/g, "\n");
	value = value.replace(attachedFilesPattern, " ");
	value = value.replace(codeSelectionPattern, " ");
	value = value.replace(pluginInfoPattern, " ");
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

	const substantiveLines = lines.filter((line) => !isHarnessOrBootLine(line));
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

	if (agentsMdHeaderPattern.test(normalized) || agentsMdInstructionsPattern.test(normalized)) {
		return true;
	}

	if (/^<\/?[a-z_:-]+/i.test(normalized)) {
		return true;
	}

	if (/^(?:instructions|environment_context|cursor_commands)\b/i.test(normalized)) {
		return true;
	}

	if (/^✓/.test(normalized) || /^Test Files\b/i.test(normalized) || /^Duration\b/i.test(normalized)) {
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
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) {
		end -= 1;
	}

	return `${bytes.subarray(0, end).toString("utf8").trimEnd()}${ellipsis}`;
}

export function learningEvidenceFromPrompt(
	rawPrompt: string,
	...extra: readonly string[]
): string[] {
	const substantive = extractSubstantivePrompt(rawPrompt);
	const promptEvidence =
		substantive !== null ? capEvidenceText(substantive) : "";
	const items = promptEvidence.length > 0 ? [promptEvidence, ...extra] : [...extra];
	return uniqueNonEmpty(items);
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

	if (singleLine.length <= 24) {
		for (const pattern of noSignalPatterns) {
			if (pattern.test(singleLine)) {
				return true;
			}
		}
	}

	for (const pattern of noSignalPatterns) {
		if (pattern.test(singleLine)) {
			return true;
		}
	}

	return false;
}

export function firstSubstantivePromptFromTurns(
	turns: ReadonlyArray<{ user_prompt: string }>,
): string | null {
	for (const turn of turns) {
		const substantive = extractSubstantivePrompt(turn.user_prompt);
		if (substantive !== null) {
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
	return value
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n");
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
