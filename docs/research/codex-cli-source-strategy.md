---
date: 2026-05-18
status: research-only
launch_criteria_gate: codex-cli-adapter-source-research
---

# Codex CLI source strategy

This note locks the on-disk source surface for the planned Codex CLI adapter
(F1-E). It mirrors the format of the prior research notes
(`background-agent-source-strategy.md`, `vault-push-source-strategy.md`,
`claude-code-source-strategy.md`) so the launch-criteria gate has the same
shape as every other research gate.

Companion plan:
[`docs/plans/2026-05-18-multi-adapter-expansion.md`](../plans/2026-05-18-multi-adapter-expansion.md)
§3. The adapter base contract lives in §1 of that plan; this note documents
only Codex-CLI-specific source decisions.

## What "Codex CLI transcripts" means here

Codex CLI (the OpenAI `codex` agent CLI) writes one JSONL file per session
under a date-partitioned tree:

    ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO>-<uuid>.jsonl

Older sessions get moved to a flat archive directory:

    ~/.codex/archived_sessions/rollout-<ISO>-<uuid>.jsonl

Both trees use the same line format. The adapter walks both roots and treats
them as a single session corpus.

This is the **local** transcript surface — analogous to Cursor's
`~/.cursor/projects/<slug>/agent-transcripts/*.jsonl` and Claude Code's
`~/.claude/projects/<encoded>/<uuid>.jsonl`. There is no remote-only surface
to research; everything Codex CLI writes for a session lives in the file.

## Filesystem probe (2026-05-18)

Confirmed against this operator's machine:

- `~/.codex/sessions/` — top-level. Contains `<YYYY>/<MM>/<DD>/` subdirs
  with date-named children (`/^\d{4}$/` then `/^\d{2}$/` then `/^\d{2}$/`).
  Also contains `.tldr/`, `.ruff_cache/`, `.DS_Store` cruft that the walker
  must skip.
- `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` — one file per
  session. Example:
  `~/.codex/sessions/2026/05/03/rollout-2026-05-03T23-02-54-019df127-415e-7b43-a43b-96fc77a98775.jsonl`.
- `~/.codex/archived_sessions/rollout-*.jsonl` — flat dir of older
  rollouts. Same format.
- `~/.codex/session_index.jsonl` — one record per session:
  `{ id, thread_name, updated_at }`. Useful for human-readable session
  names; **not** authoritative for transcript content. Out of scope for
  F1-E; revisit if a follow-up needs friendly names in the summary header.
- `~/.codex/history.jsonl` (~18 MB on this machine) — cross-session log of
  `{ session_id, ts, text }` (user prompt text only). Not the transcript
  surface. Out of scope.

## Line-type discrimination

Codex's JSONL has a **two-level** discriminator. The top-level `type` says
which envelope the line carries; the inner `payload.type` says what that
envelope contains. Probed combinations from a real session on this
machine:

| `type` | `payload.type` | Notes |
|---|---|---|
| `session_meta` | (none — payload IS the metadata) | Line 0. Carries `payload.cwd`, `payload.id`, `payload.timestamp`, `payload.cli_version`, `payload.originator`, `payload.model_provider`, `payload.base_instructions.text` (system prompt), `payload.source.subagent` when applicable. |
| `event_msg` | `task_started` | Marks a new turn. Carries `turn_id`, `started_at`, `model_context_window`. |
| `event_msg` | `user_message` | Mirrors the response_item/message user record. Includes images, local_images, text_elements. |
| `event_msg` | `agent_message` | Mirrors the response_item/message assistant record. Includes `phase`, `memory_citation`. |
| `event_msg` | `token_count` | Token-usage report. Not prose. |
| `response_item` | `message` | The actual conversation turn. `payload.role` ∈ {`user`, `assistant`}. `payload.content` is an array of typed blocks (`input_text`, `output_text`, etc.). |
| `response_item` | `reasoning` | Model's chain-of-thought. `payload.summary`, `payload.content`, `payload.encrypted_content`. Not promoted to assistant_message. |
| `response_item` | `function_call` | Tool call. `payload.name`, `payload.arguments`, `payload.call_id`. |
| `response_item` | `function_call_output` | Tool result. `payload.call_id`, `payload.output`. |
| `turn_context` | (none) | Per-turn config: `turn_id`, `cwd`, `model`, `approval_policy`, `sandbox_policy`, `permission_profile`. |

