# Agent Session Distillery Quality Improvements Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve `agent-session-distillery` output quality on real Cursor sessions so summaries are materially useful, learnings are higher-signal, and deletion readiness reflects durable extraction quality instead of artifact existence alone.

**Architecture:** Keep the existing transcript-first pipeline and SQLite-backed ledger intact, but tighten the semantic path from raw transcript -> parsed record -> reduced event -> summary -> learning -> deletion gate. The work should favor a real-session regression corpus, rule refinement, and more conservative promotion over broad model-based abstraction or large schema churn.

**Tech Stack:** Node.js 22+, TypeScript, built-in `node:sqlite`, built-in `node:test`, real Cursor JSONL fixtures, existing CLI/runtime layout under `src/adapters`, `src/reducers`, `src/pipeline`, and `src/writers`.

---

## Research Context

### Current truth from the live smoke

- Real Cursor transcripts are nested under `agent-transcripts/<session-id>/...`, including `subagents/`, so recursive discovery is required.
- Real Cursor JSONL uses `role` plus nested `message.content[]` blocks, not just flat `type` plus string content.
- The current pipeline now ingests real sessions successfully, but summary quality is still weak:
  - command extraction overcaptures prose and review text
  - failure extraction can mistake attached context blocks for genuine failures
  - some sessions become deletion-ready even when the semantic summary is still noisy
  - other sessions remain blocked because no project/user learnings are extracted, even though the session is likely compressible

### Existing implementation hotspots

- `src/adapters/cursor/parse-transcript.ts` is responsible for flattening real Cursor message blocks into usable text and tool stubs.
- `src/reducers/event-tagging.ts` currently uses regex-first tagging and is too permissive for failure/verification extraction.
- `src/pipeline/summarize.ts` currently derives topic and sections directly from reduced events and raw command/file lists, which preserves noise.
- `src/pipeline/extract.ts` currently promotes project learnings from event summaries and user learnings from prompt lines, but lacks a stronger notion of evidence quality and “compressible but non-learning-rich” sessions.

### Decision outcomes

- Deterministic reduction and real-session regression fixtures are the base quality gate.
- A later slice added an optional OpenRouter memory-lint sidecar for already-extracted project learnings; it reviews deterministic candidates but does not replace deterministic extraction or mutate canonical candidates.
- Do not broaden deletion eligibility until summary and learning quality improve; otherwise the tool will make deletion look safer than it is.
- Treat real-session fixtures and golden summaries as the primary evaluation surface for the next slice.

---

## File Structure

This plan originally improved the project in place; the repository now lives under `/Users/dallascrilley/Code/agent-session-distillery`.

```text
agent-session-distillery/
  src/
    adapters/cursor/
      parse-transcript.ts
    reducers/
      command-extraction.ts
      event-tagging.ts
      payload-pruning.ts
      turn-grouping.ts
    pipeline/
      summarize.ts
      extract.ts
      retention.ts
    writers/
      summary-writer.ts
      knowledge-writer.ts
      manifest-writer.ts
    commands/
      explain.ts
      stats.ts
  test/
    fixtures/
      cursor/
        live-regression/
    integration/
      live-quality-regression.test.mjs
    unit/
      cursor-parse-transcript.test.mjs
      reducers.test.mjs
      summarize.test.mjs
      extract.test.mjs
```

### File responsibilities

- `parse-transcript.ts` should produce high-fidelity intermediate records from real Cursor JSONL, including better separation of assistant prose, user prompts, and tool material.
- `command-extraction.ts` and `event-tagging.ts` should decide what becomes durable signal rather than pass through raw review prose and incidental code-ish text.
- `summarize.ts` should produce human-useful session recaps, not just mirrored event fragments.
- `extract.ts` and `retention.ts` should distinguish:
  - session is compressible
  - session contains durable learnings
  - session is safe to delete
- `test/fixtures/cursor/live-regression/` should hold sanitized real-session samples that reproduce the current quality failures and future regressions.

---

## Task 1: Capture a real-session regression corpus

**Files:**
- Create: `test/fixtures/cursor/live-regression/README.md`
- Create: `test/fixtures/cursor/live-regression/*.jsonl`
- Create: `test/integration/live-quality-regression.test.mjs`
- Modify: `README.md`

- [ ] **Step 1: Select 4-6 representative real sessions from the local smoke run**

