import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CommandContext } from "../cli.js";
import { executeRecall } from "./recall.js";

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
  verification: { bytes: number; command: string; status: "delivered" | "missing" } | null;
};

type ReadbackCheckPaths = {
  hookPath: string;
  mcpConfigPath: string;
  settingsPath: string;
  vaultRoot: string;
};

export async function executeReadbackCheck(context: CommandContext): Promise<number> {
  const verify = parseReadbackCheckOptions(context.args);
  const projectRoot = process.cwd();
  const vaultRoot = process.env.ASD_VAULT_ROOT?.trim() || join(homedir(), "vault");
  const report = await assessReadbackSetup({
    hookPath: join(projectRoot, ".claude", "hooks", "marrow-session-start-recall.sh"),
    mcpConfigPath: join(homedir(), ".claude.json"),
    settingsPath: join(projectRoot, ".claude", "settings.json"),
    vaultRoot,
  });
  if (verify && report.recall.status !== "unverifiable") {
    report.verification = await verifyBoundedRecall(context, projectRoot, vaultRoot);
  }
  context.output.info(JSON.stringify(report, null, 2));
  return report.hook.status === "unverifiable" || report.mcp.status === "unverifiable" ? 2 : 0;
}

export async function assessReadbackSetup(paths: ReadbackCheckPaths): Promise<ReadbackSetupReport> {
  const [hook, mcp, recall] = await Promise.all([
    inspectHook(paths.settingsPath, paths.hookPath),
    inspectMcp(paths.mcpConfigPath),
    inspectVault(paths.vaultRoot),
  ]);
  return { hook, mcp, recall, verification: null };
}

function parseReadbackCheckOptions(args: readonly string[]): boolean {
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === "--verify") return true;
  throw new Error(`Unknown readback check option: ${args[0] ?? ""}`);
}

async function verifyBoundedRecall(
  context: CommandContext,
  cwd: string,
  vaultRoot: string,
): Promise<{ bytes: number; command: string; status: "delivered" | "missing" }> {
  const output: string[] = [];
  await executeRecall({
    ...context,
    args: ["--cwd", cwd, "--vault-root", vaultRoot],
    commandPath: ["recall"],
    output: { error: (message) => output.push(message), info: (message) => output.push(message) },
  });
  const payload = output.join("\n");
  return {
    bytes: Buffer.byteLength(payload, "utf8"),
    command: `marrow recall --cwd ${cwd} --vault-root ${vaultRoot}`,
    status: payload.length > 0 ? "delivered" : "missing",
  };
}

async function inspectHook(settingsPath: string, hookPath: string): Promise<ReadbackCheckSurface> {
  const settings = await readJson(settingsPath);
  if (settings.status === "missing") {
    return missing("SessionStart hook is not registered.", "marrow hooks install --events start");
  }
  if (settings.status === "unverifiable") return settings.surface;
  const registered = containsSessionStartRecall(settings.value);
  const scriptPresent = await pathExists(hookPath);
  if (registered && scriptPresent)
    return installed("SessionStart recall hook is registered and its script exists.");
  if (registered || scriptPresent) {
    return drifted(
      "SessionStart recall registration and hook script do not agree.",
      "marrow hooks install --events start",
    );
  }
  return missing("SessionStart hook is not registered.", "marrow hooks install --events start");
}

async function inspectMcp(configPath: string): Promise<ReadbackCheckSurface> {
  const config = await readJson(configPath);
  if (config.status === "missing")
    return missing("Marrow MCP server is not registered.", "marrow mcp install");
  if (config.status === "unverifiable") return config.surface;
  const server = getRecord(getRecord(config.value).mcpServers).marrow;
  if (server === undefined)
    return missing("Marrow MCP server is not registered.", "marrow mcp install");
  if (isAsdMcpServer(server)) return installed("Marrow MCP server uses stdio and `mcp serve`.");
  return drifted(
    "Marrow MCP server registration does not use stdio `mcp serve`.",
    "marrow mcp install",
  );
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
    "Vault is reachable; run `marrow recall --cwd <project>` to verify project and global memory.",
    null,
  );
}

function containsSessionStartRecall(value: unknown): boolean {
  const hooks = getRecord(getRecord(value).hooks).SessionStart;
  if (!Array.isArray(hooks)) return false;
  return JSON.stringify(hooks).includes("marrow-session-start-recall");
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
