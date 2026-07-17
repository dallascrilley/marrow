#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { executeArchiveRun } from "./commands/archive-run.js";
import { executeCheckSessions } from "./commands/check-sessions.js";
import { executeDeleteApply } from "./commands/delete-apply.js";
import { executeDeleteCandidates } from "./commands/delete-candidates.js";
import { executeDeleteSources } from "./commands/delete-sources.js";
import { executeDoctorProvider } from "./commands/doctor-provider.js";
import { executeExplain } from "./commands/explain.js";
import { executeExportIndex } from "./commands/export-index.js";
import { executeHealth } from "./commands/health.js";
import { executeHooksInstall } from "./commands/hooks-install.js";
import { executeIngestBackfill } from "./commands/ingest-backfill.js";
import { executeIngestSync } from "./commands/ingest-sync.js";
import { executeMcp } from "./commands/mcp.js";
import { executeMemoryExportWiki } from "./commands/memory-export-wiki.js";
import { executeMemoryPushWiki } from "./commands/memory-push-wiki.js";
import { executeMigrateProjectIds } from "./commands/migrate-project-ids.js";
import { executePipelineGate } from "./commands/pipeline-gate.js";
import { executePipelineReextract } from "./commands/pipeline-reextract.js";
import { executePipelineRereduce } from "./commands/pipeline-rereduce.js";
import { executePromoteJudge } from "./commands/promote-judge.js";
import { executePromoteReview } from "./commands/promote-review.js";
import { executeQualityApplyLearningReview } from "./commands/quality-apply-learning-review.js";
import { executeQualityAudit } from "./commands/quality-audit.js";
import { executeQualityCostReport } from "./commands/quality-cost-report.js";
import { executeQualityResummarize } from "./commands/quality-resummarize.js";
import { executeQualityReviewLearnings } from "./commands/quality-review-learnings.js";
import { executeReadbackCheck } from "./commands/readback-check.js";
import { executeRecall } from "./commands/recall.js";
import { executeReport } from "./commands/report.js";
import { executeReviewQueue } from "./commands/review-queue.js";
import { executeReviewShow } from "./commands/review-show.js";
import { executeSearch } from "./commands/search.js";
import { executeSkillEvidence } from "./commands/skill-evidence.js";
import { executeSkillReport } from "./commands/skill-report.js";
import { executeStats } from "./commands/stats.js";
import { executeStorageInventory } from "./commands/storage-inventory.js";
import { executeStorageParsedCleanup } from "./commands/storage-parsed-cleanup.js";
import { executeStorageReportRetention } from "./commands/storage-report-retention.js";
import { executeWorkflowApply } from "./commands/workflow-apply.js";
import { executeWorkflowJudge } from "./commands/workflow-judge.js";
import { executeWorkflowMine } from "./commands/workflow-mine.js";
import {
  executeWorkflowAdopt,
  executeWorkflowDefer,
  executeWorkflowDismiss,
  executeWorkflowReview,
  executeWorkflowShow,
} from "./commands/workflow-review.js";
import { executeWorktreeCheck } from "./commands/worktree-check.js";
import { getRuntimeRoot } from "./config/paths.js";
import { createLedger } from "./db/ledger.js";

type Output = {
  error: (message: string) => void;
  info: (message: string) => void;
};

export type CommandContext = {
  args: string[];
  commandPath: string[];
  output: Output;
};

type CommandDefinition = {
  description: string;
  execute?: (context: CommandContext) => Promise<number>;
  subcommands?: Record<string, CommandDefinition>;
};