Choose sessions that cover:
- one review-heavy session with noisy failure extraction
- one short session with no extracted learnings
- one session that currently becomes deletion-ready
- one session with subagent content

Expected source examples:
- `/Users/dallascrilley/.cursor/projects/.../agent-transcripts/.../*.jsonl`

- [ ] **Step 2: Sanitize and copy those transcripts into a frozen regression corpus**

Preserve:
- structural JSONL shape
- nested `message.content[]`
- tool stubs
- attached file references

Redact:
- private project content not needed for parser/regression behavior
- long pasted payloads that do not change the failure mode

- [ ] **Step 3: Write a regression test that runs the full ingest path on the corpus**

Test assertions should cover:
- nonzero discovered sessions
- nonzero turns for sessions with user prompts
- summary sections are not all “None noted” for the rich cases
- at least one blocked and one ready deletion state are reproduced intentionally

- [ ] **Step 4: Run the regression corpus test before changing extraction logic**

Run:
```bash
node --test test/integration/live-quality-regression.test.mjs
```

Expected:
- PASS after the corpus is wired
- current weak summaries are captured as explicit snapshot failures or targeted assertions

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/cursor/live-regression test/integration/live-quality-regression.test.mjs README.md
git commit -m "test: add real-session quality regression corpus"
```

---

## Task 2: Tighten transcript normalization before reduction

**Files:**
- Modify: `src/adapters/cursor/parse-transcript.ts`
- Modify: `test/cursor-parse-transcript.test.mjs`
- Test: `test/integration/live-quality-regression.test.mjs`

- [ ] **Step 1: Add failing parser assertions for remaining real Cursor variants**

Add cases for:
- mixed `role`/`type` usage
- multi-block `message.content[]` with text + non-text items
- attached file wrapper text that should be preserved but marked as contextual
- subagent transcript variants

- [ ] **Step 2: Separate primary human text from contextual wrapper text**

Implementation target:
- flatten user/assistant text blocks into `messageText`
- mark obvious attachment/context scaffolding in payload fields rather than merging it into the main semantic text when possible

- [ ] **Step 3: Preserve tool and attachment hints without polluting assistant/user prose**

Ensure parsed records carry:
- `messageText` for actual conversation text
- `toolUse` for command/tool metadata
- contextual attachment or selection hints in pruned payload only

- [ ] **Step 4: Verify parser tests and corpus regression**

Run:
```bash
node --test test/cursor-parse-transcript.test.mjs
node --test test/integration/live-quality-regression.test.mjs
```

Expected:
- parser tests PASS
- regression corpus shows cleaner turn text inputs

- [ ] **Step 5: Commit**

```bash
git add src/adapters/cursor/parse-transcript.ts test/cursor-parse-transcript.test.mjs test/integration/live-quality-regression.test.mjs
git commit -m "fix: improve real Cursor transcript normalization"
```

---

## Task 3: Reduce command and file-path noise

**Files:**
- Modify: `src/reducers/command-extraction.ts`
- Modify: `src/reducers/payload-pruning.ts`
- Modify: `src/reducers/turn-grouping.ts`
- Modify: `test/reducers.test.mjs`

- [ ] **Step 1: Write failing reducer tests for command overcapture**

Add assertions proving these should not become durable commands:
- prose mentioning `sqlite3.Cursor`
- explanatory review text with inline code fragments
- broad quoted plan text that is not an executable command

- [ ] **Step 2: Restrict command extraction to higher-confidence surfaces**

Prefer, in order:
- tool-use command input
- short fenced/inline shell commands
- leading-shell-token patterns with bounded token count

Reject or downrank:
- long prose lines
- API/type identifiers
- quoted review bullets

- [ ] **Step 3: Tighten file-path extraction to meaningful touched paths**

Prefer:
- explicit tool/file paths
- path-shaped tokens in user asks and assistant actions

Avoid:
- synthetic file URIs embedded in attached context wrappers when they are not operative

- [ ] **Step 4: Re-run reducer and corpus tests**

Run:
```bash
node --test test/reducers.test.mjs
node --test test/integration/live-quality-regression.test.mjs
```

Expected:
- fewer junk commands in summaries
- files of interest skew toward actual work surfaces

- [ ] **Step 5: Commit**

```bash
git add src/reducers/command-extraction.ts src/reducers/payload-pruning.ts src/reducers/turn-grouping.ts test/reducers.test.mjs
git commit -m "fix: reduce command and path noise in summaries"
```

---

## Task 4: Make event tagging more evidence-driven

**Files:**
- Modify: `src/reducers/event-tagging.ts`
- Modify: `test/reducers.test.mjs`
- Test: `test/integration/live-quality-regression.test.mjs`

- [ ] **Step 1: Add failing tests for false-positive failures and weak verifications**

Examples to encode:
- attached review context should not automatically become `failure`
- “I’m checking X” should not become `verification`
- plan text should not become `decision` without a choice signal

- [ ] **Step 2: Introduce record-kind and evidence gates**

Rules should require combinations such as:
- failure: error-like text plus assistant/tool/result context
- verification: explicit verification command or explicit proof statement
- decision: assistant choice language plus a bounded sentence, not full prompt dump

- [ ] **Step 3: Add negative filters for known noisy wrappers**

Explicitly suppress or lower confidence for:
- `<attached_files>`
- `<code_selection ...>`
- giant quoted review payloads
- boilerplate scaffolding strings

- [ ] **Step 4: Re-run reducers and live corpus**

Run:
```bash
node --test test/reducers.test.mjs
node --test test/integration/live-quality-regression.test.mjs
```

Expected:
- `what_failed` becomes narrower and more truthful
- verification items map to actual proof, not intent chatter

- [ ] **Step 5: Commit**

```bash
git add src/reducers/event-tagging.ts test/reducers.test.mjs test/integration/live-quality-regression.test.mjs
git commit -m "fix: make event tagging more evidence-driven"
```

---

## Task 5: Rewrite summary synthesis around usefulness, not raw event mirroring

**Files:**
- Modify: `src/pipeline/summarize.ts`
- Modify: `src/writers/summary-writer.ts`
- Create: `test/summarize.test.mjs`
- Test: `test/integration/live-quality-regression.test.mjs`

- [ ] **Step 1: Add failing summary tests for the current weak cases**

Assert that:
- topic should not be a giant raw prompt dump
- next step should prefer an actionable resume point
- “what worked” should require verification or successful fix evidence
- “what failed” should exclude pure context blocks

- [ ] **Step 2: Add summary-specific ranking and truncation**

Implement ranking rules such as:
- topic prefers concise user prompt stripped of markup wrappers
- next step prefers latest high-confidence `next_step`, then unresolved failure/fix continuation
- commands/files capped by usefulness and count, not all unique items

- [ ] **Step 3: Add empty-section handling that distinguishes “none” from “unknown”**

Use clearer semantics:
- “No verified wins recorded.”
- “No concrete failure captured.”
- “No explicit next step recorded.”

instead of a generic mirrored fallback everywhere

- [ ] **Step 4: Re-run summary and corpus tests**

Run:
```bash
node --test test/summarize.test.mjs
node --test test/integration/live-quality-regression.test.mjs
```

Expected:
- summaries become shorter, more readable, and closer to operator handoff quality

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/summarize.ts src/writers/summary-writer.ts test/summarize.test.mjs
git commit -m "fix: improve session summary usefulness"
```

