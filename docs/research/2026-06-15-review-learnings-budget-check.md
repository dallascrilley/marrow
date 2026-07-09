---
date: 2026-06-15
origin: quality audit follow-up (U6)
td_epic: td-cbc405
---

# U6 check: `quality review-learnings` on low-signal sessions

## Goal

Run `asd quality review-learnings` on the backlog of low-signal sessions within the configured LLM budget.

## Current state

- **summary_low_signal sessions:** 770
- **Pending project learnings to review:** 9,203 (from `pipeline gate`)
- **Pending sessions with unreviewed learnings:** 3,130

## LLM budget gate

`pipeline gate --skip-ingest` reports:

```json
{
  "llm_budget": {
    "allowed": false,
    "max_per_window": "5/24h",
    "remaining": 0,
    "used_in_window": 5,
    "window_started_at": "2026-06-14T10:07:09.342Z"
  },
  "usd_budget": {
    "allowed": true,
    "max_usd_per_window": "1/24h",
    "spent_usd": 0.008526,
    "remaining_usd": 0.991474
  }
}
```

The per-call sliding window is exhausted (5/5 used in the last 24 hours). The USD budget is healthy.

## Decision

Do **not** override the budget. Running `quality review-learnings` now would either be skipped immediately by the budget gate or would require raising `--max-per`, which violates the "within budget" constraint.

## Recommended next step

Re-run after the window refreshes:

```bash
asd pipeline gate --skip-ingest
# when llm_budget.allowed is true:
asd quality review-learnings --if-new --max-total-learnings 100
```

A `--max-total-learnings` cap of 100 keeps the first sweep under the 5/24h call limit (one batch per session, one HTTP call per session) while making material progress on the 9,203 pending learnings.

---

## U2 trial results (2026-06-26)

**Unblock:** Account privacy still blocks fixed model ids (`openai/gpt-5-nano` → 404).
`openrouter/auto` routes successfully; used for this trial.

### Pre-run gate

```bash
asd pipeline gate --max-per 10/24h --skip-ingest
# llm_budget.allowed: true (7 remaining in 10/24h window)
# usd_budget.allowed: true ($0.153 remaining in 1/24h window at trial start)
```

### Trial command

```bash
export OPENROUTER_API_KEY="$(op read 'op://your-vault/OpenRouter API Credentials - agent-session-distillery/credential')"
asd quality review-learnings --if-new --max-per 10/24h --max-total-learnings 25 --model openrouter/auto
```

**Result (2026-06-26T19:47:54Z):**

| Metric | Value |
|--------|-------|
| `total_reviewed_learnings` | 25 |
| `failed` | 0 |
| Verdicts | 6 reject, 17 rewrite, 2 keep (implicit) |
| Pre-LLM skips | 4 (`low_signal_session`) |
| Model | `openrouter/auto` |

### Cost telemetry (`quality cost-report --since 2026-06-26T19:47:54Z`)

| Metric | Value |
|--------|-------|
| Real API calls | 24 |
| Cache hits | 1 |
| Trial spend | **$0.1608** |
| **Cost per learning** | **$0.0064** |
| Cost per session (mean) | $0.0101 |
| Cost per session (p90) | $0.0177 |

Post-trial: USD window **exhausted** (`spent_usd: 1.007`, `remaining_usd: 0`).
Next sweep must wait for 24h window refresh or explicit `--max-usd` override.

### U3 decision (scaled batch size)

At **~$0.0064/learning** under `openrouter/auto`:

- **$1/24h cap → ~150 learnings** theoretical max; target **100 learnings/sweep**
  (~$0.64) to leave headroom for retries/cache misses.
- Keep **`--max-per 10/24h`** for trial discipline; raise to **`25/24h` or `50/24h`**
  only after window refresh when USD headroom confirmed via `pipeline gate`.
- **Stop condition:** `usd_budget.allowed: false` (hard guard; hit after this trial).
- **Model:** use `openrouter/auto` (or `OPENROUTER_MODEL=openrouter/auto`) until
  account privacy allows fixed ids.

---

## U4/U5 final sweep and audit impact (2026-07-07)

The scaled sweep ran after `openrouter/auto` unblocked the provider route and the
USD window refreshed.

### Sweep command

```bash
asd quality review-learnings --if-new --max-total-learnings 100 --model openrouter/auto
```

### Sweep result

| Metric | Value |
| --- | --- |
| Reviewed learnings | 100 |
| Verdicts | 36 reject, 58 rewrite, 6 keep |
| Failures | 0 |
| Model | `openrouter/auto` |
| Spend | $0.00 for this sweep; 100% judge-cache hits |
| USD headroom after sweep | $0.914 remaining of $1/24h |
| Count budget after sweep | 47 remaining of 50/24h |
| Sidecar | `~/.agent-session-distillery/reports/llm-learning-review.jsonl` (100 records) |

### Apply + audit impact

`quality apply-learning-review` completed successfully against the 100-record
sidecar:

| Metric | Value |
| --- | --- |
| Kept/rewrite records applied | 49 to `knowledge/projects-reviewed/` |
| Rejected | 51 |
| Skipped | 0 |
| `summary_low_signal` | 941 → 941 (no increase) |
| `total_project_learnings` | 12,178 → 12,178 (held steady) |
| `with_issues` | 4,346 → 4,346 |

The unchanged audit aggregates are expected: reviewed learnings land in the
parallel `knowledge/projects-reviewed/` tree, while `quality audit` continues to
count the original deterministic `knowledge/projects/` corpus.

### Current budget posture (2026-07-09)

`pipeline gate --skip-ingest` reports the runtime can continue review work:

| Metric | Value |
| --- | --- |
| Pending project learnings | 4,694 |
| Pending sessions | 2,039 |
| Count budget | 45 remaining of 50/24h |
| USD budget | $0.696809 remaining of $1/24h |
| Recommendation | `run_review_learnings: true` |

Code default check: `src/pipeline/llm-budget.ts` sets `defaultMaxPer =
"50/24h"`; no `ASD_LLM_MAX_PER` override was present in the session
environment. This differs from the original June note's `5/24h` trial cap. The
current design keeps the count cap generous so the backlog drains at the pace of
the hard USD ceiling (`ASD_LLM_MAX_USD`, default `1/24h`). Do **not** lower the
code default back to `5/24h` for U6; use `--max-per 5/24h` only for deliberately
small trials.
