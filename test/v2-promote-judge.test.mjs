import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadGlobalInstinctIds, saveGlobalInstinct } from "../dist/v2/instinct/global-store.js";
import { instinctSchema } from "../dist/v2/instinct/schema.js";
import { saveInstinct } from "../dist/v2/instinct/store.js";
import {
  JUDGE_PROMPT_VERSION,
  judgeContentHash,
  judgeGlobalApplicability,
  parseGlobalJudgeVerdict,
} from "../dist/v2/promotion/judge.js";
import {
  judgeCacheKey,
  loadJudgeCache,
  saveJudgeCache,
  setCachedVerdict,
} from "../dist/v2/promotion/judge-cache.js";
import { detectGlobalJudgeCandidates } from "../dist/v2/promotion/queue.js";

function instinct(overrides = {}) {
  return instinctSchema.parse({
    schema_version: 1,
    id: "always-run-lint-before-push-99999999",
    trigger: "When pushing a branch",
    finding: "Run the lint gate before pushing.",
    confidence: 0.74,
    domain: "workflow",
    maturity: "candidate",
    scope: "project",
    project_id: "proj0000000001",
    source: {
      first_session: "sess-1",
      first_observed_at: "2026-05-19T10:00:00Z",
      source_refs: [],
      observations: [{ session: "sess-1", reinforcing: true, at: "2026-05-19T10:00:00Z" }],
    },
    related: [],
    created_at: "2026-05-19T10:00:00Z",
    updated_at: "2026-05-19T10:00:00Z",
    last_promoted_at: null,
    ...overrides,
  });
}

function stubFetch(
  verdictJson,
  usage = { cost: 0.00001, prompt_tokens: 50, completion_tokens: 10 },
) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: verdictJson } }],
      usage,
    }),
  });
}

test("parseGlobalJudgeVerdict accepts clean, fenced, and prose-wrapped JSON", () => {
  const clean = parseGlobalJudgeVerdict('{"global": true, "confidence": 0.8, "reason": "general"}');
  assert.equal(clean.global, true);
  assert.equal(clean.confidence, 0.8);

  const fenced = parseGlobalJudgeVerdict(
    '```json\n{"global": false, "confidence": 0.9, "reason": "project-specific path"}\n```',
  );
  assert.equal(fenced.global, false);

  const prose = parseGlobalJudgeVerdict(
    'Here is my verdict: {"global": true, "confidence": 0.65, "reason": "broad"} — done.',
  );
  assert.equal(prose.global, true);
  assert.equal(prose.confidence, 0.65);
});

test("parseGlobalJudgeVerdict rejects malformed or out-of-range output", () => {
  assert.throws(() => parseGlobalJudgeVerdict("no json here"));
  assert.throws(() =>
    parseGlobalJudgeVerdict('{"global": "yes", "confidence": 0.5, "reason": "x"}'),
  );
  assert.throws(() => parseGlobalJudgeVerdict('{"global": true, "confidence": 2, "reason": "x"}'));
});

test("judgeGlobalApplicability calls the model and returns a parsed verdict + usage", async () => {
  const result = await judgeGlobalApplicability({
    instinct: { trigger: "t", finding: "Run lint before push.", domain: "workflow" },
    model: "deepseek/deepseek-v4-flash",
    apiKey: "test-key",
    fetchImpl: stubFetch('{"global": true, "confidence": 0.82, "reason": "general best practice"}'),
  });
  assert.equal(result.verdict.global, true);
  assert.equal(result.verdict.confidence, 0.82);
  assert.equal(result.usage.model, "deepseek/deepseek-v4-flash");
});

test("judgeGlobalApplicability surfaces a clean error on null message content", async () => {
  // deepseek-v4-flash occasionally returns choices[0].message.content === null;
  // extractMessageContent must reject it cleanly, not throw a TypeError on .trim().
  const nullContentFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: null } }], usage: { cost: 0 } }),
  });
  await assert.rejects(
    () =>
      judgeGlobalApplicability({
        instinct: { trigger: "t", finding: "f", domain: "workflow" },
        model: "deepseek/deepseek-v4-flash",
        apiKey: "test-key",
        fetchImpl: nullContentFetch,
      }),
    /returned no message content/,
  );
});

test("judgeContentHash is stable for same content and changes when content changes", () => {
  const a = { trigger: "t", finding: "Run lint before push.", domain: "workflow" };
  const b = { trigger: "t", finding: "Run lint before push.", domain: "workflow" };
  const c = { trigger: "t", finding: "Run tests before push.", domain: "workflow" };
  assert.equal(judgeContentHash(a), judgeContentHash(b));
  assert.notEqual(judgeContentHash(a), judgeContentHash(c));
});

test("judgeCacheKey separates by content, model, and prompt version", () => {
  const h = "abc";
  assert.notEqual(judgeCacheKey(h, "m1", "v1"), judgeCacheKey(h, "m2", "v1"));
  assert.notEqual(judgeCacheKey(h, "m1", "v1"), judgeCacheKey(h, "m1", "v2"));
  assert.equal(judgeCacheKey(h, "m1", "v1"), judgeCacheKey(h, "m1", "v1"));
});

