import { access, chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CommandContext } from "../cli.js";

type HookEvent = "SessionEnd" | "SessionStart";

type HookSpec = {
  /** `--events` keyword. */
  key: "end" | "start";
  /** Claude Code hook event name. */
  event: HookEvent;
  /** Installed script filename under `.claude/hooks/`. */
  destName: string;
  /** Template filename under `scripts/`. */
  templateName: string;
  /** Marker substring used for idempotent detection. */
  marker: string;
};

const HOOK_SPECS: readonly HookSpec[] = [
  {
    key: "end",
    event: "SessionEnd",
    destName: "marrow-session-end-ingest.sh",
    templateName: "claude-session-end-ingest.sh",
    marker: "marrow-session-end-ingest",
  },
  {
    key: "start",
    event: "SessionStart",
    destName: "marrow-session-start-recall.sh",
    templateName: "claude-session-start-recall.sh",
    marker: "marrow-session-start-recall",
  },
];

type ClaudeSettings = {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
};

export async function executeHooksInstall(context: CommandContext): Promise<number> {
  const options = parseHooksInstallOptions(context.args);
  const events = parseHookEvents(context.args);
  const repoRoot = process.cwd();
  const settingsPath = resolveSettingsPath(repoRoot, options.global);
  const specs = HOOK_SPECS.filter((spec) => events.has(spec.key));

  if (options.dryRun) {
    context.output.info(
      JSON.stringify(
        {
          dry_run: true,
          global: options.global,
          settings_path: settingsPath,
          events: specs.map((spec) => ({
            event: spec.event,
            hook_source: resolveHookTemplatePath(spec.templateName),
            hook_dest: join(repoRoot, ".claude", "hooks", spec.destName),
            hook_command: options.global
              ? resolveGlobalHookCommand(repoRoot, spec.destName)
              : projectHookCommand(spec.destName),
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  let settings = await readSettings(settingsPath);
  const before = settings;
  const installedScripts: string[] = [];

  for (const spec of specs) {
    const hookDest = join(repoRoot, ".claude", "hooks", spec.destName);
    await mkdir(dirname(hookDest), { recursive: true });
    await copyFile(resolveHookTemplatePath(spec.templateName), hookDest);
    await chmod(hookDest, 0o755);
    installedScripts.push(hookDest);

    const hookCommand = options.global
      ? resolveGlobalHookCommand(repoRoot, spec.destName)
      : projectHookCommand(spec.destName);
    settings = mergeHookEvent(settings, spec.event, hookCommand, spec.marker);
  }

  if (settingsUnchanged(before, settings)) {
    context.output.info(`Hooks already registered in ${settingsPath}`);
    return 0;
  }

  for (const script of installedScripts) {
    context.output.info(`Installed hook script at ${script}`);
  }

  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  context.output.info(
    `Registered ${specs.map((spec) => spec.event).join(", ")} hook(s) in ${settingsPath}`,
  );
  return 0;
}

export function parseHooksInstallOptions(args: readonly string[]): {
  dryRun: boolean;
  global: boolean;
} {
  let dryRun = false;
  let global = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--global") {
      global = true;
      continue;
    }
    if (arg === "--events") {
      // Consumed by parseHookEvents; skip the value here.
      i += 1;
      continue;
    }
    if (arg.startsWith("--events=")) {
      continue;
    }
    throw new Error(`Unknown option for hooks install: ${arg}`);
  }

  return { dryRun, global };
}

/**
 * Which hook events to install. Defaults to both SessionEnd (ingest) and
 * SessionStart (recall). Override with `--events end,start` or `--events start`.
 */
export function parseHookEvents(args: readonly string[]): Set<HookSpec["key"]> {
  const valid = new Set(HOOK_SPECS.map((spec) => spec.key));
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    let raw: string | undefined;
    if (arg === "--events") {
      raw = args[i + 1];
      if (raw === undefined) {
        throw new Error("Missing value for --events (expected end, start, or end,start)");
      }
    } else if (arg.startsWith("--events=")) {
      raw = arg.slice("--events=".length);
    } else {
      continue;
    }
    const keys = raw
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length > 0);
    if (keys.length === 0) {
      throw new Error("Empty value for --events (expected end, start, or end,start)");
    }
    const selected = new Set<HookSpec["key"]>();
    for (const key of keys) {
      if (!valid.has(key as HookSpec["key"])) {
        throw new Error(`Unknown hook event for --events: ${key} (expected end, start)`);
      }
      selected.add(key as HookSpec["key"]);
    }
    return selected;
  }
  return new Set(valid);
}

export function resolveSettingsPath(repoRoot: string, global: boolean): string {
  if (global) {
    return join(homedir(), ".claude", "settings.json");
  }
  return join(repoRoot, ".claude", "settings.json");
}

export function resolveGlobalHookCommand(repoRoot: string, destName: string): string {
  return resolve(repoRoot, ".claude", "hooks", destName);
}

function projectHookCommand(destName: string): string {
  return `"$CLAUDE_PROJECT_DIR/.claude/hooks/${destName}"`;
}

/** Merge an marrow hook command into the given hook event, idempotently. */
export function mergeHookEvent(
  settings: ClaudeSettings,
  event: HookEvent,
  hookCommand: string,
  marker: string,
): ClaudeSettings {
  const hooks = { ...(settings.hooks ?? {}) };
  const entries = normalizeHookEntries(hooks[event]);

  if (entries.some((entry) => hookEntryUsesAsd(entry, hookCommand, marker))) {
    return { ...settings, hooks: { ...hooks, [event]: entries } };
  }

  entries.push({
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
      [event]: entries,
    },
  };
}

/** Back-compat wrapper retained for callers/tests targeting SessionEnd. */
export function mergeSessionEndHook(settings: ClaudeSettings, hookCommand: string): ClaudeSettings {
  return mergeHookEvent(settings, "SessionEnd", hookCommand, "marrow-session-end-ingest");
}

function normalizeHookEntries(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is Record<string, unknown> => {
    return typeof entry === "object" && entry !== null;
  });
}

function hookEntryUsesAsd(
  entry: Record<string, unknown>,
  hookCommand: string,
  marker: string,
): boolean {
  const nestedHooks = entry.hooks;
  if (!Array.isArray(nestedHooks)) {
    return false;
  }

  return nestedHooks.some((hook) => {
    if (typeof hook !== "object" || hook === null) {
      return false;
    }
    const command = (hook as Record<string, unknown>).command;
    return typeof command === "string" && (command.includes(marker) || command === hookCommand);
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

function resolveHookTemplatePath(templateName: string): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return join(moduleDir, "..", "..", "scripts", templateName);
}
