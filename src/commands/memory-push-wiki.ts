import { homedir } from "node:os";
import { join } from "node:path";

import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import { getRuntimePath } from "../config/paths.js";
import {
  type PushAllResult,
  pushAll,
  readWikiMemoryJsonl,
  vaultExists,
} from "../pipeline/vault-push.js";
import { renderProjectMemoryToVault } from "../v2/vault/render-memory.js";
import { executeMemoryExportWiki } from "./memory-export-wiki.js";

export const vaultRootEnvVar = "ASD_VAULT_ROOT";

type PushWikiOptions = {
  noOverwrite: boolean;
  refresh: boolean;
  vaultRoot: string;
};

export function parsePushWikiOptions(args: readonly string[]): PushWikiOptions {
  let noOverwrite = false;
  let refresh = false;
  let vaultRoot: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--no-overwrite") {
      noOverwrite = true;
      continue;
    }

    if (arg === "--refresh") {
      refresh = true;
      continue;
    }

    if (arg === "--vault") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --vault");
      }
      vaultRoot = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown memory push-wiki option: ${arg}`);
  }

  return {
    noOverwrite,
    refresh,
    vaultRoot: vaultRoot ?? defaultVaultRoot(),
  };
}

function defaultVaultRoot(): string {
  const override = process.env[vaultRootEnvVar];
  return override && override.length > 0 ? override : join(homedir(), "vault");
}

export async function executeMemoryPushWiki(
  context: CommandContext,
  database: DatabaseSync,
): Promise<number> {
  const options = parsePushWikiOptions(context.args);

  if (options.refresh) {
    const exportExitCode = await executeMemoryExportWiki(context, database);
    if (exportExitCode !== 0) return exportExitCode;
  }

  if (!(await vaultExists(options.vaultRoot))) {
    context.output.info(`Vault not present at ${options.vaultRoot}; skipping push (no error).`);
    return 0;
  }

  const exportPath = join(getRuntimePath("wikiMemoryExports"), "reviewed-memory.jsonl");
  const records = await readWikiMemoryJsonl(exportPath);

  if (records.length === 0) {
    context.output.info(
      `No reviewed-memory records found at ${exportPath}; nothing to push. Run 'memory export-wiki' or pass --refresh first.`,
    );
    return 0;
  }

  const now = new Date().toISOString();
  const result = await pushAll({
    noOverwrite: options.noOverwrite,
    now,
    records,
    vaultRoot: options.vaultRoot,
  });

  const memoryRenders = [];
  const projectIds = [...new Set(records.map((record) => record.project.key))];
  for (const projectId of projectIds) {
    memoryRenders.push(
      await renderProjectMemoryToVault({
        projectId,
        vaultRoot: options.vaultRoot,
      }),
    );
  }

  context.output.info(formatSummary(result, options, memoryRenders));
  return 0;
}

function formatSummary(
  result: PushAllResult,
  options: PushWikiOptions,
  memoryRenders: Array<{
    memoryPath: string;
    topicFiles: Record<string, string>;
    includedCount: number;
    spilledCount: number;
  }>,
): string {
  return JSON.stringify(
    {
      vault_root: options.vaultRoot,
      no_overwrite: options.noOverwrite,
      total_records: result.total_records,
      total_written: result.total_written,
      total_skipped_unchanged: result.total_skipped_unchanged,
      total_skipped_protected: result.total_skipped_protected,
      memory_renders: memoryRenders,
      claude_import_hint:
        "Add @import for MEMORY.md in the consuming repo CLAUDE.md if ambient context is desired.",
      pages: result.outcomes.map((entry) => ({
        id: entry.id,
        outcome: entry.outcome,
        page_path: entry.page_path,
      })),
    },
    null,
    2,
  );
}
