import type { DatabaseSync } from "node:sqlite";

import type { CommandContext } from "../cli.js";
import {
	getPhaseCheckpoint,
	insertRunHistory,
	transitionPhase,
} from "../db/ledger.js";
import type { SourceSessionRow } from "../db/queries.js";
import { extractLearnings } from "../pipeline/extract.js";
import { runArchivePhase } from "../pipeline/archive.js";
import {
	runDiscoverPhase,
	type DiscoveredSourceSession,
} from "../pipeline/discover.js";
import { runParsePhase } from "../pipeline/parse.js";
import { runReducePhase } from "../pipeline/reduce.js";
import { runSummarizePhase } from "../pipeline/summarize-phase.js";
import { writeKnowledgeArtifacts } from "../writers/knowledge-writer.js";

export async function executeIngestBackfill(
	context: CommandContext,
	database: DatabaseSync,
): Promise<number> {
	const options = parseIngestOptions(context.args);
	const discovery = await runDiscoverPhase({
		database,
		...(options.excludePaths.length > 0
			? { excludePaths: options.excludePaths }
			: {}),
		...(options.excludeProjectKeys.length > 0
			? { excludeProjectKeys: options.excludeProjectKeys }
			: {}),
		...(options.includeTestSessions ? { includeTestSessions: true } : {}),
		...(options.limit === undefined ? {} : { limit: options.limit }),
		...(options.since === undefined ? {} : { since: options.since }),
		source: options.source,
	});
	const batch = await processDiscoveredSessions(
		database,
		discovery.sessions,
		options.resume,
		options.llmTopic,
	);

	context.output.info(
		JSON.stringify(
			{
				discovered_count: discovery.discoveredCount,
				failed_count: batch.failed_count,
				failures: batch.failures,
				llm_topic: options.llmTopic,
				processed_count: batch.sessions.length,
				resumed: options.resume,
				sessions: batch.sessions,
				source: options.source,
			},
			null,
			2,
		),
	);

	return 0;
}

export type ProcessDiscoveredSessionsResult = {
	failed_count: number;
	failures: Array<{ error: string; session_id: string }>;
	sessions: Array<Record<string, unknown>>;
};

export async function processDiscoveredSessions(
	database: DatabaseSync,
	entries: readonly DiscoveredSourceSession[],
	resume: boolean,
	llmTopic = false,
): Promise<ProcessDiscoveredSessionsResult> {
	const sessions: Array<Record<string, unknown>> = [];
	const failures: ProcessDiscoveredSessionsResult["failures"] = [];

	for (const entry of entries) {
		const sourceSession = entry.ledger.sourceSession;

		try {
			const parsed = await runParsePhase({
				database,
				resume,
				sourceSession,
			});
			const reduced = await runReducePhase({
				database,
				parsedRecords: parsed.records,
				resume,
				sourceSession,
			});
			const summary = await runSummarizePhase(
				database,
				sourceSession,
				reduced.turns,
				reduced.events,
				resume,
				llmTopic,
			);
			const extracted = await runExtractPhase(
				database,
				sourceSession,
				reduced.turns,
				reduced.events,
				resume,
			);
			const archived = await runArchivePhase({
				database,
				events: reduced.events,
				knowledge: extracted,
				sourceSession,
				sourceSessionId: sourceSession.id,
				summary,
				turns: reduced.turns,
			});

			sessions.push({
				archived,
				parsed: parsed.recordCount,
				project_key: sourceSession.project_key,
				session_id: sourceSession.session_id,
				source_changed: entry.ledger.sourceChanged,
				summary_path: summary.summaryPath,
				turns: reduced.turns.length,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			failures.push({
				session_id: sourceSession.session_id,
				error: message,
			});
			console.warn(
				`[asd] ingest skipped ${sourceSession.session_id}: ${message}`,
			);

			const detailsJson = JSON.stringify({
				error: message,
				session_id: sourceSession.session_id,
			});
			const run = insertRunHistory(database, {
				detailsJson,
				finishedAt: new Date().toISOString(),
				phaseName: "archived",
				phaseState: "failed",
				sessionId: sourceSession.session_id,
				sourceHash: sourceSession.source_hash,
				sourceSessionId: sourceSession.id,
			});
			transitionPhase(database, {
				detailsJson,
				phaseName: "archived",
				phaseState: "failed",
				runId: run.id,
				sourceHash: sourceSession.source_hash,
				sourceSessionId: sourceSession.id,
			});
		}
	}

	return {
		failed_count: failures.length,
		failures,
		sessions,
	};
}

export function parseIngestOptions(args: string[]): {
	excludePaths: string[];
	excludeProjectKeys: string[];
	includeTestSessions: boolean;
	limit?: number;
	llmTopic: boolean;
	resume: boolean;
	since?: string;
	source: "cursor" | "claude-code" | "codex-cli" | "kimi" | "pi";
} {
	let limit: number | undefined;
	let resume = false;
	let since: string | undefined;
	let source: "cursor" | "claude-code" | "codex-cli" | "kimi" | "pi" = "cursor";
	let includeTestSessions = false;
	let llmTopic = false;
	const excludePaths: string[] = [];
	const excludeProjectKeys: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];

		if (arg === "--include-test-sessions") {
			includeTestSessions = true;
			continue;
		}

		if (arg === "--exclude-path") {
			excludePaths.push(requireOptionValue("--exclude-path", args[index + 1]));
			index += 1;
			continue;
		}

		if (arg === "--exclude-project") {
			excludeProjectKeys.push(
				requireOptionValue("--exclude-project", args[index + 1]),
			);
			index += 1;
			continue;
		}

		if (arg === "--resume") {
			resume = true;
			continue;
		}

		if (arg === "--llm-topic") {
			llmTopic = true;
			continue;
		}

		if (arg === "--source") {
			const value = args[index + 1];
			if (
				value !== "cursor" &&
				value !== "claude-code" &&
				value !== "codex-cli" &&
				value !== "kimi" &&
				value !== "pi"
			) {
				throw new Error(`Unsupported --source value: ${value ?? "<missing>"}`);
			}
			source = value;
			index += 1;
			continue;
		}

		if (arg === "--since") {
			since = requireOptionValue("--since", args[index + 1]);
			index += 1;
			continue;
		}

		if (arg === "--limit") {
			const parsedLimit = Number.parseInt(
				requireOptionValue("--limit", args[index + 1]),
				10,
			);
			if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
				throw new Error(
					`Invalid --limit value: ${args[index + 1] ?? "<missing>"}`,
				);
			}
			limit = parsedLimit;
			index += 1;
			continue;
		}

		throw new Error(`Unknown ingest option: ${arg}`);
	}

	return {
		excludePaths,
		excludeProjectKeys,
		includeTestSessions,
		...(limit === undefined ? {} : { limit }),
		llmTopic,
		resume,
		...(since === undefined ? {} : { since }),
		source,
	};
}

