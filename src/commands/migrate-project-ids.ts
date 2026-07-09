import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { CommandContext } from "../cli.js";
import { getRuntimePath, getRuntimeRoot } from "../config/paths.js";
import { listSourceSessions } from "../db/ledger.js";
import { resolveProjectId } from "../v2/project/resolve.js";

export async function executeMigrateProjectIds(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const apply = context.args.includes("--apply");
  const entries = await collectMigrationEntries(database);
  const reportPath = join(getRuntimeRoot(), "_project-id-migration.json");

  if (apply) {
    context.output.info(
      "Apply mode copies knowledge/projects/<old> to knowledge/projects/<new> when missing; vault paths are not renamed automatically.",
    );
    const { mkdir, cp } = await import("node:fs/promises");
    for (const entry of entries) {
      if (entry.old_key === entry.new_id) continue;
      const sourceDir = join(getRuntimePath("knowledgeProjects"), entry.old_key);
      const targetDir = join(getRuntimePath("knowledgeProjects"), entry.new_id);
      try {
        await mkdir(join(getRuntimePath("knowledgeProjects"), entry.new_id), {
          recursive: true,
        });
        await cp(sourceDir, targetDir, { recursive: true, force: false });
        entry.applied = true;
      } catch (error) {
        entry.apply_error = error instanceof Error ? error.message : String(error);
      }
    }
  }

  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        apply,
        entries,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  context.output.info(
    JSON.stringify(
      {
        dry_run: !apply,
        report: reportPath,
        entries: entries.length,
        changed: entries.filter((entry) => entry.old_key !== entry.new_id).length,
      },
      null,
      2,
    ),
  );

  return 0;
}

type MigrationEntry = {
  old_key: string;
  new_id: string;
  source: string;
  workspace_path: string | null;
  resolved_at: string;
  applied?: boolean;
  apply_error?: string;
};

async function collectMigrationEntries(database: DatabaseSync): Promise<MigrationEntry[]> {
  const resolvedAt = new Date().toISOString();
  const byOldKey = new Map<string, MigrationEntry>();

  for (const session of listSourceSessions(database)) {
    const oldKey = session.project_key;
    if (byOldKey.has(oldKey)) continue;

    const resolved = await resolveProjectId({
      workspacePath: session.workspace_path,
      sessionRoot: session.workspace_path,
    });

    byOldKey.set(oldKey, {
      old_key: oldKey,
      new_id: resolved.id,
      source: resolved.source,
      workspace_path: session.workspace_path,
      resolved_at: resolvedAt,
    });
  }
  const resolvedNewIds = new Set([...byOldKey.values()].map((entry) => entry.new_id));

  try {
    const projectDirs = await readdir(getRuntimePath("knowledgeProjects"));
    for (const oldKey of projectDirs) {
      if (byOldKey.has(oldKey) || resolvedNewIds.has(oldKey) || looksLikeAdrProjectId(oldKey)) {
        continue;
      }
      const resolved = await resolveProjectId({
        workspacePath: null,
        sessionRoot: oldKey,
      });
      byOldKey.set(oldKey, {
        old_key: oldKey,
        new_id: resolved.id,
        source: resolved.source,
        workspace_path: null,
        resolved_at: resolvedAt,
      });
    }
  } catch {
    // knowledge/projects may not exist yet
  }

  return [...byOldKey.values()].sort((left, right) => left.old_key.localeCompare(right.old_key));
}

function looksLikeAdrProjectId(projectKey: string): boolean {
  return /^[0-9a-f]{12}$/u.test(projectKey);
}
