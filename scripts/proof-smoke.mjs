#!/usr/bin/env node
/**
 * Turnkey launch proof reruns for v1 gates and the v2 memory pipeline.
 *
 * Usage:
 *   node scripts/proof-smoke.mjs              # all suites
 *   node scripts/proof-smoke.mjs --suite v2   # v2 memory pipeline only
 *   node scripts/proof-smoke.mjs --write-summary /tmp/.../SUMMARY.md
 */
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const cliPath = join(projectRoot, "dist", "cli.js");

const args = process.argv.slice(2);
const suiteArg = parseOption("--suite") ?? "all";
const writeSummaryPath = parseOption("--write-summary");
const keepSandbox = args.includes("--keep");

const suites = suiteArg === "all" ? ["v1", "v2"] : [suiteArg];

await assertBuiltCli();

const report = {
  date: new Date().toISOString().slice(0, 10),
  repo: projectRoot,
  suites: {},
  success: true,
};

if (suites.includes("v1")) {
  report.suites.v1 = await runV1Proofs();
  if (!report.suites.v1.success) report.success = false;
}

if (suites.includes("v2")) {
  report.suites.v2 = await runV2MemoryPipelineProof();
  if (!report.suites.v2.success) report.success = false;
}

console.log(JSON.stringify(report, null, 2));

if (writeSummaryPath) {
  await mkdir(dirname(writeSummaryPath), { recursive: true });
  await writeFile(writeSummaryPath, formatSummaryMarkdown(report), "utf8");
}

process.exitCode = report.success ? 0 : 1;

async function runV1Proofs() {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-proof-v1-"));
  const home = join(sandbox, "home");
  const runtimeRoot = join(sandbox, "runtime");
  const steps = [];

  try {
    const cursorProject = join(home, ".cursor", "projects", "agent-session-distillery");
    await mkdir(join(cursorProject, "agent-transcripts"), { recursive: true });
    await writeFile(join(cursorProject, "workspace-path.txt"), `${projectRoot}\n`, "utf8");
    await cp(
      join(projectRoot, "test/fixtures/cursor/transcripts/session-e2e.jsonl"),
      join(cursorProject, "agent-transcripts/session-e2e.jsonl"),
    );

    steps.push(runCliStep("install/build/help", ["--help"], { AGENT_SESSION_DISTILLERY_ROOT: runtimeRoot }));
    steps.push(
      runCliStep("ingest backfill", ["ingest", "backfill", "--source", "cursor"], {
        HOME: home,
        AGENT_SESSION_DISTILLERY_ROOT: runtimeRoot,
      }),
    );
    steps.push(
      runCliStep("review queue", ["review", "queue"], {
        AGENT_SESSION_DISTILLERY_ROOT: runtimeRoot,
      }),
    );
    steps.push(
      runCliStep("review show", ["review", "show", "session-e2e"], {
        AGENT_SESSION_DISTILLERY_ROOT: runtimeRoot,
      }),
    );
    steps.push(
      runCliStep("explain", ["explain", "session-e2e"], {
        AGENT_SESSION_DISTILLERY_ROOT: runtimeRoot,
      }),
    );

    const failed = steps.filter((step) => step.status === "failed");
    const success = failed.length === 0;
    if (!keepSandbox && success) {
      await rm(sandbox, { recursive: true, force: true });
    }
    return { home, runtimeRoot, sandbox, steps, success };
  } catch (error) {
    steps.push({
      name: "v1 setup",
      status: "failed",
      stderr: error instanceof Error ? error.message : String(error),
      stdout: "",
    });
    if (!keepSandbox) {
      await rm(sandbox, { recursive: true, force: true });
    }
    return { home, runtimeRoot, sandbox, steps, success: false };
  }
}

