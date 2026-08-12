# ADR-0003: Primary render — curated MEMORY.md vs marrow-learnings/ directory

- Date: 2026-05-19
- Status: accepted (2026-05-19)
- Deciders: operator
- Related: [ADR-0001](0001-storage-unit.md), [ADR-0004](0004-carve-out-boundary.md)

## Context

marrow today writes one markdown file per reviewed session to
`~/vault/wiki/projects/<key>/marrow-learnings/<session-id>.md`. There is
no curated rollup. Anyone (or any agent) reading the vault has to open
N files to learn what marrow has distilled about a project.

Lamarck takes the opposite shape: a curated ~200-line `MEMORY.md` per
project is the primary artifact, with topic files (workflow.md,
tooling.md, etc.) for overflow. The `MEMORY.md` is auto-loaded by
Claude Code via the project's `CLAUDE.md` import mechanism, so it
becomes ambient context for every session.

This decision is about *which artifact is canonical for human/agent
consumption*. The atomic-instinct store (ADR-0001) is canonical for
the system; this ADR decides what's canonical for the reader.

## Options

### Option A — Curated MEMORY.md is primary, learnings are audit trail (recommended)

`MEMORY.md` per project: ~200 lines, regenerated on every ingest.
Contains the highest-confidence instincts grouped by domain with
links into topic files. The `marrow-learnings/` directory survives as
an audit log (one file per session, immutable once approved).

### Option B — Status quo: directory is primary

Continue without a curated rollup. Optionally produce a
`_index.md` that lists session learnings chronologically.

### Option C — Both primary, neither curated

Produce both a `MEMORY.md` and per-session files, but no curation
logic — `MEMORY.md` is just a concatenation.

## Tradeoffs

| Aspect | A (curated) | B (status quo) | C (both, dumb) |
|---|---|---|---|
| Ambient context for Claude Code | Excellent | None | Bad (200+ lines of noise) |
| Discoverability for human | Excellent | Poor | Moderate |
| Implementation cost | Medium | Zero | Low |
| Maintenance cost (curation logic) | Medium | Zero | Zero |
| Loss of audit trail | None (preserved) | N/A | None |
| Risk of curation surprises | Medium | None | None |
| Vault carve-out impact | High (path expands) | None | High |

## Recommendation

**Option A.** The whole point of distillation is to produce something
*usable*, not just *archived*. A curated rollup is the form Claude
Code actually consumes (per the lamarck and ECC-v2 patterns).

Curation logic v1: include all `proven` instincts; include
`established` instincts above a confidence threshold (default 0.7);
group by `domain`; cap total at ~200 lines; spill overflow into topic
files (`workflow.md`, `tooling.md`, `preferences.md`, `pitfalls.md`,
`debugging.md`); link from `MEMORY.md` into the topic files for
drill-down.

The `marrow-learnings/` directory survives as an append-only audit
log — one approved learning per session, retained per existing
retention policy. Deletion receipts still apply.

## Decision

**Accepted: Option A — curated `MEMORY.md` is primary, learnings
become audit trail.**

The whole point of distillation is to produce something usable, not
just archived. A curated rollup at `~/vault/wiki/projects/<id>/MEMORY.md`
is the form Claude Code consumes (per the lamarck and ECC-v2
patterns). The `marrow-learnings/` directory survives as an append-only
audit log retained per existing retention policy.

Curation logic v1: include all `proven` instincts; include
`established` instincts with confidence ≥ 0.7; group by `domain`;
cap total at ~200 lines; spill overflow into the topic files defined
in ADR-0004; link `MEMORY.md` into the topic files for drill-down.

This decision depends on ADR-0004 for the carve-out scope expansion.

## Consequences

If A:

- New artifact path: `~/vault/wiki/projects/<id>/MEMORY.md` (and
  sibling topic files). Path is **outside the current carve-out**.
  Blocked on ADR-0004.
- Project `CLAUDE.md` (per-repo) must reference the new `MEMORY.md`
  via an `@import` or equivalent so Claude Code auto-loads it.
- Curation logic is deterministic; regeneration is idempotent.
- Diffs to `MEMORY.md` become a useful operator-facing signal
  (what changed in the curated view this week?).

If B or C:

- Skip the curated-rollup work or rescope to the cheap concatenation option.
- The "curated rollup" UX win is lost; competitors (lamarck,
  self-reflect) keep their edge.
