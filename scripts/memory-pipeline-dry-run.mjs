#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const cliPath = join(projectRoot, "dist", "cli.js");

const options = {
  limit: parseOption("--limit") ?? "100",
  requireReview: args.includes("--require-review"),
  reviewInput: parseOption("--review-input"),
  root: parseOption("--root"),
};

const env = { ...process.env };
if (options.root) {
  env.AGENT_SESSION_DISTILLERY_ROOT = resolve(options.root);
}

const runtimeRoot =
  env.AGENT_SESSION_DISTILLERY_ROOT || join(process.env.HOME ?? "", ".agent-session-distillery");
const defaultReviewInput = join(runtimeRoot, "reports", "llm-learning-review.jsonl");
const reviewInput = options.reviewInput ? resolve(options.reviewInput) : defaultReviewInput;

await assertBuiltCli();

const steps = [];
steps.push(runStep("quality audit", ["quality", "audit", "--limit", options.limit]));

const reviewSidecarExists = await pathExists(reviewInput);
let applyOccurred = false;
if (reviewSidecarExists) {
  steps.push(
    runStep("apply learning review", ["quality", "apply-learning-review", "--input", reviewInput]),
  );
  applyOccurred = steps.at(-1)?.status === "passed";
} else if (options.requireReview) {
  steps.push({
    command: `test -f ${reviewInput}`,
    exit_code: 1,
    name: "apply learning review",
    status: "failed",
    stderr: `Missing review sidecar: ${reviewInput}`,
    stdout: "",
  });
} else {
  steps.push({
    command: `test -f ${reviewInput}`,
    exit_code: 0,
    name: "apply learning review",
    status: "skipped",
    stderr: "",
    stdout: `No review sidecar found at ${reviewInput}; export will use reviewed learnings only if they already exist, otherwise deterministic project learnings.`,
  });
}

steps.push(runStep("memory export wiki", ["memory", "export-wiki"]));

const failed = steps.filter((step) => step.status === "failed");
const summary = {
  apply_occurred: applyOccurred,
  dry_run: true,
  export_path: join(runtimeRoot, "exports", "wiki-memory", "reviewed-memory.jsonl"),
  review_input: reviewInput,
  root: runtimeRoot,
  steps,
  success: failed.length === 0,
};

console.log(JSON.stringify(summary, null, 2));
process.exitCode = failed.length === 0 ? 0 : 1;

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
