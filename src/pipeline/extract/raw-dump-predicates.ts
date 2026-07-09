export function hasExcessiveMarkdownStructure(value: string): boolean {
  const markerMatches = value.match(/(?:^|\s)(?:#{1,6}\s+|[-*]\s+|\d+\.\s+|\*\*[^*]+:\*\*)/g);

  return (markerMatches?.length ?? 0) >= 3;
}

export function looksLikeRawKnowledgeDump(value: string): boolean {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return false;
  }

  if (
    (trimmed.startsWith("{") || trimmed.startsWith("[")) &&
    /"(?:findings|severity|verdict|file|line)"/.test(trimmed)
  ) {
    return true;
  }

  if (
    trimmed.includes("Traceback (most recent call last)") ||
    trimmed.includes("\n    at ") ||
    (/Error: /.test(trimmed) && trimmed.includes("\n")) ||
    trimmed.includes("npm ERR!") ||
    trimmed.includes("pnpm ERR!") ||
    ((trimmed.includes("ECONNRESET") || trimmed.includes("ENOENT") || trimmed.includes("EACCES")) &&
      trimmed.includes("\n"))
  ) {
    return true;
  }

  if (
    trimmed.includes("Base directory for this skill") ||
    trimmed.includes("/SKILL.md") ||
    trimmed.includes("<skill") ||
    trimmed.includes("Use when:") ||
    trimmed.includes("Triggers:") ||
    trimmed.includes("Description:")
  ) {
    return true;
  }

  if (hasExcessiveMarkdownStructure(trimmed)) {
    return true;
  }

  const normalized = trimmed.replace(/\s+/g, " ").trim();
  if (normalized.length > 420) {
    const leadingWindow = normalized.slice(0, 180);
    const hasProjectLocalPath =
      /\b(?:src|lib|app|server|scripts|tools|docs|tests?|api|core|shared|desktop|mobile)\/[^\s]+/i.test(
        leadingWindow,
      );
    const hasImperativePhrase = /\b(?:use|keep|avoid|run|configure|prefer|move|add|remove)\b/i.test(
      leadingWindow,
    );
    return !(hasProjectLocalPath && hasImperativePhrase);
  }

  return false;
}

export function looksLikeRawWorkflowSummary(value: string): boolean {
  const normalized = value.trim().toLowerCase();

  return (
    normalized === "fixed completed; verified." ||
    normalized.startsWith("fixed completed; verified") ||
    /\*\*(?:delivered|implemented|summary|summary of changes|changes|verified):\*\*/i.test(value) ||
    /\|\s*-{2,}\s*\|/.test(value) ||
    hasExcessiveMarkdownStructure(value)
  );
}
