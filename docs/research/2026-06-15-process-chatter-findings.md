# process_chatter diagnosis

**Date:** 2026-06-15
**Task:** td-7907e6 / U1. Diagnose process_chatter false positives

## Method

1. Ran `node dist/cli.js quality audit` against the live runtime.
2. Filtered sessions flagged with `process_chatter`.
3. Read each session's `summary.json` and located the text matching the audit regex.
4. Classified matches by source harness.

## Baseline

- `process_chatter` sessions: 1,330
- Matches inspected: 1,192 (remaining 138 likely matched a different field or had unreadable summaries)
- Distribution:
  - claude-code: 352
  - codex-cli: 236
  - cursor: 241
  - kimi: 338
  - pi: 25

## Where matches occur

- **Topic only:** 11
- **Summary body only:** 1,177
- **Both topic and body:** 4

The vast majority of triggers are in the summary body (`what_worked`, `what_failed`, `what_was_decided`, `next_step`, `project_learnings`, `user_learnings`).

## Representative false-positive patterns

### "Let me ..." followed by concrete outcome

> "Let me check what toast infrastructure is available: Now I understand what the `desktop-polish` task entails."

The phrase is process language, but the rest of the summary contains durable signal. A blanket regex flags the whole session.

### "Checking ..." with verification evidence

> "ProductionView and MainWindow tests pass. PreProductionView still has 9 failing tests (store persistence and timeouts). Checking whether we can quickly stabilize the two previous..."

The session has concrete outcomes; the gerund is assistant narration embedded in a durable summary.

### Codex / Kimi first-person planning

> "I've loaded plan/contracts and verified the repo ignore setup is already present for this Go/Bash project. Next step is task execution: I'm checking current code and docs coverage."

Codex CLI and Kimi transcripts frequently include assistant first-person narration in their event summaries.

## Root cause

`src/pipeline/quality-audit.ts` uses a simple regex to detect process chatter:

```js
/\b(?:let me|i(?:'|')ll|i need to|checking|exploring)\b/i
```

This regex:

- Does not require the match to dominate the summary.
- Does not distinguish between user intent (topic) and assistant narration (body).
- Is weaker than the upstream `looksLikeProcessNarration` / `isProcessText` helpers already used in `src/pipeline/extract.ts`.

## Recommendation for U2

Replace the audit-level regex with a tuned detector that:

1. Penalizes only when process phrases appear at the start of summary lines or dominate the line.
2. Excludes lines that also contain concrete outcomes (fixes, decisions, files, commands).
3. Reuses existing process-narration vocabulary from `extract.ts` where possible.

Target: reduce `process_chatter` by at least 10% without reclassifying genuine process-only sessions as clean.
