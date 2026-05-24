#!/usr/bin/env node
import { access, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const cliPath = join(projectRoot, "dist", "cli.js");

const dryRun = args.includes("--dry-run");
const llmTopic = !args.includes("--no-llm-topic");
const exportIndex = !args.includes("--no-export-index");
const limit = parseOption("--limit");

const env = { ...process.env };
const rootOverride = parseOption("--root");
if (rootOverride) {
  env.AGENT_SESSION_DISTILLERY_ROOT = resolve(rootOverride);
}

const runtimeRoot =
  env.AGENT_SESSION_DISTILLERY_ROOT || join(process.env.HOME ?? "", ".agent-session-distillery");

await assertBuiltCli();

const resummarizeArgs = [
  "quality",
  "resummarize",
  "--low-signal-only",
  ...(llmTopic ? ["--llm-topic"] : []),
  ...(exportIndex && !dryRun ? ["--export-index"] : []),
  ...(dryRun ? ["--dry-run"] : []),
  ...(limit ? ["--limit", limit] : []),
];

const step = runStep("resummarize corpus", resummarizeArgs);
const payload = parseCliJsonPayload(step.stdout);

const report = {
  command: resummarizeArgs.join(" "),
  dry_run: dryRun,
  export_index: exportIndex && !dryRun,
  llm_topic: llmTopic,
  report_path: join(runtimeRoot, "reports", "resummarize-corpus.json"),
  result: payload,
  root: runtimeRoot,
  step,
  success: step.status === "passed",
};

await mkdir(join(runtimeRoot, "reports"), { recursive: true });
await writeFile(report.report_path, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(JSON.stringify(report, null, 2));
process.exitCode = step.status === "passed" ? 0 : 1;

function parseOption(flag) {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

function runStep(name, stepArgs) {
  const command = [process.execPath, cliPath, ...stepArgs];
  const result = spawnSync(command[0], command.slice(1), {
    cwd: projectRoot,
    encoding: "utf8",
    env,
  });

  return {
    command: command.map(shellQuote).join(" "),
    exit_code: result.status ?? 1,
    name,
    status: result.status === 0 ? "passed" : "failed",
    stderr: result.stderr.trim(),
    stdout: result.stdout.trim(),
  };
}

async function assertBuiltCli() {
  if (await pathExists(cliPath)) {
    return;
  }

  throw new Error(`Built CLI not found at ${cliPath}. Run npm run build first.`);
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}

function parseCliJsonPayload(stdout) {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.lastIndexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) {
      return null;
    }

    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}
