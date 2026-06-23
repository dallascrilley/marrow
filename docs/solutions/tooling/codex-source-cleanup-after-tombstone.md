---
title: delete-apply only writes tombstones; actual source deletion requires a separate cleanup script
date: 2026-06-22
category: tooling
module: cli/commands
tags: [codex-cli, deletion, cleanup, tombstone, source-cleanup]
applies_when:
  - You want to reclaim disk space from ~/.codex after sessions are archived
  - delete-apply ran but original source files still exist
related: [docs/solutions/performance/codex-worktree-runtime-backups-disk-bomb.md]
---
# delete-apply only writes tombstones; actual source deletion requires a separate cleanup script

## Problem

Running `node dist/cli.js delete apply --apply` writes JSON tombstones to
`~/.agent-session-distillery/deletes/tombstones/` and updates the ledger's
`deleted` phase, but it **does not unlink the original source files** in
`~/.codex/sessions/` or `~/.codex/archived_sessions/`.

This means the codex-cli source files (often 1-2 MB each) remain on disk
indefinitely, even after the pipeline has archived, summarized, and extracted
learnings from them.

## What didn't work

- Expecting `delete-apply --apply` to also delete the source files — it does not.
- Manually finding files by session_id in the date-partitioned
  `~/.codex/sessions/YYYY/MM/DD/` tree — tedious and error-prone.

## Solution

Use `scripts/cleanup-codex-sources.mjs` (dry-run by default):

```bash
# See what would be deleted
node scripts/cleanup-codex-sources.mjs

# Actually delete source files for ready codex-cli sessions
node scripts/cleanup-codex-sources.mjs --apply
```

The script:

1. Queries the ledger for `deletion_candidates` joined with `source_sessions`
   where `source_tool = 'codex-cli'` and `candidate_state IN ('ready', 'discardable_no_signal')`
   and `safe_to_delete = 1`.
2. For each session_id, searches `~/.codex/sessions/YYYY/MM/DD/<session_id>.jsonl`
   then `~/.codex/archived_sessions/<session_id>.jsonl`.
3. Deletes the found source files.

## Why it works

The pipeline's `delete-apply` command is intentionally conservative: it only
marks ledger state. Source file deletion is a separate, irreversible operation
that must be scoped to a specific adapter and requires a file-system search
(because session IDs are date-partitioned in `~/.codex/sessions/`).

## Prevention

Run `cleanup-codex-sources.mjs` after each `delete-apply` batch if disk space
is the goal. Consider integrating it into a future `delete-apply` subcommand or
post-apply hook.
