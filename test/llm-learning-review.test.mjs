import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sourceSessionFixture } from "../dist/models/canonical.js";
import {
  buildLearningReviewCacheKey,
  generateTopicWithOpenRouter,
  reviewLearningWithOpenRouter,
} from "../dist/pipeline/llm-learning-review.js";

function learning(overrides = {}) {
  return {
    confidence: "medium",
    evidence: ["Yes — keeping the rule + fixing generation is the right design."],
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
    statement: "Yes — keeping the rule + fixing generation is the right design.",
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
    statement: "Keep the rule and fix generation because callers need one error channel.",
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

test("OpenRouter topic generation reuses chat completion client with strict JSON request", async () => {
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
                content: JSON.stringify({ topic: "gated LLM topic support" }),
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

  const topic = await generateTopicWithOpenRouter({
    apiKey: "test-key",
    deterministicTopic: "Read .agents-state/handoff.md in this worktree",
    fetchImpl,
    sourceSession: sourceSessionFixture,
    turns: [],
  });

  assert.equal(topic, "gated LLM topic support");
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "openai/gpt-5.4-nano");
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.match(body.messages[0].content, /concise display topics/);
  assert.match(body.messages[1].content, /deterministic_topic/);
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

test("OpenRouter learning review uses exact-input cache before fetching", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "asd-llm-review-cache-"));
  const cachedReview = {
    durability: "durable",
    keep: true,
    reason: "Cached durable project rule.",
    statement: "Use cached review output for identical learning inputs.",
    verdict: "keep",
  };
  const item = learning();
  const cacheKey = buildLearningReviewCacheKey({
    learning: item,
    model: "openai/gpt-5-nano",
    projectKey: "studio-tools",
  });

  try {
    await writeFile(
      join(cacheDir, `${cacheKey}.json`),
      `${JSON.stringify(cachedReview)}\n`,
      "utf8",
    );
    const fetchImpl = async () => {
      throw new Error("fetch should not be called on cache hit");
    };

    const review = await reviewLearningWithOpenRouter({
      apiKey: "test-key",
      cacheDir,
      fetchImpl,
      learning: item,
      model: "openai/gpt-5-nano",
      projectKey: "studio-tools",
    });

    assert.deepEqual(review, cachedReview);
  } finally {
    await rm(cacheDir, { force: true, recursive: true });
  }
});

test("OpenRouter learning review refresh bypasses cache and overwrites it", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "asd-llm-review-refresh-"));
  const item = learning();
  const cacheKey = buildLearningReviewCacheKey({
    learning: item,
    model: "openai/gpt-5-nano",
    projectKey: "studio-tools",
  });
  const cachePath = join(cacheDir, `${cacheKey}.json`);
  await writeFile(
    cachePath,
    `${JSON.stringify({
      durability: "durable",
      keep: true,
      reason: "Old cached result.",
      statement: "Use old cached result.",
      verdict: "keep",
    })}\n`,
    "utf8",
  );
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
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
                  reason: "Fresh model result.",
                  statement: "Use fresh model review when refresh is requested.",
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

  try {
    const review = await reviewLearningWithOpenRouter({
      apiKey: "test-key",
      cacheDir,
      fetchImpl,
      learning: item,
      model: "openai/gpt-5-nano",
      projectKey: "studio-tools",
      refreshLlm: true,
    });

    assert.equal(calls, 1);
    assert.equal(review.statement, "Use fresh model review when refresh is requested.");
    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    assert.equal(cached.statement, "Use fresh model review when refresh is requested.");
  } finally {
    await rm(cacheDir, { force: true, recursive: true });
  }
});
