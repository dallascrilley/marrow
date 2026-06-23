---
date: 2026-06-15
origin: direct brief — review of extracted project learnings from live Cursor fixtures showed markdown artifacts leaking into decision and workflow learning statements
td_epic: td-f24ad9
---

# Harden markdown sanitization in project-learning extraction

**Summary:** Close the gaps left by the markdown-compression carve-out so that decision and workflow learning statements are also free of raw markdown tables, bold emphasis, bullet wrappers, and prompt-instruction leakage.

## Problem

The markdown-compression rescue (`compressMarkdownHeavySummary`) only runs for verified-fix and file-scoped pattern candidates. Reviewing the full live-regression corpus after the rescue shows that other candidate paths still emit noisy statements:

| Session | Kind | Statement issue |
|---|---|---|
| `9c6686c3-…` | `decision` | Markdown table leaked into statement: `…fresh branches from main** is usually better than rebasing. ## Rebase vs cherry-pick vs fresh start \| Approach \| …` |
| `faa99040-…-subagent` | `decision` | Bold wrapper left intact: `**Verdict: Approved** The spec is internally consistent: …` |
| `faa99040-…-subagent` | `workflow` | Prompt instruction repeated as subject: `When working on Re-read and review ONLY this file (updated after first review):, inspect …` |
| `2dc7df27-…` | `workflow` | Summary `What Worked` is empty even though a concrete command workflow was extracted. |

Additionally, the rescued verified-fix statements still include trailing markdown fragments if the compressor's action clause is not cleaned, and the `prompt-sanitize.ts` layer does not yet strip common assistant framing tokens from learning statements.

## Requirements

- **R1.** Strip markdown structure (tables, bullets, headings, bold/italic emphasis, code-block fences) from all project-learning candidate statements before persistence.
- **R2.** Strip assistant framing tokens (`Verified:`, `Done —`, `Good —`, `Summary of changes:`, `**Verdict:**`, `When working on …:`) from candidate statements.
- **R3.** Treat prompt instructions masquerading as workflow subjects (`Re-read and review ONLY this file …`) as low-signal / non-actionable and do not create workflow learnings from them.
- **R4.** Keep concrete verified-fix and file-scoped pattern rescues working; do not regress the `d2d8b0e7` markdown-heavy concrete fix.
- **R5.** Extend, don't duplicate: centralize sanitization helpers in `prompt-sanitize.ts` and call them from `finalizeProjectLearningCandidate` so every candidate path benefits.

## Key technical decisions

- **One shared sanitizer per candidate.** Add `sanitizeLearningStatement(value)` in `prompt-sanitize.ts` that removes markdown syntax, assistant framing, and collapses whitespace. Call it in `finalizeProjectLearningCandidate` after all candidate construction, so every `kind` gets the same cleanup without touching per-path logic.
- **Markdown table stripping is structural, not just regex cosmetic.** Tables contain pipe characters and heading separators; a dedicated `stripMarkdownTable(value)` helper truncates at the first table separator line (`|---|---|`) and removes trailing row fragments.
- **Prompt-instruction rejection belongs upstream.** The `workflow` candidate in `faa99040` is produced by the existing command/file fallback. Add a predicate `looksLikePromptInstruction(value)` in `extract.ts` and drop workflow candidates whose statement is derived from a prompt line rather than an actual command outcome.
- **Evidence stays raw; only the statement is sanitized.** This preserves traceability while making the durable statement readable.
- **Keep summaries separate.** This plan only changes learning statements; summary markdown remains untouched so downstream readers still see full context.

## Implementation units

### U1. Add shared learning-statement sanitizer
- **Goal:** Every finalized project-learning statement is free of markdown syntax and assistant framing.
- **Requirements:** R1, R2, R5
- **Files:** `src/pipeline/prompt-sanitize.ts`, `test/prompt-sanitize.test.mjs`
- **Approach:**
  1. Add `sanitizeLearningStatement(value: string): string` in `prompt-sanitize.ts`.
  2. Implement or reuse helpers:
     - `stripMarkdownEmphasis` — remove `**`, `__`, `*`, `_` wrappers.
     - `stripMarkdownTable` — truncate at the first table separator line and remove trailing row lines.
     - `stripMarkdownHeadings` — remove leading `#` tokens and trailing heading markers.
     - `stripAssistantFraming` — remove prefixes `Verified:`, `Done —`, `Good —`, `Summary of changes:`, `Summary of what changed:`, `**Verdict:**`.
     - `collapseWhitespace` — collapse multiple spaces/newlines into a single space.
  3. Apply in order: strip blocks → strip tables → strip headings → strip emphasis → strip framing → collapse whitespace → trim trailing punctuation.
- **Tests:** Each helper has targeted unit tests; full sanitizer tests cover the bad statements from `9c6686c3` and `faa99040`.
- **Verification:** `npm test` passes.

### U2. Wire sanitizer into all candidate finalization
- **Goal:** No project-learning statement reaches persistence without passing through the sanitizer.
- **Requirements:** R1, R2, R5
- **Files:** `src/pipeline/extract.ts`, `test/extract-project-learnings.test.mjs`
- **Approach:**
  1. Import `sanitizeLearningStatement` into `extract.ts`.
  2. Call it in `finalizeProjectLearningCandidate` on `candidate.statement` before returning.
  3. Ensure the sanitizer is applied before the raw-dump guard `looksLikeRawKnowledgeDump` runs, so sanitized markdown-heavy statements are re-evaluated and may pass.
