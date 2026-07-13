---
title: Scope lifecycle candidates to the selected ledger row
date: 2026-07-12
category: logic-errors
module: runtime-lifecycle-inventory
tags: [lifecycle, retention, sqlite, source-session-id]
severity: high
---

# Scope lifecycle candidates to the selected ledger row

## Problem
A runtime artifact path is keyed by ASD session ID, but the ledger can hold multiple source rows for that ID when source paths or revisions differ. Looking up a deletion candidate by `session_id` could attach a safe candidate from an older archived row to the current discovered row and incorrectly classify the shared parsed artifact as reclaimable.

## What didn't work
Selecting the last row from `listSourceSessions()` was also unsafe: that query sorts by source transcript `updated_at`, not ledger row recency. An older row with a later transcript timestamp could overwrite the current row in a session-ID map.

## Solution
In `src/read/lifecycle-inventory.ts`, select the current source row per session ID by greatest ledger `id`, matching `getSourceSessionBySessionId`. Index deletion candidates by `source_session_id` and only consult the candidate attached to that selected row. `test/lifecycle-inventory.test.mjs` seeds an older archived row with a later source `updated_at` plus a ready candidate, then verifies the newer discovered row remains required.

## Why it works
The ledger row ID, not transcript metadata timestamps, defines the newest stored source-session identity. Joining candidates on that ID prevents lifecycle state from crossing revisions that happen to share the filesystem session directory.

## Prevention
When aggregating runtime files by session ID, use the same row-selection rule as the ledger reader and preserve joins through `source_session_id`. Add a regression fixture whenever a new read model combines source sessions with deletion candidates.