async function runV2MemoryPipelineProof() {
  const sandbox = await mkdtemp(join(tmpdir(), "asd-proof-v2-"));
  const home = join(sandbox, "home");
  const runtimeRoot = join(sandbox, "runtime");
  const vaultRoot = join(sandbox, "vault");
  const steps = [];
  const artifacts = {};

  try {
    await mkdir(vaultRoot, { recursive: true });

    const cursorProject = join(home, ".cursor", "projects", "agent-session-distillery");
    await mkdir(join(cursorProject, "agent-transcripts"), { recursive: true });
    await writeFile(join(cursorProject, "workspace-path.txt"), `${projectRoot}\n`, "utf8");
    await cp(
      join(projectRoot, "test/fixtures/cursor/transcripts/session-e2e.jsonl"),
      join(cursorProject, "agent-transcripts/session-e2e.jsonl"),
    );

    const ingestStep = runCliStep("ingest backfill", ["ingest", "backfill", "--source", "cursor"], {
      HOME: home,
      AGENT_SESSION_DISTILLERY_ROOT: runtimeRoot,
    });
    steps.push(ingestStep);

    const ingestPayload = JSON.parse(ingestStep.stdout);
    const projectKey = ingestPayload.sessions[0]?.project_key;
    if (!projectKey) {
      throw new Error("ingest backfill did not return project_key");
    }

    const learningPath = join(
      runtimeRoot,
      "knowledge/projects",
      projectKey,
      "session-e2e.jsonl",
    );
    const [learning] = (await readFile(learningPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    const reviewPath = join(runtimeRoot, "reports/llm-learning-review.jsonl");
    await mkdir(dirname(reviewPath), { recursive: true });
    await writeFile(
      reviewPath,
      `${JSON.stringify({
        session_id: "session-e2e",
        learning_id: learning.learning_id,
        scope_key: learning.scope_key,
        statement: learning.statement,
        suggested_statement: "Prefer reviewed project learnings for v2 instinct sync proof.",
        verdict: "keep",
        keep: true,
        durability: "durable",
        reason: "Proof sidecar for v2 memory pipeline.",
      })}\n`,
      "utf8",
    );
    artifacts.review_sidecar = reviewPath;

    steps.push(
      runCliStep("quality apply-learning-review", ["quality", "apply-learning-review"], {
        AGENT_SESSION_DISTILLERY_ROOT: runtimeRoot,
      }),
    );

    const applyReport = JSON.parse(
      await readFile(join(runtimeRoot, "reports/llm-learning-review-apply.json"), "utf8"),
    );
    artifacts.apply_report = join(runtimeRoot, "reports/llm-learning-review-apply.json");
    artifacts.instinct_sync = applyReport.instinct_sync;

    const projectId = applyReport.instinct_sync?.[0]?.project_id;
    if (!projectId) {
      steps.push({
        name: "instinct sync",
        status: "failed",
        stderr: "apply report missing instinct_sync project_id",
        stdout: JSON.stringify(applyReport),
      });
    } else {
      const instinctDir = join(runtimeRoot, "instincts", projectId, "instincts");
      const instinctFiles = await listYamlFiles(instinctDir);
      artifacts.project_id = projectId;
      artifacts.instinct_dir = instinctDir;
      artifacts.instinct_files = instinctFiles;
      steps.push({
        name: "instinct store populated",
        status: instinctFiles.length > 0 ? "passed" : "failed",
        stderr: instinctFiles.length > 0 ? "" : `no instincts under ${instinctDir}`,
        stdout: JSON.stringify({ project_id: projectId, instinct_files: instinctFiles }),
      });
    }

    steps.push(
      runCliStep("memory export-wiki", ["memory", "export-wiki"], {
        AGENT_SESSION_DISTILLERY_ROOT: runtimeRoot,
      }),
    );
    artifacts.export_path = join(runtimeRoot, "exports/wiki-memory/reviewed-memory.jsonl");

    steps.push(
      runCliStep("memory push-wiki", ["memory", "push-wiki", "--vault", vaultRoot], {
        AGENT_SESSION_DISTILLERY_ROOT: runtimeRoot,
        ASD_VAULT_ROOT: vaultRoot,
      }),
    );

    if (projectId) {
      const memoryPath = join(vaultRoot, "wiki/projects", projectId, "MEMORY.md");
      try {
        const memory = await readFile(memoryPath, "utf8");
        artifacts.memory_path = memoryPath;
        artifacts.memory_excerpt = memory.split("\n").slice(0, 12).join("\n");
        const pushPayload = JSON.parse(steps.find((s) => s.name === "memory push-wiki")?.stdout ?? "{}");
        artifacts.memory_render = pushPayload.memory_renders?.[0] ?? null;
        steps.push({
          name: "vault MEMORY.md render",
          status:
            memory.includes("# Project memory (curated)") &&
            pushPayload.memory_renders?.[0]?.memoryPath
              ? "passed"
              : "failed",
          stderr: "",
          stdout: JSON.stringify({
            memory_path: memoryPath,
            included_count: pushPayload.memory_renders?.[0]?.includedCount ?? null,
          }),
        });
      } catch (error) {
        steps.push({
          name: "vault MEMORY.md render",
          status: "failed",
          stderr: error instanceof Error ? error.message : String(error),
          stdout: memoryPath,
        });
      }
    }

    const failed = steps.filter((step) => step.status === "failed");
    const success = failed.length === 0;
    if (!keepSandbox && success) {
      await rm(sandbox, { recursive: true, force: true });
    }
    return {
      sandbox,
      home,
      runtimeRoot,
      vaultRoot,
      steps,
      artifacts,
      success,
    };
  } catch (error) {
    steps.push({
      name: "v2 setup",
      status: "failed",
      stderr: error instanceof Error ? error.message : String(error),
      stdout: "",
    });
    if (!keepSandbox) {
      await rm(sandbox, { recursive: true, force: true });
    }
    return { sandbox, home, runtimeRoot, vaultRoot, steps, artifacts, success: false };
  }
}

function runCliStep(name, stepArgs, env) {
  const command = [process.execPath, cliPath, ...stepArgs];
  const result = spawnSync(command[0], command.slice(1), {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

  return {
    name,
    command: command.slice(1).join(" "),
    status: result.status === 0 ? "passed" : "failed",
    exit_code: result.status ?? 1,
    stderr: result.stderr.trim(),
    stdout: result.stdout.trim(),
  };
}

async function listYamlFiles(dir) {
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    return entries.filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"));
  } catch {
    return [];
  }
}

async function assertBuiltCli() {
  try {
    await access(cliPath);
  } catch {
    throw new Error(`Built CLI not found at ${cliPath}. Run npm run build first.`);
  }
}

function parseOption(flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function formatSummaryMarkdown(report) {
  const v2 = report.suites.v2;
  const lines = [
    "# v2 memory pipeline proof",
    "",
    `Date: ${report.date}`,
    `Repo: ${report.repo}`,
    "",
    "## Verdict",
    "",
    v2?.success ? "P0 v2 memory pipeline: validated." : "P0 v2 memory pipeline: FAILED.",
    "",
    "## Commands",
    "",
    "```bash",
    "npm run build",
    "node scripts/proof-smoke.mjs --suite v2 --keep",
    "```",
    "",
    "## Artifacts",
    "",
  ];

  if (v2?.artifacts) {
    for (const [key, value] of Object.entries(v2.artifacts)) {
      lines.push(`- **${key}:** ${typeof value === "string" ? value : JSON.stringify(value)}`);
    }
  }

  lines.push("", "## Steps", "");
  for (const step of v2?.steps ?? []) {
    lines.push(`- ${step.status === "passed" ? "✓" : "✗"} ${step.name}`);
    if (step.status === "failed" && step.stderr) {
      lines.push(`  - ${step.stderr}`);
    }
  }

  lines.push("", "## Unit test backing", "", "- `npm test` — v2 suite under `test/v2-*.test.mjs`", "");
  return `${lines.join("\n")}\n`;
}
