# Project Learning Extraction Improvement Plan

**Goal:** Improve project-level learning extraction so more compressible sessions produce durable, useful project knowledge and become eligible for deletion when the provenance artifacts are complete.

**Current evidence:** The latest deterministic audit over an isolated 25-session Cursor sample was stable across reruns:

- `25` sessions audited
- `13` deletion-ready
- `12` blocked
- `18` sessions with at least one quality issue
- top issues:
  - `no_project_learnings=10`
  - `no_useful_commands=7`
  - `no_files_of_interest=6`
  - `summary_low_signal=3`
  - `process_chatter=1`

**Primary weakness:** `src/pipeline/extract.ts` currently promotes only explicit decisions, failures, explicit verification commands, and `**Done:** ... **Verified:** ...` completion summaries. Real sessions often contain useful project knowledge as verified fixes, error resolutions, test/runtime improvements, repo workflow actions, and file-scoped implementation outcomes without matching that exact final-completion pattern.

**Non-goals for this deterministic extraction slice:**

- Do not replace deterministic extraction with an LLM extraction stage.
- Do not relax deletion readiness without evidence-backed learnings.
- Do not promote generic user preferences into project scope.
- Do not create new schema tables unless deterministic JSONL artifacts cannot express the result.

**Later extension:** An OpenRouter LLM memory-lint sidecar now reviews deterministic project-learning candidates and applies durable keep/rewrite verdicts into `knowledge/projects-reviewed/` without mutating `knowledge/projects/`.

## Desired Outcome

After implementation:

- The same 25-session audit should reduce `no_project_learnings` materially.
- Newly promoted project learnings should be grounded in source refs, evidence text, and file/command context where available.
- False positives should remain low; a session with only vague discussion should still stay blocked.
- `asd quality audit` should make before/after comparison easy for this extraction slice.

Target for this slice:

- Reduce `no_project_learnings` from `10/25` to `<=6/25` on the same sample, without increasing `process_chatter` or wrapper-tag issues.
- Keep all existing tests passing.
- Add fixture coverage for at least three currently blocked `no_project_learnings` session shapes.

## Extraction Categories To Add

### 1. Verified Fix Learning

Promote when:

- A `fix` event and a `verification` event occur in the same turn, or
- A verification event mentions a concrete implementation outcome, even without the strict `**Done:**` marker.

Candidate statement shape:

```text
Fixed <project-specific target>; verified with <command or evidence>.
```

Evidence requirements:

- `fix` or verification event summary
- same `turn_id`
- optional command evidence from `verification_command`, `command_strings`, or inline command text

Avoid promotion when:

- summary contains process chatter only, such as “let me verify”
- verification is future-tense, such as “I can verify later”
- no concrete target can be extracted

### 2. Error Resolution Learning

Promote when:

- A `failure` event is followed by a `fix` or `verification` event in the same turn or next turn.
- The failure contains a concrete error signal: `ENOENT`, `EACCES`, stack trace language, missing file/module, test failure, build failure, or command failure.

Candidate statement shape:

```text
Resolved <error/failure> by <fix/outcome>.
```

Evidence requirements:

- failure event source ref
- fix or verification event source ref
- confidence `medium` unless explicit command/test evidence exists, then `high`

### 3. Repo Workflow Learning

Promote when:

- A session completes a repo operation that is reusable for this project:
  - worktree setup/pruning
  - example fixture generation
  - test-speed improvement
  - project-specific build/test command selection
  - repo-local script usage

Candidate statement shape:

```text
Use <project-specific workflow/command/path> for <task>.
```

Evidence requirements:

- at least one useful command or file path
- summary topic or event text that names the workflow target

Avoid promotion when:

- the command is generic and not project-specific
- the topic is only a slash command like `/docs/update` with no evidence

### 4. File-Scoped Implementation Learning

Promote when:

- A session has useful files of interest and a verified/fix outcome.
- No broader workflow or error-resolution learning is available.

Candidate statement shape:

```text
Updated <file> for <topic/outcome>.
```

Evidence requirements:

- one or more useful files from summary/event payload
- fix or verification evidence

Avoid promotion when:

- only workspace roots are available
- file path is from attached context but no work happened

## Implementation Tasks

### Task 1: Build a focused blocked-session fixture set

**Files:**

- Modify: `test/fixtures/cursor/live-regression/README.md`
- Possibly add: `test/fixtures/cursor/live-regression/*.jsonl`
- Modify: `test/integration/live-quality-regression.test.mjs`

Steps:

- [ ] Select 3-5 sessions from the latest audit worst list:
  - `2477b32c-27f6-4c56-b81c-75ab3e6938d8`
  - `2dc7df27-6993-4113-9ad0-d27d5e2c2143`
  - `58d2e1f7-50af-4cd5-921c-962c1b061d9d`
  - `9c6686c3-7663-495b-bd35-8e31b5a231df`
  - `d2d8b0e7-3fae-4506-927b-8f80a301ccb0`
- [ ] Copy only the minimal real-session fixtures needed to reproduce the learning gap.
- [ ] Add assertions that these sessions currently hit `no_project_learnings`.
- [ ] Record baseline audit output in test comments or fixture README.

Verification:

```bash
npm test
AGENT_SESSION_DISTILLERY_ROOT=/tmp/asd-learning-baseline node dist/cli.js ingest backfill --source cursor --limit 25
AGENT_SESSION_DISTILLERY_ROOT=/tmp/asd-learning-baseline node dist/cli.js quality audit --limit 25
```

