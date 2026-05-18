---
date: 2026-05-18
status: design-only
authors: dallascrilley
related:
  - docs/wiki-memory-export-contract.md
  - docs/research/background-agent-source-strategy.md
  - docs/plans/2026-05-18-vault-push-integration.md
  - LAUNCH_CRITERIA.md
launch_criteria_gates_proposed:
  - adapter-base-contract
  - claude-code-adapter-source-research
  - claude-code-adapter
  - codex-cli-adapter-source-research
  - codex-cli-adapter
  - pi-adapter-source-research
  - pi-adapter
---

# Multi-adapter expansion: Claude Code, Codex CLI, Pi

Add Claude Code, Codex CLI, and Pi (Zosma `pi`) transcript adapters alongside
the existing Cursor adapter under `src/adapters/cursor/`.

This is a design pass only. No TypeScript is changed in this round. The Cursor
adapter is the reference implementation and is preserved exactly as-is.

Companion plan: [vault push integration](2026-05-18-vault-push-integration.md).
The two plans are independent — adapters do not depend on vault push, and vault
push works against today's Cursor-only data without waiting for new adapters.

---

## Open Decisions (resolved before drafting)

| # | Question | Operator answer | Why |
|---|----------|-----------------|-----|
| 1 | Does "Pi" mean a transcript source, a vault integration target, or both? | **Both.** Pi appears here as a third transcript source (`~/.pi/agent/sessions/`). It also appears in the companion vault-push plan as the engine context for `pi-llm-wiki-custom`. | Probe found per-workspace Pi session JSONL on disk; the data is real and worth ingesting independently of whether the vault-push plan ships. |

The vault-push plan resolves its own decisions independently. They do not
affect this plan.

---

## §1 Adapter base contract (extracted from `src/adapters/cursor/`)

The Cursor adapter today is the implicit reference. Reading the seven files
under `src/adapters/cursor/` reveals a four-stage pipeline that every adapter
must implement, plus a per-adapter intermediate type. The contract below
formalises that so a follow-up agent can scaffold a new adapter without
re-reading the Cursor code.

### Pipeline stages

| Stage | Cursor file | Purpose | Generic shape |
|---|---|---|---|
| **Discover** | `discover.ts` | Walk the on-disk source root, return transcript file paths plus optional support-database paths. Compute `sourceHash` (sha256) and `modifiedAt` per transcript. | `discover<Source>Inputs(opts) → { transcripts: SourceTranscriptDiscovery[]; supportDatabases?: ... }` |
| **Parse-transcript** | `parse-transcript.ts` | Stream the transcript line-by-line, classify each record into one of `user_message` \| `assistant_message` \| `tool_use_stub` \| `tool_result_stub` \| `event`. Extract `messageText`, `commandStrings`, `filePaths`, `timestampHint`, `toolUse` stub, and `provenance: { sourcePath, sourceHash, lineNumber }`. | `parse<Source>Transcript({ sourcePath, sourceHash }) → { records: <Source>TranscriptRecord[] }` |
| **Enrich** (optional) | `enrich-state-db.ts`, `enrich-tracking-db.ts`, `sqlite-enrichment.ts` | Read auxiliary stores (SQLite KV, JSON, etc.) read-only and emit attribution hints — workspace path, conversation/session ids, request ids. | `enrich<Source><Kind>({ databasePath }) → <Source><Kind>Enrichment \| null` |
| **Workspace-map** | `workspace-map.ts` | Map a transcript path to `{ projectKey, workspacePath, workspaceSlug, <source>ProjectPath }`. Pure function of the path plus on-disk hints; never reads the transcript body. | `derive<Source>WorkspaceMapping(transcriptPath, opts) → <Source>WorkspaceMapping` |
| **Intermediate type** | `intermediate.ts` | Declares the per-source `TranscriptRecord`, `ToolUseStub`, and enrichment shapes that the rest of the pipeline (`src/pipeline/`) consumes. | One file per adapter; re-exports the public types only. |

The downstream pipeline (`src/pipeline/parse.ts`, `reduce.ts`, `summarize.ts`,
`extract.ts`, `archive.ts`, `retention.ts`) consumes `TranscriptRecord` and
`WorkspaceMapping` and is adapter-agnostic. New adapters do **not** modify
pipeline code; they extend the discriminated union accepted at the parse/reduce
boundary.

### What generalises vs stays Cursor-specific

