# ADR 0010: Multi-tracker hub-and-spoke (beads + Linear + GitHub)

**Status:** Accepted  
**Date:** 2026-08-07  
**Context:** `docs/plans/2026-08-07-chore-beads-linear-github-workflow-demo-plan.md`

## Decision

Use **beads** as the agent source of truth for issue tracking in this repository. Use **Linear** as the human product board (epics/outcomes). Use **GitHub Issues** for public/community intake only. Use **GitHub PRs/Actions** for code review and CI waits via beads gates — not as the agent task queue.

Topology is **hub-and-spoke**, not triple bidirectional sync:

- Agents read/write **only beads** (`bd ready`, claim, deps, discovered-from, close).
- Linear and GitHub Issues are selective mirrors linked by a single `external_ref` per bead.
- One bead has at most one remote primary (Linear **or** `gh-N`, not both).

## Consequences

- After cutover, `.todos/` (`td`) is a frozen archive; agents must not `td create` / `td update`.
- Micro-tasks and wisps never push to Linear.
- Promotion to Linear/GitHub is deliberate (type epic/feature and/or `promote:*` labels).
- Conflict policy: prefer local for execution state; prefer spoke only on intentional planning/public pulls.

## Alternatives considered

| Option | Why rejected |
|--------|----------------|
| Stay on `td` only | No Linear/GH product surfaces; weaker ready/deps for multi-agent demo |
| GitHub Issues as agent queue | Flat list; no dependency-ready queue |
| Full bi-sync all three | Status thrash and dual claims |
| Dual-write td + beads | Dual SoT failure mode |

## Related

- Operator runbook: `docs/recipes/beads-linear-github-workflow.md`
- Demo script: `docs/recipes/beads-demo-script.md`
- Skill: `beads-multi-tracker` (Hub library)