### Task 2: Refactor extraction around candidate objects

**Files:**

- Modify: `src/pipeline/extract.ts`
- Add: `test/extract-project-learnings.test.mjs`

Steps:

- [ ] Introduce an internal `ProjectLearningCandidate` type with:
  - `kind`
  - `statement`
  - `title`
  - `confidence`
  - `evidence`
  - `sourceRefs`
  - `promotionBasis`
  - `dedupeKey`
- [ ] Convert existing decision/failure/verification/completion promotion into candidate producers.
- [ ] Keep output schema unchanged by converting candidates through existing `learningSchema`.
- [ ] Preserve current behavior before adding broader rules.

Verification:

```bash
node --test test/extract.test.mjs test/extract-project-learnings.test.mjs
```

### Task 3: Add verified fix and error-resolution promotion

**Files:**

- Modify: `src/pipeline/extract.ts`
- Modify: `test/extract-project-learnings.test.mjs`

Steps:

- [ ] Group events by turn.
- [ ] Promote same-turn `fix + verification` into `workflow` or `pattern` learnings.
- [ ] Promote `failure + fix` or `failure + verification` into `failure_mode` learnings.
- [ ] Extract command evidence from:
  - `verification_command`
  - `command_strings`
  - inline backticked executable commands
- [ ] Reject future-tense or process-only verification text.

Verification:

```bash
node --test test/extract.test.mjs test/extract-project-learnings.test.mjs test/reducers.test.mjs
```

### Task 4: Add workflow and file-scoped fallback promotion

**Files:**

- Modify: `src/pipeline/extract.ts`
- Modify: `src/pipeline/summarize.ts` only if needed for reusable helpers
- Modify: `test/extract-project-learnings.test.mjs`

Steps:

- [ ] Use turn topic/prompt, useful commands, and files touched to identify repo workflow learnings.
- [ ] Promote file-scoped implementation learning only when there is fix/verification evidence.
- [ ] Downrank generic slash-command topics unless supported by file/command evidence.
- [ ] Keep fallback confidence at `medium`.

Verification:

```bash
node --test test/extract-project-learnings.test.mjs test/summarize.test.mjs
```

### Task 5: Extend quality audit before/after reporting

**Status:** Partially implemented. `quality audit` reports project-learning distribution metrics. Reviewed-learning metrics are the next active edge and should account for `knowledge/projects-reviewed/` once finalization/promotion exists.

**Files:**

- Modify: `src/pipeline/quality-audit.ts`
- Modify: `src/commands/quality-audit.ts`
- Modify: `test/quality-audit.test.mjs`
- Modify: `README.md`
Steps:

- [ ] Add optional `--jsonl` or `--issues no_project_learnings` filter only if needed for inspection.
- [ ] Add per-session learning artifact state already present today to the worst-session report in README examples.
- [ ] Add a concise `recommendations` block to audit output:
  - top issue
  - suggested next extraction category
  - affected session count

Verification:

```bash
node --test test/quality-audit.test.mjs test/cli.test.mjs
node dist/cli.js quality audit --limit 25
```

### Task 6: Run real-sample comparison and lock the threshold

**Files:**

- Modify: `test/integration/live-quality-regression.test.mjs`
- Possibly modify: `test/fixtures/cursor/live-regression/README.md`

Steps:

- [ ] Run the same isolated 25-session audit before/after.
- [ ] Assert the fixture corpus improves at least one formerly blocked learning gap.
- [ ] Do not require the full local 25-session threshold in unit tests, because local Cursor data can drift.
- [ ] Record the observed local audit numbers in the PR summary and `td` log.

Verification:

```bash
npm test
AGENT_SESSION_DISTILLERY_ROOT=/tmp/asd-learning-after node dist/cli.js ingest backfill --source cursor --limit 25
AGENT_SESSION_DISTILLERY_ROOT=/tmp/asd-learning-after node dist/cli.js quality audit --limit 25
```

## Acceptance Criteria

- `npm test` passes.
- New tests prove at least:
  - verified fix learning promotion
  - error resolution learning promotion
  - workflow/file-scoped learning promotion
  - process-only text rejection
  - same-turn verified-fix suppression
  - priority-aware semantic deduplication for overlapping candidates
  - OpenRouter review request/response validation
  - gated review apply into `knowledge/projects-reviewed/`
- A real high-count audit shows deterministic project learnings are reduced to a manageable distribution, then LLM review/apply reduces them further into high-precision durable statements.
- No raw completion blocks, conversational scaffold prefixes, markdown-heavy summaries, or transient debug narration should appear in reviewed project learnings.
- No increase in `process_chatter`, `wrapper_tags`, or `completion_as_next_step`.
## Risks

- False positives are worse than false negatives because they pollute project memory and make deletion look safer.
- Some blocked sessions may legitimately have no durable project learning; the correct outcome is to leave them blocked or classify them as compressible-but-no-learning only after an explicit retention policy decision.
- Real local Cursor data can drift; tests should use fixtures for hard assertions and local audits for operator evidence.

## Recommended Execution

Create one focused `td` task:

```bash
td create "Improve project learning extraction" --type task --priority P1 --labels quality,learning,retention
```

Then implement Tasks 1-6 in order. Commit as one logical slice if the diff stays small; split after Task 3 if candidate refactoring becomes large.