| Cursor helper | Generalises? | Action |
|---|---|---|
| `cursorTranscriptExtensions = [".jsonl", ".txt"]` | Per-source. | Replace with adapter-owned `<source>TranscriptExtensions`. |
| `hashFileContents` (sha256 of full file) | Yes. | Lift to `src/adapters/_common/hash.ts`. Pure function. |
| `pathExists`, `isMissingPathError` | Yes. | Lift to `src/adapters/_common/fs.ts`. |
| `walkCursorProjects` / `collectTranscriptFiles` | Per-source layout. | Each adapter implements its own walker; pattern stays the same (recursive `readdir`, deterministic sort, skip symlinks, skip non-files). |
| `readCursorKvRowsReadOnly` + `collectAttribution` (SQLite VS Code state-db reader) | Cursor-specific. | Keep under `src/adapters/cursor/`. Pi and Codex are JSON/JSONL only; Claude Code has no enrichment store. |
| `parseJsonLine` + `JsonRecord` type | Yes. | Lift to `src/adapters/_common/jsonl.ts`. Same loop in every adapter. |
| `classifyRecordKind` (regex over `type` / `role`) | **Concept generalises, regex does not.** | Each adapter ships its own classifier table keyed on the source's actual `type` values (Cursor uses `"role": "user"|"assistant"` plus `"tool_use"`; Claude Code uses `"type": "user"|"assistant"|"tool_use"|"attachment"|...`; Codex uses `"type": "session_meta"|"response_item"|...`; Pi uses `"type": "session"|"prompt"|"thinking"|"response"|...`). |
| `extractMessageText` (candidate-path fallback walker) | Yes. | Lift the recursive `extractNormalizedText` + `pickFirstString` helpers; each adapter supplies its own candidate-path list. |
| `extractFilePaths`, `extractCommandStrings` (regex over message/tool text) | Yes. | Lift; the regexes are language/shell-shaped, not Cursor-shaped. |
| `detectRedaction` / `looksRedacted` | Yes. | Lift. |
| `deriveCursorWorkspaceMapping` (slug under `.cursor/projects/<slug>/agent-transcripts/`) | Per-source layout. | Each adapter implements its own; the contract (return `{ projectKey, workspacePath, workspaceSlug, <source>ProjectPath }`) is shared. |

**Proposed extraction module:** `src/adapters/_common/` with `hash.ts`,
`fs.ts`, `jsonl.ts`, `text-extract.ts` (the text/path/command extraction
helpers). This extraction lands as its own PR before the first new adapter so
the diff is small and the Cursor adapter is the test fixture (no behaviour
change expected).

### Adapter scaffold checklist

A new adapter PR ships with, at minimum:

- `src/adapters/<source>/intermediate.ts` — exported types only.
- `src/adapters/<source>/discover.ts` — walker + hashing.
- `src/adapters/<source>/parse-transcript.ts` — classifier + record builder.
- `src/adapters/<source>/workspace-map.ts` — path → workspace mapping.
- `src/adapters/<source>/enrich-*.ts` — only if the source has a side-channel.
- `test/adapters/<source>/` — at least one smoke fixture pair: a real-shape
  transcript file + the expected `TranscriptRecord[]` JSON snapshot.
- README section under "Supported Sources".
- New `LAUNCH_CRITERIA` gate (see §5).
- `--source <name>` accepted by `node dist/cli.js ingest backfill`.

---

## §2 On-disk probe — Claude Code

**Confirmed on 2026-05-18.**

- **Transcript root:** `~/.claude/projects/<encoded-workspace>/<session-uuid>.jsonl`
  - Example workspace dir: `~/.claude/projects/-Users-dallascrilley-Code-agent-session-distillery/`
  - Encoding: leading `-` then absolute workspace path with `/` replaced by `-`.
    Decoder must restore the leading `/` and the slashes.
  - Filenames: `<uuid>.jsonl`, one file per session. Multiple per workspace.
- **Format:** JSONL. Each line is a JSON object with `type` discriminator.
  Confirmed `type` values from probed sessions:
  - `last-prompt` — `{ leafUuid, sessionId }`. Session-pointer record, no body.
  - `permission-mode` — `{ permissionMode, sessionId }`. Session-pointer record.
  - `attachment` — `{ parentUuid, isSidechain, attachment, uuid, timestamp,
    userType, entrypoint, cwd, sessionId, version, gitBranch }`. **First
    occurrence of `cwd` and `sessionId` together — the workspace anchor.**
  - (Standard) `user`, `assistant`, `tool_use`, `tool_result`, `summary`,
    `system` — to be confirmed against a longer session during the parser PR;
    these are the publicly known types and match the wider Claude Code
    transcript schema used by other readers.