const commandTree: Record<string, CommandDefinition> = {
  ingest: {
    description: "Ingest source sessions into the local distillery runtime.",
    subcommands: {
      backfill: {
        description:
          "Ingest historical transcripts for --source (cursor, claude-code, codex-cli, kimi, pi) with optional since/limit/resume controls.",
        execute: async (context) => withLedger(context, executeIngestBackfill),
      },
      sync: {
        description:
          "Ingest only new-or-changed transcripts for --source (cursor, claude-code, codex-cli, kimi, pi).",
        execute: async (context) => withLedger(context, executeIngestSync),
      },
    },
  },
  review: {
    description: "Inspect the review queue and individual review records.",
    subcommands: {
      queue: {
        description: "List review queue entries.",
        execute: async (context) => withLedger(context, executeReviewQueue),
      },
      show: {
        description: "Show one review queue entry by session id.",
        execute: async (context) => withLedger(context, executeReviewShow),
      },
    },
  },
  quality: {
    description: "Audit distilled output quality across stored sessions.",
    subcommands: {
      audit: {
        description:
          "Score summaries, learnings, and deletion readiness across existing runtime artifacts. Pass --topic-distribution for corpus topic-quality stats and remediation hints.",
        execute: async (context) => withLedger(context, executeQualityAudit),
      },
      "review-learnings": {
        description:
          "Review project learnings with OpenRouter LLM memory lint and write an immutable batch. Pass --if-new to skip when nothing is pending; default --max-per is 50/24h.",
        execute: async (context) => withLedger(context, executeQualityReviewLearnings),
      },
      "apply-learning-review": {
        description:
          "Apply an explicit immutable review batch into knowledge/projects-reviewed. Pass --batch <path> or --latest.",
        execute: async (context) => withLedger(context, executeQualityApplyLearningReview),
      },
      "cost-report": {
        description:
          "Report OpenRouter LLM cost from telemetry receipts: cost per session (mean/p50/p90/max), cost per learning, cache-hit rate. Flags: --json, --since <iso>, --backlog-learnings <n>.",
        execute: async (context) => executeQualityCostReport(context),
      },
      resummarize: {
        description:
          "Regenerate summary topics for archived sessions without mutating manifests; optional --leaked-topic-only, --low-signal-only, --over-extracted-only, --llm-topic, --max-per, --export-index, --dry-run.",
        execute: async (context) => withLedger(context, executeQualityResummarize),
      },
    },
  },
  check: {
    description:
      "Read-only session integrity report: duplicate asd_session_id, duplicate ledger session_id, orphan manifests.",
    execute: async (context) => withLedger(context, executeCheckSessions),
  },
  archive: {
    description: "Move accepted sessions into archive storage.",
    subcommands: {
      run: {
        description: "Archive extracted sessions and generate deletion candidates.",
        execute: async (context) => withLedger(context, executeArchiveRun),
      },
    },
  },
  delete: {
    description: "Inspect and apply deletion decisions.",
    subcommands: {
      candidates: {
        description: "List deletion candidates and readiness state.",
        execute: async (context) => withLedger(context, executeDeleteCandidates),
      },
      apply: {
        description: "Dry-run deletion apply by default; pass --apply to mark candidates deleted.",
        execute: async (context) => withLedger(context, executeDeleteApply),
      },
      sources: {
        description:
          "Dry-run raw archive and deletion for one source adapter; pass --source codex-cli and --apply to archive, verify, unlink, and tombstone eligible Codex sources.",
        execute: async (context) => withLedger(context, executeDeleteSources),
      },
    },
  },
  doctor: {
    description: "Preflight checks for operator diagnostics.",
    subcommands: {
      provider: {
        description:
          "Check OpenRouter credential resolution, model catalog, route/data-policy, and LLM budget headroom.",
        execute: async (context) => executeDoctorProvider(context),
      },
    },
  },
  memory: {
    description: "Export reviewed memory records for downstream systems.",
    subcommands: {
      "export-wiki": {
        description: "Write reviewed-memory JSONL for the LLM wiki importer.",
        execute: async (context) => withLedger(context, executeMemoryExportWiki),
      },
      "push-wiki": {
        description:
          "Push reviewed-memory records into the personal vault as Obsidian-shaped pages.",
        execute: async (context) => withLedger(context, executeMemoryPushWiki),
      },
    },
  },
  search: {
    description: "Search the session index by topic, session id, or source tool.",
    execute: async (context) => withLedger(context, executeSearch),
  },
  "export-index": {
    description: "Write a consolidated session index JSONL for summarized sessions.",
    execute: async (context) => withLedger(context, executeExportIndex),
  },
  health: {
    description:
      "Summarize operational health, blockers, budgets, delivery, storage, and one next command.",
    execute: async (context) => executeHealth(context),
  },
  stats: {
    description: "Report high-level distillery runtime statistics.",
    execute: async (context) => withLedger(context, executeStats),
  },
  storage: {
    description: "Inspect bounded runtime lifecycle and storage inventory.",
    subcommands: {
      inventory: {
        description:
          "Classify runtime files by artifact kind, lifecycle state, age, and conservative retention dependency. Pass --json, --state, or --older-than-days.",
        execute: async (context) => withLedger(context, executeStorageInventory),
      },
      "retain-reports": {
        description:
          "Dry-run conservative retention of terminal archive and applied review reports. Pass --history, --older-than-days, and --apply to prune.",
        execute: async (context) => withLedger(context, executeStorageReportRetention),
      },
      "cleanup-parsed": {
        description:
          "Dry-run or apply conservative age/size cleanup of parsed records with durable downstream retention.",
        execute: async (context) => withLedger(context, executeStorageParsedCleanup),
      },
    },
  },
  explain: {
    description: "Explain how a stored result was derived.",
    execute: async (context) => withLedger(context, executeExplain),
  },
  report: {
    description: "Write static offline reports from the current runtime.",
    execute: async (context) => withLedger(context, executeReport),
  },
  migrate: {
    description: "Migrate runtime artifacts between naming schemes.",
    subcommands: {
      "project-ids": {
        description:
          "Map legacy project keys to ADR-0002 project ids (dry-run by default; pass --apply to copy knowledge/projects).",
        execute: async (context) => withLedger(context, executeMigrateProjectIds),
      },
    },
  },
  hooks: {
    description: "Install harness hooks that trigger asd ingest on session lifecycle events.",
    subcommands: {
      install: {
        description:
          "Install Claude Code SessionEnd hook → asd ingest sync --source claude-code (project .claude/ by default; pass --global for ~/.claude/settings.json).",
        execute: async (context) => executeHooksInstall(context),
      },
    },
  },
  worktree: {
    description: "Inspect registered Git worktrees without mutating them.",
    subcommands: {
      check: {
        description:
          "Classify registered worktrees as clean-current, dirty-active, dirty-stale, merged, or unknown. Flags: --json, --repo <path>.",
        execute: async (context) => executeWorktreeCheck(context),
      },
    },
  },
  skill: {
    description: "Analyze hub skill usage against distilled session evidence.",
    subcommands: {
      evidence: {
        description:
          "List indexed sessions whose summaries mention a hub skill id (run export-index after ingest).",
        execute: async (context) => withLedger(context, executeSkillEvidence),
      },
      report: {
        description:
          "Score SKILL.md checklist adherence across relevant sessions and emit improvement suggestions.",
        execute: async (context) => withLedger(context, executeSkillReport),
      },
    },
  },
  workflow: {
    description: "Mine distilled sessions for reviewable workflow guidance candidates.",
    subcommands: {
      mine: {
        description:
          "Emit read-only workflow guidance candidates from recent sessions. Flags: --days, --source, --limit, --json.",
        execute: async (context) => withLedger(context, executeWorkflowMine),
      },
      review: {
        description: "List undecided workflow candidates. Flags: --days, --source, --json.",
        execute: async (context) => withLedger(context, executeWorkflowReview),
      },
      show: {
        description: "Show one workflow candidate by id, including excerpts and prior decision.",
        execute: async (context) => withLedger(context, executeWorkflowShow),
      },
      adopt: {
        description: "Append an adopt decision for a workflow candidate. Flags: --note.",
        execute: async (context) => withLedger(context, executeWorkflowAdopt),
      },
      dismiss: {
        description: "Append a dismiss decision for a workflow candidate. Flags: --note.",
        execute: async (context) => withLedger(context, executeWorkflowDismiss),
      },
      defer: {
        description: "Append a defer decision for a workflow candidate. Flags: --note.",
        execute: async (context) => withLedger(context, executeWorkflowDefer),
      },
      judge: {
        description:
          "LLM-judge workflow candidates and append judged decisions. Flags: --limit, --days, --source, --model, --max-per, --max-usd.",
        execute: async (context) => withLedger(context, executeWorkflowJudge),
      },
      apply: {
        description:
          "Render a draft artifact for a workflow candidate. Flags: --target, --dry-run, --days, --source.",
        execute: async (context) => withLedger(context, executeWorkflowApply),
      },
    },
  },
  pipeline: {
    description: "Cheap pipeline gates before LLM-bound memory passes.",
    subcommands: {
      gate: {
        description:
          "Report pending ingest work, unreviewed learnings, and LLM budget headroom without calling OpenRouter. Pass --skip-ingest after a sync loop to avoid re-scanning adapters.",
        execute: async (context) => withLedger(context, executePipelineGate),
      },
      reextract: {
        description:
          "Retroactively re-run summarize+extract+archive on already-ingested sessions with the current pipeline (deterministic, no LLM). Requires --process-chatter-only or --session-id <id>; pass --dry-run to preview matched sessions.",
        execute: async (context) => withLedger(context, executePipelineReextract),
      },
      rereduce: {
        description:
          "Re-run reduce (then summarize+extract+archive) from surviving parsed-records.json so reduce-layer improvements reach historical sessions (deterministic, no LLM). Requires --all-with-parsed or --session-id <id>; pass --dry-run to see which sessions can be re-reduced and which are locked.",
        execute: async (context) => withLedger(context, executePipelineRereduce),
      },
    },
  },
  promote: {
    description: "Inspect cross-project promotion candidates and global-tier state.",
    subcommands: {
      review: {
        description: "List queued cross-project promotion candidates from ADR-0006.",
        execute: async (context) => executePromoteReview(context),
      },
      judge: {
        description:
          "LLM-judge high-confidence single-project instincts for global promotion (U10). Flags: --model, --limit, --min-verdict-confidence, --max-per, --max-usd, --dry-run.",
        execute: async (context) => executePromoteJudge(context),
      },
    },
  },
  mcp: {
    description:
      "Query distilled instincts through the capped ADR-0005 MCP surface. Subcommands: search_instincts, instincts_for_file, recent_instincts, serve, install (register asd in ~/.claude.json; --dry-run to preview).",
    execute: async (context) => executeMcp(context),
  },
  readback: {
    description:
      "Inspect the read-only SessionStart recall hook, MCP registration, and vault reachability.",
    subcommands: {
      check: {
        description:
          "Report installed, missing, drifted, or unverifiable read-back setup without changing configuration.",
        execute: async (context) => executeReadbackCheck(context),
      },
    },
  },
  recall: {
    description:
      "Print the current project's curated vault memory for a SessionStart hook to inject (ADR-0010 read-back). Fails open when no memory exists. Flags: --cwd, --vault-root, --max-bytes.",
    execute: async (context) => executeRecall(context),
  },
};