---

## Task 6: Refine learning extraction and retention gating

**Files:**
- Modify: `src/pipeline/extract.ts`
- Modify: `src/pipeline/retention.ts`
- Modify: `src/writers/knowledge-writer.ts`
- Create: `test/extract.test.mjs`
- Modify: `test/integration/artifacts.test.mjs`

- [ ] **Step 1: Add failing tests for “compressible but not learning-rich” sessions**

Cover cases where:
- session has a valid summary and manifest
- no durable project/user learning is justified
- deletion should stay blocked or move to a distinct intermediate state by policy

- [ ] **Step 2: Separate “artifact completeness” from “semantic sufficiency”**

Retention should reason about:
- summary exists
- knowledge exists
- summary quality threshold met
- session class supports deletion without learnings, or does not

- [ ] **Step 3: Tighten user-learning promotion**

Require stronger evidence for user-level facts:
- explicit stable preferences
- repeated operator instructions
- cross-session-worthy workflow patterns

Avoid promoting one-off task text from a giant prompt.

- [ ] **Step 4: Add a distinct blocked reason taxonomy**

Examples:
- `no_durable_learnings`
- `summary_low_signal`
- `missing_manifest`
- `missing_receipt`

- [ ] **Step 5: Re-run extraction and artifact tests**

Run:
```bash
node --test test/extract.test.mjs
node --test test/integration/artifacts.test.mjs
node --test test/integration/live-quality-regression.test.mjs
```