- **Workspace attribution:** read once per file — every `attachment` (and every
  user/assistant) record carries `cwd`. The first record with `cwd` is
  authoritative for the session. `sessionId` is in **every** line.
- **Session UUID:** transcript filename minus `.jsonl`; also present as
  `sessionId` on every line. Use the filename as the canonical id; verify it
  matches `sessionId` and warn on mismatch.
- **Auxiliary stores:** none required. `~/.claude/projects/` is self-contained.
  `~/.claude/todos/`, `~/.claude/sessions/`, `~/.claude/session-aliases/` exist
  but are not needed for transcript ingestion and are out of scope for the
  first PR.
- **Gotchas:**
  - The first 2–3 lines are *session-pointer* records (`last-prompt`,
    `permission-mode`) with no `cwd` or `parentUuid`. Skip cleanly; do not
    treat as malformed.
  - `isSidechain: true` records belong to sub-agent invocations. Decide per
    adapter: keep them under the same session id, or split — recommend keep
    with a `sidechain: true` field on the intermediate record so summarisation
    can group/exclude later. Mirrors how Cursor's `tool_use_stub` is kept under
    the parent session.
  - `gitBranch` is captured per record. Useful enrichment but not needed for
    workspace mapping.
  - Large files: the local sample sessions are 124KB–430KB; in production they
    can exceed 10MB. Stream like Cursor's `parse-transcript.ts` (line-by-line
    `readline`), never `readFile`.
  - Workspace path may not exist on disk (deleted projects). Mirror Cursor's
    `normalizeWorkspaceCandidate` pattern: return the decoded path even if
    `access` fails, and let the workspace-map result carry `workspacePath:
    null` only when decoding itself fails.

---

## §3 On-disk probe — Codex CLI

**Confirmed on 2026-05-18.**

- **Transcript root:** `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO>-<uuid>.jsonl`
  - Date-partitioned, not workspace-partitioned. **The Codex adapter must
    derive workspace from the file contents, not the path.**
  - Example: `~/.codex/sessions/2026/05/05/rollout-2026-05-05T11-51-24-019df90d-30b6-7931-971a-5295a91d3973.jsonl`
- **Archived sessions:** `~/.codex/archived_sessions/rollout-<ISO>-<uuid>.jsonl`
  — flat directory of older rollouts. Same format. Adapter walks both roots.
- **Index file:** `~/.codex/session_index.jsonl` — one record per session:
  `{ id, thread_name, updated_at }`. Useful for human-readable session names;
  do **not** treat as authoritative for transcript content.
- **Global history:** `~/.codex/history.jsonl` (~18 MB on this machine) — a
  cross-session log of `{ session_id, ts, text }` (user prompt text only). Not
  the transcript surface. Out of scope for v1 of this adapter; revisit only if
  asd ever needs prompt-only ingestion.
- **Format:** JSONL. Every line is `{ timestamp, type, payload }`. Probed
  `type` values include:
  - `session_meta` — line 0. Contains `payload.cwd`, `payload.id`,
    `payload.timestamp`, `payload.cli_version`, `payload.originator`,
    `payload.model_provider`, `payload.base_instructions.text` (system prompt),
    and importantly `payload.source.subagent` when the session was spawned as
    a sub-agent with `{ parent_thread_id, depth, agent_nickname, agent_role }`.
  - Subsequent lines: user/assistant/tool messages wrapped in
    `payload` — exact shape to be enumerated during the parser PR by tailing
    a long session. Treat the first PR as: parse `session_meta`, classify
    subsequent lines by best-effort `type`, fall back to `event`.
- **Workspace attribution:** `payload.cwd` on the `session_meta` line. Single
  source of truth per session. No KV/SQLite enrichment needed.
- **Session UUID:** `payload.id` on `session_meta`; also embedded in the
  filename. Use `payload.id` as canonical; warn on filename mismatch.
