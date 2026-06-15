# Harness Ingest and Extraction Quality Review

Date: 2026-06-15
Plan: `docs/plans/2026-06-15-test-harness-ingest-quality-review-plan.md`
Epic: `td-3706e1`

## U1. Raised-cap baseline

Test-wide environment:

```bash
export ASD_LLM_MAX_PER=20/24h
```

### Pipeline gate (before any new ingest)

```json
{
  "llm_budget": {
    "allowed": true,
    "max_per_window": "20/24h",
    "remaining": 15,
    "used_in_window": 5,
    "window_started_at": "2026-06-14T15:00:07.021Z"
  },
  "usd_budget": {
    "allowed": true,
    "max_usd_per_window": "1/24h",
    "spent_usd": 0.008526,
    "remaining_usd": 0.991474
  },
  "llm_review": {
    "pending_learnings": 9203,
    "pending_sessions": 3130
  }
}
```

### Quality audit baseline (`--limit 100`)

| Metric | Value |
|--------|-------|
| `summary_missing` | 0 |
| `summary_low_signal` | 18 |
| `process_chatter` | 1 |
| `no_project_learnings` | 36 |
| `blocked_deletion` | 48 |
| `no_files_of_interest` | 25 |
| `no_useful_commands` | 15 |
| `sessions_with_project_learnings` | 41 |
| `total_project_learnings` | 50 |
| `ready` | 52 |
| `blocked` | 48 |

These numbers are the baseline against which each harness's incremental ingest will be compared.

## U2–U6. Per-harness observations

(TBD after each ingest run.)

## U7. Cross-harness findings

(TBD after all harnesses are reviewed.)
