import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

const wikiMemorySchemaVersion = "asd.wiki_memory.v1" as const;
const vaultPushManifestSchemaVersion = "asd.vault_push_manifest.v1" as const;

const sourceRefSchema = z.object({
  source_path: z.string(),
  source_hash: z.string(),
  session_id: z.string(),
  turn_id: z.string().nullable(),
  event_id: z.string().nullable(),
  line: z.number().int().nonnegative().nullable(),
});

const wikiMemoryRecordSchema = z.object({
  schema_version: z.literal(wikiMemorySchemaVersion),
  id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  kind: z.literal("project_learning"),
  project: z.object({
    key: z.string(),
    root: z.string().nullable(),
  }),
  title: z.string(),
  body: z.string(),
  evidence: z.object({
    learning_id: z.string(),
    promotion_basis: z.string(),
    evidence: z.array(z.string()),
    source_refs: z.array(sourceRefSchema),
  }),
  review: z.object({
    verdict: z.literal("keep"),
    confidence: z.string(),
    source: z.enum(["deterministic-export", "reviewed-export"]),
  }),
  created_at: z.string(),
});

export type WikiMemoryRecord = z.infer<typeof wikiMemoryRecordSchema>;

export type ManifestEntry = z.infer<typeof manifestEntrySchema>;

export type VaultPushManifest = z.infer<typeof manifestSchema>;

export type PushOutcome = "written" | "skipped_unchanged" | "skipped_protected";

export type PushRecordResult = {
  id: string;
  outcome: PushOutcome;
  page_path: string;
};

export type PushAllResult = {
  outcomes: PushRecordResult[];
  total_records: number;
  total_written: number;
  total_skipped_unchanged: number;
  total_skipped_protected: number;
};

/**
 * Strip path-traversal characters from a project key. Returns "unknown" if the
 * key becomes empty after sanitisation.
 */
export function sanitiseProjectKey(key: string): string {
  const stripped = key
    .replace(/[\\/]+/g, "")
    .replace(/\.\.+/g, "")
    .replace(/^\.+/, "")
    .trim();
  return stripped.length > 0 ? stripped : "unknown";
}

/**
 * Normalise em-dash and double-hyphen punctuation to comma+space. Preserves
 * compound flags like `--no-overwrite` (only the spaced double-hyphen form
 * counts as punctuation per the vault's wiki-ingest convention).
 */
export function sanitiseWikiText(text: string): string {
  return text
    .replace(/ — /g, ", ")
    .replace(/—/g, ", ")
    .replace(/ -- /g, ", ");
}

/** Strip the `sha256:` prefix from a record id, returning the bare hex digest. */
export function pageBasenameFromId(id: string): string {
  return id.replace(/^sha256:/, "");
}

/** Strict YAML scalar emitter: always single-quoted, with `''` escape. */
function yamlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Emit `null` for null values, single-quoted string otherwise. */
function yamlNullableString(value: string | null): string {
  return value === null ? "null" : yamlString(value);
}

/** Emit `null` for null values, the bare number otherwise. */
function yamlNullableNumber(value: number | null): string {
  return value === null ? "null" : String(value);
}

/** Render the YAML frontmatter for a wiki memory record. */
export function renderFrontmatter(record: WikiMemoryRecord): string {
  const lines = [
    "---",
    `id: ${yamlString(record.id)}`,
    `source: 'asd'`,
    `schema_version: ${yamlString(record.schema_version)}`,
    `project: ${yamlString(record.project.key)}`,
    `learning_id: ${yamlString(record.evidence.learning_id)}`,
    `promotion_basis: ${yamlString(record.evidence.promotion_basis)}`,
    `confidence: ${yamlString(record.review.confidence)}`,
    `review_source: ${yamlString(record.review.source)}`,
    `created_at: ${yamlString(record.created_at)}`,
    "tags:",
    "  - 'asd'",
    `  - ${yamlString(`asd/${record.project.key}`)}`,
    "source_refs:",
  ];

  if (record.evidence.source_refs.length === 0) {
    lines.push("  []");
  } else {
    for (const ref of record.evidence.source_refs) {
      lines.push(`  - source_path: ${yamlString(ref.source_path)}`);
      lines.push(`    source_hash: ${yamlString(ref.source_hash)}`);
      lines.push(`    session_id: ${yamlString(ref.session_id)}`);
      lines.push(`    turn_id: ${yamlNullableString(ref.turn_id)}`);
      lines.push(`    event_id: ${yamlNullableString(ref.event_id)}`);
      lines.push(`    line: ${yamlNullableNumber(ref.line)}`);
    }
  }

  lines.push("---");
  return `${lines.join("\n")}\n`;
}

