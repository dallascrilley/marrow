import test from "node:test";
import assert from "node:assert/strict";

import { sourceSessionFixture } from "../dist/models/canonical.js";
import { reviewLearningWithOpenRouter } from "../dist/pipeline/llm-learning-review.js";

function learning(overrides = {}) {
	return {
		confidence: "medium",
		evidence: [
			"Yes — keeping the rule + fixing generation is the right design.",
		],
		kind: "decision",
		learning_id: "session:project:decision:1",
		promotion_basis: "fixture",
		scope: "project",
		scope_key: "studio-tools",
		source_refs: [
			{
				event_id: null,
				line: null,
				session_id: sourceSessionFixture.session_id,
				source_hash: sourceSessionFixture.source_hash,
				source_path: sourceSessionFixture.source_path,
				turn_id: null,
			},
		],
		statement:
			"Yes — keeping the rule + fixing generation is the right design.",
		title: "Decision",
		...overrides,
	};
}

test("OpenRouter learning review sends strict JSON memory-lint request", async () => {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url, init });
		return {
			ok: true,
			status: 200,
			async json() {
				return {
					choices: [
						{
							message: {
								content: JSON.stringify({
									durability: "durable",
									keep: true,
									reason: "Useful project decision after rewrite.",
									statement:
										"Keep the rule and fix generation because callers need one error channel.",
									verdict: "rewrite",
								}),
							},
						},
					],
				};
			},
			async text() {
				return "";
			},
		};
	};

	const review = await reviewLearningWithOpenRouter({
		apiKey: "test-key",
		fetchImpl,
		learning: learning(),
		model: "openai/gpt-5-nano",
		projectKey: "studio-tools",
	});

	assert.deepEqual(review, {
		durability: "durable",
		keep: true,
		reason: "Useful project decision after rewrite.",
		statement:
			"Keep the rule and fix generation because callers need one error channel.",
		verdict: "rewrite",
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
	assert.equal(calls[0].init.method, "POST");
	assert.equal(calls[0].init.headers.Authorization, "Bearer test-key");

	const body = JSON.parse(calls[0].init.body);
	assert.equal(body.model, "openai/gpt-5-nano");
	assert.deepEqual(body.response_format, { type: "json_object" });
	assert.match(body.messages[0].content, /strict memory-lint judge/);
	assert.match(body.messages[1].content, /keeping the rule/);
});

test("OpenRouter learning review rejects invalid JSON schema", async () => {
	const fetchImpl = async () => ({
		ok: true,
		status: 200,
		async json() {
			return {
				choices: [
					{
						message: {
							content: JSON.stringify({ keep: true, verdict: "maybe" }),
						},
					},
				],
			};
		},
		async text() {
			return "";
		},
	});

	await assert.rejects(
		reviewLearningWithOpenRouter({
			apiKey: "test-key",
			fetchImpl,
			learning: learning(),
			projectKey: "studio-tools",
		}),
		/invalid verdict/,
	);
});
