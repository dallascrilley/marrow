export function stripEventPrefix(value: string): string {
  return value.replace(/^Verification noted:\s*/i, "").trim();
}

export function normalizeFixSummary(value: string): string {
  return stripLeadingCompletionVerb(
    stripTrailingPunctuation(stripWhatChangedClause(stripEventPrefix(stripCompletionBlock(value))))
      .replace(
        /^(?:fixed|resolved|updated|changed|patched|corrected)\s+(?:fixed|resolved|updated|changed|patched|corrected)\b\s*/i,
        (match) => {
          const firstWord = match.trim().split(/\s+/)[0] ?? "";
          return firstWord.length > 0 ? `${firstWord} ` : "";
        },
      )
      .trim(),
  );
}

export function normalizeWorkflowStatement(value: string): string {
  return stripLeadingWorkflowPrefix(normalizeFixSummary(value));
}

export function startsWithPastTenseVerb(value: string): boolean {
  return /^(?:fixed|resolved|updated|changed|patched|corrected|added|implemented|replaced|removed|wired|pre-?production\b[\s\S]{0,120}\bare implemented\b|all\b[\s\S]{0,80}\boptimizations\b)/i.test(
    value,
  );
}

function stripWhatChangedClause(value: string): string {
  return value
    .replace(
      /\s+\*\*(?:What changed|Changed|Changes|Implemented|Delivered|Updates|Change|Summary|Summary of changes):\*\*[\s\S]*$/i,
      "",
    )
    .replace(/\s+Summary of what changed:[\s\S]*$/i, "")
    .trim();
}

export function normalizeResolutionSummary(value: string): string {
  return stripTrailingPunctuation(
    stripWhatChangedClause(stripEventPrefix(stripCompletionBlock(value))),
  );
}

function stripLeadingCompletionVerb(value: string): string {
  return value
    .replace(
      /^(?:completed|done)\s+(?=(?:implemented|added|fixed|resolved|updated|changed|patched|corrected|replaced|removed)\b)/i,
      "",
    )
    .trim();
}

function stripLeadingWorkflowPrefix(value: string): string {
  return value
    .replace(/^(?:completed|done)\s+/i, "")
    .replace(/^implemented\s+(?=implemented\b)/i, "")
    .trim();
}

export function formatCommand(command: string): string {
  return command.startsWith("`") && command.endsWith("`") ? command : `\`${command}\``;
}

export function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.!?]+$/g, "").trim();
}

export function lowercaseFirst(value: string): string {
  if (value.length === 0) {
    return value;
  }

  return `${value[0]?.toLowerCase()}${value.slice(1)}`;
}

export function stripCompletionBlock(value: string): string {
  const stripped = stripEventPrefix(value)
    .replace(/^\*\*Done:\*\*\s*/i, "")
    .replace(/\s+\*\*Verified:\*\*[\s\S]*$/i, "")
    .replace(/\s+\*\*Changed:\*\*[\s\S]*$/i, "")
    .replace(/\s+\*\*Changes:\*\*[\s\S]*$/i, "")
    .trim();

  return stripped.length > 0 ? stripped : value;
}