/**
 * Render the page body for a wiki memory record. Sanitises em-dash and
 * spaced-double-hyphen punctuation in title, body, and evidence so the
 * output complies with the vault's wiki-ingest "no em dashes" rule.
 */
export function renderBody(record: WikiMemoryRecord): string {
  const title = sanitiseWikiText(record.title);
  const body = sanitiseWikiText(record.body);
  const evidenceLines = record.evidence.evidence.map((entry) =>
    `- ${sanitiseWikiText(entry)}`,
  );

  const sections: string[] = [`# ${title}`, "", body];

  if (evidenceLines.length > 0) {
    sections.push("", "## Source evidence", "", ...evidenceLines);
  }

  return `${sections.join("\n")}\n`;
}

/** sha256 of the rendered body (frontmatter excluded by design). */
export function contentHashOf(body: string): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

/** Atomic write via temp file + rename. */
export async function atomicWriteFile(targetPath: string, contents: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const tempPath = join(dirname(targetPath), `.${basenameOf(targetPath)}.tmp`);
  await writeFile(tempPath, contents, "utf8");
  await rename(tempPath, targetPath);
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

const MANIFEST_FILENAME = "_asd-manifest.json";

const manifestEntrySchema = z.object({
  page: z.string(),
  content_hash: z.string(),
  written_at: z.string(),
  schema_version: z.literal(wikiMemorySchemaVersion),
  deleted_at: z.string().optional(),
});

const manifestSchema = z.object({
  schema_version: z.literal(vaultPushManifestSchemaVersion),
  written_by: z.literal("asd"),
  last_push_at: z.string(),
  records: z.record(z.string(), manifestEntrySchema),
});

function emptyManifest(now: string): VaultPushManifest {
  return {
    schema_version: vaultPushManifestSchemaVersion,
    written_by: "asd",
    last_push_at: now,
    records: {},
  };
}

/**
 * Load the per-project manifest. Returns an empty manifest skeleton if the
 * file does not exist. Throws if the file exists but is malformed.
 */
export async function loadManifest(manifestPath: string, now: string): Promise<VaultPushManifest> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return emptyManifest(now);
    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  return manifestSchema.parse(parsed);
}

