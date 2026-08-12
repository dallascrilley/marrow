# ADR-0011: LLM-judged global promotion fast-path

- Date: 2026-06-30
- Status: accepted (2026-06-30)
- Deciders: operator
- Related: [ADR-0006](0006-promotion-thresholds.md) (supplements),
  [ADR-0005](0005-mcp-surface.md), [ADR-0010](0010-recall-read-back.md)

## Context

[ADR-0006] set the cross-project promotion gate: the **same instinct id in
≥2 projects** at **avg confidence ≥ 0.8**, aged ≥14 days, promotes to global
scope. That gate assumes the same insight recurs under the same id across
projects.

In practice it never fires. The U5 reinforcement spike found ~0 cross-project
id overlap: slug ids are derived from a finding's wording, and the same advice
rarely produces identical wording across unrelated codebases, so the
`min_projects: 2` requirement is essentially never met. The live corpus
confirms the downstream effect — of 1,069 non-deprecated project instincts,
only 1 cleared 0.8 confidence and exactly 2 were ever promoted. The global
store stayed empty and `recall` (ADR-0010) surfaced nothing global, which was
the headline failure in the landscape analysis: "the number that matters is how
many instincts a future agent will ever see — and it was 2."

The `min_projects: 2` count was always a *proxy* for the real question — "is
this advice generally applicable, or specific to one codebase?" — and a poor
one. The question itself is answerable directly.

## Options

1. **Lower the deterministic thresholds.** Drop `min_projects` to 1 and/or
   `min_avg_confidence` toward 0.7.
2. **Canonicalize ids by semantic similarity** so the same insight dedupes to
   one id across projects, making the ≥2-projects signal accumulate.
3. **LLM-judged single-project fast-path.** Surface high-confidence
   single-project instincts and ask a model directly whether each is globally
   applicable; promote the approved ones.

## Tradeoffs

| | 1. Lower thresholds | 2. Semantic canonicalization | 3. LLM judge |
|---|---|---|---|
| Fires on real data | Yes, but indiscriminately | Only if overlap exists | Yes |
| Precision (rejects project-specific) | Weak — count is a poor proxy | Medium | Strong — judges applicability directly |
| Matches marrow's LLM-gated review culture | Weak | Weak | Strong |
| Cost | Free | Free | Cheap (deepseek-v4-flash ≈ $0.00008/instinct) |
| Feasibility | Trivial | Spike found ~0 overlap (rejected in U5) | Reuses existing OpenRouter harness |

Option 2 was effectively foreclosed by the U5 spike. Option 1 fires but
promotes project-specific noise (a single-project debugging note about a named
service would go global). Option 3 spends a fraction of a cent to ask the
question the count was proxying for.

## Recommendation

Adopt Option 3, alongside — not replacing — the ADR-0006 deterministic queue.
The deterministic path remains the "strong evidence" route (if an id genuinely
recurs across projects, promote it); the LLM judge is the path that actually
fires on today's corpus.

## Decision

Accepted. Add a single-project fast-path:

- **Candidate detection** (`detectGlobalJudgeCandidates`): every non-deprecated
  project-scope instinct at **confidence ≥ 0.7**, deduped by id to its
  highest-confidence occurrence. 0.7 is the live high-signal cliff — ~3 instincts
  clear 0.75 but ~257 clear 0.70.
- **Judge** (`judgeGlobalApplicability`): asks the model whether the finding is
  transferable best-practice vs codebase-specific; conservative (defaults to not
  global); returns `{global, confidence, reason}`.
- **Apply** (`promote judge` command): detect → judge (bounded by `--limit` and
  the shared count/USD budgets, re-checked per call, telemetry-recorded so
  `--max-usd` enforces) → write approved as `scope: global` → render to
  `_global/MEMORY.md` → `recall`. Fails open without `OPENROUTER_API_KEY`.

The promote step stays manual and budget-gated (not wired into the scheduled
pipeline), consistent with [ADR-0007]'s daemon/LLM separation: the cheap
deterministic pipeline never makes paid calls; LLM spend is always deliberate.

## Consequences

- The global tier is now reachable. First live populate: 30 judged → 16
  promoted, 14 rejected, $0.0024; `recall` now leads every session with the
  global rollup.
- `min_projects`/`min_avg_confidence` from ADR-0006 still govern the
  deterministic queue; this ADR supplements that gate, it does not retune it.
- Promotion quality now depends on judge prompt quality. Revisit the prompt and
  `--min-verdict-confidence` default if the global rollup accumulates noise.
- Cost scales with candidate volume; the count/USD budgets bound each run, and
  already-global ids are skipped on re-runs so a sweep converges.
