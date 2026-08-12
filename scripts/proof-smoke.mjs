#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/**
 * Turnkey launch proof reruns for v1 gates and the v2 memory pipeline.
 *
 * Usage:
 *   node scripts/proof-smoke.mjs              # all suites
 *   node scripts/proof-smoke.mjs --suite v2   # v2 memory pipeline only
 *   node scripts/proof-smoke.mjs --write-summary /tmp/.../SUMMARY.md
 */
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLearningReviewBatch,
  buildLearningReviewInputContentHash,
  writeLearningReviewBatch,
} from "../dist/pipeline/llm-learning-review-batch.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const cliPath = join(projectRoot, "dist", "cli.js");

const args = process.argv.slice(2);
const suiteArg = parseOption("--suite") ?? "all";
const writeSummaryPath = parseOption("--write-summary");
const keepSandbox = args.includes("--keep");

const suites = suiteArg === "all" ? ["v1", "v2"] : [suiteArg];
const supportedSuites = new Set(["v1", "v2", "first-time"]);
if (suites.some((suite) => !supportedSuites.has(suite))) {
  throw new Error(`Unknown suite "${suiteArg}". Use v1, v2, first-time, or all.`);
}

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

if (suites.includes("first-time")) {
  report.suites.first_time = await runV1Proofs({ firstTime: true });
  if (!report.suites.first_time.success) report.success = false;
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

async function runV1Proofs({ firstTime = false } = {}) {
  const sandbox = await mkdtemp(join(tmpdir(), "marrow-proof-v1-"));
  const home = join(sandbox, "home");
  const runtimeRoot = join(sandbox, "runtime");
  const sourcePath = join(
    home,
    ".cursor",
    "projects",
    "marrow",
    "agent-transcripts",
    "session-e2e.jsonl",
  );
  const steps = [];
  const artifacts = {};

  try {
    const cursorProject = dirname(dirname(sourcePath));
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(join(cursorProject, "workspace-path.txt"), `${projectRoot}\n`, "utf8");
    await cp(join(projectRoot, "test/fixtures/cursor/transcripts/session-e2e.jsonl"), sourcePath);

    steps.push(runCliStep("install/build/help", ["--help"], { MARROW_ROOT: runtimeRoot }));
    const ingestStep = runCliStep("ingest backfill", ["ingest", "backfill", "--source", "cursor"], {
      HOME: home,
      MARROW_ROOT: runtimeRoot,
    });
    steps.push(ingestStep);
    steps.push(
      runCliStep("review queue", ["review", "queue"], {
        MARROW_ROOT: runtimeRoot,
      }),
    );
    steps.push(
      runCliStep("review show", ["review", "show", "session-e2e"], {
        MARROW_ROOT: runtimeRoot,
      }),
    );
    const explainStep = runCliStep("explain", ["explain", "session-e2e"], {
      MARROW_ROOT: runtimeRoot,
    });
    steps.push(explainStep);

    if (firstTime) {
      const ingestPayload = JSON.parse(ingestStep.stdout);
      const projectKey = ingestPayload.sessions[0]?.project_key;
      if (!projectKey) throw new Error("ingest backfill did not return project_key");

      artifacts.summary_path = join(runtimeRoot, "summaries/by-session/session-e2e/summary.md");
      artifacts.learning_path = join(
        runtimeRoot,
        "knowledge/projects",
        projectKey,
        "session-e2e.jsonl",
      );
      artifacts.deletion_candidate_path = join(runtimeRoot, "deletes/receipts/session-e2e.json");
      artifacts.runtime_root = runtimeRoot;
      artifacts.source_path = sourcePath;
      artifacts.cleanup_command = `rm -rf ${sandbox}`;
      const [summary, learningJsonl] = await Promise.all([
        readFile(artifacts.summary_path, "utf8"),
        readFile(artifacts.learning_path, "utf8"),
        access(artifacts.deletion_candidate_path),
        access(sourcePath),
      ]);
      const [learning] = learningJsonl
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const durableArtifactsPresent = summary.trim().length > 0 && Boolean(learning?.learning_id);
      steps.push({
        name: "durable summary and learning",
        status: durableArtifactsPresent ? "passed" : "failed",
        stderr: durableArtifactsPresent ? "" : "summary or durable learning is empty",
        stdout: JSON.stringify({
          learning_id: learning?.learning_id ?? null,
          summary_bytes: Buffer.byteLength(summary, "utf8"),
        }),
      });

      const explainPayload = JSON.parse(explainStep.stdout);
      const candidateReady = explainPayload.deletion_candidate?.candidate_state === "ready";
      steps.push({
        name: "deletion readiness without source deletion",
        status: candidateReady ? "passed" : "failed",
        stderr: candidateReady ? "" : "fixture deletion candidate is not ready",
        stdout: JSON.stringify(explainPayload.deletion_candidate ?? null),
      });

      steps.push(
        runCliStep("export index", ["export-index"], {
          MARROW_ROOT: runtimeRoot,
        }),
      );
      const searchStep = runCliStep("bounded search", ["search", "session-e2e"], {
        MARROW_ROOT: runtimeRoot,
      });
      searchStep.status =
        searchStep.status === "passed" && /\b1 match\./.test(searchStep.stdout)
          ? "passed"
          : "failed";
      if (searchStep.status === "failed" && !searchStep.stderr) {
        searchStep.stderr = "search did not return the fixture session";
      }
      steps.push(searchStep);
      artifacts.recall_path = join(runtimeRoot, "index/session-index.jsonl");
      artifacts.next_live_command = "node dist/cli.js ingest sync --resume --source cursor";
      artifacts.runtime_root_isolated = runtimeRoot.startsWith(sandbox);
    }

    const failed = steps.filter((step) => step.status === "failed");
    const success = failed.length === 0;
    if (!keepSandbox && success) {
      await rm(sandbox, { recursive: true, force: true });
    }
    return {
      home,
      runtimeRoot,
      sandbox,
      steps,
      artifacts,
      runtime_root_isolated: runtimeRoot.startsWith(sandbox),
      next_live_command: firstTime ? "node dist/cli.js ingest sync --resume --source cursor" : null,
      success,
    };
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
    return {
      home,
      runtimeRoot,
      sandbox,
      steps,
      artifacts,
      runtime_root_isolated: runtimeRoot.startsWith(sandbox),
      next_live_command: firstTime ? "node dist/cli.js ingest sync --resume --source cursor" : null,
      success: false,
    };
  }
}

async function runV2MemoryPipelineProof() {
  const sandbox = await mkdtemp(join(tmpdir(), "marrow-proof-v2-"));
  const home = join(sandbox, "home");
  const runtimeRoot = join(sandbox, "runtime");
  const vaultRoot = join(sandbox, "vault");
  const steps = [];
  const artifacts = {};

  try {
    await mkdir(vaultRoot, { recursive: true });

    const cursorProject = join(home, ".cursor", "projects", "marrow");
    await mkdir(join(cursorProject, "agent-transcripts"), { recursive: true });
    await writeFile(join(cursorProject, "workspace-path.txt"), `${projectRoot}\n`, "utf8");
    await cp(
      join(projectRoot, "test/fixtures/cursor/transcripts/session-e2e.jsonl"),
      join(cursorProject, "agent-transcripts/session-e2e.jsonl"),
    );

    const ingestStep = runCliStep("ingest backfill", ["ingest", "backfill", "--source", "cursor"], {
      HOME: home,
      MARROW_ROOT: runtimeRoot,
    });
    steps.push(ingestStep);

    const ingestPayload = JSON.parse(ingestStep.stdout);
    const projectKey = ingestPayload.sessions[0]?.project_key;
    if (!projectKey) {
      throw new Error("ingest backfill did not return project_key");
    }

    const learningPath = join(runtimeRoot, "knowledge/projects", projectKey, "session-e2e.jsonl");
    const [learning] = (await readFile(learningPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    const generatedBatch = await writeLearningReviewBatch({
      batch: buildLearningReviewBatch({
        createdAt: new Date().toISOString(),
        model: "proof-fixture",
        reviews: [
          {
            session_id: "session-e2e",
            learning_id: learning.learning_id,
            input_content_hash: buildLearningReviewInputContentHash(learning),
            scope_key: learning.scope_key,
            statement: learning.statement,
            suggested_statement: "Prefer reviewed project learnings for v2 instinct sync proof.",
            trigger: learning.trigger,
            verdict: "rewrite",
            keep: true,
            durability: "durable",
            reason: "Proof batch for v2 memory pipeline.",
          },
        ],
        runId: `proof-v2-${Date.now()}`,
        sourceLedgerWatermark: {
          entry_count: 0,
          last_learning_id: null,
          last_reviewed_at: null,
        },
      }),
      reportsDir: join(runtimeRoot, "reports"),
    });
    artifacts.review_batch = generatedBatch.batchPath;

    steps.push(
      runCliStep(
        "quality apply-learning-review",
        ["quality", "apply-learning-review", "--batch", generatedBatch.batchPath],
        { MARROW_ROOT: runtimeRoot },
      ),
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
        MARROW_ROOT: runtimeRoot,
      }),
    );
    artifacts.export_path = join(runtimeRoot, "exports/wiki-memory/reviewed-memory.jsonl");

    steps.push(
      runCliStep("memory push-wiki", ["memory", "push-wiki", "--vault", vaultRoot], {
        MARROW_ROOT: runtimeRoot,
        ASD_VAULT_ROOT: vaultRoot,
      }),
    );

    if (projectId) {
      const memoryPath = join(vaultRoot, "wiki/projects", projectId, "MEMORY.md");
      try {
        const memory = await readFile(memoryPath, "utf8");
        artifacts.memory_path = memoryPath;
        artifacts.memory_excerpt = memory.split("\n").slice(0, 12).join("\n");
        const pushPayload = JSON.parse(
          steps.find((s) => s.name === "memory push-wiki")?.stdout ?? "{}",
        );
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

  lines.push(
    "",
    "## Unit test backing",
    "",
    "- `npm test` — v2 suite under `test/v2-*.test.mjs`",
    "",
  );
  return `${lines.join("\n")}\n`;
}
