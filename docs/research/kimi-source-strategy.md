---
date: 2026-05-23
status: research-only
launch_criteria_gate: kimi-adapter-source-research
---

# Kimi (Kimi Code CLI) source strategy

This note documents the on-disk source surface for the Kimi Code CLI
adapter so that future maintenance is evidence-backed rather than
guesswork.

## What "Kimi transcripts" means here

Kimi Code CLI (referred to as `kimi` in the adapter) writes one
`wire.jsonl` file per session under a workspace-hashed directory tree:

    ~/.kimi/sessions/<md5-workspace-path>/<session-uuid>/wire.jsonl

This is the **local** transcript surface — analogous to Cursor's
`~/.cursor/projects/<slug>/agent-transcripts/*.jsonl`, Claude Code's
`~/.claude/projects/<encoded>/<uuid>.jsonl`, Pi's
`~/.pi/agent/sessions/<encoded-cwd>/<iso>_<uuid>.jsonl`, and Codex
CLI's `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`. There is no
remote-only surface; everything Kimi writes for a session lives in the
file.

## Filesystem probe (2026-05-23)

Confirmed against this operator's machine:

- `~/.kimi/sessions/` — top-level. One subdirectory per workspace,
  named as the MD5 hex digest of the absolute workspace path.
- `~/.kimi/sessions/<md5-workspace-path>/` — example:
  `~/.kimi/sessions/182fbcf3a283c1dc518fdeed3fe94ae4/`. Contains one
  or more session-uuid subdirectories.
- `~/.kimi/sessions/<md5-workspace-path>/<session-uuid>/wire.jsonl` —
  the actual transcript file.
- `~/.kimi/sessions/<md5-workspace-path>/<session-uuid>/context.jsonl` —
  context cache (system prompts, large context blocks). Out of scope
  for transcript ingestion; the wire file contains the full turn
  sequence.
- `~/.kimi/sessions/<md5-workspace-path>/<session-uuid>/state.json` —
  session state (approval settings, custom title, plan mode, todos).
  Out of scope for transcript ingestion.
- `~/.kimi/kimi.json` — operator config. Contains a `work_dirs` array
  with `path`, `kaos`, and `last_session_id` fields. Used for MD5 →
  workspace path reverse mapping.

Adjacent paths NOT needed for transcript ingestion:
- `~/.kimi/commands/` — symlinked command directory.
- `~/.kimi/skills/` — skill tree (structurally unrelated).
- `~/.kimi/logs/` — runtime logs (structurally unrelated).
- `~/.kimi/plans/` — plan directory (structurally unrelated).

## Line-type discrimination

Kimi's wire format is a JSONL where each line has:

```json
{"timestamp": <unix-epoch-float>, "message": {"type": <msg-type>, "payload": {...}}}
```

The first line is metadata (`{"type": "metadata", "protocol_version": "..."}`).

Probed `message.type` values from a real session:

| `message.type` | Notes |
|---|---|
| `TurnBegin` | User input. `payload.user_input` is either a plain string or an array of `{type: "text", text: "..."}` parts. |
| `StepBegin` | Step counter start. `payload.n` is the step number. Diagnostic only. |
| `ContentPart` | Assistant output. `payload.type` ∈ {`think`, `text`}. `think` contains reasoning; `text` contains prose. |
| `ToolCall` | Tool invocation. `payload.type` is `"function"`. `payload.function.name` is the tool name; `payload.function.arguments` is a JSON string of arguments. |
| `ToolResult` | Tool output. `payload.tool_call_id` matches the ToolCall id. `payload.return_value` contains `output`, `message`, `is_error`, etc. |
| `StatusUpdate` | Token usage and context stats. Diagnostic only. |
| `TurnEnd` | Turn boundary marker. Empty payload. |

### Classifier strategy

| `message.type` | Cursor-style intermediate kind | Notes |
|---|---|---|
| `TurnBegin` | `user_message` | `payload.user_input` is unwrapped from string or content-part array. |
| `ContentPart` | `assistant_message` | `payload.think` or `payload.text` is extracted. |
| `ToolCall` | `tool_use_stub` | `payload.function.name` and `payload.function.arguments` are parsed. |
| `ToolResult` | `tool_result_stub` | `payload.return_value.output` is preferred over `payload.return_value.message`. |
| `StepBegin` | `event` | Diagnostic. |
| `StatusUpdate` | `event` | Diagnostic. |
| `TurnEnd` | `event` | Boundary marker. |
| `metadata` (top-level) | `event` | Protocol version line at start of file. |
| anything else | `event` | Default catch-all. |