### Classifier strategy

The Codex classifier table joins on `type` and `payload.type`:

| Composite key | Cursor-style intermediate kind | Notes |
|---|---|---|
| `response_item/message` + `payload.role=user` | `user_message` | content is `[{type: "input_text", text: "..."}]`; the generic `extractNormalizedText` recursively unwraps it. |
| `response_item/message` + `payload.role=assistant` | `assistant_message` | content is `[{type: "output_text", text: "..."}]` or similar; same unwrap path. |
| `response_item/function_call` | `tool_use_stub` | `name` lives at `payload.name`; `arguments` at `payload.arguments`; `call_id` at `payload.call_id`. |
| `response_item/function_call_output` | `tool_result_stub` | `call_id` at `payload.call_id`; `output` at `payload.output`. |
| `response_item/reasoning` | `event` (kind: `reasoning`) | Keep visible but don't promote; matches how Pi's `thinking` records are handled. |
| `event_msg/user_message` | `event` (kind: `event-msg-user`) | Duplicate of `response_item/message` user — skip the duplicate to avoid double-counting in the reducer. The reducer can dedupe by `turn_id` if needed. |
| `event_msg/agent_message` | `event` (kind: `event-msg-agent`) | Same — duplicate. |
| `event_msg/task_started` | `event` (kind: `task-started`) | Turn marker. |
| `event_msg/token_count` | `event` (kind: `token-count`) | Usage report. |
| `session_meta` | `event` (kind: `session-meta`) | Line 0 only. The adapter SHOULD also extract the metadata into a SessionMeta sidecar on the parse result so the workspace mapping can be cross-checked. |
| `turn_context` | `event` (kind: `turn-context`) | Per-turn config. Carries an updated `cwd` if the user `cd`'d mid-session. |
| anything else | `event` (kind: `unknown`) | Default catch-all. |

Fall-through to `event` is intentional and matches the Cursor and Claude
Code adapters' behaviour.

## Workspace attribution

Codex sessions are date-partitioned, not workspace-partitioned. **The
adapter cannot derive workspace from the file path**; it must read the
file contents.

Two sources of truth, ranked:

1. **`payload.cwd` on the `session_meta` line.** Line 0. Single source of
   truth per session. Always present in current Codex builds.
2. **`payload.cwd` on `turn_context` lines.** Tracks mid-session `cd`
   changes. The adapter uses the first qualifying value (session_meta) as
   the canonical workspace; later `cwd` shifts are recorded on the
   intermediate `event` records but do not retroactively change the
   workspace mapping for the session.

No KV/SQLite enrichment needed.

## Session id

`payload.id` on the `session_meta` line is the canonical session UUID. The
filename also embeds it (between the timestamp and `.jsonl`). The adapter
validates the two match; warn on mismatch but trust `payload.id`.

## Sub-agent context

Codex spawns sub-agent rollouts as **separate session files**. The
`session_meta` line carries `payload.source.subagent.{parent_thread_id,
depth, agent_path, agent_nickname, agent_role}` when applicable. The
adapter persists these fields on the intermediate `session-meta` event so
a follow-up reducer can stitch parent↔child by `parent_thread_id`. Phase 1
treats every sub-agent session as an independent top-level session — that
matches how the on-disk layout already represents them.

## Auxiliary stores

**None required.** `~/.codex/sessions/` plus `~/.codex/archived_sessions/`
are self-contained for transcript ingestion. The Codex adapter does **not**
read:

- `~/.codex/session_index.jsonl` (friendly-names side index)
- `~/.codex/history.jsonl` (prompt-only cross-session log)
- Any global state file under `~/.codex/`

If a future feature wants thread_name display or prompt-only ingestion,
those become separate enrichment surfaces; explicitly out of scope for
F1-E.

## Gotchas