type FlatCommandEntry = {
  description: string;
  path: string[];
};

type ResolvedCommand = {
  args: string[];
  definition: CommandDefinition;
  path: string[];
};

function collectCommandEntries(
  definitions: Record<string, CommandDefinition>,
  prefix: string[] = [],
): FlatCommandEntry[] {
  const entries: FlatCommandEntry[] = [];

  for (const [name, definition] of Object.entries(definitions)) {
    const path = [...prefix, name];

    if (definition.subcommands) {
      entries.push(...collectCommandEntries(definition.subcommands, path));
      continue;
    }

    entries.push({
      description: definition.description,
      path,
    });
  }

  return entries;
}

function formatCommandLabel(path: string[]): string {
  return path.join(" ");
}

function padCommandLabel(path: string[], width: number): string {
  return formatCommandLabel(path).padEnd(width, " ");
}

function formatHelp(): string {
  const commandEntries = collectCommandEntries(commandTree);
  const widestLabel = commandEntries.reduce((width, entry) => {
    return Math.max(width, formatCommandLabel(entry.path).length);
  }, 0);

  return [
    "Usage: asd <command> [subcommand] [options]",
    "",
    `Runtime root: ${getRuntimeRoot()}`,
    "",
    "Commands:",
    ...commandEntries.map((entry) => {
      return `  ${padCommandLabel(entry.path, widestLabel)}    ${entry.description}`;
    }),
    "",
    "Options:",
    "  -h, --help           Show this help",
  ].join("\n");
}