/** Serialise the manifest deterministically: top-level keys ordered, records sorted by id. */
export function serialiseManifest(manifest: VaultPushManifest): string {
  const sortedRecords: Record<string, ManifestEntry> = {};
  for (const id of Object.keys(manifest.records).sort()) {
    const entry = manifest.records[id];
    if (!entry) continue;
    sortedRecords[id] = entry;
  }

  const ordered = {
    schema_version: manifest.schema_version,
    written_by: manifest.written_by,
    last_push_at: manifest.last_push_at,
    records: sortedRecords,
  };

  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export async function saveManifest(manifestPath: string, manifest: VaultPushManifest): Promise<void> {
  await atomicWriteFile(manifestPath, serialiseManifest(manifest));
}

export type PushRecordOptions = {
  manifest: VaultPushManifest;
  noOverwrite: boolean;
  now: string;
  record: WikiMemoryRecord;
  vaultRoot: string;
};

/**
 * Push a single record to the vault. Mutates the manifest in place. Returns
 * the per-record outcome and the absolute page path.
 */
export async function pushRecord(options: PushRecordOptions): Promise<PushRecordResult> {
  const { manifest, noOverwrite, now, record, vaultRoot } = options;
  const projectDir = projectSubtreePath(vaultRoot, record.project.key);
  const basename = `${pageBasenameFromId(record.id)}.md`;
  const pagePath = join(projectDir, basename);
  const frontmatter = renderFrontmatter(record);
  const body = renderBody(record);
  const newContentHash = contentHashOf(body);
  const existing = manifest.records[record.id];

  if (existing && existing.content_hash === newContentHash) {
    return { id: record.id, outcome: "skipped_unchanged", page_path: pagePath };
  }

  if (noOverwrite && (await pathExists(pagePath))) {
    const onDisk = await readFile(pagePath, "utf8");
    const onDiskHash = contentHashOf(stripFrontmatter(onDisk));
    if (existing && onDiskHash !== existing.content_hash) {
      return { id: record.id, outcome: "skipped_protected", page_path: pagePath };
    }
  }

  await atomicWriteFile(pagePath, `${frontmatter}${body}`);

  manifest.records[record.id] = {
    page: basename,
    content_hash: newContentHash,
    written_at: now,
    schema_version: wikiMemorySchemaVersion,
  };

  return { id: record.id, outcome: "written", page_path: pagePath };
}

export type PushAllOptions = {
  noOverwrite: boolean;
  now: string;
  records: readonly WikiMemoryRecord[];
  vaultRoot: string;
};

/**
 * Push every record. Groups records by project so each project's manifest is
 * loaded once and saved once. Records within a project are pushed in id order
 * for deterministic manifest output.
 */
export async function pushAll(options: PushAllOptions): Promise<PushAllResult> {
  const { noOverwrite, now, records, vaultRoot } = options;
  const grouped = new Map<string, WikiMemoryRecord[]>();

  for (const record of records) {
    const projectKey = sanitiseProjectKey(record.project.key);
    const sanitisedRecord: WikiMemoryRecord = {
      ...record,
      project: { ...record.project, key: projectKey },
    };
    const existing = grouped.get(projectKey);
    if (existing) {
      existing.push(sanitisedRecord);
    } else {
      grouped.set(projectKey, [sanitisedRecord]);
    }
  }

  const outcomes: PushRecordResult[] = [];

  for (const projectKey of [...grouped.keys()].sort()) {
    const group = grouped.get(projectKey);
    if (!group) continue;
    const projectDir = projectSubtreePath(vaultRoot, projectKey);
    await mkdir(projectDir, { recursive: true });
    const manifestPath = join(projectDir, MANIFEST_FILENAME);
    const manifest = await loadManifest(manifestPath, now);

    let manifestChanged = false;

    for (const record of group.sort((left, right) => left.id.localeCompare(right.id))) {
      const result = await pushRecord({ manifest, noOverwrite, now, record, vaultRoot });
      outcomes.push(result);
      if (result.outcome === "written") manifestChanged = true;
    }

    if (manifestChanged) {
      manifest.last_push_at = now;
      await saveManifest(manifestPath, manifest);
    }
  }

  return {
    outcomes,
    total_records: outcomes.length,
    total_written: outcomes.filter((entry) => entry.outcome === "written").length,
    total_skipped_unchanged: outcomes.filter((entry) => entry.outcome === "skipped_unchanged").length,
    total_skipped_protected: outcomes.filter((entry) => entry.outcome === "skipped_protected").length,
  };
}

/**
 * Read and parse a wiki-memory JSONL export. Empty file → empty array.
 */
export async function readWikiMemoryJsonl(path: string): Promise<WikiMemoryRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }

  const records: WikiMemoryRecord[] = [];
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `Failed to parse wiki-memory JSONL at ${path}:${index + 1}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    records.push(wikiMemoryRecordSchema.parse(parsed));
  }

  return records;
}

/** Compute the per-project vault subtree path. Project key is sanitised. */
export function projectSubtreePath(vaultRoot: string, projectKey: string): string {
  return join(vaultRoot, "wiki", "projects", sanitiseProjectKey(projectKey), "asd-learnings");
}

/** Return whether the given vault root exists on disk. */
export async function vaultExists(vaultRoot: string): Promise<boolean> {
  return pathExists(vaultRoot);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function stripFrontmatter(text: string): string {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return text;
  return text.slice(end + 5);
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Walk an `asd-learnings/` directory and return the page filenames present on
 * disk (excluding the manifest). Useful for tests and for the phase-2
 * deletion-reconciliation skill.
 */
export async function listPushedPages(projectDir: string): Promise<string[]> {
  try {
    const entries = await readdir(projectDir);
    return entries.filter((name) => name.endsWith(".md")).sort();
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}
