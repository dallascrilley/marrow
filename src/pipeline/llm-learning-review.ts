import type { Learning } from "../models/canonical.js";
import { learningSchema } from "../models/canonical.js";

export const defaultOpenRouterLearningReviewModel = "openai/gpt-5-nano";
export const openRouterApiKeyEnvVar = "OPENROUTER_API_KEY";
export const openRouterModelEnvVar = "OPENROUTER_MODEL";

export type LearningReviewVerdict = "keep" | "reject" | "rewrite";
export type LearningReviewDurability =
	| "durable"
	| "transient"
	| "process"
	| "duplicate"
	| "unclear";

export type LearningReviewResult = {
	durability: LearningReviewDurability;
	keep: boolean;
	reason: string;
	statement: string;
	verdict: LearningReviewVerdict;
};

export type ReviewedLearning = {
	learning: Learning;
	review: LearningReviewResult;
};

type FetchLike = typeof fetch;

export async function reviewLearningWithOpenRouter(input: {
	apiKey?: string | undefined;
	fetchImpl?: FetchLike | undefined;
	learning: Learning;
	model?: string | undefined;
	projectKey: string;
}): Promise<LearningReviewResult> {
	const apiKey = input.apiKey ?? process.env[openRouterApiKeyEnvVar];
	if (apiKey === undefined || apiKey.trim().length === 0) {
		throw new Error(
			`${openRouterApiKeyEnvVar} is required for LLM learning review`,
		);
	}

	const model =
		input.model ??
		process.env[openRouterModelEnvVar] ??
		defaultOpenRouterLearningReviewModel;
	const fetchImpl = input.fetchImpl ?? fetch;
	const learning = learningSchema.parse(input.learning);
	const abortController = new AbortController();
	const timeout = setTimeout(() => abortController.abort(), 30_000);
	let response: Response;
	try {
		response = await fetchImpl(
			"https://openrouter.ai/api/v1/chat/completions",
			{
				body: JSON.stringify({
					messages: [
						{
							content: buildLearningReviewSystemPrompt(),
							role: "system",
						},
						{
							content: JSON.stringify(
								{
									evidence: learning.evidence,
									kind: learning.kind,
									project_key: input.projectKey,
									statement: learning.statement,
								},
								null,
								2,
							),
							role: "user",
						},
					],
					model,
					response_format: { type: "json_object" },
					temperature: 0,
				}),
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					"HTTP-Referer": "https://github.com/agent-session-distillery",
					"X-Title": "agent-session-distillery",
				},
				method: "POST",
				signal: abortController.signal,
			},
		);
	} finally {
		clearTimeout(timeout);
	}

	if (!response.ok) {
		const body = await response.text();
		throw new Error(
			`OpenRouter learning review failed (${response.status}): ${body}`,
		);
	}

	const payload = (await response.json()) as {
		choices?: Array<{ message?: { content?: string } }>;
	};
	const content = extractReviewContent(payload);

	return parseLearningReview(content);
}

export async function reviewProjectLearningsWithOpenRouter(input: {
	apiKey?: string | undefined;
	fetchImpl?: FetchLike | undefined;
	learnings: readonly Learning[];
	model?: string | undefined;
	projectKey: string;
}): Promise<ReviewedLearning[]> {
	const reviewed: ReviewedLearning[] = [];
	for (const learning of input.learnings) {
		reviewed.push({
			learning,
			review: await reviewLearningWithOpenRouter({
				apiKey: input.apiKey,
				fetchImpl: input.fetchImpl,
				learning,
				model: input.model,
				projectKey: input.projectKey,
			}),
		});
	}

	return reviewed;
}

function buildLearningReviewSystemPrompt(): string {
	return [
		"You are a strict memory-lint judge for project learnings extracted from agent transcripts.",
		"Return only JSON with keys: keep, verdict, durability, statement, reason.",
		"verdict must be one of: keep, reject, rewrite.",
		"durability must be one of: durable, transient, process, duplicate, unclear.",
		"Reject chat narration, progress reports, generic completion summaries, and statements that are not reusable project knowledge.",
		"If useful but raw, rewrite into one concise durable project-memory statement under 140 characters.",
		"Prefer imperative rule/action form: Use..., Keep..., Move..., Forward..., Add..., Configure..., Avoid...",
		"Do not include test counts, coverage percentages, email counts, or other validation stats unless they are the durable rule itself.",
		"Do not introduce facts, file paths, commands, or tools that are not present in the statement or evidence.",
		"Reject generic completion summaries whose only durable fact is that work was completed or verified.",
		"Use keep=false for reject; use keep=true for keep or rewrite.",
	].join("\n");
}

function extractReviewContent(payload: {
	choices?: Array<{ message?: { content?: string } }>;
}): string {
	const content = payload.choices?.[0]?.message?.content;
	if (content === undefined || content.trim().length === 0) {
		throw new Error("OpenRouter learning review returned no message content");
	}

	return content.trim();
}

function parseLearningReview(content: string): LearningReviewResult {
	const parsed = JSON.parse(content) as Partial<LearningReviewResult>;
	const verdict = parseEnum(
		parsed.verdict,
		["keep", "reject", "rewrite"] as const,
		"verdict",
	);
	const durability = parseEnum(
		parsed.durability,
		["durable", "transient", "process", "duplicate", "unclear"] as const,
		"durability",
	);

	if (typeof parsed.keep !== "boolean") {
		throw new Error("Learning review JSON must include boolean keep");
	}

	const statement = normalizeReviewStatement({
		keep: parsed.keep,
		statement: parsed.statement,
	});

	if (statement.length === 0) {
		throw new Error("Learning review JSON must include non-empty statement");
	}

	if (typeof parsed.reason !== "string" || parsed.reason.trim().length === 0) {
		throw new Error("Learning review JSON must include non-empty reason");
	}

	return {
		durability,
		keep: parsed.keep,
		reason: parsed.reason.trim(),
		statement,
		verdict,
	};
}

function normalizeReviewStatement(input: {
	keep: boolean;
	statement: unknown;
}): string {
	if (typeof input.statement === "string") {
		const trimmed = input.statement.trim();
		if (trimmed.length > 0) {
			return trimmed;
		}
	}

	return input.keep ? "__missing_statement__" : "Rejected learning";
}

function parseEnum<const Values extends readonly string[]>(
	value: unknown,
	values: Values,
	fieldName: string,
): Values[number] {
	if (typeof value === "string" && values.includes(value)) {
		return value as Values[number];
	}

	throw new Error(`Learning review JSON has invalid ${fieldName}`);
}