- **Gotchas:**
  - Sub-agent rollouts (`payload.source.subagent.depth > 0`) belong to a
    parent. Capture `parent_thread_id`, `agent_nickname`, `agent_role` on the
    intermediate record so the reducer can either keep sub-agent sessions
    independent (recommended; matches their on-disk separation) or stitch them
    later via the parent id.
  - `payload.base_instructions.text` can be a multi-KB system prompt. Do not
    treat as a `user_message`; mark as `event` with `kind: "system"` so it
    doesn't pollute summaries.
  - Codex stores both `originator: "codex-tui"` and `originator: "codex-cli"`
    sessions. Both flow through the same parser.
  - The presence of `.tldr/`, `.ruff_cache/`, `.DS_Store` under
    `~/.codex/sessions/` means the walker must filter to date-named children
    (`/^\d{4}$/` then `/^\d{2}$/`) before descending. Symlink/hidden-file
    handling matches Cursor.

---

## §4 On-disk probe — Pi (Zosma)

**Confirmed on 2026-05-18.**

- **Transcript root:** `~/.pi/agent/sessions/<encoded-cwd>/<ISO-utc>_<uuid>.jsonl`
  - Example workspace dir: `~/.pi/agent/sessions/--Users-dallascrilley-Code-agent-session-distillery--/`
  - Encoding: leading and trailing `--` framing, with `/` replaced by `-` inside
    the path. Decoder strips the framing and restores slashes.
  - Filename pattern: `<YYYY-MM-DDTHH-MM-SS-mmmZ>_<uuid>.jsonl`. The timestamp
    is the session-creation time in UTC. The UUID matches the `id` field on
    line 0.
- **Format:** JSONL. Confirmed `type` values from probed sessions:
  - `session` (line 0) — `{ type, version, id, timestamp, cwd }`. **Provides
    `cwd` directly; redundant with the path encoding and authoritative on
    conflict.** Note `version: 3` on the current build — the adapter must
    accept the field but should warn on unknown versions.
  - `prompt` — model invocation start, includes `id`, `parentId`, `timestamp`,
    `provider`, `modelId`.
  - `thinking` — extended-thinking record with `thinkingLevel`. Marked as
    `event` in the intermediate; don't promote to `assistant_message`.
  - (Expected) `response`, `tool_use`, `tool_result` — to be enumerated during
    the parser PR by tailing a long session.
- **Workspace attribution:** trivial. Line 0 `cwd` is canonical. Path encoding
  is a fallback when line 0 is missing or unreadable.
- **Session UUID:** line 0 `id`. Filename suffix matches.
- **Auxiliary stores:** Pi keeps additional state under `~/.pi/agent/` and
  `~/.pi-lens/projects/` but none of it is required for transcript ingestion.
  Out of scope for the first PR.
- **Gotchas:**
  - The sessions directory mixes real workspace sessions (e.g.
    `--Users-dallascrilley-Code-agent-session-distillery--`) with
    test/temp-directory sessions (`--var-folders-d8-.../T-pi-test-...--`,
    `--private-tmp-...--`). The walker should keep them all — let workspace
    mapping return whatever the cwd says — but the operator may want a
    discovery-time filter for `/^--(var-folders|private-tmp)/` to reduce
    noise. Recommend: include by default, add an `--exclude-temp` CLI flag in
    a follow-up if noise becomes a problem.
  - Path encoding can collide if a workspace itself contains `--`. Use the
    line-0 `cwd` as the authoritative source; treat the path encoding as a
    discovery convenience only.
  - The `version` field on line 0 (currently `3`) is the Pi session-schema
    version. The adapter must persist this on the intermediate so future
    upgrades can be detected.
  - Pi has a parallel `~/.pi/.agents/` skill tree that is unrelated to
    transcripts. Do not walk into it.

---

## §5 Per-adapter design sketches

