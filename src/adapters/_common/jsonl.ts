import type { JsonValue } from "../../models/canonical.js";

export type JsonRecord = Record<string, JsonValue>;

/**
 * Parse a single JSONL line into a `JsonRecord`. Throws with `sourcePath` and
 * `lineNumber` context when the line is not valid JSON or is not an object.
 */
export function parseJsonLine(
  line: string,
  sourcePath: string,
  lineNumber: number,
  sourceLabel: string = "JSONL"
): JsonRecord {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(
      `Failed to parse ${sourceLabel} at ${sourcePath}:${lineNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (!isJsonRecord(parsed)) {
    throw new Error(`${sourceLabel} line must be an object at ${sourcePath}:${lineNumber}`);
  }

  return parsed;
}

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
