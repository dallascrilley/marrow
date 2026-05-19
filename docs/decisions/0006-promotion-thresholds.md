# ADR-0006: Cross-project promotion thresholds

- Date: 2026-05-19
- Status: accepted (2026-05-19)
- Deciders: operator
- Related: [td-5aeb65](#), [ADR-0001](0001-storage-unit.md), [ADR-0002](0002-project-id.md)

## Context

[td-5aeb65] adds cross-project promotion: when the same instinct
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

Operator can override in `~/.asd/config.yaml`.

### Option B — Stricter defaults

`min_projects: 3`, `min_avg_confidence: 0.85`, `min_age_days: 30`.
Less noise, slower promotion.

### Option C — Manual promotion only

`asd promote <instinct-id>` is the only way to move scope. No
automatic promotion. Operator review on every elevation.

### Option D — Auto-suggest, manual approve

Automatic detection produces a queue. `asd promote review` shows
candidates; operator approves/rejects.

## Tradeoffs

| Aspect | A (ECC defaults) | B (stricter) | C (manual) | D (auto-suggest) |
|---|---|---|---|---|
| Time to first useful global instinct | Medium | Slow | Operator-paced | Medium |
| Noise risk in global tier | Medium | Low | Lowest | Low |
| Operator overhead | Low | Low | High | Medium |
| Matches asd's LLM-gated review culture | Weak | Weak | Strong | Strong |
| Implementation cost | Low | Low | Lowest | Medium |
| Reversibility (demote) | Need to ship | Need to ship | N/A | Need to ship |

## Recommendation

**Option D** (auto-suggest, manual approve), with thresholds from A.

This matches asd's existing review culture: the LLM proposes; the
operator approves. The current ingest+review flow is exactly this
pattern at the per-session level. Cross-project promotion should
inherit the model.

Concretely:

- The cron/SessionEnd-triggered pipeline detects promotion candidates
  (instincts meeting `min_projects: 2`, `min_avg_confidence: 0.8`,
  `min_age_days: 14`) and writes them to a queue.
- `asd promote review` lists pending candidates with their per-project
  contexts; operator runs `asd promote approve <id>` or
  `asd promote reject <id> --reason "<...>"`.
- Rejections are persistent (don't re-suggest the same instinct for N
  days).
- Demotion (`asd promote demote <id>`) exists as the safety valve.

Thresholds are tunable in `~/.asd/config.yaml`, but operator approval
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
`~/.agent-session-distillery/promote-queue.json`. The operator
approves or rejects via:

- `asd promote review` — list pending candidates with per-project context
- `asd promote approve <id>`
- `asd promote reject <id> --reason "<...>"`
- `asd promote demote <id>` — safety valve
- `asd promote list` — show global tier

Rejections persist for 30 days (don't re-suggest the same instinct
during the window). Thresholds tunable in `~/.asd/config.yaml`; the
manual-approve gate is not optional in v1.

This matches asd's existing LLM-gated review culture (LLM proposes,
operator approves) and inherits the trust property the per-session
review path already has.

## Consequences

If D:

- Queue artifact at `~/.agent-session-distillery/promote-queue.json`.
- `asd promote` subcommand group: `review`, `approve`, `reject`,
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
