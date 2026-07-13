import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CommandContext } from "../cli.js";

export type ReadbackCheckStatus = "drifted" | "installed" | "missing" | "unverifiable";

type ReadbackCheckSurface = {
  detail: string;
  install_command: string | null;
  status: ReadbackCheckStatus;
};

export type ReadbackSetupReport = {
  hook: ReadbackCheckSurface;
  mcp: ReadbackCheckSurface;
  recall: ReadbackCheckSurface;
};

type ReadbackCheckPaths = {
  hookPath: string;
  mcpConfigPath: string;
  settingsPath: string;
  vaultRoot: string;
};

export async function executeReadbackCheck(context: CommandContext): Promise<number> {
  if (context.args.length > 0)
    throw new Error(`Unknown readback check option: ${context.args[0] ?? ""}`);
  const projectRoot = process.cwd();
  const report = await assessReadbackSetup({
    hookPath: join(projectRoot, ".claude", "hooks", "asd-session-start-recall.sh"),
    mcpConfigPath: join(homedir(), ".claude.json"),
    settingsPath: join(projectRoot, ".claude", "settings.json"),
    vaultRoot: process.env.ASD_VAULT_ROOT?.trim() || join(homedir(), "vault"),
  });
  context.output.info(JSON.stringify(report, null, 2));
  return report.hook.status === "unverifiable" || report.mcp.status === "unverifiable" ? 2 : 0;
}

export async function assessReadbackSetup(paths: ReadbackCheckPaths): Promise<ReadbackSetupReport> {
  const [hook, mcp, recall] = await Promise.all([
    inspectHook(paths.settingsPath, paths.hookPath),
    inspectMcp(paths.mcpConfigPath),
    inspectVault(paths.vaultRoot),
  ]);
  return { hook, mcp, recall };
}

async function inspectHook(settingsPath: string, hookPath: string): Promise<ReadbackCheckSurface> {
  const settings = await readJson(settingsPath);
  if (settings.status === "missing") {
    return missing("SessionStart hook is not registered.", "asd hooks install --events start");
  }
  if (settings.status === "unverifiable") return settings.surface;
  const registered = containsSessionStartRecall(settings.value);
  const scriptPresent = await pathExists(hookPath);
  if (registered && scriptPresent)
    return installed("SessionStart recall hook is registered and its script exists.");
  if (registered || scriptPresent) {
    return drifted(
      "SessionStart recall registration and hook script do not agree.",
      "asd hooks install --events start",
    );
  }
  return missing("SessionStart hook is not registered.", "asd hooks install --events start");
}

async function inspectMcp(configPath: string): Promise<ReadbackCheckSurface> {
  const config = await readJson(configPath);
  if (config.status === "missing")
    return missing("ASD MCP server is not registered.", "asd mcp install");
  if (config.status === "unverifiable") return config.surface;
  const server = getRecord(getRecord(config.value).mcpServers).asd;
  if (server === undefined) return missing("ASD MCP server is not registered.", "asd mcp install");
  if (isAsdMcpServer(server)) return installed("ASD MCP server uses stdio and `mcp serve`.");
  return drifted("ASD MCP server registration does not use stdio `mcp serve`.", "asd mcp install");
}

async function inspectVault(vaultRoot: string): Promise<ReadbackCheckSurface> {
  if (!(await pathExists(vaultRoot))) {
    return {
      detail: `Vault root is unavailable: ${vaultRoot}`,
      install_command: null,
      status: "unverifiable",
    };
  }
  return missing(
    "Vault is reachable; run `asd recall --cwd <project>` to verify project and global memory.",
    null,
  );
}

function containsSessionStartRecall(value: unknown): boolean {
  const hooks = getRecord(getRecord(value).hooks).SessionStart;
  if (!Array.isArray(hooks)) return false;
  return JSON.stringify(hooks).includes("asd-session-start-recall");
}

function isAsdMcpServer(value: unknown): boolean {
  const server = getRecord(value);
  const args = server.args;
  return (
    server.type === "stdio" &&
    Array.isArray(args) &&
    args.length >= 2 &&
    args[args.length - 2] === "mcp" &&
    args[args.length - 1] === "serve"
  );
}

function getRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

async function readJson(
  path: string,
): Promise<
  | { status: "missing" }
  | { status: "valid"; value: unknown }
  | { status: "unverifiable"; surface: ReadbackCheckSurface }
> {
  try {
    return { status: "valid", value: JSON.parse(await readFile(path, "utf8")) };
  } catch (error) {
    if (isMissingPathError(error)) return { status: "missing" };
    return {
      status: "unverifiable",
      surface: {
        detail: `Cannot read valid JSON: ${path}`,
        install_command: null,
        status: "unverifiable",
      },
    };
  }
}

function installed(detail: string): ReadbackCheckSurface {
  return { detail, install_command: null, status: "installed" };
}

function missing(detail: string, installCommand: string | null): ReadbackCheckSurface {
  return { detail, install_command: installCommand, status: "missing" };
}

function drifted(detail: string, installCommand: string): ReadbackCheckSurface {
  return { detail, install_command: installCommand, status: "drifted" };
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

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
