# ADR-0004: Vault carve-out scope for MEMORY.md and topic files

- Date: 2026-05-19
- Status: accepted (2026-05-19)
- Deciders: operator
- Related: [ADR-0003](0003-primary-render.md), [td-0b76e8](#), `~/.claude/CLAUDE.md` Personal Hub Vault section

## Context

The current vault carve-out (per `~/.claude/CLAUDE.md` and this
project's `CLAUDE.md`) is:

> `~/vault/wiki/projects/<project-key>/asd-learnings/` (pages) and
> the sibling `_asd-manifest.json` file.

The carve-out is named for asd specifically and is *strictly scoped*:
asd must not touch any other vault path, and "new artifacts that
don't fit either pattern require re-opening the design discussion,
not silent expansion."

ADR-0003 (if accepted) introduces a curated `MEMORY.md` at the
project root (`~/vault/wiki/projects/<id>/MEMORY.md`), plus topic
files (`workflow.md`, `tooling.md`, `preferences.md`, `pitfalls.md`,
`debugging.md`) as siblings. These paths are *outside* the current
carve-out as written.

This ADR proposes the boundary renegotiation.

## Options

### Option A — Expand carve-out to project root with named files (recommended)

New carve-out:

> asd may write to:
> 1. `~/vault/wiki/projects/<id>/asd-learnings/**` (audit trail)
> 2. `~/vault/wiki/projects/<id>/MEMORY.md` (curated rollup)
> 3. `~/vault/wiki/projects/<id>/{workflow,tooling,preferences,pitfalls,debugging}.md` (topic files)
> 4. `~/vault/wiki/projects/<id>/_asd-manifest.json` (manifest)
>
> asd must not write any other path under `~/vault/`. New artifacts
> require re-opening this discussion.

Five named additions to the existing carve-out. Scope is still
named-and-bounded.

### Option B — Expand to "any file matching `_asd-*` or `MEMORY.md`"

Pattern-based instead of file-based. Allows future asd renderers
without re-opening the ADR.

### Option C — Subdirectory carve-out

Move *everything* asd writes (including the curated rollup) under
`~/vault/wiki/projects/<id>/asd/`. Curated rollup becomes
`asd/MEMORY.md`. Carve-out stays one path.

### Option D — Keep current carve-out, ship rollup elsewhere

Put `MEMORY.md` at `~/vault/wiki/projects/<id>/asd-learnings/MEMORY.md`.
Inside current carve-out. Loses the "project-root rollup that Claude
Code auto-loads" property unless project `CLAUDE.md` imports the
nested path explicitly (which it can).

## Tradeoffs

| Aspect | A (named) | B (pattern) | C (subdir) | D (status quo path) |
|---|---|---|---|---|
| Stays scoped (no creeping expansion) | Yes | Weakest | Yes | Yes |
| Matches lamarck/Claude convention of project-root MEMORY.md | Yes | Yes | No | No |
| Project `CLAUDE.md` import simplicity | Best | Best | OK | OK (with explicit path) |
| Future asd renderers (slack/email digest) | Need new ADR | OK | Need new ADR | Need new ADR |
| Risk of asd writing to unintended sibling | Lowest | Medium | Zero | Zero |
| Vault map readability for human | Best | Best | Worse | Same |

The strongest argument against A is "what if asd grows a 7th file
type next quarter?" — and the answer is "open another ADR." Naming
the files keeps the boundary auditable.

The strongest argument for C is purity: one path, end of story. Cost
is that `MEMORY.md` lives at `projects/<id>/asd/MEMORY.md` instead
of `projects/<id>/MEMORY.md`, which is the path Claude Code expects
to find ambient context at.

## Recommendation

**Option A.** Named expansion of the carve-out to the five new file
types. Keeps the contract auditable, matches the lamarck convention,
and the operator can re-open this ADR if the file list grows.

## Decision

**Accepted: Option A — named seven-pattern expansion of the carve-out.**

The expansion is named and bounded, not pattern-based. Carve-out
grows from one pattern (`asd-learnings/`) to seven named patterns:

1. `asd-learnings/**`
2. `_asd-manifest.json`
3. `MEMORY.md`
4. `workflow.md`
5. `tooling.md`
6. `preferences.md`
7. `pitfalls.md`
8. `debugging.md`

(Eight paths, seven concerns — `MEMORY.md` is one concern, the five
topic files are one concern, the learnings directory and manifest
are the existing two.)

The boundary stays auditable. New artifact types require re-opening
this ADR, not silent expansion. The technical guardrail (code-
enforced path allowlist) is mandatory and replaces the social
contract from the v1 carve-out as the primary enforcement.

The amendment lands per `docs/claude-md-v2-carve-out-amendment-draft.md`,
applied to both `~/.claude/CLAUDE.md` and the project `CLAUDE.md`.

## Consequences

If A:

- Amend `~/.claude/CLAUDE.md` "Personal Hub Vault" section, named
  exception block.
- Amend project `CLAUDE.md` "Vault write surface" section.
- Add unit test to asd that asserts vault writes stay within the
  five named patterns (path allowlist enforced in code, not only in
  docs).
- ADR-0003 unblocked.

If C:

- ADR-0003 stays as written but `MEMORY.md` path becomes
  `~/vault/wiki/projects/<id>/asd/MEMORY.md`. Per-project
  `CLAUDE.md` imports the nested path.
- Carve-out stays one line.

If D:

- Curated rollup ships nested. Loses ambient-context auto-load
  unless project `CLAUDE.md` imports `asd-learnings/MEMORY.md`
  explicitly. Acceptable but worse UX.
