---
date: 2026-06-14
origin: (direct brief — no docs/brainstorms doc)
---

# LLM cost telemetry, per-session cost metrics, and waste reduction

**Summary:** asd makes OpenRouter calls but captures **zero** cost/token data and throttles
by a coarse *count* of command runs, not actual spend. This plan adds source-boundary
cost telemetry (OTel GenAI conventions), a cost-report command that answers "cost per
session", a calibration baseline using the new $5 test key, a true cost-based budget
ceiling, and the highest-leverage waste cuts (skip-junk-before-LLM, batching).

## Context discovered (evidence)

- **Single choke point:** all OpenRouter spend flows through `completeOpenRouterJson`
  (`src/pipeline/llm-learning-review.ts:306`), used by both `reviewLearningWithOpenRouter`
  (`:44`) and `generateTopicWithOpenRouter` (`:108`). Instrument once → cover everything.
- **No cost capture today:** the request body (`:324`) does not set `usage:{include:true}`,
  and the response parse (`:348`) reads only `choices[0].message.content` — `usage`/`cost`
  are discarded.
- **One API call per learning:** `reviewProjectLearningsWithOpenRouter` (`:137`) loops each
  learning into its own `completeOpenRouterJson` call. The 3,154-learning backlog = 3,154
  requests, each re-sending the full system prompt. No batching.
- **Budget is count-based, decoupled from cost:** `recordLlmBudgetUse` is called **once per
  command run** (`quality-review-learnings.ts:147`), so `5/24h` means 5 *runs*, not 5
  learnings or $5. A single run can issue thousands of calls and spend arbitrarily while
  counting as "1 use" (`src/pipeline/llm-budget.ts`). The $5 key has no enforced ceiling.
- **Per-learning cache exists** (`learning-review-cache-v1`, keyed by content+model) — cache
  hits avoid re-calling, so re-runs of already-reviewed learnings are free.
- **Default model:** `openai/gpt-5-nano` (`OPENROUTER_MODEL` env override).
- **No existing cost/metrics surface** (`stats.ts` = lifecycle counts only) and **no
  `docs/solutions/` learning** touches LLM cost.
- **Key:** `OpenRouter API Credentials - agent-session-distillery` in 1Password, $5 cap, for
  calibration/testing.

## Requirements

- R1. Capture actual per-call OpenRouter cost + token usage at the source boundary (no
  estimation from stale pricing tables — fail closed on unknowns, per agent-telemetry).
- R2. Persist telemetry as a raw JSONL receipt using OTel GenAI field names, kept separate
  from any derived summary.
- R3. Report estimated **cost per session** plus supporting metrics (cost/learning, tokens,
  cache-hit rate, cost by operation) from captured receipts.
- R4. Establish a real baseline with a bounded calibration run against the $5 test key.
- R5. Enforce a hard **USD** spend ceiling per window (protect the $5 key), in addition to
  the existing count throttle.
- R6. Cut waste: stop paying to LLM-review low-signal / test-session / duplicate learnings,
  and reduce per-call overhead (batching).

## Key technical decisions

