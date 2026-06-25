---
date: 2026-06-16
origin: direct brief — fixture ingest and quality audit still report no_files_of_interest even when the session contains concrete path evidence
td_epic: td-9f950e
---

# Fix files_of_interest extraction and ranking

**Summary:** Close the remaining ingest-quality gap where summaries under-report touched files and `quality audit` raises `no_files_of_interest` for otherwise healthy sessions. Keep the fix deterministic and harness-agnostic by reusing existing path normalization and reduced-event/source-ref evidence instead of adding adapter-specific special cases.

## Requirements

- **R1.** Summary generation must emit non-empty `files_of_interest` when the session contains concrete file or directory path evidence in turn data, event payloads, or reduced-event-derived text.
- **R2.** Extracted file paths should prefer project-relative paths when recoverable from absolute workspace-style paths such as `/Users/example/Code/demo/src/...`.
- **R3.** The known Claude fixture session (`session-fixture-0001`) must stop triggering `no_files_of_interest` in `quality audit` without regressing existing ingest artifacts, project learnings, or deletion readiness.
- **R4.** Keep the behavior harness-agnostic; do not add a Claude-only rule when the same normalization can serve codex-cli, pi, kimi, and cursor.

## Key technical decisions

- **Reuse existing path normalization.** `extract.ts` already normalizes absolute `/Code/<repo>/...` paths into project-relative paths in `normalizeFilePath`; summary generation should either share that logic or adopt the same rules, not invent a second normalization path.
- **Broaden summary evidence sources before changing adapters.** The defect is downstream: `summarize.ts` only reads `turn.files_touched` plus `command_strings` that already look like source paths, while the session still produces a promoted decision containing `/Users/example/Code/demo/src`. Fix summary/ranking and reduced-event evidence first; adapter-specific changes are deferred unless the broader fix proves insufficient.
- **Use audit as the acceptance oracle.** `quality-audit.ts` already defines the operator-visible failure (`no_files_of_interest`). The fix is done only when the fixture ingest no longer raises that issue.
- **Apply prior quality evidence.** `docs/research/2026-06-15-harness-ingest-quality-review.md` measured 25 `no_files_of_interest` cases in the live baseline, so this is not a one-off fixture quirk; the implementation should improve the general heuristic rather than patching a single session.

## Implementation units

### U1. Expand summary file extraction sources
- **Goal:** `summarize.ts` collects file evidence from more than just `turn.files_touched` and path-shaped `command_strings`, while preserving existing filtering and ranking rules.
- **Requirements:** R1, R2, R4
- **Files:** `src/pipeline/summarize.ts`, `test/summarize.test.mjs`
- **Approach:**
  1. Inspect the current `filesOfInterest` pipeline in `summarizeSessionWithTopic` and the event helpers `collectEventFiles`, `isUsefulFilePath`, and `looksLikeSourcePath`.
  2. Add additional file-evidence sources that already exist in reduced events or summaries, such as dedicated payload arrays and summary text path extraction, while keeping the result set deduped and capped.
  3. Normalize absolute workspace-style paths using the same `/Code/<repo>/...` stripping behavior already used in `extract.ts` so summaries prefer project-relative output.
  4. Keep the filter conservative: workspace roots or generic repo directories are not files of interest unless they point to a concrete subpath worth surfacing.
- **Tests:** Add regression cases for absolute `/Users/example/Code/demo/src/...` paths, project-relative paths, and non-file workspace-root noise.
- **Verification:** `npm run build && node --test test/summarize.test.mjs`

### U2. Reuse reduced-event/source-ref path evidence
- **Goal:** When path signal exists in reduced-event provenance or derived text but not in `command_strings`, the ingest pipeline still preserves enough evidence for summary file extraction.
- **Requirements:** R1, R2, R4
- **Files:** `src/pipeline/extract.ts`, `src/pipeline/summarize.ts`, relevant focused tests (`test/extract-project-learnings.test.mjs`, `test/summarize.test.mjs`, and/or ingest integration coverage)
- **Approach:**
  1. Compare `extract.ts` `usefulFilesForTurn` / `normalizeFilePath` with `summarize.ts` file extraction to identify the missing evidence path.
  2. If summary can safely reuse extract’s normalization directly, factor a shared helper in the pipeline layer; otherwise mirror the same logic exactly and document why the duplication remains.
  3. If promoted decision or reduced event text is the only surviving carrier of a path, add a narrow text-path extractor that pulls concrete project paths without treating arbitrary prose as files.
  4. Preserve harness-agnostic behavior and avoid modifying adapter classifiers unless the missing path never reaches reduced events.
