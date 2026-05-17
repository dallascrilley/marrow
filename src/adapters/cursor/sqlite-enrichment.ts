import { DatabaseSync } from "node:sqlite";

import type { JsonValue } from "../../models/canonical.js";

const supportedIdentifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const absolutePosixPathPattern = /\/(?:Users|home|tmp|var|opt|private|Volumes)\/[^\s"'`]+/g;
const absoluteWindowsPathPattern = /[A-Za-z]:\\[^\s"'`]+/g;

export type CursorKvRow = {
  entryKey: string;
  entryValue: JsonValue;
};

export type CursorAttributionAccumulator = {
  activeComposerIds: Set<string>;
  conversationIds: Set<string>;
  matchedKeys: string[];
  requestIds: Set<string>;
  sessionIds: Set<string>;
  workspaceIds: Set<string>;
  workspacePaths: Set<string>;
  workspaceStorageIds: Set<string>;
};

export function readCursorKvRowsReadOnly(databasePath: string): CursorKvRow[] {
  const database = new DatabaseSync(databasePath, {
    open: true,
    readOnly: true
  });

  try {
    const tables = database
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
         ORDER BY name`
      )
      .all()
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string" && isSafeIdentifier(name));

    const rows: CursorKvRow[] = [];

    for (const tableName of tables) {
      const tableInfo = database.prepare(`PRAGMA table_info(${tableName})`).all();
      const keyColumn = selectColumnName(tableInfo, ["key", "name"]);
      const valueColumn = selectColumnName(tableInfo, ["value"]);

      if (!keyColumn || !valueColumn) {
        continue;
      }

      const statement = database.prepare(
        `SELECT ${keyColumn} AS entryKey, ${valueColumn} AS entryValue
         FROM ${tableName}
         WHERE lower(${keyColumn}) LIKE '%composer%'
            OR lower(${keyColumn}) LIKE '%workspace%'
            OR lower(${keyColumn}) LIKE '%tracking%'
            OR lower(${keyColumn}) LIKE '%session%'
            OR lower(${keyColumn}) LIKE '%conversation%'
            OR lower(${keyColumn}) LIKE '%request%'`
      );

      for (const row of statement.all()) {
        if (typeof row.entryKey !== "string") {
          continue;
        }

        rows.push({
          entryKey: row.entryKey,
          entryValue: parseDatabaseValue(row.entryValue)
        });
      }
    }

    return rows;
  } finally {
    database.close();
  }
}

export function createAttributionAccumulator(): CursorAttributionAccumulator {
  return {
    activeComposerIds: new Set<string>(),
    conversationIds: new Set<string>(),
    matchedKeys: [],
    requestIds: new Set<string>(),
    sessionIds: new Set<string>(),
    workspaceIds: new Set<string>(),
    workspacePaths: new Set<string>(),
    workspaceStorageIds: new Set<string>()
  };
}

export function collectAttribution(rows: readonly CursorKvRow[]): CursorAttributionAccumulator {
  const accumulator = createAttributionAccumulator();

  for (const row of rows) {
    if (!accumulator.matchedKeys.includes(row.entryKey)) {
      accumulator.matchedKeys.push(row.entryKey);
    }

    visitJsonValue(row.entryValue, [], row.entryKey.toLowerCase(), accumulator);
  }

  accumulator.matchedKeys.sort((left, right) => left.localeCompare(right));

  return accumulator;
}

function visitJsonValue(
  value: JsonValue,
  path: string[],
  entryKey: string,
  accumulator: CursorAttributionAccumulator
): void {
  if (typeof value === "string") {
    collectStringSignals(value, path, entryKey, accumulator);
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      visitJsonValue(entry, path, entryKey, accumulator);
    }

    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...path, key];
    const normalizedKey = key.toLowerCase();

    if (typeof child === "string") {
      if (normalizedKey === "composerid") {
        accumulator.activeComposerIds.add(child);
      } else if (
        normalizedKey === "id" &&
        (entryKey.includes("active") || path.some((segment) => segment.toLowerCase().includes("active")))
      ) {
        accumulator.activeComposerIds.add(child);
      } else if (normalizedKey === "conversationid") {
        accumulator.conversationIds.add(child);
      } else if (normalizedKey === "requestid") {
        accumulator.requestIds.add(child);
      } else if (normalizedKey === "sessionid") {
        accumulator.sessionIds.add(child);
      } else if (normalizedKey === "workspaceid") {
        accumulator.workspaceIds.add(child);
      } else if (normalizedKey === "workspacestorageid") {
        accumulator.workspaceStorageIds.add(child);
      }
    }

    visitJsonValue(child, nextPath, entryKey, accumulator);
  }
}

function collectStringSignals(
  value: string,
  path: string[],
  entryKey: string,
  accumulator: CursorAttributionAccumulator
): void {
  for (const pathMatch of value.match(absolutePosixPathPattern) ?? []) {
    accumulator.workspacePaths.add(pathMatch);
  }

  for (const pathMatch of value.match(absoluteWindowsPathPattern) ?? []) {
    accumulator.workspacePaths.add(pathMatch);
  }

  if (
    path.some((segment) => segment.toLowerCase() === "path") ||
    entryKey.includes("workspace")
  ) {
    const trimmed = value.trim();

    if (
      trimmed.startsWith("/") ||
      /^[A-Za-z]:\\/.test(trimmed)
    ) {
      accumulator.workspacePaths.add(trimmed);
    }
  }
}

function selectColumnName(rows: unknown[], candidates: readonly string[]): string | null {
  for (const row of rows) {
    const columnName =
      typeof row === "object" && row !== null && "name" in row ? row.name : null;

    if (
      typeof columnName === "string" &&
      candidates.includes(columnName.toLowerCase()) &&
      isSafeIdentifier(columnName)
    ) {
      return columnName;
    }
  }

  return null;
}

function parseDatabaseValue(value: unknown): JsonValue {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return parseTextValue(Buffer.from(value).toString("utf8"));
  }

  if (typeof value === "string") {
    return parseTextValue(value);
  }

  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  return JSON.stringify(value);
}

function parseTextValue(value: string): JsonValue {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return "";
  }

  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    return value;
  }
}

function isSafeIdentifier(value: string): boolean {
  return supportedIdentifierPattern.test(value);
}
