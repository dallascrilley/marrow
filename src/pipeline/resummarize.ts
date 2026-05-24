import { access, readFile } from "node:fs/promises";

import type { DatabaseSync } from "node:sqlite";

import type { SourceSessionRow } from "../db/queries.js";
import { getSessionManifestPath } from "../writers/manifest-writer.js";
import { getSessionSummaryJsonPath } from "../writers/summary-writer.js";
import { summarySchema } from "../models/canonical.js";
import { type LlmTopicGenerator, isLowSignalTopic } from "./summarize.js";
import { runParsePhase } from "./parse.js";
import {
	getReducedArtifactPath,
	runReducePhase,
	type ReducedArtifact,
} from "./reduce.js";
import { runSummarizePhase } from "./summarize-phase.js";
import { listSourceSessions } from "../db/ledger.js";

export type ResummarizeSkipReason = "high_signal_topic" | "missing_manifest";

export type ResummarizeSkip = {
	reason: ResummarizeSkipReason;
	session_id: string;
};

export type ResummarizeOptions = {
	dryRun?: boolean;
	exportIndex?: boolean;
	generateTopic?: LlmTopicGenerator;
	limit?: number;
	llmTopic?: boolean;
	lowSignalOnly?: boolean;
	projectKeys?: readonly string[];
	sessionIds?: readonly string[];
};

export type ResummarizeFailure = {
	error: string;
	session_id: string;
};

export type ResummarizeResult = {
	candidate_count: number;
	dry_run: boolean;
	export_path: string | null;
	failed_count: number;
	failures: ResummarizeFailure[];
	processed_count: number;
	sessions: Array<{
		session_id: string;
		summary_path: string;
		topic: string;
		topic_source: string;
	}>;
	skipped: ResummarizeSkip[];
	skipped_count: number;
	would_process_count: number;
};

export async function resummarizeSessions(
	database: DatabaseSync,
	options: ResummarizeOptions = {},
): Promise<ResummarizeResult> {
	const candidates = await selectResummarizeCandidates(database, options);
	const failures: ResummarizeFailure[] = [];
	const skipped: ResummarizeSkip[] = [];
	const sessions: ResummarizeResult["sessions"] = [];
	let wouldProcessCount = 0;

	for (const sourceSession of candidates) {
		if (options.lowSignalOnly === true) {
			const existingTopic = await readExistingTopic(sourceSession.session_id);
			if (existingTopic === null || !isLowSignalTopic(existingTopic)) {
				skipped.push({
					reason: "high_signal_topic",
					session_id: sourceSession.session_id,
				});
				continue;
			}
		}

		if (!(await manifestExists(sourceSession.session_id))) {
			skipped.push({
				reason: "missing_manifest",
				session_id: sourceSession.session_id,
			});
			continue;
		}

		wouldProcessCount += 1;

		if (options.dryRun === true) {
			continue;
		}

		try {
			const reduced = await loadOrBuildReduced(database, sourceSession);
			const summaryResult = await runSummarizePhase(
				database,
				sourceSession,
				reduced.turns,
				reduced.events,
				false,
				options.llmTopic === true,
				true,
				options.generateTopic,
			);
			sessions.push({
				session_id: sourceSession.session_id,
				summary_path: summaryResult.summaryPath,
				topic: summaryResult.summary.topic,
				topic_source: summaryResult.summary.topic_source,
			});
		} catch (error) {
			failures.push({
				session_id: sourceSession.session_id,
				error: error instanceof Error ? error.message : String(error),
			});
			console.warn(
				`[asd] resummarize skipped ${sourceSession.session_id}: ${failures[failures.length - 1]!.error}`,
			);
		}
	}

	return {
		candidate_count: candidates.length,
		dry_run: options.dryRun === true,
		export_path: null,
		failed_count: failures.length,
		failures,
		processed_count: sessions.length,
		sessions,
		skipped,
		skipped_count: skipped.length,
		would_process_count: wouldProcessCount,
	};
}

async function selectResummarizeCandidates(
	database: DatabaseSync,
	options: ResummarizeOptions,
): Promise<SourceSessionRow[]> {
	let candidates = listSourceSessions(database).filter((session) =>
		["archived", "deletion_candidate", "extracted", "summarized"].includes(
			session.current_lifecycle_state,
		),
	);

	if (options.sessionIds !== undefined && options.sessionIds.length > 0) {
		const wanted = new Set(options.sessionIds);
		candidates = candidates.filter((session) => wanted.has(session.session_id));
	}

	if (options.projectKeys !== undefined && options.projectKeys.length > 0) {
		const wanted = new Set(options.projectKeys);
		candidates = candidates.filter((session) =>
			wanted.has(session.project_key),
		);
	}

	if (options.limit !== undefined) {
		candidates = candidates.slice(0, options.limit);
	}

	return candidates;
}

async function loadOrBuildReduced(
	database: DatabaseSync,
	sourceSession: SourceSessionRow,
): Promise<ReducedArtifact> {
	const artifactPath = getReducedArtifactPath(sourceSession.session_id);
	if (await fileExists(artifactPath)) {
		return JSON.parse(await readFile(artifactPath, "utf8")) as ReducedArtifact;
	}

	const parsed = await runParsePhase({
		database,
		resume: true,
		sourceSession,
	});
	const reduced = await runReducePhase({
		database,
		parsedRecords: parsed.records,
		resume: true,
		sourceSession,
	});

	return {
		events: reduced.events,
		turns: reduced.turns,
	};
}

async function readExistingTopic(sessionId: string): Promise<string | null> {
	const summaryPath = getSessionSummaryJsonPath(sessionId);

	if (!(await fileExists(summaryPath))) {
		return null;
	}

	const summary = summarySchema.parse(
		JSON.parse(await readFile(summaryPath, "utf8")),
	);
	return summary.topic;
}

async function manifestExists(sessionId: string): Promise<boolean> {
	return fileExists(getSessionManifestPath(sessionId));
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (error) {
		return isMissingFileError(error) ? false : Promise.reject(error);
	}
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "ENOENT"
	);
}
