import { access, chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CommandContext } from "../cli.js";

const HOOK_SCRIPT_NAME = "asd-session-end-ingest.sh";
const HOOK_MARKER = "asd-session-end-ingest";
const PROJECT_HOOK_COMMAND = `"$CLAUDE_PROJECT_DIR/.claude/hooks/${HOOK_SCRIPT_NAME}"`;

type ClaudeSettings = {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
};

export async function executeHooksInstall(context: CommandContext): Promise<number> {
  const options = parseHooksInstallOptions(context.args);
  const repoRoot = process.cwd();
  const settingsPath = resolveSettingsPath(repoRoot, options.global);
  const hookDest = join(repoRoot, ".claude", "hooks", HOOK_SCRIPT_NAME);
  const hookSource = resolveHookTemplatePath();

  if (options.dryRun) {
    context.output.info(
      JSON.stringify(
        {
          dry_run: true,
          global: options.global,
          hook_source: hookSource,
          hook_dest: hookDest,
          settings_path: settingsPath,
          hook_command: options.global ? resolveGlobalHookCommand(repoRoot) : PROJECT_HOOK_COMMAND,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  await mkdir(dirname(hookDest), { recursive: true });
  await copyFile(hookSource, hookDest);
  await chmod(hookDest, 0o755);

  const existing = await readSettings(settingsPath);
  const hookCommand = options.global ? resolveGlobalHookCommand(repoRoot) : PROJECT_HOOK_COMMAND;
  const merged = mergeSessionEndHook(existing, hookCommand);

  if (settingsUnchanged(existing, merged)) {
    context.output.info(`SessionEnd hook already registered in ${settingsPath}`);
    return 0;
  }

  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

  context.output.info(`Installed SessionEnd hook script at ${hookDest}`);
  context.output.info(`Registered SessionEnd hook in ${settingsPath}`);
  return 0;
}

export function parseHooksInstallOptions(args: readonly string[]): {
  dryRun: boolean;
  global: boolean;
} {
  let dryRun = false;
  let global = false;

  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--global") {
      global = true;
      continue;
    }
    throw new Error(`Unknown option for hooks install: ${arg}`);
  }

  return { dryRun, global };
}

export function resolveSettingsPath(repoRoot: string, global: boolean): string {
  if (global) {
    return join(homedir(), ".claude", "settings.json");
  }
  return join(repoRoot, ".claude", "settings.json");
}

export function resolveGlobalHookCommand(repoRoot: string): string {
  return resolve(repoRoot, ".claude", "hooks", HOOK_SCRIPT_NAME);
}

export function mergeSessionEndHook(settings: ClaudeSettings, hookCommand: string): ClaudeSettings {
  const hooks = { ...(settings.hooks ?? {}) };
  const sessionEnd = normalizeHookEntries(hooks.SessionEnd);

  if (sessionEnd.some((entry) => hookEntryUsesAsd(entry, hookCommand))) {
    return { ...settings, hooks: { ...hooks, SessionEnd: sessionEnd } };
  }

  sessionEnd.push({
    hooks: [
      {
        type: "command",
        command: hookCommand,
      },
    ],
  });

  return {
    ...settings,
    hooks: {
      ...hooks,
      SessionEnd: sessionEnd,
    },
  };
}

function normalizeHookEntries(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is Record<string, unknown> => {
    return typeof entry === "object" && entry !== null;
  });
}

function hookEntryUsesAsd(entry: Record<string, unknown>, hookCommand: string): boolean {
  const nestedHooks = entry.hooks;
  if (!Array.isArray(nestedHooks)) {
    return false;
  }

  return nestedHooks.some((hook) => {
    if (typeof hook !== "object" || hook === null) {
      return false;
    }
    const command = (hook as Record<string, unknown>).command;
    return (
      typeof command === "string" && (command.includes(HOOK_MARKER) || command === hookCommand)
    );
  });
}

function settingsUnchanged(before: ClaudeSettings, after: ClaudeSettings): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

async function readSettings(path: string): Promise<ClaudeSettings> {
  try {
    await access(path);
  } catch {
    return {};
  }

  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid Claude settings JSON at ${path}`);
  }
  return parsed as ClaudeSettings;
}

function resolveHookTemplatePath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return join(moduleDir, "..", "..", "scripts", "claude-session-end-ingest.sh");
}