Expected:
- blocked sessions explain why more precisely
- ready sessions are backed by stronger semantic evidence

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/extract.ts src/pipeline/retention.ts src/writers/knowledge-writer.ts test/extract.test.mjs test/integration/artifacts.test.mjs
git commit -m "fix: refine learning extraction and retention gating"
```

---

## Task 7: Improve operator diagnostics and acceptance surfaces

**Files:**
- Modify: `src/commands/explain.ts`
- Modify: `src/commands/stats.ts`
- Modify: `README.md`
- Test: `test/integration/live-quality-regression.test.mjs`

- [ ] **Step 1: Extend `explain` to surface quality blockers, not just artifact existence**

Add fields that make debugging obvious:
- learning counts by scope
- summary signal notes
- top retained commands/files/events
- blocked reason taxonomy from retention

- [ ] **Step 2: Extend `stats` with quality-oriented counters**

Add counters such as:
- sessions with zero turns
- sessions with zero learnings
- sessions ready vs blocked by reason
- sessions with noisy-command suppression hits

- [ ] **Step 3: Document the live-smoke workflow for future regression checks**

Add an operator recipe for:
- isolated runtime root
- small recent backfill
- inspecting `stats`, `explain`, and one summary before trusting deletion candidates

- [ ] **Step 4: Re-run CLI proof**

Run:
```bash
AGENT_SESSION_DISTILLERY_ROOT=/tmp/asd-real-smoke node dist/cli.js stats
AGENT_SESSION_DISTILLERY_ROOT=/tmp/asd-real-smoke node dist/cli.js explain <session-id>
```

Expected:
- output clearly distinguishes semantic quality issues from missing files

- [ ] **Step 5: Commit**

```bash
git add src/commands/explain.ts src/commands/stats.ts README.md
git commit -m "feat: improve quality diagnostics for operators"
```

---

## Task 8: Final verification and acceptance run

**Files:**
- No new files expected
- Verify current tree only

- [ ] **Step 1: Run targeted quality test suites**

Run:
```bash
node --test test/cursor-parse-transcript.test.mjs
node --test test/reducers.test.mjs
node --test test/summarize.test.mjs
node --test test/extract.test.mjs
node --test test/integration/artifacts.test.mjs
node --test test/integration/live-quality-regression.test.mjs
```

Expected:
- all PASS

- [ ] **Step 2: Build the CLI**

Run:
```bash
npm run build
```

Expected:
- PASS

- [ ] **Step 3: Re-run isolated live smoke on real Cursor data**

Run:
```bash
rm -rf /tmp/asd-real-smoke
mkdir -p /tmp/asd-real-smoke
AGENT_SESSION_DISTILLERY_ROOT=/tmp/asd-real-smoke node dist/cli.js ingest backfill --source cursor --limit 10
AGENT_SESSION_DISTILLERY_ROOT=/tmp/asd-real-smoke node dist/cli.js stats
```

Expected:
- nonzero discovered and processed counts
- summaries are materially useful for the rich cases
- blocked vs ready deletion states are explainable and consistent

- [ ] **Step 4: Manually inspect at least three sessions**

Inspect:
- one ready session
- one blocked `no_durable_learnings` session
- one blocked `summary_low_signal` or equivalent session if present

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "fix: improve distillery output quality on real sessions"
```

---

## Open Questions To Resolve During Execution

- Should a short but well-summarized session with zero durable learnings ever become deletion-ready, or should zero-learning sessions always remain blocked in v1?
- Should subagent transcripts be summarized as part of the parent session by default, or remain individually ingested but linked?
- Do we want a future optional cheap-model pass only after deterministic quality stabilizes, or do we want to keep v1 strictly deterministic?

---

## Recommended Execution Order

1. Task 1 — capture real-session corpus
2. Task 2 — parser cleanup
3. Task 3 — command/path noise reduction
4. Task 4 — evidence-driven event tagging
5. Task 5 — summary synthesis rewrite
6. Task 6 — extraction and retention refinement
7. Task 7 — operator diagnostics
8. Task 8 — full verification and live smoke
