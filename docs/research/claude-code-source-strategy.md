---
date: 2026-05-18
status: research-only
launch_criteria_gate: claude-code-adapter-source-research
---

# Claude Code source strategy

This note locks the on-disk source surface for the planned Claude Code
adapter (F1-C). It mirrors the structure of
`docs/research/background-agent-source-strategy.md` and
`docs/research/vault-push-source-strategy.md` so the launch-criteria gate
has the same shape as the other research gates.

Companion plan:
[`docs/plans/2026-05-18-multi-adapter-expansion.md`](../plans/2026-05-18-multi-adapter-expansion.md)
§2. The adapter base contract lives in §1 of that plan; this note
documents only the Claude-Code-specific source decisions.

## What "Claude Code transcripts" means here

Claude Code (the CLI tool) writes one JSONL file per session under
`~/.claude/projects/<encoded-workspace>/<session-uuid>.jsonl`. Each line is
a JSON object with a `type` discriminator. The set of files in a workspace
directory grows monotonically as sessions accumulate.

This is the **local** transcript surface — analogous to Cursor's
`~/.cursor/projects/<slug>/agent-transcripts/*.jsonl`. There is no
remote-only surface to research; everything Claude Code writes for a
session lives in the file. (Contrast: Cursor's background-agent chats live
on Cursor's cloud and required the separate
`background-agent-source-strategy.md` research.)

## Filesystem probe (2026-05-18)

Confirmed against this operator's machine:

- `~/.claude/projects/` — top-level dir. One subdirectory per workspace.
- `~/.claude/projects/<encoded-workspace>/` — example:
  `~/.claude/projects/-Users-dallascrilley-Code-agent-session-distillery/`.
  Contains one `.jsonl` per session.
- **Encoding rule:** the workspace dir name is the absolute workspace path
  with `/` replaced by `-`, plus a leading `-` (i.e. the leading `/` of the
  absolute path also becomes `-`). The decoder must restore the leading
  `/` and the internal slashes.
- Filenames: `<uuid>.jsonl`. The UUID is the canonical session id and also
  appears as `sessionId` on every line.
- Adjacent state directories that are NOT needed for transcript ingestion
  in F1-C (out of scope; revisit only if a follow-up needs them):
  - `~/.claude/sessions/` — different session storage; not consulted.
  - `~/.claude/todos/` — todo state per session.
  - `~/.claude/session-aliases/` — alias map.
  - `~/.claude/projects/<workspace>/agent-transcripts/` does NOT exist; the
    transcripts are siblings of the workspace dir, not nested.

## Line-type discrimination

Probed `type` values from real sessions on this machine:

- `last-prompt` — `{ leafUuid, sessionId }`. Session-pointer record only;
  no body, no `cwd`, no `parentUuid`. Appears at the start of a file.
- `permission-mode` — `{ permissionMode, sessionId }`. Session-pointer
  record. Also appears near the start of a file.
- `attachment` — `{ parentUuid, isSidechain, attachment, uuid, timestamp,
  userType, entrypoint, cwd, sessionId, version, gitBranch }`. **First
  occurrence of `cwd` and `sessionId` together — the workspace anchor.**
  Carries `isSidechain` to mark sub-agent activity.
- (Standard, to be confirmed against a longer real session during the
  adapter PR) `user`, `assistant`, `tool_use`, `tool_result`, `summary`,
  `system`. These are the publicly-known Claude Code transcript types and
  match what other readers consume.

### Classifier strategy

The Claude Code classifier table will key on `type`:

| `type` value | Cursor-style intermediate kind | Notes |
|---|---|---|
| `user`, `human` | `user_message` | — |
| `assistant` | `assistant_message` | — |
| `tool_use`, `function_call` | `tool_use_stub` | Extract tool name + input |
| `tool_result`, `result` | `tool_result_stub` | — |
| `attachment` | `event` (kind: `attachment`) | Carries `cwd` and `gitBranch` |
| `last-prompt`, `permission-mode` | `event` (kind: `session-pointer`) | Cleanly skipped from summaries |
| `summary`, `system` | `event` (kind: `system` / `summary`) | Not promoted to user/assistant |
| anything else | `event` | Default catch-all |

