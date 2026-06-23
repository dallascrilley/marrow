export function normalizeFilePath(value: string): string | null {
  const trimmed = value.trim().replace(/^`+|`+$/g, "");

  if (!trimmed) {
    return null;
  }

  const codeIndex = trimmed.indexOf("/Code/");
  if (codeIndex >= 0) {
    const afterCode = trimmed.slice(codeIndex + "/Code/".length);
    const [, ...rest] = afterCode.split("/");

    if (rest.length > 0) {
      return rest.join("/");
    }
  }

  return trimmed;
}

export function extractPathsFromText(value: string): string[] {
  const paths: string[] = [];

  for (const match of value.matchAll(
    /(?:\/|[A-Za-z]:\\)[^\s`"'(),;:!?]+(?:\/[^\s`"'(),;:!?]+)*/g,
  )) {
    const candidate = match[0]?.trim();
    if (
      candidate &&
      (candidate.startsWith("/Users/") ||
        candidate.startsWith("src/") ||
        candidate.startsWith("./") ||
        /^[A-Za-z]:\\/.test(candidate))
    ) {
      paths.push(candidate);
    }
  }

  return paths;
}
