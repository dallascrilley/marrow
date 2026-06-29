# 0010. Recall read-back and the per-project reinforcement contract

- **Status:** accepted
- **Date:** 2026-06-29

## Context

asd's deterministic pipeline (ingest → summarize → extract instincts → render
`MEMORY.md` → vault push) was mature and idempotent, but the loop was **open at
both ends**. Two distinct failures compounded:

1. **Reinforcement never accumulated.** Recompute/replay reset every instinct's
   confidence back to the extraction noise floor (~0.54) on each pass, so
   high-signal instincts never stayed above the per-project rollup gate. A
   diagnostic at U8 measured exactly **2** instinct lines reachable in a vault
   `MEMORY.md` across 259 projects (`asd stats` → `reachability.reachable=2`).

2. **Nothing read the output back.** Even those 2 reachable lines never reached
   a future agent. The vault `MEMORY.md` files were write-only: no harness
   surface loaded `~/vault/wiki/projects/<id>/MEMORY.md` into a session.

The cross-project promotion ladder (see [ADR-0006](0006-promotion-thresholds.md),
`min_projects ≥ 2`) was investigated as the fix and rejected: a spike (U5a)
showed ~0 cross-project recurrence on this corpus, so the promotion gate is
structurally unsatisfiable here. The leverage is **per-project** memory that is
actually read back, not global distillation.

## Decision

We close the loop with a per-project read-back contract and pin down what
reinforcement guarantees.

- **`confidence_floor` is persisted per instinct (U4).** Recompute and
  bundle-replay may never reset an instinct below its earned floor. A high-floor
  (0.7) instinct recomputes to ~0.74 and clears the per-project rollup gate
  (`shouldIncludeInRollup`: `candidate` + confidence ≥ 0.6). This single change
  lifted per-project reachability from **2 → 259** instincts across **105**
  projects under the U4-aware build.

- **`asd recall` is the read-back surface.** It resolves the project id from the
  current working directory (git-remote hash, `.asd-project-key` declared key, or
  path hash per [ADR-0002](0002-project-id.md)), reads the curated
  `MEMORY.md` plus the topic files (`workflow.md`, `tooling.md`, `pitfalls.md`,
  `debugging.md`, `preferences.md`) from the carve-out
  (see [ADR-0004](0004-carve-out-boundary.md) / `src/config/vault-paths.ts`),
  strips frontmatter, caps the payload at 4000 bytes, and **fails open** (a
  missing vault prints nothing and exits 0).

- **Delivery is a hub-managed SessionStart hook.** `asd recall` is wired into the
  agent harness via the `asd-recall-sessionstart` hook artifact in the shared
  hub (`~/.hub/artifacts/hooks/asd-recall-sessionstart/`), registered identically
  to the existing `axi-opt-in-sessionstart` hook. It resolves the project from the
  SessionStart payload `cwd`, runs `asd recall`, and emits the result as
  `hookSpecificOutput.additionalContext` on `startup|resume`. It is fail-open by
  contract: any error, missing build, missing vault, or an unmemoried project
  yields `{}` so a session never breaks. It is Claude-scoped for now; the same
  artifact can add `codex`/`cursor` event blocks later.

- **Cross-project / global promotion stays out of scope.** The product is
  per-project working memory read back into the next session. We explicitly
  reject a single-high-signal global fast-path: it would flood the vault with
  trivial, low-recurrence noise. A within-environment global *writer* remains
  optional and unbuilt; the global *reader* already exists (the MCP `global`
  scope branch in `src/v2/mcp/query.ts`).

## Consequences

- A new session in any of the 105 memoried projects now receives its curated
  memory at start (verified: 2,279 bytes / 10 bullets for `agent-ntfy-ios`,
  1,034 bytes / 4 bullets for `cohost-ai-studio`). Read-back is real, not
  aspirational.

- The live hook was wired **surgically** into `~/.claude/settings.json` rather
  than via a whole-runtime `hubctl runtime install claude`, because that path
  re-merges every enabled hub SessionStart hook and would re-introduce the
  banner/axi hooks that were deliberately removed from the live config. Formal
  hub adoption (which would generate `.hook-lock.json` and reconcile all hooks)
  is therefore a deferred, opt-in follow-up, not a silent side effect.

- Reachability is now governed by two independent gates that must not be
  conflated: the **per-project rollup gate** (`shouldIncludeInRollup`, now
  satisfied by persisted floors) and the **cross-project promotion gate**
  ([ADR-0006](0006-promotion-thresholds.md), still starved by design). Reporting
  should prefer the bundle-replay `produced` count over the raw instinct-yaml
  store count, which double-counts superseded records.

- The trigger backfill (78% of instincts lack a recorded trigger) gates the MCP
  *query* retrieval path, not the SessionStart *read-back* path, so it is
  decoupled from this contract and can proceed on its own (budget-gated)
  schedule.
