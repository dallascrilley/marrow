# 0009. Project learning extraction quality gates

- **Status:** accepted
- **Date:** 2026-06-15

## Context

The harness ingest quality review showed project learnings were sometimes raw transcript or wrapper text: JSON reviewer findings, stack traces, skill docs, and long assistant narratives. These were written before the optional LLM learning review pass had a chance to reject them. We also saw concrete command/file sessions produce zero project learnings when unrelated low-signal events were present.

## Decision
- Add a deterministic `looksLikeRawKnowledgeDump()` guard in `extract.ts` that rejects obvious raw
  dumps: JSON reviewer findings, stack traces, skill docs, and markdown-heavy output that cannot be
  distilled into a concrete file + action.
- Before rejecting a markdown-heavy `fix` or `verification` summary, attempt to compress it with
  `compressMarkdownHeavySummary()`. Compression succeeds only when it finds a project-local file path
  and a concise action clause containing a change verb. The compressed statement is then used for
  verified-fix and file-scoped pattern candidates instead of the raw markdown.
- Add a shared `sanitizeLearningStatement()` helper in `prompt-sanitize.ts` that strips markdown
  tables, headings, emphasis, bullets, fenced code blocks, and common assistant framing tokens
  (`Verified:`, `Done —`, `**Verdict:**`, `Summary of changes:`, etc.) from every project-learning
  candidate statement.
- In `finalizeProjectLearningCandidate()`, apply the structural sanitizer with newlines preserved,
  then run the raw-dump guard on that structurally cleaned text so that multi-line error dumps and
  stack traces are still rejected. After the guard passes, collapse whitespace into a single-line
  statement for persistence.
- Reject workflow candidates whose task text is a prompt instruction (`Re-read and review ONLY this
  file`, `When working on ...`, etc.) so that the original user instruction is not promoted as a
  project workflow.
- Apply the raw-dump guard in both `finalizeProjectLearningCandidate()` and `isDurableCandidate()`
  so future candidate paths cannot bypass it.
- Extend the concrete-turn fallback so it runs whenever no workflow candidate exists and the turns
  have useful commands/files, even if other events are present.
- Expand `summarize.ts` topic rescue heuristics to flag wrapper/context topics and typo-only debug
  topics as low signal, so `--llm-topic` rescue is triggered more reliably without changing
  deterministic default behavior.
- When a concrete-turn fallback produces a workflow learning and no fix/verification events exist,
  include that workflow statement in the session summary's `what_worked` section so the summary
  reflects the concrete signal.

## Consequences
- Obvious raw dumps are rejected before any paid LLM review.
- Markdown-heavy fix/verification summaries that contain a concrete file + action are distilled and
  rescued as workflow or pattern learnings instead of being discarded.
- Decision and workflow project-learning statements are also free of raw markdown tables, headings,
  emphasis, and assistant framing tokens.
- Multi-line error dumps and stack traces remain rejected because the raw-dump guard evaluates the
  structurally cleaned text before whitespace is collapsed.
- Concrete command/file sessions keep producing workflow learnings even when the reduced event stream
  is noisy, and those sessions now show a non-empty `What Worked` summary line.
- Prompt instructions are not promoted to workflow learnings.
- Optional LLM topic rescue catches more wrapper/context topics without affecting default summaries.
