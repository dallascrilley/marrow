import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";

import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import type { CommandContext } from "../cli.js";
import { ensureRuntimePath, getRuntimePath } from "../config/paths.js";
import { sourceSessionSchema, summarySchema } from "../models/canonical.js";

export const sessionIndexSchemaVersion = 1;

const absolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value), {
    message: "Expected an absolute path",
  });

const sessionManifestSchema = z.object({
  artifact_paths: z.object({
    summary_json_path: absolutePathSchema,
  }),
  generated_at: z.string().datetime({ offset: true }),
  session: sourceSessionSchema.extend({
    source_path: absolutePathSchema,
  }),
  version: z.literal(1),
});

export const sessionIndexRecordSchema = z.object({
  v: z.literal(sessionIndexSchemaVersion),
  source_path: absolutePathSchema,
  source_uuid: z.string().min(1),
  source_tool: sourceSessionSchema.shape.source_tool,
  asd_session_id: z.string().min(1),
  topic: z.string().min(1),
  topic_source: summarySchema.shape.topic_source,
  next_step: z.string().min(1),
  summary_json_path: absolutePathSchema,
  updated_at: z.string().datetime({ offset: true }),
});

export type SessionIndexRecord = z.infer<typeof sessionIndexRecordSchema>;

export async function executeExportIndex(
  context: CommandContext,
  _database: DatabaseSync,
): Promise<number> {
  const records = await buildSessionIndex();
  const indexDir = await ensureRuntimePath("index");
  const exportPath = join(indexDir, "session-index.jsonl");
  const contents =
    records.length === 0 ? "" : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

  await writeFile(exportPath, contents, "utf8");

  context.output.info(
    `Exported ${records.length} session index ${records.length === 1 ? "record" : "records"}.`,
  );
  context.output.info(`Export path: ${exportPath}`);

  return 0;
}

export async function buildSessionIndex(): Promise<SessionIndexRecord[]> {
  const manifestPaths = await listManifestPaths();
  const recordsByIdentity = new Map<
    string,
    { generatedAt: string; manifestPath: string; record: SessionIndexRecord }
  >();

  for (const manifestPath of manifestPaths) {
    const manifest = sessionManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
    const summary = summarySchema.parse(
      JSON.parse(await readFile(manifest.artifact_paths.summary_json_path, "utf8")),
    );
    const record = sessionIndexRecordSchema.parse({
      v: sessionIndexSchemaVersion,
      source_path: manifest.session.source_path,
      source_uuid: deriveSourceUuid(
        manifest.session.source_tool,
        manifest.session.source_path,
        manifest.session.session_id,
      ),
      source_tool: manifest.session.source_tool,
      asd_session_id: summary.session_id,
      topic: summary.topic,
      topic_source: summary.topic_source,
      next_step: summary.next_step,
      summary_json_path: manifest.artifact_paths.summary_json_path,
      updated_at: manifest.generated_at,
    });
    const identityKey = `${manifest.session.source_tool}\0${manifest.session.source_path}\0${manifest.session.session_id}`;
    const existing = recordsByIdentity.get(identityKey);
    if (
      !existing ||
      manifest.generated_at > existing.generatedAt ||
      (manifest.generated_at === existing.generatedAt && manifestPath > existing.manifestPath)
    ) {
      recordsByIdentity.set(identityKey, {
        generatedAt: manifest.generated_at,
        manifestPath,
        record,
      });
    }
  }

  const records = Array.from(recordsByIdentity.values()).map((entry) => entry.record);

  return records.sort((left, right) => {
    const byPath = left.source_path.localeCompare(right.source_path);
    return byPath !== 0 ? byPath : left.asd_session_id.localeCompare(right.asd_session_id);
  });
}

async function listManifestPaths(): Promise<string[]> {
  const manifestDir = getRuntimePath("manifests");
  let entries: string[];

  try {
    entries = await readdir(manifestDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  return entries
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => join(manifestDir, entry));
}

function deriveSourceUuid(sourceTool: string, sourcePath: string, sessionId: string): string {
  const fileStem = basename(sourcePath, extname(sourcePath));

  if (sourceTool === "codex-cli") {
    const match = fileStem.match(
      /^rollout-(?:\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    );
    return match?.[1] ?? (fileStem.replace(/^rollout-/, "") || sessionId);
  }

  return fileStem || sessionId;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