export async function runExtractPhase(
	database: DatabaseSync,
	sourceSession: SourceSessionRow,
	turns: readonly import("../models/canonical.js").Turn[],
	events: readonly import("../models/canonical.js").Event[],
	resume: boolean,
) {
	const checkpoint = getPhaseCheckpoint(
		database,
		sourceSession.id,
		"extracted",
	);
	const learnings = extractLearnings({
		events,
		sourceSession: toSourceSessionModel(sourceSession),
		turns,
	});
	const knowledge = await writeKnowledgeArtifacts({
		projectLearnings: learnings.project,
		sessionId: sourceSession.session_id,
		userLearnings: learnings.user,
	});

	if (
		resume &&
		checkpoint?.phase_state === "completed" &&
		checkpoint.source_hash === sourceSession.source_hash
	) {
		return knowledge;
	}

	const detailsJson = JSON.stringify({
		project_knowledge_path: knowledge.project.path,
		project_learning_count: knowledge.project.count,
		user_knowledge_path: knowledge.user.path,
		user_learning_count: knowledge.user.count,
	});
	const run = insertRunHistory(database, {
		detailsJson,
		finishedAt: new Date().toISOString(),
		phaseName: "extracted",
		phaseState: "completed",
		sessionId: sourceSession.session_id,
		sourceHash: sourceSession.source_hash,
		sourceSessionId: sourceSession.id,
	});
	transitionPhase(database, {
		detailsJson,
		phaseName: "extracted",
		phaseState: "completed",
		runId: run.id,
		sourceHash: sourceSession.source_hash,
		sourceSessionId: sourceSession.id,
	});

	return knowledge;
}

function requireOptionValue(flag: string, value: string | undefined): string {
	if (!value) {
		throw new Error(`Missing value for ${flag}`);
	}

	return value;
}

function toSourceSessionModel(sourceSession: SourceSessionRow) {
	return {
		conversation_id: sourceSession.conversation_id,
		ingest_status: sourceSession.ingest_status,
		project_key: sourceSession.project_key,
		retention_status: sourceSession.retention_status,
		session_id: sourceSession.session_id,
		source_format: sourceSession.source_format,
		source_hash: sourceSession.source_hash,
		source_path: sourceSession.source_path,
		source_tool: sourceSession.source_tool,
		started_at: sourceSession.started_at,
		updated_at: sourceSession.updated_at,
		workspace_path: sourceSession.workspace_path,
	};
}
