import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import type { CommandContext } from "../cli.js";
import { getRuntimePath } from "../config/paths.js";
import { preflightStagingReadRoot } from "../storage/staging.js";
import { getPhaseCheckpoint, listSourceSessions } from "../db/ledger.js";
import type { SourceSessionRow } from "../db/queries.js";
import { turnSchema } from "../models/canonical.js";
import {
  extractSubstantivePrompt,
  looksLikeEmbeddedAgentPrompt,
} from "../pipeline/prompt-sanitize.js";
import { getReducedArtifactPath } from "../pipeline/reduce.js";

export const emuloMessageSchemaVersion = "asd.user_message.v1" as const;
export const emuloCorpusSchemaVersion = "asd.emulo_corpus.v1" as const;

const reducedArtifactSchema = z.object({
  turns: z.array(turnSchema),
});

const emuloMessageSchema = z.object({
  schema_version: z.literal(emuloMessageSchemaVersion),
  type: z.literal("asd.user_message"),
  session_id: z.string().min(1),
  source_tool: z.string().min(1),
  source_hash: z.string().min(1),
  project_key: z.string().min(1),
  turn_id: z.string().min(1),
  turn_index: z.number().int().nonnegative(),
  timestamp: z.string().datetime({ offset: true }),
  text: z.string().min(1),
});

export type EmuloMessageRecord = z.infer<typeof emuloMessageSchema>;

type ExportedSession = {
  content_sha256: string;
  message_count: number;
  path: string;
  project_key: string;
  session_id: string;
  source_hash: string;
  source_tool: string;
};

type SkippedSession = {
  reason:
    | "no_substantive_user_messages"
    | "reduced_artifact_missing"
    | "reduced_checkpoint_missing_or_stale";
  session_id: string;
};

export type EmuloCorpusManifest = {
  schema_version: typeof emuloCorpusSchemaVersion;
  generated_at: string | null;
  message_count: number;
  session_count: number;
  sessions: ExportedSession[];
  skipped_sessions: SkippedSession[];
};

export type EmuloCorpusExportResult = {
  exportRoot: string;
  generationRoot: string;
  manifest: EmuloCorpusManifest;
  manifestPath: string;
  pointerPath: string;
};

export async function executeProfileExportEmulo(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  if (context.args.length > 0) {
    throw new Error(`Unknown profile export-emulo option: ${context.args[0]}`);
  }

  const result = await buildEmuloCorpusExport(database);
  context.output.info(
    JSON.stringify(
      {
        export_path: result.exportRoot,
        generation_path: result.generationRoot,
        manifest_path: result.manifestPath,
        message_count: result.manifest.message_count,
        session_count: result.manifest.session_count,
        skipped_sessions: result.manifest.skipped_sessions,
      },
      null,
      2,
    ),
  );
  return 0;
}