| # | Gotcha | How F1-E handles it |
|---|---|---|
| 1 | `~/.codex/sessions/` mixes date dirs with `.tldr/`, `.ruff_cache/`, `.DS_Store` | Walker filters to children matching `/^\d{4}$/` then `/^\d{2}$/` then `/^\d{2}$/`; everything else skipped. |
| 2 | Two-level type discriminator (`type` + `payload.type`) | Classifier reads both keys to build the composite-key table above; falls through to `event` if either is missing. |
| 3 | Duplicate user/assistant records between `event_msg/*_message` and `response_item/message` | Treat `event_msg/*_message` as `event` kind so summarisation only sees the canonical `response_item/message` record. The reducer can opt to inspect the `event_msg/*` records later if it ever needs them. |
| 4 | `payload.base_instructions.text` can be a multi-KB system prompt | The `session_meta` event carries it through, but it is NOT extracted as `messageText` because the kind is `event`. Summaries stay clean. |
| 5 | `payload.cwd` may shift mid-session via `turn_context` | The adapter records the per-turn `cwd` on the intermediate event but does not re-assign the session's canonical `workspacePath`. Phase 1 keeps one workspace per session. |
| 6 | Sub-agent rollouts (`payload.source.subagent.depth > 0`) | Ingested as independent sessions; capture `parent_thread_id`, `agent_nickname`, `agent_role` on the session-meta event. No automatic stitching in phase 1. |
| 7 | `archived_sessions/` is a FLAT dir, not date-partitioned | Walker has two roots: the date-partitioned `sessions/` tree and the flat `archived_sessions/`. Both produce `rollout-*.jsonl` files. |
| 8 | `originator` values vary (`codex-tui`, `codex-cli`) | Both flow through the same parser. The originator string is preserved on the `session-meta` event for diagnostics. |
| 9 | Symlinks and hidden files mixed into walked dirs | Walker skips symlinks and dotfiles, matching the Cursor/Claude Code adapters. |

## Recommendation

Build the F1-E adapter directly against this surface. Source surfaces
beyond `~/.codex/sessions/` and `~/.codex/archived_sessions/` are not
needed. The adapter shape is:

- `src/adapters/codex-cli/discover.ts` — two-rooted walker. Date-tree
  walker for `~/.codex/sessions/<YYYY>/<MM>/<DD>/` plus flat walker for
  `~/.codex/archived_sessions/`. Hashes via `_common/hash.ts`.
- `src/adapters/codex-cli/parse-transcript.ts` — `readline`-streamed
  classifier joining on `type` and `payload.type`. Reuses
  `_common/text-extract.ts` for body / file path / command extraction.
  The session_meta line gets stored as a `SessionMeta` sidecar on the
  parse result alongside the records, used by the workspace mapper.
- `src/adapters/codex-cli/workspace-map.ts` — reads the session_meta line
  off disk (light I/O), pulls `payload.cwd`, derives `projectKey` from
  the last segment of the cwd path.
- `src/adapters/codex-cli/intermediate.ts` — `CodexCliTranscriptRecord`
  alias plus `CodexCliWorkspaceMapping` extension.
- No `enrich-*.ts` (no auxiliary store needed).

## Out of scope for F1-E

- `~/.codex/session_index.jsonl` (friendly names).
- `~/.codex/history.jsonl` (prompt-only log).
- Cross-session sub-agent stitching by `parent_thread_id` (kept as a
  future reducer enhancement; per-session record persists the parent id
  for the future stitcher).
- Mid-session `cwd` re-assignment (one workspace per session in phase 1).
- Deduplication of `event_msg/*_message` against `response_item/message`
  beyond classifying the duplicates as `event` so they don't contaminate
  the summarizer's user/assistant counts.
- Whole-file reads; the parser must be stream-only.

## Next operator action

After this gate lands, F1-E implements the four files above plus a smoke
fixture under `test/adapters/codex-cli/`. F1-E's gate (`codex-cli-adapter`)
requires that `node dist/cli.js ingest backfill --source codex-cli`
against the fixture produces at least one session with attributed
`projectKey`, one summary, and one extracted learning.