| Concern | Claude Code | Codex CLI | Pi |
|---|---|---|---|
| Discovery walker | Recurse `~/.claude/projects/`; collect `*.jsonl`; skip symlinks, hidden files, and non-`-`-prefixed dirs. | Walk `~/.codex/sessions/{YYYY}/{MM}/{DD}/` plus `~/.codex/archived_sessions/`; collect `rollout-*.jsonl`. | Recurse `~/.pi/agent/sessions/`; collect `*.jsonl`; skip `.DS_Store`. |
| Parser shape | Streamed `readline`; classifier table on `type`; session-pointer lines (`last-prompt`, `permission-mode`) become `event` with `kind: "session-pointer"`. | Streamed `readline`; classifier on `type` and `payload.type` (the payload often re-discriminates); `session_meta` becomes a single `event` with `kind: "session-meta"` plus a parsed `SessionMeta` sidecar on the result. | Streamed `readline`; classifier on `type`; line 0 (`type: "session"`) becomes a `SessionMeta` sidecar. |
| Enrichment | None. | None. | None. |
| Workspace mapping | Decode the leading-dash workspace slug; cross-check against every record's `cwd`; use the most common `cwd` if they disagree, log mismatch. | Read `payload.cwd` from `session_meta`. Single record, no path-based fallback. | Read line-0 `cwd`; fall back to decoded path framing only if line 0 is missing. |
| Session id | Filename UUID == `sessionId` in every record. Warn on mismatch. | `payload.id` on `session_meta`; embedded in filename. | Line-0 `id`; embedded in filename. |
| Sub-agent / sidechain | `isSidechain: true` records kept inline, flagged on intermediate. | Sub-agent rollouts ingested as independent sessions; capture `parent_thread_id` on the intermediate so a follow-up reducer can stitch. | No known sub-agent surface in current Pi sessions. |
| Smoke fixture | One real session, scrubbed of secrets; expected `TranscriptRecord[]` JSON snapshot. | One `session_meta`-only file + one full session. | One real session including `thinking` records. |

---

## §6 Phasing and gates

Each phase is one PR. Each PR ships smoke fixtures under `test/`, updates
README, and proposes a `LAUNCH_CRITERIA` gate. The gates below are written in
the format the existing `LAUNCH_CRITERIA.md` uses (id / feature / test /
proof_required / proof_level).

| PR | Title | LAUNCH_CRITERIA gate(s) | Depends on |
|---|---|---|---|
| **F1-A** | Extract `src/adapters/_common/` (hash, fs, jsonl, text-extract). Cursor adapter rewired to use the shared module with zero behaviour change. | `adapter-base-contract` — proof: `node dist/cli.js ingest backfill --source cursor` against the existing v1 fixture produces a byte-identical runtime under `AGENT_SESSION_DISTILLERY_ROOT`. | none. |
| **F1-B** | Claude Code adapter source research note under `docs/research/`, mirroring `background-agent-source-strategy.md`. | `claude-code-adapter-source-research` — proof: research note checked in, citing real on-disk paths and ranking surfaces. | F1-A optional. |
| **F1-C** | Claude Code adapter (`src/adapters/claude-code/`). | `claude-code-adapter` — proof: `ingest backfill --source claude-code` against a fixture in `test/adapters/claude-code/` produces at least one session with attributed `projectKey`, one summary, and one extracted learning. Quality audit passes. | F1-A, F1-B. |
| **F1-D** | Codex CLI adapter source research note. | `codex-cli-adapter-source-research`. | F1-A optional. |
| **F1-E** | Codex CLI adapter (`src/adapters/codex-cli/`). | `codex-cli-adapter` — same proof shape as F1-C. | F1-A, F1-D. |
| **F1-F** | Pi adapter source research note. | `pi-adapter-source-research`. | F1-A optional. |
| **F1-G** | Pi adapter (`src/adapters/pi/`). | `pi-adapter` — same proof shape as F1-C. | F1-A, F1-F. |

PRs F1-B/D/F can ship in parallel after F1-A; F1-C/E/G are sequential per
adapter but independent across adapters. None of them modify
`src/adapters/cursor/` beyond the F1-A common-module rewire.

---

## What this plan deliberately does **not** do

- No code changes in `src/adapters/cursor/`. The Cursor adapter is the
  reference implementation. PR F1-A's `_common/` extraction is a rewire,
  not a rewrite; the public type surface is unchanged.
- No re-opening of the four closed `td` review items.
- No background-agent ingestion. That surface remains gated by
  `docs/research/background-agent-source-strategy.md`.
- No coupling to the vault-push plan. New adapters silently grow the volume
  of pushable records without any change to the push command.

## Recommended model routing

- **PR F1-A:** Opus 4.7 — careful refactor; the only chance to set up the
  shared module cleanly.
- **PRs F1-B/D/F (research notes):** Sonnet 4.6 — probe + write.
- **PRs F1-C/E/G (adapter implementations):** Sonnet 4.6 — straightforward
  implementation against a known contract. Drop to Haiku for fixture
  scaffolding.