export async function buildEmuloCorpusExport(
  database: DatabaseSync,
): Promise<EmuloCorpusExportResult> {
  await preflightStagingReadRoot();
  const exportRoot = getRuntimePath("emuloExports");
  const temporaryRoot = join(exportRoot, `.tmp-${randomUUID()}`);
  const sessions = listSourceSessions(database).sort(compareSourceSessions);
  const exportedSessions: ExportedSession[] = [];
  const skippedSessions: SkippedSession[] = [];
  const includedUpdatedAt: string[] = [];

  rejectDuplicateSessionIds(sessions);
  await mkdir(join(temporaryRoot, "sessions"), { recursive: true });

  try {
    for (const session of sessions) {
      const reducedCheckpoint = getPhaseCheckpoint(database, session.id, "reduced");
      if (
        reducedCheckpoint?.phase_state !== "completed" ||
        reducedCheckpoint.source_hash !== session.source_hash
      ) {
        skippedSessions.push({
          reason: "reduced_checkpoint_missing_or_stale",
          session_id: session.session_id,
        });
        continue;
      }

      const artifact = await readReducedArtifact(session);
      if (artifact === null) {
        skippedSessions.push({
          reason: "reduced_artifact_missing",
          session_id: session.session_id,
        });
        continue;
      }

      const records = artifact.turns
        .sort((left, right) => left.index - right.index)
        .flatMap((turn): EmuloMessageRecord[] => {
          if (turn.session_id !== session.session_id) {
            throw new Error(
              `Reduced artifact session mismatch for ${session.session_id}: found ${turn.session_id}`,
            );
          }
          const substantive = extractSubstantivePrompt(turn.user_prompt);
          if (substantive === null || looksLikeEmbeddedAgentPrompt(substantive)) {
            return [];
          }
          return [
            emuloMessageSchema.parse({
              schema_version: emuloMessageSchemaVersion,
              type: "asd.user_message",
              session_id: session.session_id,
              source_tool: session.source_tool,
              source_hash: session.source_hash,
              project_key: session.project_key,
              turn_id: turn.turn_id,
              turn_index: turn.index,
              timestamp: turn.started_at,
              text: substantive,
            }),
          ];
        });

      if (records.length === 0) {
        skippedSessions.push({
          reason: "no_substantive_user_messages",
          session_id: session.session_id,
        });
        continue;
      }

      const relativePath = join(
        "sessions",
        safePathComponent(session.source_tool),
        `${stableSessionFilename(session)}.jsonl`,
      );
      const contents = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
      const outputPath = join(temporaryRoot, relativePath);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, contents, "utf8");

      exportedSessions.push({
        content_sha256: sha256(contents),
        message_count: records.length,
        path: relative(temporaryRoot, outputPath),
        project_key: session.project_key,
        session_id: session.session_id,
        source_hash: session.source_hash,
        source_tool: session.source_tool,
      });
      includedUpdatedAt.push(session.updated_at);
    }

    const manifest: EmuloCorpusManifest = {
      schema_version: emuloCorpusSchemaVersion,
      generated_at: latestTimestamp(includedUpdatedAt),
      message_count: exportedSessions.reduce((sum, session) => sum + session.message_count, 0),
      session_count: exportedSessions.length,
      sessions: exportedSessions,
      skipped_sessions: skippedSessions.sort((left, right) =>
        left.session_id.localeCompare(right.session_id),
      ),
    };
    const temporaryManifestPath = join(temporaryRoot, "manifest.json");
    const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(temporaryManifestPath, manifestContents, "utf8");
    const generationId = sha256(manifestContents).replace("sha256:", "").slice(0, 24);
    const generationRelativePath = join("generations", generationId);
    const generationRoot = join(exportRoot, generationRelativePath);
    await mkdir(dirname(generationRoot), { recursive: true });
    if (await pathExists(generationRoot)) {
      await rm(temporaryRoot, { force: true, recursive: true });
    } else {
      await rename(temporaryRoot, generationRoot);
    }

    const pointerPath = join(exportRoot, "current.json");
    const temporaryPointerPath = join(exportRoot, `.current-${randomUUID()}.tmp`);
    const pointer = {
      schema_version: "asd.emulo_pointer.v1",
      generation: generationRelativePath,
      manifest: join(generationRelativePath, "manifest.json"),
    };
    await writeFile(temporaryPointerPath, `${JSON.stringify(pointer, null, 2)}\n`, "utf8");
    await rename(temporaryPointerPath, pointerPath);

    return {
      exportRoot,
      generationRoot,
      manifest,
      manifestPath: join(generationRoot, "manifest.json"),
      pointerPath,
    };
  } catch (error) {
    await rm(temporaryRoot, { force: true, recursive: true });
    throw error;
  }
}

async function readReducedArtifact(
  session: SourceSessionRow,
): Promise<z.infer<typeof reducedArtifactSchema> | null> {
  try {
    const contents = await readFile(getReducedArtifactPath(session.session_id), "utf8");
    return reducedArtifactSchema.parse(JSON.parse(contents));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function rejectDuplicateSessionIds(sessions: readonly SourceSessionRow[]): void {
  const seen = new Set<string>();
  for (const session of sessions) {
    if (seen.has(session.session_id)) {
      throw new Error(
        `Duplicate ledger session_id cannot be exported safely: ${session.session_id}`,
      );
    }
    seen.add(session.session_id);
  }
}

function compareSourceSessions(left: SourceSessionRow, right: SourceSessionRow): number {
  const bySource = left.source_tool.localeCompare(right.source_tool);
  return bySource !== 0 ? bySource : left.session_id.localeCompare(right.session_id);
}

function safePathComponent(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "-") || "unknown";
}

function stableSessionFilename(session: SourceSessionRow): string {
  return createHash("sha256")
    .update(`${session.source_tool}:${session.session_id}`)
    .digest("hex")
    .slice(0, 24);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function latestTimestamp(values: readonly string[]): string | null {
  return values.length === 0 ? null : ([...values].sort().at(-1) ?? null);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
