# LLM cost baseline (calibration U4)

Captured 2026-06-14 against the dedicated `$5` test key
(1Password: *OpenRouter API Credentials - agent-session-distillery*) using the
telemetry + cost-report from plan
[`docs/plans/2026-06-14-feat-llm-cost-telemetry-plan.md`](../plans/2026-06-14-feat-llm-cost-telemetry-plan.md).

Method: `quality review-learnings --limit 6000 --max-total-learnings 8 --no-cache`
on real runtime sessions, then `quality cost-report --json --since <run> --backlog-learnings 3078`.

## Numbers (model `openai/gpt-5-nano`, 8 real reviews)

| Metric | Value |
|--------|-------|
| Cost per learning | **$0.000867** |
| Cost per session (mean) | $0.002312 |
| Cost per session (p50 / p90 / max) | $0.000918 / $0.004397 / $0.005267 |
| Total (8 calls) | $0.006936 |
| Input tokens / call (mean) | 354 |
| Output tokens / call (mean) | 2,123 |
| **Reasoning tokens / call (mean)** | **2,000** |
| Total tokens / call (mean) | 2,478 |
| Projected full drain (3,078 learnings) | **~$2.67** |

## Key findings

1. **The key is BYOK** (`is_byok: true`). OpenRouter's own `usage.cost` is `0`;
   real spend lands on the upstream provider key and is reported in
   `cost_details.upstream_inference_cost`. Telemetry records this as
   `cost_source: "upstream"`. **Implication for U5:** a USD budget computed from
   OpenRouter's `cost` would never trigger — budget must sum the effective
   (upstream) cost, which is what `LlmCallUsage.cost` now carries.
2. **Reasoning tokens dominate.** ~2,000 of ~2,123 output tokens per call (94%)
   are reasoning, for a memory-lint that emits a tiny JSON verdict. This is the
   single largest cost lever. **U6 priority:** set a minimal/low reasoning effort
   (or disable reasoning) for the review and topic prompts — expected order-of-
   magnitude reduction in output tokens and cost.
3. **Whole-backlog cost is small but not free.** ~$2.67 to review 3,078 learnings
   at current settings; well within the $5 cap, but the reasoning waste means
   ~10x headroom is available, and the BYOK upstream key still pays it.
4. **Inline cost is trustworthy here** (no `unknown_cost_calls`); the planned
   `/api/v1/generation` fallback was not needed — `cost_details` is returned
   inline with `usage: { include: true }`.

## Reproduce

```bash
KEY="$(op read 'op://your-vault/OpenRouter API Credentials - agent-session-distillery/credential')"
OPENROUTER_API_KEY="$KEY" node dist/cli.js quality review-learnings \
  --limit 6000 --max-total-learnings 8 --no-cache
node dist/cli.js quality cost-report --json --backlog-learnings 3078
```

## After U5/U6 (verification, 2026-06-14)

Re-run on the same key (`quality review-learnings --limit 6000
--max-total-learnings 12 --no-cache --batch-size 6`, 12 real reviews), then
`cost-report --json --since <run> --backlog-learnings 3078`:

| Metric | U4 baseline | After U5/U6 | Change |
|--------|-------------|-------------|--------|
| Cost per learning | $0.000867 | **$0.000132** | ~6.6x cheaper |
| **Reasoning tokens / call (mean)** | **2,000** | **138.7** | ~14x fewer |
| Output tokens / call (mean) | 2,123 | 283.8 | ~7.5x fewer |
| HTTP calls (12 learnings) | 12 | **4** | batching (`--batch-size 6`) |
| Projected full drain (3,078) | ~$2.67 | **~$0.41** | ~6.5x cheaper |

`unknown_cost_calls: 0`; all 12 receipts `cost_source: "upstream"`; `usd_budget`
surfaced and under cap. Capping reasoning effort (U6c) is the dominant win;
batching (U6b) cuts the HTTP-call count; the USD ceiling (U5) and pre-filter
(U6a) bound and trim spend. Total spend for this verification run: ~$0.0016.
