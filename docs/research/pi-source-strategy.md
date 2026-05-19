---
date: 2026-05-18
status: research-only
launch_criteria_gate: pi-adapter-source-research
---

# Pi (Zosma) source strategy

This note locks the on-disk source surface for the planned Pi adapter
(F1-G). It mirrors the format of the prior research notes
(`background-agent-source-strategy.md`, `vault-push-source-strategy.md`,
`claude-code-source-strategy.md`, `codex-cli-source-strategy.md`) so the
launch-criteria gate has the same shape as every other research gate.

Companion plan:
[`docs/plans/2026-05-18-multi-adapter-expansion.md`](../plans/2026-05-18-multi-adapter-expansion.md)
§4. The adapter base contract lives in §1 of that plan; this note documents
only Pi-specific source decisions.

## What "Pi transcripts" means here

Pi (the Zosma `pi` agent CLI) writes one JSONL file per session under a
workspace-encoded directory tree:

    ~/.pi/agent/sessions/<encoded-cwd>/<ISO-utc>_<uuid>.jsonl

This is the **local** transcript surface — analogous to Cursor's
`~/.cursor/projects/<slug>/agent-transcripts/*.jsonl`, Claude Code's
`~/.claude/projects/<encoded>/<uuid>.jsonl`, and Codex CLI's
`~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`. There is no
remote-only surface to research; everything Pi writes for a session lives
in the file.

## Filesystem probe (2026-05-18)

Confirmed against this operator's machine:

- `~/.pi/agent/sessions/` — top-level. One subdirectory per workspace,
  encoded with leading-and-trailing `--` framing.
- `~/.pi/agent/sessions/<encoded-cwd>/` — example:
  `~/.pi/agent/sessions/--Users-dallascrilley-Code-agent-session-distillery--/`.
  Contains one or more `.jsonl` files per session.
- **Encoding rule:** leading and trailing `--` framing plus `/` → `-`
  inside the path. The leading `/` of the original path encodes to a `-`
  inside the framed region. Decoder: drop the leading and trailing `--`,
  then prepend `/` and replace remaining `-` with `/` between segments.
- **Filename pattern:** `<YYYY-MM-DDTHH-MM-SS-mmmZ>_<uuid>.jsonl`. The
  timestamp prefix is session-creation time in UTC. The UUID matches
  `id` on line 0.
