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
  reviewBatch: parseOption("--review-batch"),
  root: parseOption("--root"),
};

const env = { ...process.env };
if (options.root) {
  env.MARROW_ROOT = resolve(options.root);
}

const runtimeRoot = env.MARROW_ROOT || join(process.env.HOME ?? "", ".marrow");
const reviewBatch = options.reviewBatch ? resolve(options.reviewBatch) : undefined;

await assertBuiltCli();

const steps = [];
steps.push(runStep("quality audit", ["quality", "audit", "--limit", options.limit]));

const reviewBatchExists = reviewBatch !== undefined && (await pathExists(reviewBatch));
let applyOccurred = false;
if (reviewBatchExists) {
  steps.push(
    runStep("apply learning review", ["quality", "apply-learning-review", "--batch", reviewBatch]),
  );
  applyOccurred = steps.at(-1)?.status === "passed";
} else if (options.requireReview) {
  steps.push({
    command: reviewBatch === undefined ? "test -n $REVIEW_BATCH" : `test -f ${reviewBatch}`,
    exit_code: 1,
    name: "apply learning review",
    status: "failed",
    stderr:
      reviewBatch === undefined
        ? "Missing --review-batch <path>"
        : `Missing review batch: ${reviewBatch}`,
    stdout: "",
  });
} else {
  steps.push({
    command: reviewBatch === undefined ? "test -n $REVIEW_BATCH" : `test -f ${reviewBatch}`,
    exit_code: 0,
    name: "apply learning review",
    status: "skipped",
    stderr: "",
    stdout:
      reviewBatch === undefined
        ? "No review batch selected; export will use existing reviewed learnings when available, otherwise deterministic project learnings."
        : `No review batch found at ${reviewBatch}; export will use existing reviewed learnings when available, otherwise deterministic project learnings.`,
  });
}

steps.push(runStep("memory export wiki", ["memory", "export-wiki"]));

const failed = steps.filter((step) => step.status === "failed");
const summary = {
  apply_occurred: applyOccurred,
  dry_run: true,
  export_path: join(runtimeRoot, "exports", "wiki-memory", "reviewed-memory.jsonl"),
  review_batch: reviewBatch ?? null,
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
