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
