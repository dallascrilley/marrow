---
title: '~/.codex/worktrees can contain multi-gigabyte runtime-backups snapshots'
date: 2026-06-22
category: performance
module: disk-usage
tags: [codex, worktree, disk-usage, runtime-backups, cleanup]
applies_when:
  - ~/.codex is unexpectedly large
  - du -sh ~/.codex/worktrees shows multi-gigabyte entries
related: [docs/solutions/tooling/codex-source-cleanup-after-tombstone.md]
---

# ~/.codex/worktrees can contain multi-gigabyte runtime-backups snapshots

## Problem

`~/.codex/worktrees/` contained a 5.1G entry (`04d8`) on 2026-06-22. Most of
that was `~/.codex/worktrees/04d8/.hub/runtime-backups/`: 225 directories, each
~21 MB, created between May 31 and June 10. Each directory was a full snapshot
of a `pi` runtime checkout including `node_modules/`.

Additionally, many worktree entries were empty 8K shells with no actual content.

## Context

Codex CLI creates internal git worktrees (`.codex.git` remote, not linked to
user repos). Some of these accumulate automated snapshots under
`runtime-backups/`. The worktrees are not active sessions (no entry in
`~/.codex/.codex-global-state.json` under `sessions[].workspace_path`).

## Solution

Delete abandoned worktrees and their `runtime-backups`:

```bash
# Identify large worktrees
du -sh ~/.codex/worktrees/* | sort -rh | head -20

# Check if worktree is active (has a session pointing to it)
node -e "
const fs = require('fs');
const state = JSON.parse(fs.readFileSync(process.env.HOME + '/.codex/.codex-global-state.json', 'utf8'));
const active = new Set();
for (const id in state.sessions || {}) {
  const wp = state.sessions[id]?.workspace_path;
  if (wp) active.add(wp);
}
console.log('Active worktrees:', [...active]);
"

# Delete runtime-backups (safe — snapshots of runtime state)
rm -rf ~/.codex/worktrees/<hash>/.hub/runtime-backups

# Delete empty/abandoned worktrees
rm -rf ~/.codex/worktrees/*
```

On 2026-06-22 this reclaimed ~5.6G total (4.6G from runtime-backups + 1.2G from
other abandoned worktrees).

## Prevention

Monitor `~/.codex/worktrees/` growth. The `runtime-backups` pattern is specific
to the `pi` runtime. If this repeats, consider adding a cron or periodic cleanup
for `~/.codex/worktrees/*/.hub/runtime-backups/` directories older than N days.

## Related

[[codex-source-cleanup-after-tombstone]]
