---
title: archive and verify Codex sources before deletion
date: 2026-07-14
category: tooling
module: cli/commands
tags: [codex-cli, deletion, cleanup, archive, source-cleanup]
applies_when:
  - You want to reclaim disk space from ~/.codex after sessions are archived
  - A ready Codex source needs an immutable raw copy before unlinking
related: [docs/solutions/performance/codex-worktree-runtime-backups-disk-bomb.md]
---
# Archive and verify Codex sources before deletion

## Problem

`delete apply --apply` is intentionally a tombstone-and-ledger workflow. It
does not preserve or remove original Codex JSONL files. A direct cleanup script
that unlinks those files can reclaim space, but it leaves no verified raw copy
and cannot safely recover an interrupted deletion.

## Solution

Use the source-specific command, which is dry-run by default:

```bash
# Inspect eligible, blocked, missing, and already-archived sessions
node dist/cli.js delete sources --source codex-cli

# Archive, verify, then remove only eligible Codex transcripts
node dist/cli.js delete sources --source codex-cli --apply
```

For each safe candidate in `ready` or `discardable_no_signal` state, the
command writes:

- `~/.agent-session-distillery/archives/raw/codex-cli/YYYY/MM/DD/<session-id>.jsonl.gz`
- a neighboring `.receipt.json` with source and archive hashes, byte counts,
  source path, and timestamps

It writes the gzip to a temporary path, atomically renames it, decompresses it,
and checks its SHA-256 against the immutable source hash before unlinking the
original. Failed copies, hash mismatches, unsafe paths, and archive collisions
leave the source and ledger unchanged.

## Recovery and compatibility

If a previous run created a valid archive and receipt but stopped before
unlinking, rerunning `delete sources --source codex-cli --apply` validates the
archive, removes the remaining source, and finalizes the ledger. A missing
source without a valid receipt stays blocked.

Legacy `applied` candidates are archived and removed without creating a second
tombstone. `scripts/cleanup-codex-sources.mjs` remains as a deprecated wrapper
that delegates to this command; it no longer unlinks files directly.

## Prevention

Use `delete candidates` to inspect readiness, then use `delete sources --source
codex-cli --apply` for Codex disk reclamation. Keep `delete apply --apply` for
the compatible tombstone-only path when raw source deletion is not intended.
