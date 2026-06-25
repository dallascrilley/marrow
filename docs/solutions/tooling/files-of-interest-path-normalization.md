# Files-of-interest path normalization across extract and summarize

## Problem

`files_of_interest` drifted from project-learning extraction because `src/pipeline/summarize.ts` and `src/pipeline/extract.ts` used different path-evidence rules. Summary generation only trusted `turn.files_touched` and `command_strings` that already looked like file paths, so fixture sessions with absolute workspace paths in event payloads or decision text produced `files_of_interest: []` and tripped `quality audit` with `no_files_of_interest`.

## What worked

- Move shared path cleanup into one helper: `src/pipeline/file-paths.ts`.
- Reuse the same `normalizeFilePath()` logic in both `extract.ts` and `summarize.ts` so absolute `/Users/.../Code/<repo>/...` paths collapse to project-relative paths consistently.
- Let summary extraction read path evidence from `command_strings`, `files_touched`, `file_paths`, `paths`, and narrow text-path extraction from event summaries.
- Keep the directory-path allowance conservative in `summarize.ts`: allow repo-relative directories like `src`, `app`, `lib`, `docs`, `test`, `tests`, and `scripts`, but still reject workspace roots and noisy tool/runtime strings.

## Why it matters

If extract and summarize normalize paths differently, the pipeline can promote a valid project learning while the operator-facing summary and quality audit still claim there were no touched files. That erodes trust in deletion readiness and quality reports.

## How to apply

When adding new path evidence sources, update both learning extraction and summary synthesis through the shared helper instead of adding ad hoc regexes in one layer. Verify with:

- `test/summarize.test.mjs`
- `test/extract-project-learnings.test.mjs`
- `test/integration/claude-code-ingest.test.mjs`
- `test/quality-audit.test.mjs`
- manual fixture ingest + `quality audit`
