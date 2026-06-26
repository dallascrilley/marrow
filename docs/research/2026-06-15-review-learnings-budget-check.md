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
export OPENROUTER_API_KEY="$(op read 'op://Private/OpenRouter API Credentials - agent-session-distillery/credential')"
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
