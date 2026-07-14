---
title: path and runtime-root triage before assuming ASD lost a file
date: 2026-07-13
category: tooling
module: cli/runtime
tags: [paths, runtime-root, ENOENT, config, troubleshooting]
applies_when:
  - ASD reports a missing session index, summary, reduced artifact, or runtime file
  - A command appears to read the wrong corpus or an empty runtime
  - A shell snippet uses ~ or relative paths and behavior differs between sessions
related: [docs/solutions/tooling/files-of-interest-path-normalization.md]
---
# path and runtime-root triage before assuming ASD lost a file

## Problem

A large share of recurring ASD failures are not parser bugs. They are path and file-surface mistakes:

- the command is pointed at the wrong runtime because `AGENT_SESSION_DISTILLERY_ROOT` is set
- a helper reads a relative path from a different working directory
- `~` expansion or shell quoting differs between interactive and scripted runs
- the expected artifact does not exist yet because the producing command never ran

These failures usually show up as `ENOENT`, missing index messages, empty report surfaces, or "unknown session" follow-on errors.

## What works

1. Confirm the active runtime root first:

```bash
echo "${AGENT_SESSION_DISTILLERY_ROOT:-$HOME/.agent-session-distillery}"
```

ASD resolves runtime paths through `src/config/paths.ts`:

- default runtime root: `~/.agent-session-distillery`
- override env var: `AGENT_SESSION_DISTILLERY_ROOT`
- canonical subpaths come from `getRuntimePath(...)`

2. Check the exact producer/consumer pair instead of guessing:

```bash
asd export-index
asd search <query>

asd review queue
asd explain <session-id>
```

If `search` reports a missing session index, first confirm the displayed path exists and is readable. Rebuild it with `asd export-index` only when the file is genuinely absent; permission and other filesystem errors need their own fix.

3. When a file should exist under the runtime, inspect the canonical directories, not ad hoc guesses:

```bash
printf '%s\n' "${AGENT_SESSION_DISTILLERY_ROOT:-$HOME/.agent-session-distillery}/index"
printf '%s\n' "${AGENT_SESSION_DISTILLERY_ROOT:-$HOME/.agent-session-distillery}/staging"
printf '%s\n' "${AGENT_SESSION_DISTILLERY_ROOT:-$HOME/.agent-session-distillery}/summaries/by-session"
```

4. Treat `ENOENT` as a branching condition only when the code does.

ASD already has a shared helper for missing filesystem paths in `src/adapters/_common/fs.ts`:

- `pathExists(targetPath)`
- `isMissingPathError(error)`

Reuse those helpers or the same `error.code === "ENOENT"` check instead of swallowing every read failure. Missing file, invalid JSON, and schema drift are different problems.

## Why it works

The runtime layout is centralized in one place (`src/config/paths.ts`), and multiple commands now read through typed readers that expect those exact locations. Most "file missing" reports are really either wrong-root problems or missing producer steps. Checking the runtime root and the producing command first avoids debugging the wrong layer.

## Prevention

- For runtime artifacts, derive paths from `getRuntimePath(...)` or the existing artifact helpers instead of string-building paths in commands.
- For operator checks, verify the active `AGENT_SESSION_DISTILLERY_ROOT` before assuming the corpus is empty or broken.
- When documenting recovery, name the producer command explicitly (`asd export-index`, `asd ingest sync`, `asd quality resummarize --export-index`) so the next session knows how the file is created.

## Quick checks

```bash
# Which runtime am I reading?
echo "${AGENT_SESSION_DISTILLERY_ROOT:-$HOME/.agent-session-distillery}"

# Rebuild the session index when search is empty/missing
asd export-index

# Inspect one stored session's derived state
asd explain <session-id>
```