function isHelpFlag(value: string | undefined): boolean {
  return value === "-h" || value === "--help";
}

function getSubcommandList(definition: CommandDefinition): string {
  return Object.entries(definition.subcommands ?? {})
    .map(([name, child]) => `${name}: ${child.description}`)
    .join(", ");
}

function resolveCommand(argv: string[]): ResolvedCommand | { error: string } {
  const commandName = argv[0];
  if (!commandName) {
    return { error: "Missing command. Pass --help for usage." };
  }
  const maybeSubcommand = argv[1];
  const rest = argv.slice(2);
  const command = commandTree[commandName];

  if (!command) {
    return { error: `Unknown command: ${commandName}` };
  }

  if (command.subcommands) {
    const subcommand = maybeSubcommand ? command.subcommands[maybeSubcommand] : undefined;

    if (!maybeSubcommand || !subcommand) {
      return {
        error: `Unknown or missing subcommand for ${commandName}. Available: ${getSubcommandList(command)}`,
      };
    }

    return {
      args: rest,
      definition: subcommand,
      path: [commandName, maybeSubcommand],
    };
  }

  return {
    args: maybeSubcommand ? [maybeSubcommand, ...rest] : rest,
    definition: command,
    path: [commandName],
  };
}

export async function main(
  argv: string[],
  output: Output = {
    error: console.error,
    info: console.log,
  },
): Promise<number> {
  if (argv.length === 0 || isHelpFlag(argv[0])) {
    output.info(formatHelp());
    return 0;
  }

  if (argv.some(isHelpFlag)) {
    output.info(formatHelp());
    return 0;
  }

  const resolved = resolveCommand(argv);

  if ("error" in resolved) {
    output.error(resolved.error);
    output.info(formatHelp());
    return 1;
  }

  if (!resolved.definition.execute) {
    output.error(`Command is not executable: ${formatCommandLabel(resolved.path)}`);
    return 1;
  }

  try {
    return await resolved.definition.execute({
      args: resolved.args,
      commandPath: resolved.path,
      output,
    });
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function isDirectEntryPoint(currentImportMetaUrl: string): boolean {
  const entryPath = process.argv[1];
  return typeof entryPath === "string" && fileURLToPath(currentImportMetaUrl) === entryPath;
}

if (isDirectEntryPoint(import.meta.url)) {
  const exitCode = await main(process.argv.slice(2));

  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}

async function withLedger(
  context: CommandContext,
  execute: (
    context: CommandContext,
    database: Awaited<ReturnType<typeof createLedger>>,
  ) => Promise<number>,
): Promise<number> {
  const database = await createLedger();

  try {
    return await execute(context, database);
  } finally {
    database.close();
  }
}