test("judge cache round-trips verdicts and a re-load sees them", async () => {
  const previousRoot = process.env.AGENT_SESSION_DISTILLERY_ROOT;
  const sandbox = await mkdtemp(join(tmpdir(), "asd-jcache-"));
  process.env.AGENT_SESSION_DISTILLERY_ROOT = join(sandbox, "runtime");
  try {
    const cache = await loadJudgeCache();
    assert.equal(cache.size, 0, "fresh cache is empty");

    const key = judgeCacheKey(
      judgeContentHash({ trigger: "t", finding: "f", domain: "workflow" }),
      "deepseek/deepseek-v4-flash",
      JUDGE_PROMPT_VERSION,
    );
    setCachedVerdict(
      cache,
      key,
      { global: false, confidence: 0.9, reason: "project-specific" },
      "deepseek/deepseek-v4-flash",
      JUDGE_PROMPT_VERSION,
      "2026-06-30T00:00:00Z",
    );
    await saveJudgeCache(cache);

    const reloaded = await loadJudgeCache();
    assert.equal(reloaded.size, 1);
    const entry = reloaded.get(key);
    assert.equal(entry.verdict.global, false);
    assert.equal(entry.verdict.confidence, 0.9);
    assert.equal(entry.prompt_version, JUDGE_PROMPT_VERSION);
  } finally {
    if (previousRoot === undefined) delete process.env.AGENT_SESSION_DISTILLERY_ROOT;
    else process.env.AGENT_SESSION_DISTILLERY_ROOT = previousRoot;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("detectGlobalJudgeCandidates returns high-confidence instincts, deduped and filtered", async () => {
  const previousRoot = process.env.AGENT_SESSION_DISTILLERY_ROOT;
  const sandbox = await mkdtemp(join(tmpdir(), "asd-judge-"));
  process.env.AGENT_SESSION_DISTILLERY_ROOT = join(sandbox, "runtime");
  try {
    // High-confidence in two projects (same id) → deduped to one, project_count 2.
    await saveInstinct("projaaaaaaaa01", instinct({ confidence: 0.74 }));
    await saveInstinct(
      "projbbbbbbbb02",
      instinct({ confidence: 0.72, project_id: "projbbbbbbbb02" }),
    );
    // Below the 0.70 floor → excluded.
    await saveInstinct(
      "projcccccccc03",
      instinct({
        id: "low-signal-instinct-00000001",
        confidence: 0.68,
        project_id: "projcccccccc03",
      }),
    );
    // A distinct high-confidence instinct.
    await saveInstinct(
      "projdddddddd04",
      instinct({
        id: "prefer-small-prs-instinct-00000002",
        confidence: 0.71,
        project_id: "projdddddddd04",
      }),
    );

    const candidates = await detectGlobalJudgeCandidates();
    const ids = candidates.map((c) => c.instinct_id);
    assert.ok(ids.includes("always-run-lint-before-push-99999999"));
    assert.ok(ids.includes("prefer-small-prs-instinct-00000002"));
    assert.ok(!ids.includes("low-signal-instinct-00000001"), "sub-0.70 excluded");

    const lint = candidates.find((c) => c.instinct_id === "always-run-lint-before-push-99999999");
    assert.equal(lint.project_count, 2, "same id in two projects deduped with count 2");
    assert.equal(lint.confidence, 0.74, "keeps the highest-confidence occurrence");

    // Sorted strongest-first.
    assert.ok(candidates[0].confidence >= candidates[candidates.length - 1].confidence);

    // alreadyGlobalIds excludes a promoted id.
    const filtered = await detectGlobalJudgeCandidates(
      new Set(["always-run-lint-before-push-99999999"]),
    );
    assert.ok(!filtered.map((c) => c.instinct_id).includes("always-run-lint-before-push-99999999"));
  } finally {
    if (previousRoot === undefined) delete process.env.AGENT_SESSION_DISTILLERY_ROOT;
    else process.env.AGENT_SESSION_DISTILLERY_ROOT = previousRoot;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("saveGlobalInstinct round-trips and rejects non-global scope", async () => {
  const previousRoot = process.env.AGENT_SESSION_DISTILLERY_ROOT;
  const sandbox = await mkdtemp(join(tmpdir(), "asd-gstore-"));
  process.env.AGENT_SESSION_DISTILLERY_ROOT = join(sandbox, "runtime");
  try {
    await assert.rejects(() => saveGlobalInstinct(instinct({ scope: "project" })));

    const globalOne = instinct({
      scope: "global",
      project_id: "",
      last_promoted_at: "2026-06-29T00:00:00Z",
    });
    await saveGlobalInstinct(globalOne);
    const ids = await loadGlobalInstinctIds();
    assert.deepEqual(ids, ["always-run-lint-before-push-99999999"]);
  } finally {
    if (previousRoot === undefined) delete process.env.AGENT_SESSION_DISTILLERY_ROOT;
    else process.env.AGENT_SESSION_DISTILLERY_ROOT = previousRoot;
    await rm(sandbox, { recursive: true, force: true });
  }
});
