# Learning Classification Contract

- Date: 2026-06-22
- Status: draft (for review)
- Related: [atomic-instinct-schema](./atomic-instinct-schema.md),
  [ADR-0001](../decisions/0001-storage-unit.md)

## Purpose

This is a **classification contract**, not a new storage schema. It defines the
axes every distilled learning carries and *how each one is produced*
(deterministic / heuristic / LLM / derived), so we can add classification
without turning the pipeline into taxonomy theater.

Two layers stay separate:

- **Extracted `Learning`** (`src/models/canonical.ts`) — the per-session,
  ephemeral record the pipeline emits today.
- **Durable `Instinct`** (`src/v2/instinct/schema.ts`) — the cross-session,
  deduped, decaying unit. `trigger + finding`, content-hash identity.

The classification axes below are defined on the **`Learning`** layer (that is
where extraction happens) and then **bridged** into the `Instinct` layer. The
bridge today is lossy: `createDeltaFromLearning` maps `title → trigger`,
`statement → finding`, and *derives* `domain` from `kind`
(`src/v2/instinct/from-learning.ts:12,32`). This contract closes that gap by
making the axes real extracted fields with explicit fallbacks.

## Production-method legend

| Tag | Meaning |
|---|---|
| **D** (deterministic) | Pure function of data already on `Turn`/`Event` (commands, files, offsets). No guessing. |
| **H** (heuristic) | Regex/keyword classification over text. Brittle but cheap; the bulk of `extract.ts` today. |
| **L** (LLM) | Needs a model pass (Haiku review path per atomic-instinct-schema). High recall, costs tokens. |
| **R** (derived) | Computed from other axes after extraction; no new signal. |

## Axes

### Have today

| Axis | Field | Method | Notes |
|---|---|---|---|
| **shape** | `kind` | H | `workflow \| decision \| pattern \| failure_mode \| verification_rule \| preference`. Structural type of the lesson. Keep as-is. |
| **trust (prose)** | `promotion_basis` | H | Currently free text. Promote to the `evidence_type` enum below. |
| **scope** | `scope` | D | `project \| user` (the canonical `Learning` enum). Storage location, not transferability (see `applies_when`). `global` is **not** a `Learning` scope — it exists only on the durable `Instinct` and is a *promotion* outcome, not an extracted value. |

### Add — the core set

| Axis | Field | Method | Required | Notes |
|---|---|---|---|---|
| **precondition** | `trigger` | H now, L later | **yes** | "When this matters." The highest-leverage missing field: it gates contextual recall. **MVP is heuristic/derived**: reuse `title` (matches the current bridge so nothing regresses) plus keyword-derived context — no model pass. An **optional LLM enhancement** later lifts recall on triggers the heuristic can't phrase. Required field; the *quality* of its value improves in two steps. |
| **area** | `domain` | R → H | yes | The v2 enum: `code-style \| testing \| git \| debugging \| workflow \| tooling \| security \| performance \| product`. Start as **derived** from `kind` (already implemented in `domainFromLearning`), upgrade to **heuristic** from entities/commands when the `kind→domain` map proves too coarse. |
| **subject** | `technologies[]` | D | yes, may be `[]` | Entities the session touched: languages, package managers, frameworks, services, CLIs. Field is always present; an empty array is valid when nothing is detected. Derive from `commands_seen` (the `isUsefulCommand` whitelist already enumerates them), `files_touched` extensions, and import lines. No LLM. |
| **capability** | `skill_ref[]` | D | no | Harness skill(s) the learning informs, via a command→skill lookup table (`git worktree`→`using-git-worktrees`, `td`→`td-task-management`, `gh pr`→`git`, `pytest/bun test`→`tdd-guide`). **Only useful paired with `trigger`** — without a precondition it is just another flat recall tag. |
| **trust** | `evidence_type` | D/H | yes | `verified \| user_stated \| inferred \| model_inferred`. Four tiers, not three: a deterministic assistant claim (`inferred`) and an LLM-extraction guess (`model_inferred`) must not share a trust level. `verified` = same-turn fix+verification; `user_stated` = direct user instruction/correction. |

### Add — distinct kinds, not flattened

| Axis | Shape | Method | Notes |
|---|---|---|---|
| **dead-end** | `{ attempted, failed_because, applies_when }` | H | A doomed approach future agents should skip. **Keep first-class** — do not force it into "avoid X" advice; preserve the three sub-fields so the *reason* and *scope* survive. Detectable from "tried … / reverted / abandoned / didn't work" phrasing. Currently dropped entirely. |
| **error-signature** | `{ signature, fix_ref }` | D/H | Normalized symptom (error string, exit code, `ENOENT`-class) keyed to its fix. The retrieval key that makes "I've hit this before" work for the debug skill. Pairs with existing `failure_mode`. |
| **transferability** | `applies_when` | H | Whether a learning is project-pinned or globally transferable. Distinct from `scope` (which is *storage*); this controls **promotion** to the global tier. |

### Defer

| Axis | Why defer |
|---|---|
| **relationship edges** | `supersedes \| contradicts \| depends_on` only. Defer beyond that minimal set until dedupe/promote/decay actually *consume* the edges. Premature graph modeling is pure cost. |
| **decision rationale + rejected alternatives** | ADR-shaped; valuable but L-only and high-cost. Revisit after the core set ships. |
| **cost/latency** | `extraction_cost` is already stubbed on the bundle; wire it when there is a consumer. |

## The Learning → Instinct bridge

Today (`from-learning.ts`):

```
title     → trigger        (structural fallback, NOT a real precondition)
statement → finding
kind      → domain         (switch in domainFromLearning)
confidence(level) → initial_confidence (0.4–0.7)
```

Target, once the axes above are extracted:

```
trigger          → trigger          (real precondition; title only as fallback)
statement        → finding
domain           → domain           (extracted/derived, passed through — no re-derivation)
technologies[]   → instinct tags / entity index
skill_ref[]      → instinct skill index (drives contextual injection)
evidence_type    → initial_confidence weighting + maturity floor
                   (verified/user_stated start higher; model_inferred starts at CONFIDENCE_MIN)
applies_when     → scope decision at promote time
error-signature  → finding + retrieval key
dead-end         → create delta with a negative-polarity finding
```

Identity stays `instinctIdFromTriggerFinding(trigger, finding)` — which is
exactly why making `trigger` a *real* extracted precondition (not a recycled
title) matters: it determines cross-session dedupe and reinforcement.

## Sequencing

1. **`trigger` + `evidence_type`** — unlock contextual recall and honest trust. Trigger ships **heuristic/title-derived (no LLM)** in tier 1, with the optional LLM-recall pass deferred; evidence_type is D/H. Highest value.
2. **`technologies[]` + `skill_ref[]`** — both D off existing `Turn` data. The skill-mapping payoff (contextual injection) depends on (1)'s trigger.
3. **dead-ends + error-signature** — cheap H/D wins, currently discarded.
4. **`domain` upgrade** D→H, **`applies_when`** — once promotion logic needs them.
5. **Defer** relationship edges / rationale / cost until a consumer exists.

(1)–(3) are deterministic or heuristic and need no new LLM pass; only `trigger`
high-recall extraction wants a model. That keeps the contract practical.
