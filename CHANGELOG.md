# Changelog

All notable changes to `marrow` are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Renamed the project to Marrow.** It was previously called
  `agent-session-distillery` and its CLI was `asd`. The package is now `marrow`,
  the binary is `marrow`, the runtime root moved from `~/.agent-session-distillery`
  to `~/.marrow`, the `AGENT_SESSION_DISTILLERY_ROOT` and
  `AGENT_SESSION_DISTILLERY_STAGING_ROOT` overrides became `MARROW_ROOT` and
  `MARROW_STAGING_ROOT`, and the MCP server registers under the key `marrow`.
  Operational tuning variables are read as `MARROW_*` first with the legacy
  `ASD_*` spellings still honored (`MARROW_VAULT_ROOT`, `MARROW_LLM_MAX_PER`,
  `MARROW_LLM_MAX_USD`, `MARROW_MAX_PROJECT_LEARNINGS`, `MARROW_PYTHON`,
  `MARROW_PI_SESSIONS_ROOT`, and the scheduled-pipeline knobs).

  Two compatibility paths remain so an existing local runtime keeps working:
  the pre-rename environment variables are still read when the new ones are
  unset, and a repository that declares `.asd-project-key` is still honoured
  when no `.marrow-project-key` exists. Persisted record fields keep their
  original names (`asd_session_id`, the `asd.*` telemetry keys); renaming those
  is a data migration rather than a rebrand and is deliberately not part of it.

  Move an existing runtime with `mv ~/.agent-session-distillery ~/.marrow`.

### Fixed

- The installed binary now works. `npm link` and `npm install -g` put a symlink
  on `PATH`, and the entry-point guard compared the resolved module path against
  the unresolved `process.argv[1]`, so every installed invocation fell through
  the guard: `marrow --help` exited 0 and printed nothing. Both sides are
  resolved before comparing, and a test now invokes the CLI through a symlink.
- The workflow mining recency window is anchored to an injectable clock instead
  of reading the wall clock directly, so tests with fixed-date fixtures cannot
  drift out of the window as they age. CI now also runs on a daily schedule to
  catch date-sensitive regressions between commits.

## [1.0.0] - 2026-05-18

First launch-ready release for local Cursor transcript ingestion.

### Capabilities

- Discover local Cursor transcripts from `~/.cursor/projects/<workspace>/agent-transcripts/`
  with workspace-hint based attribution.
- Drive each discovered transcript through `parsed`, `reduced`, `summarized`,
  `extracted`, `archived`, and `deletion_candidate` lifecycle phases.
- Generate `summary.json`, `summary.md`, deterministic project-learning JSONL,
  user-learning JSONL, immutable provenance manifests, and retention receipts.
- Audit summary, learning, and deletion-readiness quality with
  `quality audit`.
- Optional OpenRouter-gated LLM review of deterministic project learnings with
  `quality review-learnings`, idempotent against a content-keyed cache.
- Apply reviewed learnings as a non-mutating `knowledge/projects-reviewed/`
  sidecar with `quality apply-learning-review`.
- Export reviewed memory records for downstream wiki ingestion with
  `memory export-wiki`.
- Single-command local memory-value loop with `npm run memory:pipeline:dry-run`.
- Safe-by-default deletion: `delete apply` is a dry run unless `--apply` is
  passed, and a session is only marked safe to delete when all required
  artifacts exist.

### Out of scope for v1

- Cursor background-agent chats. They are remote-only, so there is no local
  transcript to read.
