#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { access, cp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/resummarize-corpus.mjs [options]

Regenerate summary topics for archived sessions with safety defaults for corpus sweeps.

Options:
  --dry-run              Report would_process_count without writing summaries
  --confirm              Required for write sweeps against the real runtime store
  --no-llm-topic         Use deterministic topic derivation only (default)
  --llm-topic            Allow LLM topic rescue during resummarize
  --no-export-index      Skip session-index.jsonl refresh after write
  --export-index         Refresh session-index.jsonl after write (default when writing)
  --low-signal-only      Legacy selector: only low-signal topics (not wrapper-header leaks)
  --leaked-topic-only    Selector for harness/wrapper topic leaks (default)
  --limit <n>            Cap candidate sessions processed
  --max-per <n>          LLM budget cap (requires --llm-topic)
  --root <path>          Override AGENT_SESSION_DISTILLERY_ROOT
  --help, -h             Show this help

Write sweeps copy summaries/ to backups/summaries-pre-resummarize-<timestamp>/ first.
Set ASD_CORPUS_RESUMMARIZE_CONFIRM=1 as an alternative to --confirm.
`);
  process.exit(0);
}

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const cliPath = join(projectRoot, "dist", "cli.js");

const dryRun = args.includes("--dry-run");
const confirm = args.includes("--confirm") || process.env.ASD_CORPUS_RESUMMARIZE_CONFIRM === "1";
const llmTopic = args.includes("--llm-topic");
const exportIndex = !args.includes("--no-export-index");
const lowSignalOnly = args.includes("--low-signal-only");
const leakedTopicOnly = args.includes("--leaked-topic-only") || !lowSignalOnly;
const limit = parseOption("--limit");
const maxPer = parseOption("--max-per") ?? process.env.ASD_LLM_MAX_PER;

if (lowSignalOnly && args.includes("--leaked-topic-only")) {
  throw new Error("Use only one of --leaked-topic-only or --low-signal-only");
}

const env = { ...process.env };
const rootOverride = parseOption("--root");
if (rootOverride) {
  env.AGENT_SESSION_DISTILLERY_ROOT = resolve(rootOverride);
}

const runtimeRoot =
  env.AGENT_SESSION_DISTILLERY_ROOT || join(process.env.HOME ?? "", ".agent-session-distillery");

await assertBuiltCli();

if (!dryRun && !confirm) {
  throw new Error(
    "Refusing write sweep without --confirm (or ASD_CORPUS_RESUMMARIZE_CONFIRM=1). Run with --dry-run first.",
  );
}

let backupPath = null;
if (!dryRun) {
  backupPath = await backupSummaries(runtimeRoot);
}

const resummarizeArgs = [
  "quality",
  "resummarize",
  ...(leakedTopicOnly ? ["--leaked-topic-only"] : []),
  ...(lowSignalOnly ? ["--low-signal-only"] : []),
  ...(llmTopic ? ["--llm-topic"] : []),
  ...(maxPer ? ["--max-per", maxPer] : []),
  ...(exportIndex && !dryRun ? ["--export-index"] : []),
  ...(dryRun ? ["--dry-run"] : []),
  ...(limit ? ["--limit", limit] : []),
];

const step = runStep("resummarize corpus", resummarizeArgs);
const payload = parseCliJsonPayload(step.stdout);

const report = {
  backup_path: backupPath,
  command: resummarizeArgs.join(" "),
  confirmed: confirm,
  dry_run: dryRun,
  export_index: exportIndex && !dryRun,
  leaked_topic_only: leakedTopicOnly,
  llm_topic: llmTopic,
  low_signal_only: lowSignalOnly,
  max_per: maxPer ?? null,
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

async function backupSummaries(root) {
  const summariesPath = join(root, "summaries");
  if (!(await pathExists(summariesPath))) {
    return null;
  }

  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const destination = join(root, "backups", `summaries-pre-resummarize-${timestamp}`);
  await mkdir(join(root, "backups"), { recursive: true });
  await cp(summariesPath, destination, { recursive: true });
  return destination;
}

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
