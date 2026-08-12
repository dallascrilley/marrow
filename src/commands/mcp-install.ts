import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CommandContext } from "../cli.js";

const DEFAULT_SERVER_NAME = "marrow";

/**
 * One Claude Code MCP server registration. marrow serves over stdio via
 * `marrow mcp serve`, matching the `type: "stdio"` shape Claude Code writes for
 * locally-spawned servers in `~/.claude.json`.
 */
export type McpServerEntry = {
  type: "stdio";
  command: string;
  args: string[];
};

type ClaudeJson = {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
};

export type McpInstallOptions = {
  dryRun: boolean;
  configPath: string;
  serverName: string;
  nodePath: string;
  cliPath: string;
};

/**
 * Register marrow's capped (ADR-0005) MCP query server in the user's
 * `~/.claude.json` so agents can query distilled instincts on demand.
 *
 * Idempotent: if the named server already resolves to the desired entry, the
 * file is left untouched. Every other key in `~/.claude.json` is preserved —
 * only `mcpServers.<name>` is added or updated, written atomically.
 */
export async function executeMcpInstall(context: CommandContext): Promise<number> {
  const options = parseMcpInstallOptions(context.args);
  const entry = desiredServerEntry(options.nodePath, options.cliPath);

  const config = await readClaudeJson(options.configPath);
  const { config: merged, changed } = mergeMcpServer(config, options.serverName, entry);

  if (options.dryRun) {
    context.output.info(
      JSON.stringify(
        {
          dry_run: true,
          config_path: options.configPath,
          server_name: options.serverName,
          would_change: changed,
          entry,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (!changed) {
    context.output.info(
      `MCP server "${options.serverName}" already registered in ${options.configPath}`,
    );
    return 0;
  }

  await atomicWriteJson(options.configPath, merged);
  context.output.info(
    `Registered MCP server "${options.serverName}" in ${options.configPath} (command: ${entry.command} ${entry.args.join(" ")})`,
  );
  return 0;
}

export function parseMcpInstallOptions(args: readonly string[]): McpInstallOptions {
  let dryRun = false;
  let configPath = defaultConfigPath();
  let serverName = DEFAULT_SERVER_NAME;
  let nodePath = process.execPath;
  let cliPath = defaultCliPath();

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    const readValue = (): string => {
      const next = args[i + 1];
      if (next === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      i += 1;
      return next;
    };
    switch (arg) {
      case "--dry-run":
        dryRun = true;
        break;
      case "--config":
        configPath = resolve(readValue());
        break;
      case "--name":
        serverName = readValue();
        break;
      case "--node":
        nodePath = readValue();
        break;
      case "--cli":
        cliPath = resolve(readValue());
        break;
      default:
        throw new Error(`Unknown option for mcp install: ${arg}`);
    }
  }

  return { dryRun, configPath, serverName, nodePath, cliPath };
}

export function desiredServerEntry(nodePath: string, cliPath: string): McpServerEntry {
  return {
    type: "stdio",
    command: nodePath,
    args: [cliPath, "mcp", "serve"],
  };
}

/**
 * Merge the desired server entry into a Claude config, preserving every other
 * key. Returns `changed: false` when the existing entry already deep-equals the
 * desired one, so callers can skip writing the (large, sensitive) file.
 */
export function mergeMcpServer(
  config: ClaudeJson,
  serverName: string,
  entry: McpServerEntry,
): { config: ClaudeJson; changed: boolean } {
  const servers = { ...(config.mcpServers ?? {}) };
  if (deepEqual(servers[serverName], entry)) {
    return { config, changed: false };
  }
  return {
    config: { ...config, mcpServers: { ...servers, [serverName]: entry } },
    changed: true,
  };
}

function defaultConfigPath(): string {
  return join(homedir(), ".claude.json");
}

function defaultCliPath(): string {
  // This module compiles to dist/commands/mcp-install.js, so the sibling CLI
  // entrypoint is one directory up. Resolving from the running module keeps the
  // registration pinned to the build that installed it.
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, "..", "cli.js");
}

async function readClaudeJson(path: string): Promise<ClaudeJson> {
  try {
    await access(path);
  } catch {
    return {};
  }
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid Claude config JSON at ${path}`);
  }
  return parsed as ClaudeJson;
}

async function atomicWriteJson(targetPath: string, value: unknown): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const tempPath = join(dirname(targetPath), `.${basename(targetPath)}.marrow.tmp`);
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, targetPath);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
