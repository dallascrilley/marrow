# Resumed incremental sync must allow stale manifest overwrite

## Problem

`asd ingest sync --resume --source <harness>` reprocesses sessions that already have archived manifests. The archive phase treated existing manifests as immutable, so it failed with:

```
Immutable manifest already exists with different contents
```

This blocked resumed incremental ingests whenever a session's extracted knowledge had changed (e.g., after summary or learning-extraction improvements).

## Root cause

The archive writer refused to overwrite a manifest once it existed, and the ingest backfill command always ran the archive phase for selected sessions. On a resumed sync, many sessions already had archived checkpoints, so the collision was guaranteed.

## Fix

In `src/commands/ingest-backfill.ts`:

1. Look up the existing `archived` phase checkpoint for the session.
2. If `resume` is true **and** the checkpoint is `completed` **and** `source_hash` matches, skip the archive phase entirely.
3. If `resume` is true but the checkpoint is missing or stale (different `source_hash`), pass `allowManifestOverwrite: true` to `runArchivePhase` so the manifest can be regenerated.

This keeps manifests immutable for normal (non-resume) ingests while letting resumed syncs refresh stale artifacts.

## When this applies

- After changing summary, learning-extraction, or archive logic and re-running `ingest sync --resume`.
- When backfilling a harness whose transcripts were previously archived with an older pipeline version.
- Any future harness adapter where the same session may be archived more than once.

## Verification

Run:

```bash
node dist/cli.js ingest sync --resume --source <harness>
```

Expect `failed_count: 0` even when previously archived sessions are selected.

## References

- Fixed in commit `c976504` on `refactor-session-artifact-quality`.
- Plan: `docs/plans/2026-06-15-harness-ingestion-health-sweep-plan.md` (U2).