Fall-through to `event` is intentional and matches the Cursor adapter's
behaviour.

## Workspace attribution

Two sources of truth, ranked:

1. **`cwd` field on `attachment` (and every user/assistant) record.** Read
   the first record carrying a non-empty `cwd` and use that as the
   canonical workspace path for the session.
2. **Decoded workspace slug from the directory name.** Used as a fallback
   when no record in the file carries `cwd`, and as a cross-check (warn on
   mismatch).

`sessionId` is on every line. The adapter validates that the filename UUID
equals `sessionId`; warn on mismatch but trust the filename as the
canonical id.

## Auxiliary stores

**None required.** `~/.claude/projects/` is self-contained for transcript
ingestion. The Claude Code adapter does **not** read:

- `~/.claude/sessions/`
- `~/.claude/todos/`
- `~/.claude/session-aliases/`
- Any global state file under `~/.claude/`

If a future feature wants project-level usage statistics or todo lifecycle
data, that becomes a separate enrichment surface; it is explicitly out of
scope for F1-C.

## Gotchas

| # | Gotcha | How F1-C handles it |
|---|---|---|
| 1 | First 2–3 lines are session-pointer records (`last-prompt`, `permission-mode`) with no `cwd` or `parentUuid` | Classify as `event` with `kind: "session-pointer"`. Do not treat as malformed. Do not pull `messageText`. |
| 2 | `isSidechain: true` records belong to sub-agent invocations | Keep inline with the parent session id, flag with `sidechain: true` on the intermediate record so summarisation can group/exclude later. Mirrors how Cursor keeps `tool_use_stub` records under the parent session. |
| 3 | `gitBranch` is captured per record | Persist on the intermediate as an optional enrichment field. Not needed for workspace mapping. |
| 4 | Production session files can exceed 10 MB | Stream like Cursor's `parse-transcript.ts` (line-by-line `readline`); never `readFile` the whole transcript. |
| 5 | Workspace path may not exist on disk (deleted project) | Mirror Cursor's `normalizeWorkspaceCandidate` pattern: return the decoded path even if `access` fails; carry `workspacePath: null` only when decoding itself fails. |
| 6 | Symlinks and `.DS_Store` files mixed into `~/.claude/projects/` | Walker skips symlinks and non-`.jsonl` files. |
| 7 | `gitBranch` and other per-record fields may be missing on older sessions | Treat every field as optional. The classifier table is the only required-shape contract. |

## Recommendation

Build the F1-C adapter directly against this surface. Source surfaces
beyond `~/.claude/projects/` are not needed. The adapter shape is:

- `src/adapters/claude-code/discover.ts` — recursive walker for
  `~/.claude/projects/`, filtered to `*.jsonl` siblings of workspace dirs,
  hashing each transcript via `_common/hash.ts`.
- `src/adapters/claude-code/parse-transcript.ts` — `readline`-streamed
  classifier using the table above, sharing extraction helpers with
  `_common/text-extract.ts`.
- `src/adapters/claude-code/workspace-map.ts` — decode the leading-dash
  workspace slug, cross-check against `cwd` on the first qualifying
  record, log mismatches.
- `src/adapters/claude-code/intermediate.ts` — `ClaudeCodeTranscriptRecord`
  type plus the kind discriminator.
- No `enrich-*.ts` (no auxiliary store needed).

## Out of scope for F1-C

- `~/.claude/sessions/`, `~/.claude/todos/`, `~/.claude/session-aliases/`.
- Cross-session stitching of `parentUuid` chains (kept as a future
  reducer enhancement, not an adapter responsibility).
- Sub-agent (`isSidechain`) extraction as separate sessions — kept inline.
- Whole-file reads; the parser must be stream-only.

## Next operator action

After this gate lands, F1-C implements the four files above plus a smoke
fixture under `test/adapters/claude-code/`. F1-C's gate
(`claude-code-adapter`) requires that `node dist/cli.js ingest backfill
--source claude-code` against the fixture produces at least one session
with attributed `projectKey`, one summary, and one extracted learning.
