import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";

import type { CommandContext } from "../cli.js";
import { getRuntimePath, getRuntimeRoot } from "../config/paths.js";
import { listSourceSessions } from "../db/ledger.js";
import { learningSchema, type Learning } from "../models/canonical.js";

export async function executeQualityApplyLearningReview(
	context: CommandContext,
	_database: DatabaseSync,
): Promise<number> {
	const options = parseOptions(context.args);
	const inputPath =
		options.input ??
		join(getRuntimePath("reports"), "llm-learning-review.jsonl");
	const reviews = await readReviewSidecar(inputPath);
	const sessionsById = new Map(
		listSourceSessions(_database).map((session) => [
			session.session_id,
			session,
		]),
	);
	const originalLearnings = await readOriginalProjectLearnings(
		reviews,
		sessionsById,
	);
	const reviewedLearningsBySession = new Map<string, Learning[]>();
	const rejected = [];
	const skipped = [];

	for (const review of reviews) {
		const original = originalLearnings.get(review.learning_id);
		if (original === undefined) {
			skipped.push({
				learning_id: review.learning_id,
				reason: "missing_original_learning",
			});
			continue;
		}

		const validationFlags = validateSuggestedStatement(
			review.suggested_statement,
		);
		if (
			!review.keep ||
			review.durability !== "durable" ||
			validationFlags.length > 0
		) {
			rejected.push({
				learning_id: review.learning_id,
				reason: review.reason,
				validation_flags: validationFlags,
				verdict: review.verdict,
				durability: review.durability,
			});
			continue;
		}

		const rewritten = learningSchema.parse({
			...original,
			statement: review.suggested_statement,
			title: original.title,
			promotion_basis: `${original.promotion_basis} LLM-reviewed with ${review.verdict} verdict.`,
		});
		const sessionLearnings =
			reviewedLearningsBySession.get(review.session_id) ?? [];
		sessionLearnings.push(rewritten);
		reviewedLearningsBySession.set(review.session_id, sessionLearnings);
	}

	for (const [sessionId, learnings] of reviewedLearningsBySession) {
		const session = sessionsById.get(sessionId);
		if (session === undefined || learnings.length === 0) {
			continue;
		}

		const outputPath = getReviewedProjectKnowledgePath(
			session.project_key,
			sessionId,
		);
		await writeJsonlFile(outputPath, learnings);
	}

	const reportPath = join(
		getRuntimePath("reports"),
		"llm-learning-review-apply.json",
	);
	await mkdir(dirname(reportPath), { recursive: true });
	await writeFile(
		reportPath,
		`${JSON.stringify(
			{
				input: inputPath,
				kept: [...reviewedLearningsBySession.values()].reduce(
					(sum, learnings) => sum + learnings.length,
					0,
				),
				rejected: rejected.length,
				skipped: skipped.length,
				output_root: join(getRuntimeRoot(), "knowledge/projects-reviewed"),
				rejected_details: rejected,
				skipped_details: skipped,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);

	context.output.info(
		JSON.stringify(
			{
				input: inputPath,
				kept: [...reviewedLearningsBySession.values()].reduce(
					(sum, learnings) => sum + learnings.length,
					0,
				),
				rejected: rejected.length,
				skipped: skipped.length,
				output_root: join(getRuntimeRoot(), "knowledge/projects-reviewed"),
				report: reportPath,
			},
			null,
			2,
		),
	);

	return 0;
}

type ApplyReviewOptions = {
	input?: string | undefined;
};

type ReviewSidecarEntry = {
	durability: string;
	keep: boolean;
	learning_id: string;
	reason: string;
	scope_key: string;
	session_id: string;
	statement: string;
	suggested_statement: string;
	verdict: string;
};

function parseOptions(args: readonly string[]): ApplyReviewOptions {
	return {
		input: parseStringOption(args, "--input"),
	};
}

function parseStringOption(
	args: readonly string[],
	flag: string,
): string | undefined {
	const flagIndex = args.findIndex((arg) => arg === flag);
	if (flagIndex === -1) {
		return undefined;
	}

	const value = args[flagIndex + 1];
	if (value === undefined || value.trim().length === 0) {
		throw new Error(`${flag} requires a value`);
	}

	return value;
}

async function readReviewSidecar(path: string): Promise<ReviewSidecarEntry[]> {
	const contents = await readFile(path, "utf8");
	return contents
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as ReviewSidecarEntry);
}

async function readOriginalProjectLearnings(
	reviews: readonly ReviewSidecarEntry[],
	sessionsById: ReadonlyMap<
		string,
		{ project_key: string; session_id: string }
	>,
): Promise<Map<string, Learning>> {
	const originalLearnings = new Map<string, Learning>();
	const sessionIds = [...new Set(reviews.map((review) => review.session_id))];
	for (const sessionId of sessionIds) {
		const session = sessionsById.get(sessionId);
		if (session === undefined) {
			continue;
		}

		for (const learning of await readProjectLearningFile(
			session.project_key,
			session.session_id,
		)) {
			originalLearnings.set(learning.learning_id, learning);
		}
	}

	return originalLearnings;
}

async function readProjectLearningFile(
	projectKey: string,
	sessionId: string,
): Promise<Learning[]> {
	try {
		const contents = await readFile(
			join(
				getRuntimePath("knowledgeProjects"),
				projectKey,
				`${sessionId}.jsonl`,
			),
			"utf8",
		);
		return contents
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => learningSchema.parse(JSON.parse(line)));
	} catch (error) {
		if (isMissingFileError(error)) {
			return [];
		}

		throw error;
	}
}

function getReviewedProjectKnowledgePath(
	projectKey: string,
	sessionId: string,
): string {
	return join(
		getRuntimeRoot(),
		"knowledge/projects-reviewed",
		projectKey,
		`${sessionId}.jsonl`,
	);
}

async function writeJsonlFile(
	path: string,
	entries: readonly Learning[],
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		"utf8",
	);
}

function validateSuggestedStatement(statement: string): string[] {
	const flags: string[] = [];
	const trimmed = statement.trim();
	const normalized = trimmed.toLowerCase();

	if (
		trimmed.length === 0 ||
		trimmed === "Rejected learning" ||
		trimmed === "__missing_statement__"
	) {
		flags.push("missing_statement");
	}

	if (trimmed.length > 180) {
		flags.push("too_long");
	}

	if (
		/^(?:completed|fixed done|yes[—-]|you(?:'|’)re right|now fix|here is|here(?:'|’)s|summary)/i.test(
			trimmed,
		)
	) {
		flags.push("raw_prefix");
	}

	if (
		/\b(?:continue investigating|investigating remaining|line \d+|l\d+ fixed|tests? pass|coverage|verified with `?\.\/scripts\/qa`?)\b/i.test(
			normalized,
		)
	) {
		flags.push("transient_or_validation_detail");
	}

	if (/\*\*|^#+\s|\|\s*-{2,}\s*\|/m.test(trimmed)) {
		flags.push("markdown_residue");
	}

	return flags;
}

function isMissingFileError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}
