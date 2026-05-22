#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { executeArchiveRun } from "./commands/archive-run.js";
import { executeDeleteApply } from "./commands/delete-apply.js";
import { executeDeleteCandidates } from "./commands/delete-candidates.js";
import { executeExplain } from "./commands/explain.js";
import { executeExportIndex } from "./commands/export-index.js";
import { executeIngestBackfill } from "./commands/ingest-backfill.js";
import { executeIngestSync } from "./commands/ingest-sync.js";
import { executeMemoryExportWiki } from "./commands/memory-export-wiki.js";
import { executeMemoryPushWiki } from "./commands/memory-push-wiki.js";
import { executeMigrateProjectIds } from "./commands/migrate-project-ids.js";
import { executeQualityAudit } from "./commands/quality-audit.js";
import { executeQualityApplyLearningReview } from "./commands/quality-apply-learning-review.js";
import { executeQualityReviewLearnings } from "./commands/quality-review-learnings.js";
import { executeReviewQueue } from "./commands/review-queue.js";
import { executeReviewShow } from "./commands/review-show.js";
import { executeStats } from "./commands/stats.js";
import { ensureRuntimePath, getRuntimeRoot } from "./config/paths.js";
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
					"Ingest historical Cursor transcripts with optional since/limit/resume controls.",
				execute: async (context) => withLedger(context, executeIngestBackfill),
			},
			sync: {
				description: "Ingest only new-or-changed Cursor transcripts.",
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
					"Score summaries, learnings, and deletion readiness across existing runtime artifacts.",
				execute: async (context) => withLedger(context, executeQualityAudit),
			},
			"review-learnings": {
				description:
					"Review project learnings with OpenRouter LLM memory lint and write a sidecar report.",
				execute: async (context) =>
					withLedger(context, executeQualityReviewLearnings),
			},
			"apply-learning-review": {
				description:
					"Apply an LLM learning-review sidecar into knowledge/projects-reviewed without mutating originals.",
				execute: async (context) =>
					withLedger(context, executeQualityApplyLearningReview),
			},
		},
	},
	archive: {
		description: "Move accepted sessions into archive storage.",
		subcommands: {
			run: {
				description:
					"Archive extracted sessions and generate deletion candidates.",
				execute: async (context) => withLedger(context, executeArchiveRun),
			},
		},
	},
	delete: {
		description: "Inspect and apply deletion decisions.",
		subcommands: {
			candidates: {
				description: "List deletion candidates and readiness state.",
				execute: async (context) =>
					withLedger(context, executeDeleteCandidates),
			},
			apply: {
				description:
					"Dry-run deletion apply by default; pass --apply to mark candidates deleted.",
				execute: async (context) => withLedger(context, executeDeleteApply),
			},
		},
	},
	memory: {
		description: "Export reviewed memory records for downstream systems.",
		subcommands: {
			"export-wiki": {
				description: "Write reviewed-memory JSONL for the LLM wiki importer.",
				execute: async (context) =>
					withLedger(context, executeMemoryExportWiki),
			},
			"push-wiki": {
				description:
					"Push reviewed-memory records into the personal vault as Obsidian-shaped pages.",
				execute: async (context) => withLedger(context, executeMemoryPushWiki),
			},
		},
	},
	search: {
		description: "Search indexed distillery data.",
		execute: async (context) => runStub(context, "index"),
	},
	"export-index": {
		description: "Write a consolidated session index JSONL for summarized sessions.",
		execute: async (context) => withLedger(context, executeExportIndex),
	},
	stats: {
		description: "Report high-level distillery runtime statistics.",
		execute: async (context) => withLedger(context, executeStats),
	},
	explain: {
		description: "Explain how a stored result was derived.",
		execute: async (context) => withLedger(context, executeExplain),
	},
	migrate: {
		description: "Migrate runtime artifacts between naming schemes.",
		subcommands: {
			"project-ids": {
				description:
					"Map legacy project keys to ADR-0002 project ids (dry-run by default; pass --apply to copy knowledge/projects).",
				execute: async (context) =>
					withLedger(context, executeMigrateProjectIds),
			},
		},
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

async function runStub(
	context: CommandContext,
	runtimePathName: Parameters<typeof ensureRuntimePath>[0],
): Promise<number> {
	const runtimePath = await ensureRuntimePath(runtimePathName);
	const commandName = context.commandPath.join(" ");
	const suffix = context.args.length > 0 ? ` ${context.args.join(" ")}` : "";

	context.output.info(`${commandName}${suffix}`);
	context.output.info(`Runtime path ready: ${runtimePath}`);
	context.output.info("Command scaffolded for Task 1.");

	return 0;
}

function resolveCommand(argv: string[]): ResolvedCommand | { error: string } {
	const commandName = argv[0]!;
	const maybeSubcommand = argv[1];
	const rest = argv.slice(2);
	const command = commandTree[commandName];

	if (!command) {
		return { error: `Unknown command: ${commandName}` };
	}

	if (command.subcommands) {
		const subcommand = maybeSubcommand
			? command.subcommands[maybeSubcommand]
			: undefined;

		if (!subcommand) {
			return {
				error: `Unknown or missing subcommand for ${commandName}. Available: ${getSubcommandList(command)}`,
			};
		}

		return {
			args: rest,
			definition: subcommand,
			path: [commandName, maybeSubcommand!],
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
		output.error(
			`Command is not executable: ${formatCommandLabel(resolved.path)}`,
		);
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
	return (
		typeof entryPath === "string" &&
		fileURLToPath(currentImportMetaUrl) === entryPath
	);
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