- Adjacent paths NOT needed for transcript ingestion (out of scope for
  F1-G; revisit only if a follow-up needs them):
  - `~/.pi/agent/settings.json` and friends (per-agent config).
  - `~/.pi/agent/history.jsonl` if present (cross-session log; analogous
    to Codex's history).
  - `~/.pi/.agents/` (Pi's skill tree; structurally unrelated).
  - `~/.pi-lens/projects/` (Pi's session projections; structurally
    unrelated and may be a derived view).

The sessions root also mixes real workspaces (e.g.
`--Users-dallascrilley-Code-agent-session-distillery--`) with
test/temp-directory sessions
(`--var-folders-d8-.../T-pi-test-...--`, `--private-tmp-...--`).
Phase 1 includes them all; the operator can filter later.

## Line-type discrimination

Probed `type` values from a real long session on this machine:

| `type` | Notes |
|---|---|
| `session` | Line 0. `{ type, version, id, timestamp, cwd }`. Workspace anchor. `version: 3` on current Pi builds. |
| `model_change` | Model switch event. `{ id, parentId, timestamp, provider, modelId }`. Not prose. |
| `thinking_level_change` | Thinking-budget switch. `{ thinkingLevel }`. Not prose. |
| `custom` | Extension/UI hook data. `{ customType, data }`. Not prose. |
| `custom_message` | Extension messages (e.g. injected memory context). `{ customType, content, display, details }`. Not promoted to user/assistant. |
| `message` | The actual conversation turn. `{ message: { role, content[], ... } }`. `message.role` ∈ {`user`, `assistant`, `toolResult`}. |

**Counter-intuitive: `tool_use` and `tool_result` are NOT top-level types
in Pi sessions.** Pi embeds tool calls inside an assistant message's
`message.content` array as `{type: "toolCall", id, name, arguments}`
blocks, and emits tool results as `message` records with
`message.role: "toolResult"`, `message.toolCallId`, `message.toolName`,
and `message.content[]`.

### Content-block types inside `message.content[]`

For assistant messages and toolResult messages, `content` is an array of
typed blocks. Probed block types:

- `text` — prose body. The dominant block type for assistant prose.
- `toolCall` — assistant invoking a tool. `{ id, name, arguments }`.
- `thinking` — chain-of-thought. `{ text }`.

The generic `extractNormalizedText` from `_common/text-extract.ts`
recursively unwraps `text` fields from these blocks; for phase 1 that is
sufficient to surface prose for the summarizer. `toolCall` blocks
contribute their arguments string only inasmuch as the recursive walk
finds a `text` value; cleaner tool-use surfacing is a phase-2
enhancement.

### Classifier strategy

The Pi classifier table keys on `type` and (when `type === "message"`)
the nested `message.role`:

| `type` (+ `message.role`) | Cursor-style intermediate kind | Notes |
|---|---|---|
| `message` + `role=user` | `user_message` | `message.content` is `[{type: "text", text: "..."}]`; recursive unwrap handles it. |
| `message` + `role=assistant` | `assistant_message` | `message.content` mixes `text`, `toolCall`, `thinking`. Recursive unwrap pulls `text` fields. |
| `message` + `role=toolResult` | `tool_result_stub` | `message.toolCallId`, `message.toolName`, `message.content`. Output text comes from the content array. |
| `session` | `event` (kind: `session-meta`) | Line 0 sidecar source. |
| `model_change` | `event` (kind: `model-change`) | Diagnostic. |
| `thinking_level_change` | `event` (kind: `thinking-level-change`) | Diagnostic. |
| `custom` | `event` (kind: `custom`) | Extension data. |
| `custom_message` | `event` (kind: `custom-message`) | Extension messages (memory injects, etc.). |
| anything else | `event` (kind: `unknown`) | Default catch-all. |

Phase 1 does NOT emit `tool_use_stub` records because Pi nests tool calls
inside assistant `message.content[]` rather than promoting them to
top-level records. The assistant_message records carry the toolCall
blocks via their `rawEvent` JSON and via recursive text extraction. A
future reducer enhancement could flatten toolCall blocks into separate
intermediate records if downstream phases want them.

## Workspace attribution

Two sources of truth, ranked:

1. **`cwd` field on the `session` line (line 0).** Always present on
   current Pi builds. Authoritative.
2. **Decoded workspace slug from the directory name.** Fallback when line
   0 is missing or unreadable. Use the line-0 `cwd` on conflict; record
   the decoded path on the intermediate event for diagnostics.

`id` is on line 0 and matches the UUID portion of the filename. The
adapter validates the two match; warn on mismatch but trust line-0 `id`.

## Auxiliary stores

**None required.** `~/.pi/agent/sessions/` is self-contained for
transcript ingestion. The Pi adapter does **not** read:

- `~/.pi/agent/settings.json`
- `~/.pi/.agents/` (skill tree, structurally unrelated)
- `~/.pi-lens/` (session projections, structurally unrelated)

If a future feature wants extension config or projection data, those
become separate enrichment surfaces; out of scope for F1-G.

## Gotchas

| # | Gotcha | How F1-G handles it |
|---|---|---|
| 1 | Workspace slug uses leading and trailing `--` framing | Decoder strips the framing, restores leading `/`, replaces internal `-` with `/`. Mirrors the Claude Code decoder pattern but with the trailing framing. |
| 2 | Sessions root mixes real workspaces with temp-dir test sessions (`--var-folders-...`, `--private-tmp-...`) | Walker includes all by default; operator can add `--exclude-temp` in a follow-up. Phase 1 keeps the surface uniform. |
| 3 | Tool calls live inside `message.content[]` as `toolCall` blocks, not as separate top-level records | Classifier maps `message` (role=assistant) to `assistant_message` and lets the recursive `extractNormalizedText` unwrap text from the content array. Tool-call flattening is a phase-2 reducer concern. |
| 4 | `toolResult` is a `message` with `role="toolResult"`, not a separate top-level `tool_result` type | Classifier maps it to `tool_result_stub` and pulls `toolCallId`/`toolName` from the inner `message` object. |
| 5 | Pi's content blocks include `thinking` (chain-of-thought) | Recursive text extraction will include thinking text in the assistant body. Phase 1 accepts this; a future toggle could strip thinking blocks pre-extraction. |
| 6 | `version` field on the session line (currently `3`) is the Pi session-schema version | Adapter persists the version on the session-meta event so future upgrades are detectable. |
| 7 | Path encoding collision if a workspace itself contains `--` | Use line-0 `cwd` as authoritative; treat the path encoding as a discovery convenience only. |
| 8 | Pi's parallel `~/.pi/.agents/` skill tree is unrelated to transcripts | Walker descends only into `~/.pi/agent/sessions/` and never into `.pi/.agents/`. |
| 9 | `custom_message` records can carry multi-KB injected-memory content | Classified as `event`; the body is preserved on `rawEvent` but does NOT flow into `messageText`, so summaries stay clean. |

## Recommendation

Build the F1-G adapter directly against this surface. Source surfaces
beyond `~/.pi/agent/sessions/` are not needed. The adapter shape is:

- `src/adapters/pi/discover.ts` — recursive walker for
  `~/.pi/agent/sessions/<encoded-cwd>/<iso>_<uuid>.jsonl`. Hashes via
  `_common/hash.ts`.
- `src/adapters/pi/parse-transcript.ts` — `readline`-streamed classifier
  using the table above. The `message` records branch on
  `message.role`. Reuses `_common/text-extract.ts` for body / file
  path / command extraction.
- `src/adapters/pi/workspace-map.ts` — decode the leading-and-trailing
  `--` framed workspace slug; cross-check against line-0 `cwd` (read
  via a lightweight session-meta probe similar to the Codex adapter).
- `src/adapters/pi/intermediate.ts` — `PiTranscriptRecord` alias plus
  `PiWorkspaceMapping` and `PiSessionMeta` types.
- No `enrich-*.ts` (no auxiliary store needed).

## Out of scope for F1-G

- `~/.pi/agent/history.jsonl` if it exists (cross-session log).
- `~/.pi/.agents/` (skill tree).
- `~/.pi-lens/` (session projections).
- Flattening `toolCall` blocks inside assistant content arrays into
  separate `tool_use_stub` records (phase 2 reducer enhancement).
- Stripping `thinking` blocks pre-extraction (phase 2 toggle).
- A `--exclude-temp` filter for `--var-folders-...` / `--private-tmp-...`
  workspaces (phase 2 ergonomic flag).
- Whole-file reads; the parser must be stream-only.

## Next operator action

After this gate lands, F1-G implements the four files above plus a smoke
fixture under `test/adapters/pi/`. F1-G's gate (`pi-adapter`) requires
that `node dist/cli.js ingest backfill --source pi` against the fixture
produces at least one session with attributed `projectKey`, one summary,
and one extracted learning.
