# ADR-0006: Cross-project promotion thresholds

- Date: 2026-05-19
- Status: accepted (2026-05-19); supplemented by [ADR-0011](0011-llm-judged-promotion.md) (2026-06-30)
- Deciders: operator
- Related: [ADR-0001](0001-storage-unit.md), [ADR-0002](0002-project-id.md), [ADR-0011](0011-llm-judged-promotion.md)

> **Note (2026-06-30):** The `min_projects: 2` gate this ADR sets almost never
> fires in practice — the same insight rarely produces the same slug id across
> projects (U5 spike: ~0 overlap), so only 2 instincts were ever promoted.
> [ADR-0011](0011-llm-judged-promotion.md) adds an LLM-judged single-project
> fast-path as the working promotion route. The thresholds below still govern
> the deterministic queue; they are not retuned here.

## Context

Cross-project promotion: when the same instinct
appears in multiple projects with sustained confidence, it gets
promoted from project-scoped to operator-wide (global) scope. ECC
continuous-learning-v2 uses:

> Same instinct ID in **≥2 projects** with **avg confidence ≥ 0.8**
> → auto-promote to global.

This ADR is about whether to adopt those defaults, tune them, or
make them tunable.

The risk of too-permissive thresholds: noise pollutes the global
tier; "always use TDD" gets promoted because three random projects
mentioned it. The risk of too-restrictive thresholds: nothing ever
promotes, the global tier stays empty, the feature is dead code.

## Options

### Option A — Adopt ECC defaults, expose them as tunable config (recommended)

Default: `min_projects: 2`, `min_avg_confidence: 0.8`,
`min_age_days: 14` (additional sanity check — must have survived
14 days as `established` or `proven` in at least one project).

Operator can override in `~/.marrow/config.yaml`.

### Option B — Stricter defaults

`min_projects: 3`, `min_avg_confidence: 0.85`, `min_age_days: 30`.
Less noise, slower promotion.

### Option C — Manual promotion only

`marrow promote <instinct-id>` is the only way to move scope. No
automatic promotion. Operator review on every elevation.

### Option D — Auto-suggest, manual approve

Automatic detection produces a queue. `marrow promote review` shows
candidates; operator approves/rejects.

## Tradeoffs

| Aspect | A (ECC defaults) | B (stricter) | C (manual) | D (auto-suggest) |
|---|---|---|---|---|
| Time to first useful global instinct | Medium | Slow | Operator-paced | Medium |
| Noise risk in global tier | Medium | Low | Lowest | Low |
| Operator overhead | Low | Low | High | Medium |
| Matches marrow's LLM-gated review culture | Weak | Weak | Strong | Strong |
| Implementation cost | Low | Low | Lowest | Medium |
| Reversibility (demote) | Need to ship | Need to ship | N/A | Need to ship |

## Recommendation

**Option D** (auto-suggest, manual approve), with thresholds from A.

This matches marrow's existing review culture: the LLM proposes; the
operator approves. The current ingest+review flow is exactly this
pattern at the per-session level. Cross-project promotion should
inherit the model.

Concretely:

- The cron/SessionEnd-triggered pipeline detects promotion candidates
  (instincts meeting `min_projects: 2`, `min_avg_confidence: 0.8`,
  `min_age_days: 14`) and writes them to a queue.
- `marrow promote review` lists pending candidates with their per-project
  contexts; operator runs `marrow promote approve <id>` or
  `marrow promote reject <id> --reason "<...>"`.
- Rejections are persistent (don't re-suggest the same instinct for N
  days).
- Demotion (`marrow promote demote <id>`) exists as the safety valve.

Thresholds are tunable in `~/.marrow/config.yaml`, but operator approval
is non-optional. Adopt automatic promotion only if review queue
turns out to be a bottleneck.

## Decision

**Accepted: Option D — auto-suggest with manual approval, using
Option A thresholds.**

Promotion candidate detection runs on every ingest pipeline:

- `min_projects: 2`
- `min_avg_confidence: 0.8`
- `min_age_days: 14` (must have spent ≥14 days at `established` or
  `proven` in at least one project)

Candidates land in a queue at
`~/.marrow/promote-queue.json`. The operator
approves or rejects via:

- `marrow promote review` — list pending candidates with per-project context
- `marrow promote approve <id>`
- `marrow promote reject <id> --reason "<...>"`
- `marrow promote demote <id>` — safety valve
- `marrow promote list` — show global tier

Rejections persist for 30 days (don't re-suggest the same instinct
during the window). Thresholds tunable in `~/.marrow/config.yaml`; the
manual-approve gate is not optional in v1.

This matches marrow's existing LLM-gated review culture (LLM proposes,
operator approves) and inherits the trust property the per-session
review path already has.

## Consequences

If D:

- Queue artifact at `~/.marrow/promote-queue.json`.
- `marrow promote` subcommand group: `review`, `approve`, `reject`,
  `demote`, `list`.
- Promoted instincts persist `scope: global`; the project-scoped
  copies remain (audit trail).
- MCP `search_instincts` honors scope and merges global + project
  results.

If A (pure auto):

- Skip the queue + subcommands. Promotion happens silently.
- Add a `--no-auto-promote` flag for sessions where the operator
  wants to disable.

If C:

- Promotion stays an explicit operator gesture only.