- **Tests:** Add regression tests using exact noisy strings from the corpus; assert they come out as single clean sentences.
- **Verification:** Re-run live-regression corpus ingest and inspect learning statements.

### U3. Reject prompt-instruction workflow candidates
- **Goal:** Workflow learnings do not use the original prompt text as their subject.
- **Requirements:** R3, R4
- **Files:** `src/pipeline/extract.ts`, `test/extract-project-learnings.test.mjs`
- **Approach:**
  1. Add `looksLikePromptInstruction(value: string): boolean` that matches patterns like `Re-read and review ONLY this file`, `When working on`, `Update ONLY`, `Review ONLY`.
  2. In `toProjectTurnCandidates`, when creating a workflow candidate from a command/file fallback, drop the candidate if its sanitized statement matches the predicate.
  3. Do not apply this predicate to verified-fix or decision candidates; only workflow subjects derived from prompt text.
- **Tests:** A synthetic turn with a command and a prompt-instruction summary yields no workflow learning.
- **Verification:** `faa99040` no longer emits the malformed workflow learning.

### U4. Improve workflow summary signals
- **Goal:** When a concrete workflow learning is extracted, the summary reflects what worked.
- **Requirements:** R2 (related)
- **Files:** `src/pipeline/summarize.ts`, `test/summarize.test.mjs`
- **Approach:**
  1. When the concrete-turn fallback produces workflow candidates, ensure the summary's `What Worked` line includes the command/file signal.
  2. This is a small polish; if the summary code already emits the command under `Useful Commands`, leave `What Worked` empty only when no actual outcome occurred.
- **Tests:** A session with a concrete setup command has non-empty `What Worked` or `Useful Commands`.
- **Verification:** `2dc7df27` summary shows either a worked item or the command is already in `Useful Commands`.

### U5. Update markdown-compression ADR
- **Goal:** Document the broader sanitization policy and why decision/workflow candidates needed it too.
- **Requirements:** R5
- **Files:** `docs/decisions/0009-project-learning-quality-gates.md`
- **Approach:**
  1. Extend the decision section to note that `sanitizeLearningStatement` is applied universally.
  2. Add a consequence: markdown artifacts in decision/workflow statements are also stripped.
  3. Add a consequence: prompt-instruction text is not promoted to a workflow learning.
- **Tests:** N/A.
- **Verification:** ADR review.

### U6. Re-run corpus verification and compare
- **Goal:** Confirm the sanitization improvements do not regress good learnings and clean the bad ones.
- **Requirements:** R1–R4
- **Files:** `test/integration/live-quality-regression.test.mjs`, runtime reports
- **Approach:**
  1. Re-run the full live-regression corpus ingest.
  2. Assert all previously ready sessions stay ready.
  3. Inspect the statements for `9c6686c3`, `faa99040`, and `d2d8b0e7`:
     - `9c6686c3` decision should be a single clean sentence without tables.
     - `faa99040` decision should have no `**` wrappers.
     - `faa99040` should not emit the prompt-instruction workflow.
     - `d2d8b0e7` verified-fix should still be present and clean.
  4. Run `script/cibuild`.
- **Tests:** Update live-regression test to assert statement cleanliness for the known noisy sessions.
- **Verification:** `script/cibuild` passes.

## Worktree & concurrency

- **worktree_slug:** feat/harden-markdown-sanitization
- **spine_owner:** self
- **Pre-flight:** `scripts/worktree-posture.sh --claim feat/harden-markdown-sanitization --surfaces "src/pipeline/prompt-sanitize.ts,src/pipeline/extract.ts,src/pipeline/summarize.ts,docs/decisions/0009-project-learning-quality-gates.md,test/extract-project-learnings.test.mjs,test/prompt-sanitize.test.mjs,test/summarize.test.mjs,test/integration/live-quality-regression.test.mjs"`
- **Active conflicts:** none

### Write surfaces (exclusive per parallel track)

- U1: `src/pipeline/prompt-sanitize.ts`, `test/prompt-sanitize.test.mjs`
- U2: `src/pipeline/extract.ts`, `test/extract-project-learnings.test.mjs`
- U3: `src/pipeline/extract.ts`, `test/extract-project-learnings.test.mjs`
- U4: `src/pipeline/summarize.ts`, `test/summarize.test.mjs`
- U5: `docs/decisions/0009-project-learning-quality-gates.md`
- U6: `test/integration/live-quality-regression.test.mjs`, runtime reports

## Prior learnings applied

- `docs/decisions/0009-project-learning-quality-gates.md` — the markdown-compression carve-out intentionally targeted only fix/verification candidates; this plan extends the same protective cleanup to decision and workflow candidates.
- `docs/plans/2026-06-15-refactor-session-artifact-quality-plan.md` — U2 and U3 of this plan directly support the broader epic goal (R2: strip assistant framing, R3: atomic concise statements) without duplicating the cap/atomicity work already planned there.

## Deferred / out of scope

- Summary markdown polishing beyond the one `What Worked` signal fix in U4.
- LLM rewriting of statements; this plan is purely deterministic.
- Per-kind sanitizer differences; one universal sanitizer is preferred.

## Open questions

- Should the sanitizer also strip inline code backticks from statements? Keep them for now — `npm test` and `import psycopg.rows` are more readable with backticks — but flag if they create downstream indexing noise.
- Does stripping markdown tables ever remove useful tabular decision rationale? If so, future work could preserve tables in evidence while keeping statements atomic.
