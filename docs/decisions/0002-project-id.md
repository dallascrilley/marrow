# ADR-0002: Project ID strategy

- Date: 2026-05-19
- Status: accepted (2026-05-19)
- Deciders: operator
- Related: [ADR-0001](0001-storage-unit.md)

## Context

marrow today identifies projects by filesystem path (e.g.,
`-Users-dallas-Code-marrow`). Path keys are
machine-local: the same project on the operator's laptop and desktop
gets two different IDs. Cross-project promotion requires
a portable ID so the operator's two machines agree the instinct
"prefer pnpm" came from the same project.

ECC continuous-learning-v2 uses **git remote URL hashed** to a stable
ID. Portable across machines and worktrees, machine-agnostic. But marrow
ingests from sources that are not always git-backed: ad-hoc Cursor
workspaces, Codex CLI runs on scratch directories, Pi transcripts
tied to a chat session not a repo.

## Options

### Option A — git remote hash with fallback chain (recommended)

```
git remote URL hash       (when repo has a remote)
  ↓ fallback
workspace path hash       (machine-local, but stable on this machine)
  ↓ fallback
user-declared key         (from `.marrow-project-key` file at session root)
```

Each session resolves to exactly one ID via the chain. Operator can
override by dropping `.marrow-project-key` containing a string.

### Option B — git remote hash only

Sessions without a git remote are filed under a single `unscoped`
bucket. Forces the operator to add remotes or accept loss.

### Option C — Keep path-based IDs

Drop cross-project promotion. Or accept that promotion only works on
one machine at a time.

### Option D — Operator declares ID per session

A `--project-id` flag on `marrow ingest sync`. No automatic resolution.

## Tradeoffs

| Aspect | A (chain) | B (remote only) | C (path) | D (manual) |
|---|---|---|---|---|
| Portable across machines | Yes (when remote) | Yes | No | Yes |
| Works for ad-hoc Cursor workspaces | Yes (path fallback) | No | Yes | Yes |
| Operator-overridable | Yes | No | No | Yes (always) |
| Zero-config common case | Yes | Yes | Yes | No |
| Implementation complexity | Medium | Low | Low | Low |
| Risk of silent ID drift | Low (deterministic) | None | High | None |

## Recommendation

**Option A.** The fallback chain handles the long tail (no-remote
workspaces) while giving the common case (real repos) the portable ID
needed for promotion. Manual override via `.marrow-project-key` is the
escape hatch for projects with multiple remotes or repos that have
been re-homed.

Specific hash function: SHA-256 over the normalized remote URL
(stripped scheme, no trailing `.git`, lowercased), truncated to 12
hex chars. Same for path fallback.

## Decision

**Accepted: Option A — git remote hash with fallback chain.**

Resolution order: normalized git remote URL hash → workspace path
hash → user-declared `.marrow-project-key` file at session root. SHA-256
truncated to 12 hex chars. The chain handles the common case (real
repos with remotes) portably across machines while still working
for ad-hoc Cursor workspaces and Codex scratch dirs. The
`.marrow-project-key` override is the escape hatch for projects with
multiple remotes, re-homed repos, or operator-imposed grouping.

Migration writes a `_project-id-migration.json` mapping for audit so
the rename from path-keyed to hash-keyed storage is reversible.

## Consequences

If A:

- One-time migration: walk existing `marrow-learnings/<path-key>/`
  directories, resolve each to a new ID via the chain, and produce a
  `_project-id-migration.json` mapping for audit.
- `manifest.json` gains a `project_id` field.
- Vault path also moves: `~/vault/wiki/projects/<new-id>/marrow-learnings/`.
  ADR-0004 (carve-out) covers the renaming permission.
- Operator can write `.marrow-project-key` in any repo to override.