- **Tests:** Add regression coverage for the current failing evidence shape: path survives in promoted decision / event summary text but `files_of_interest` was previously empty.
- **Verification:** `npm run build && node --test test/extract-project-learnings.test.mjs test/summarize.test.mjs`

### U3. Prove audit improvement on fixture ingest
- **Goal:** The end-to-end fixture ingest and audit path no longer reports `no_files_of_interest` for `session-fixture-0001`.
- **Requirements:** R2, R3
- **Files:** `test/integration/claude-code-ingest.test.mjs`, `test/quality-audit.test.mjs`, optionally `test/integration/live-quality-regression.test.mjs`
- **Approach:**
  1. Extend the Claude fixture ingest assertion to verify `summary.files_of_interest` is populated and project-relative.
  2. Add or extend a quality-audit regression so a ready session with concrete file evidence is not flagged `no_files_of_interest`.
  3. Re-run the isolated ingest + audit scenario used in the manual review to confirm the operator-facing issue is gone while deletion readiness and learning persistence stay intact.
- **Tests:** Focused integration tests for fixture ingest plus the relevant audit regression.
- **Verification:** `npm run build && node --test test/integration/claude-code-ingest.test.mjs test/quality-audit.test.mjs` and `script/cibuild`

## Worktree & concurrency

- **worktree_slug:** `fix/files-of-interest-extraction-ranking`
- **spine_owner:** self
- **Pre-flight:** `scripts/worktree-posture.sh --claim fix/files-of-interest-extraction-ranking --surfaces "src/pipeline/summarize.ts,src/pipeline/extract.ts,test/summarize.test.mjs,test/extract-project-learnings.test.mjs,test/integration/claude-code-ingest.test.mjs,test/quality-audit.test.mjs"`
- **Active conflicts:** `scripts/worktree-posture.sh` and `.agents-state/worktrees.json` are absent in this repo. Current td session is on branch `test/harness-ingest-quality-review`, so execution should use a fresh worktree/branch for this plan rather than reusing the current branch.

### Write surfaces (exclusive per parallel track)

- U1: `src/pipeline/summarize.ts`, `test/summarize.test.mjs`
- U2: `src/pipeline/extract.ts`, `src/pipeline/summarize.ts`, `test/extract-project-learnings.test.mjs`, `test/summarize.test.mjs`
- U3: `test/integration/claude-code-ingest.test.mjs`, `test/quality-audit.test.mjs`, optional `test/integration/live-quality-regression.test.mjs`

## Prior learnings applied

- `docs/research/2026-06-15-harness-ingest-quality-review.md` — `no_files_of_interest` already affects 25 audited sessions, so the fix must generalize beyond the single Claude fixture.
- `docs/research/2026-06-15-no-project-learnings-findings.md` — upstream reducers can miss event-derived signal even when turn-level data is concrete; treat missing file signal as a reduction/summarization evidence issue first, not just an audit display bug.
- `docs/plans/2026-06-15-harden-markdown-sanitization-in-learning-extraction-plan.md` — follow the existing plan style: one normalization path, targeted regression cases, and end-to-end live/fixture verification instead of ad hoc patching.

## Deferred / out of scope

- Adapter-specific classifier changes unless the path evidence is proven missing before reduction.
- Broader summary-topic or command-extraction changes.
- LLM-based repair of weak summaries.
- Vault export or MCP instinct path behavior.

## Open questions

- Does the best general fix live in shared path-normalization helpers between `extract.ts` and `summarize.ts`, or is a narrow summary-only reuse enough? Resolve during implementation based on the smallest maintainable diff.
- Should directory-only paths like `src/` count as files of interest, or should the summary require concrete file leaves? The fixture evidence references `.../src`; implementation should follow existing audit intent and tests should make the policy explicit.
