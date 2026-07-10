# Exactly-once reviewed-memory application proof

- Generated: 2026-07-10T04:55:29.487Z
- Git SHA: `216b869811366379782e979001f9d45ac2d809e1`
- Verdict: **PASS**

## Commands

```bash
mise x node@22.22.2 -- npm run build
OPENROUTER_API_KEY=<secret> mise x node@22.22.2 -- node scripts/proof-review-apply-exactly-once.mjs --live
```

## Deterministic sandbox

- Duplicate apply: `no_op=true`; reviewed output and bundle hashes, sizes, and modification times unchanged: `true`; receipt recreated: `true`.
- Skipped generation: reason `llm_budget_exhausted`; no new batch, apply-ledger change, or reviewed-output timestamp change: `true`.
- Interrupted retry: exit `1`; transitions `applying -> failed -> applying -> applied`; converged with identical output hashes: `true`.
- Reviewed files: 1; reviewed learnings: 1.

## Bounded live provider batch

- Status: `passed`
- Model: `google/gemini-3-flash-preview`
- Reviewed: 1; accepted: 1; applied: 1.
- Batch files: 1; exact generated batch applied: `true`.
- Limits: count `1/24h`; spend `0.05/24h`.
- Ledger: `applying -> applied`.

The live proof uses an isolated runtime and one pending fixture learning. It neither reads nor mutates unrelated reviewed memory. Secret values are not included in this artifact.