- **Capture cost from the API, not a pricing table.** Set `usage: { include: true }` on the
  OpenRouter request; read `usage.cost` (USD) and `usage.prompt_tokens` /
  `completion_tokens` / `total_tokens` from the response. agent-telemetry rule: "never
  estimate cost unless the source is explicit" → when `usage` is absent, record `cost:
  "unknown"` + `missing_reason`, never a guess.
- **Instrument the single choke point** (`completeOpenRouterJson`) so review + topic-gen are
  both covered without touching callers' logic. Return a `{content, usage}` shape instead of
  bare `content`; thread `session_id`/`learning_id`/`operation`/`cache_hit` from callers for
  receipt context.
- **OTel GenAI vocabulary** for portability: `gen_ai.request.model`, `gen_ai.provider.name`,
  `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.total_tokens`,
  `gen_ai.usage.cost`, `gen_ai.client.operation.duration`. asd-local context fields
  (`session_id`, `learning_id`, `operation`, `cache_hit`) as a sibling block.
- **Receipt path:** `reports/llm-telemetry.jsonl` (append-only raw receipts); derived rollup
  computed on demand by the report command (not a second persisted file that can drift).
- **Cost budget is additive, not a replacement.** Keep the count window; add a USD window
  checked against summed receipt cost in the trailing window. Either limit can block. Hard
  ceiling via `ASD_LLM_MAX_USD` (e.g. `1/24h`), defaulting conservative for the $5 key.
- **Pre-LLM filter reuses existing signal detection** (the `summary_low_signal` /
  low-signal + test-session heuristics already in the audit path) so we don't add a second
  notion of "junk".

## Implementation units

### U1. Capture OpenRouter usage + cost at the call boundary
- **Goal:** every OpenRouter call returns real token + USD cost (or an explicit `unknown`).
- **Requirements:** R1
- **Files:** `src/pipeline/llm-learning-review.ts`
- **Approach:** add `usage: { include: true }` to the request body (`:324`). Define a
  `LlmCallUsage` type (`input_tokens`, `output_tokens`, `total_tokens`, `cost`,
  `cost_is_known`, `missing_reason?`, `duration_ms`). Change `completeOpenRouterJson` to
  return `{ content, usage }`, parsing `payload.usage` (OpenRouter returns `cost`,
  `prompt_tokens`, `completion_tokens`, `total_tokens`); when absent, populate `unknown` +
  `missing_reason`. Measure `duration_ms` around the fetch. Propagate the new return shape
  through `reviewLearningWithOpenRouter` and `generateTopicWithOpenRouter` (attach usage to
  their results) without changing verdict logic.
- **Tests:** `test/llm-learning-review.test.mjs` (extend) with a stubbed `fetchImpl`
  returning a `usage` block → assert cost/tokens parsed; a response with **no** `usage` →
  assert `cost_is_known:false` + `missing_reason` (fail-closed); duration is recorded.
- **Verification:** `npm test` green; new assertions cover present + absent usage.
- **Deviation (implemented):** `completeOpenRouterJson` returns `{content, usage}` as planned,
  but usage is propagated up via an optional `onUsage?(usage)` callback plus a `usage` field on
  `ReviewedLearning` — not by changing the public return types of `reviewLearningWithOpenRouter`
  (still `LearningReviewResult`) or `generateTopicWithOpenRouter` (still `string`). This keeps
  the `summarize.ts` injectable `generateTopic` contract and the review cache schema unchanged
  and non-breaking. `LlmCallUsage` also carries `model` + `cache_hit` for U2 correlation.

### U2. Persist OTel-GenAI telemetry receipts
- **Goal:** each real (non-cache-hit) call appends one OTel-shaped JSONL receipt.
- **Requirements:** R1, R2
- **Files:** new `src/pipeline/llm-telemetry.ts`; writer call sites in
  `src/commands/quality-review-learnings.ts` and `src/commands/quality-resummarize.ts`;
  `src/config/paths.ts` (telemetry path under `reports`).
- **Approach:** `appendLlmTelemetry(record)` writing `reports/llm-telemetry.jsonl`
  (append-only, never overwrite). Record = OTel GenAI fields (U1 usage) + asd context
  (`session_id`, `learning_id`, `operation: "learning_review" | "topic_generation"`,
  `cache_hit`, `model`, `created_at`). Cache hits write a receipt with `cache_hit:true` and
  `cost:0` so hit-rate is measurable. Fail-closed: a telemetry write error must **not** break
  the pipeline (catch + warn).
- **Tests:** new `test/llm-telemetry.test.mjs` — append N records → read back, assert shape
  + append semantics (no clobber); a non-writable dir is swallowed (pipeline unaffected).
- **Verification:** `npm test` green; receipt file accumulates across two runs.

### U3. `quality cost-report` command (cost per session + metrics)
- **Goal:** one command answers "estimated cost per session" and the supporting metrics.
- **Requirements:** R3
- **Files:** new `src/commands/quality-cost-report.ts`; register in `src/cli.ts`;
  `README.md` (command docs).
- **Approach:** read `reports/llm-telemetry.jsonl`, aggregate: total cost, cost by operation,
  **cost per session** (group by `session_id`: mean / p50 / p90 / max), cost per learning,
  mean tokens per call, cache-hit rate, count of `unknown`-cost calls. `--json` for a citable
  receipt; `--since <iso>` window filter. Project per-session averages onto the
  `discovered`-backlog count to estimate full-drain cost. Mark estimates derived from
  `unknown` costs explicitly.
- **Tests:** new `test/quality-cost-report.test.mjs` — seed a fixture telemetry JSONL →
  assert per-session aggregation, cache-hit rate, and `unknown`-cost handling.
- **Verification:** `node dist/cli.js quality cost-report --json` on the fixture; `npm test`.

### U4. Calibration baseline run ($5 key)
- **Goal:** real cost-per-session / cost-per-learning numbers, documented.
- **Requirements:** R4
- **Files:** new `docs/ops/llm-cost-baseline.md` (operator note).
- **Approach:** load the $5 key from 1Password via `op` (no echo). Run a bounded
  `quality review-learnings --max-learnings <small> --limit <small>` against real sessions,
  then `quality cost-report --json`. Record: model, cost/call, cost/learning, mean
  cost/session, tokens/call, and the projected cost to drain the full backlog
  (cost/learning × pending learnings). Note remaining key balance. This is the proof gate for
  the whole plan — exercises U1–U3 live.
- **Tests:** n/a (operational run; evidence is the report JSON + doc).
- **Verification:** `cost-report` JSON shows non-zero real costs; baseline doc committed.

### U5. Hard USD spend ceiling
- **Goal:** a per-window USD cap that blocks before overspending the key.
- **Requirements:** R5
- **Files:** `src/pipeline/llm-budget.ts`; gate read in
  `src/commands/quality-review-learnings.ts` + `src/pipeline/pipeline-gate.ts`.
- **Approach:** add `assessUsdBudget(maxUsdSpec)` summing `cost` from telemetry receipts in
  the trailing window vs `ASD_LLM_MAX_USD` (reuse the `N/Tu` window grammar, value in USD).
  `allowed` only if **both** count and USD budgets allow. Surface `usd_budget` in the gate
  JSON and in `review-learnings` output. Conservative default for the $5 key (e.g. `1/24h`).
- **Tests:** extend `test/llm-budget.test.mjs` — receipts under cap → allowed; over cap →
  blocked with `skip_reason:"llm_usd_budget_exhausted"`; window expiry releases budget.
- **Verification:** `npm test`; gate JSON shows `usd_budget`.

### U6. Cut LLM waste — skip junk before paying, then batch
- **Goal:** stop spending on low-signal/test/duplicate learnings; reduce per-call overhead.
- **Requirements:** R6
- **Files:** `src/commands/quality-review-learnings.ts`,
  `src/pipeline/llm-learning-review.ts`.
- **Approach (two slices):**
  - **U6a — pre-LLM filter:** before sending, drop learnings the deterministic heuristics
    already flag as low-signal/test-session (reuse the audit's `summary_low_signal` /
    junk-topic detection — e.g. the `pi-test-*` and "Say hello" sessions), and dedupe
    identical statements within the batch. Report `skipped_pre_llm` count. Pure savings: these
    would be rejected anyway.
  - **U6b — batch reviews:** review M learnings per request (model returns a JSON array keyed
    by learning id) instead of one call each, so the system prompt is amortized. Keep the
    per-learning cache by checking cache first, batching only the misses. Bounded M
    (e.g. 10) to stay within context and keep retries cheap.
- **Tests:** `test/extract-project-learnings.test.mjs`/review tests — assert filtered
  learnings never reach `fetchImpl`; batched call returns correctly demultiplexed verdicts;
  cache hits bypass the batch. Compare call-count before/after on a fixture.
- **Verification:** `npm test`; `cost-report` on a re-run shows lower cost/learning + lower
  call count vs the U4 baseline.

## Prior learnings applied
- (none in `docs/solutions/` touch LLM cost — this plan should emit one via `ce-compound`
  after U4/U6 with the measured baseline and the batching/skip savings.)

## Deferred / out of scope
- Fixing the epoch-zero `created_at` on exported learnings (separate data-quality issue from
  the prior session's findings).
- Restoring/replacing the over-limit *production* OpenRouter key (operator billing action;
  this plan uses the new $5 test key only).
- OTLP export to a hosted sink (Phoenix/Langfuse) — local JSONL receipts are sufficient now;
  fields are chosen to map later without rework.
- Switching models away from `gpt-5-nano` — revisit only if U4 shows it's not cheapest for
  the structured-output workload (compare via the `openrouter` skill's `list-models.ts`).

## Open questions
- Does OpenRouter return `usage.cost` directly on chat-completions with `usage:{include:true}`,
  or must we hit `GET /api/v1/generation?id=`? **Resolve in U1** by inspecting one live
  response during the calibration setup; fall back to the generation endpoint if cost is
  absent inline (still source-of-truth, just a second call).
- Default `ASD_LLM_MAX_USD` value — set after U4 reveals real cost/run against the $5 cap.
- Batch size M (U6b) — tune from U4 token/call numbers vs the model's context window.
