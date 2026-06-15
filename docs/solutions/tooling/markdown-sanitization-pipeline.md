# Markdown sanitization in project-learning extraction

## Problem

Project learning statements extracted from assistant responses carried raw markdown artifacts: tables, headings, bold emphasis, bullet lists, and assistant framing tokens like `Verified:` or `**Verdict:**`. These leaked into persisted project knowledge and rendered summaries noisy.

A narrower earlier fix only compressed markdown-heavy `fix`/`verification` summaries, leaving `decision` and `workflow` candidates (and their titles) uncleaned.

## Root causes

1. **No universal sanitizer.** Each candidate path formatted its own statement; decision/workflow paths never ran markdown cleanup.
2. **Whitespace collapse before table detection.** `summarizeText()` in `src/reducers/event-tagging.ts` collapsed all whitespace to a single space, turning multi-line markdown tables into inline text before extraction could see the table structure.
3. **Underscore emphasis regex ate identifiers.** A naive `_..._` pattern matched underscores inside file names like `sql_dialect.py`.
4. **Title builder didn't reject residual markdown.** `sanitizeLearningTitle()` reused the raw truncated title body even when it contained unclosed `**` markers.

## Fix

- Added `sanitizeLearningStatement()` in `src/pipeline/prompt-sanitize.ts` that strips tables, headings, emphasis, bullets, fenced code blocks, and framing tokens.
- Wired it into `finalizeProjectLearningCandidate()` so every project-learning statement passes through it.
- Applied it with `preserveNewlines: true` for the raw-dump guard, then collapsed whitespace only after the guard accepted the candidate. This keeps multi-line stack traces and error dumps rejected.
- Changed `summarizeText()` to preserve single newlines (`\n{3,}` → `\n\n`, horizontal whitespace collapsed) so table-detection can see table rows.
- Made the single-emphasis regexes use word-boundary negative lookaround so underscores inside identifiers are preserved.
- Hardened `sanitizeLearningTitle()` to detect residual `**`, `|`, and `## ` markers and fall back to the clean statement body.
- Added `looksLikePromptInstruction()` to reject workflow candidates derived from prompt instructions like "Re-read and review ONLY this file".

## Verification

- `script/cibuild` passes: 302 tests, 0 failures, lint clean.
- Full live-regression corpus ingest shows clean statements for `9c6686c3`, `faa99040`, `6e8197bb`, and `d2d8b0e7`.

## Prevention

Any new candidate path in `extract.ts` should produce its statement and rely on `finalizeProjectLearningCandidate()` for sanitization; do not add per-path cleanup. When changing event summarization, preserve line breaks until downstream sanitization runs.