### Tool argument parsing

Kimi nests tool arguments inside `payload.function.arguments` as a **JSON
string**. The adapter parses this string and extracts:

1. `command` — for Shell tool calls
2. `input` — fallback for generic input
3. `path` — fallback for path-based tools
4. The whole parsed object as text — final fallback

If the arguments string is not valid JSON (e.g., legacy format), the raw
string is used as input text.

## Workspace attribution

Two sources of truth, ranked:

1. **`~/.kimi/kimi.json` `work_dirs` array.** Authoritative. Each entry
   has `path` (absolute workspace path) and `last_session_id`. The
   adapter computes the MD5 of each path and matches against the
   directory slug.
2. **The MD5 slug itself.** Fallback when the config is missing,
   unreadable, or the slug is not listed. The slug is used as the
   opaque workspace identifier.

## Auxiliary stores

**None required.** `~/.kimi/sessions/` is self-contained for transcript
ingestion. The adapter does **not** read:

- `~/.kimi/sessions/<...>/context.jsonl`
- `~/.kimi/sessions/<...>/state.json`
- `~/.kimi/commands/`
- `~/.kimi/skills/`
- `~/.kimi/logs/`

If a future feature wants session state or context cache data, those
become separate enrichment surfaces; out of scope for the initial
adapter.

## Gotchas

| # | Gotcha | How the adapter handles it |
|---|---|---|
| 1 | `wire.jsonl` is inside a session-uuid subdirectory, not flat | Walker descends two levels: workspace-slug → session-uuid → `wire.jsonl`. |
| 2 | Workspace slug is an MD5 hash, not a human-readable path | Reverse lookup via `~/.kimi/kimi.json`. Falls back to slug as opaque identifier. |
| 3 | `user_input` can be either a plain string or a content-part array | Parser checks type: string is used directly; arrays are unwrapped for `text`-type parts. |
| 4 | Tool arguments are a JSON string, not an object | `extractKimiToolInputText` parses the string and extracts `command` / `input` / `path`. |
| 5 | Tool result `return_value` has both `output` (command stdout) and `message` (human-readable status) | Parser prefers `output` over `message` so summaries capture actual command results. |
| 6 | `ContentPart` has both `think` (reasoning) and `text` (prose) | Both are extracted; thinking text is included in the assistant body. A future toggle could strip it. |
| 7 | Metadata line at start of file has no `message` field | Classifier sees `msgType === null` and maps it to `event`. |
| 8 | Timestamps are Unix epoch floats, not ISO strings | `extractTimestampHint` multiplies by 1000 and calls `new Date().toISOString()`. |

## Recommendation

Build the adapter directly against this surface. Source surfaces beyond
`~/.kimi/sessions/*/wire.jsonl` are not needed. The adapter shape is:

- `src/adapters/kimi/discover.ts` — recursive walker for
  `~/.kimi/sessions/<md5>/<uuid>/wire.jsonl`. Hashes via
  `_common/hash.ts`.
- `src/adapters/kimi/parse-transcript.ts` — `readline`-streamed
  classifier using the table above. Handles both string and array-form
  `user_input`, parses JSON tool arguments, and prefers `output` over
  `message` for tool results.
- `src/adapters/kimi/workspace-map.ts` — MD5 reverse lookup via
  `~/.kimi/kimi.json`; falls back to slug.
- `src/adapters/kimi/intermediate.ts` — `KimiTranscriptRecord` alias
  plus `KimiWorkspaceMapping` types.
- No `enrich-*.ts` (no auxiliary store needed).

## Out of scope

- `context.jsonl` (context cache; large system prompts).
- `state.json` (session state; approval settings, todos).
- `~/.kimi/skills/` (skill tree).
- `~/.kimi/logs/` (runtime logs).
- Stripping `think` blocks pre-extraction (phase 2 toggle).
- Flattening multi-part `user_input` arrays beyond `text`-type parts.
- Whole-file reads; the parser must be stream-only.

## Next operator action

After this gate lands, the adapter implements the four files above plus
a smoke fixture under `test/fixtures/kimi/`. The adapter gate requires
that `node dist/cli.js ingest backfill --source kimi` against the
fixture produces at least one session with attributed `projectKey`, one
summary, and one extracted learning.
