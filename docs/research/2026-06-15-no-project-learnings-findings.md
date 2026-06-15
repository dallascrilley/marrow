---
date: 2026-06-15
origin: quality audit follow-up (U3)
td_epic: td-cbc405
---

# Findings: `no_project_learnings` false negatives

## Context

`no_project_learnings` is raised when a session is already a `deletion_candidate`, the summary has useful signal (`what_worked`, `what_failed`, `what_was_decided`, `useful_commands`, `files_of_interest`, or `user_learnings`), but no project-learning artifacts were produced. After the `process_chatter` hardening in U2, the live runtime had:

- **1,906** sessions flagged `no_project_learnings`
  - cursor: 1,128
  - codex-cli: 384
  - claude-code: 127
  - pi: 146
  - kimi: 121

## Methodology

1. Queried the ledger (`/Users/operator/.agent-session-distillery/ledger/sessions.sqlite`) for every `no_project_learnings` session.
2. Loaded each session's `staging/<session_id>/reduced-session.json` and its `summaries/by-session/<session_id>/summary.json`.
3. Re-ran the current `extractLearnings` function against the reduced transcript to see how many sessions would now produce project learnings.
4. Manually inspected representative samples from each root-cause bucket.

## Key findings

### 1. More than a third have no extracted events at all

- **680 / 1,906 (35.7%)** reduced transcripts contain zero events.
- Of those zero-event sessions, **528 have useful commands**, **521 have files touched**, and **389 have both**.

The learning extractor is event-driven, but the upstream reducer often fails to emit events for cursor/codex-cli/pi/kimi transcripts even though the turn-level data contains concrete project signal. Those sessions still get a summary with `what_worked`/`files_of_interest`, so they are flagged `no_project_learnings`, but there is nothing for the extractor to promote.

### 2. A quarter would already promote under current code

- **476 / 1,906 (25.0%)** produced at least one project learning when re-run with the current `extractLearnings` implementation.

This indicates the stored summaries and knowledge artifacts are stale relative to recent extractor improvements. Re-ingestion or a backfill would recover a large chunk of the false negatives without any code change.

### 3. Remaining sessions have events, but filters discard them

The remaining **~750 sessions (≈39%)** have events, yet the extractor rejects every candidate. Manual sampling shows three dominant failure modes:

| Failure mode | Example event summary | Why it is filtered |
|--------------|----------------------|--------------------|
| **Events are completion summaries, not raw fixes** | `decision:medium:**Skills:** using-superpowers (light). **Done** - just check green — 146 tests + pocketops --help.` | `looksLikeNonDurableSummary` / excessive markdown structure / treated as explanation |
| **Failure events describe what was implemented** | `failure:high:## Summary **Primary fix:** matched_caps_json in core/shell/handoff-subscriber.sh used broken jq ...` | `looksLikeCompletionNotFailure` or `looksLikeNonDurableSummary` |
| **Fix events contain process narration** | `fix:medium:Logo fixed. Downstream stale after logo re-run — resuming pipeline.` or `... Let me verify Prisma now treats the migration ...` | `looksLikeProcessNarration` drops the fix event |
| **Verification events lack a command payload** | `verification:medium:Verification noted: ## Verdict: APPROVE Both units meet acceptance criteria...` | No `verification_command` payload and no `**Done:** ... **Verified:**` pattern, so no `verification_rule` learning |

### 4. Per-harness breakdown

| Harness | Total flagged | No events | Produces learnings on re-run |
|---------|--------------|-----------|------------------------------|
| cursor | 1,128 | 313 (27.7%) | 277 (24.6%) |
| codex-cli | 384 | 167 (43.5%) | 132 (34.4%) |
| pi | 146 | 78 (53.4%) | 18 (12.3%) |
| claude-code | 127 | 98 (77.2%) | 3 (2.4%) |
| kimi | 121 | 24 (19.8%) | 46 (38.0%) |

`claude-code` and `pi` are the most event-starved, while `kimi` and `codex-cli` have the highest recovery rate under current extraction.

## Root-cause summary

1. **Event-reducer coverage gaps.** Many non-claude-code transcripts produce turns with commands and files but no `fix`/`failure`/`verification`/`decision` events.
2. **Over-aggressive durability filters.** When events do exist, they are often completion summaries rather than atomic signals, so `looksLikeProcessNarration`, `looksLikeNonDurableSummary`, and `looksLikeCompletionNotFailure` discard them.
3. **Stale artifacts.** Roughly 25% of flagged sessions would now produce learnings, so backfill/re-ingestion alone will recover a meaningful portion.

## Recommendations for U4

1. **Turn-level fallback for no-event sessions.** When no events are present but turns contain project-specific commands/files, derive workflow or pattern learnings from the turn prompt and the strongest command/file pair (e.g., `Use <command> for <task> in <project>`).
2. **Soften filters for concrete completion summaries.** Allow decision/failure events to promote when they contain durable signal such as `fixed`, `implemented`, `resolved`, or explicit file paths, even if they are wrapped in markdown summary structure.
3. **Broaden verification learning extraction.** Derive a verification workflow from any verification event that names a passing command or check, not only from the `verification_command` payload.
4. **Backfill after U2/U4 land.** Re-run ingestion or a summary/knowledge backfill so stored artifacts reflect the improved extraction logic.

## Examples for test fixtures

These real session IDs can be used as regression fixtures (reduced transcripts available in the runtime):

- **No events + turn commands/files:** `af1a25a6-b67e-42e2-a2bf-30b6871586e9` (cursor, code-review follow-ups), `86ccf3bb-0625-419c-b280-a047bbcad2cb` (cursor, merge back to main).
- **Completion summary filtered as decision:** `87948f2f-0568-4b6b-a7b5-471598b947e4` (cursor, `using-superpowers` workflow, tests green).
- **Failure summary filtered as completion:** `dd29ad20-3221-456d-957e-2720ef5e51d2` (cursor, strategy/PR table), `29493955-8067-4b30-bad2-58f0498c3b18` (cursor, handoff-subscriber jq fix).
- **Verification without command payload:** `rollout-2026-05-15T18-13-56-019e2deb-0075-72b2-9a47-d867bd9e52b8` (codex-cli), `79b4d24b-db66-4a8f-b504-b526bd57bab4` (cursor, PR approval verdict).
- **Process narration in fix:** `93c13529-38f5-4450-aa13-25b5d525a089` (cursor, logo fix + downstream resume).
