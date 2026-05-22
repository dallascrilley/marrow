# ASD Session Index Export Contract

Status: current v1 contract
Schema version: `asd.session_index.v1`
Command: `node dist/cli.js export-index`
Output: `<runtime-root>/index/session-index.jsonl`

The session index is a JSONL handoff format for consumers that need one
readable title and next action per summarized source session. Each line is one
summarized session record.

## Source Selection

`export-index` reads immutable session manifests from
`<runtime-root>/sources/manifests/*.json` and joins each manifest to the
`artifact_paths.summary_json_path` file recorded in that manifest.

The export does not walk source transcript directories and does not re-summarize
sessions. A session is exportable only after the archive phase has written a
manifest that contains:

- `session.source_path`
- `session.source_tool`
- `session.session_id`
- `artifact_paths.summary_json_path`
- `generated_at`

## Record Schema

Required top-level fields:

- `v`: numeric contract version, currently `1`.
- `source_path`: exact absolute source transcript path stored in the manifest.
- `source_uuid`: source-native session id derived from the source path.
- `source_tool`: source tool id, currently `claude-code`, `codex-cli`, `cursor`,
  or `pi`.
- `asd_session_id`: asd's internal summarized session id.
- `topic`: title text from `summary.json`.
- `next_step`: next step text from `summary.json`.
- `summary_json_path`: absolute path to the source `summary.json`.
- `updated_at`: manifest generation timestamp.

## Source UUID Rules

`source_uuid` is derived without changing `source_path`:

- `claude-code`: the `.jsonl` filename stem.
- `codex-cli`: the UUID suffix from a rollout filename, with the leading
  `rollout-<timestamp>-` prefix removed when present.
- `cursor` and `pi`: the `.jsonl` filename stem.

Consumers that join against live session files must use `source_path`, not
`source_uuid`, as the primary key. `source_path` is intentionally preserved
exactly as asd read it from disk; the exporter validates that it is absolute but
does not normalize or rewrite it.

## Example Record

```json
{
  "v": 1,
  "source_path": "/Users/example/.codex/sessions/2026/05/22/rollout-2026-05-22T15-45-14-019e516f-5f85-7550-a1b9-adcbab812b33.jsonl",
  "source_uuid": "019e516f-5f85-7550-a1b9-adcbab812b33",
  "source_tool": "codex-cli",
  "asd_session_id": "rollout-2026-05-22T15-45-14-019e516f-5f85-7550-a1b9-adcbab812b33",
  "topic": "Read the handoff and complete tasks.",
  "next_step": "No open next step recorded.",
  "summary_json_path": "/Users/example/.agent-session-distillery/summaries/by-session/rollout-2026-05-22T15-45-14-019e516f-5f85-7550-a1b9-adcbab812b33/summary.json",
  "updated_at": "2026-05-22T20:00:00.000Z"
}
```

## Consumer Assumptions

Downstream consumers should:

- Treat `source_path` as the join key.
- Preserve `source_path` byte-for-byte when comparing against local session
  file paths.
- Ignore unknown future fields.
- Reject records where `v` is not `1` unless explicitly upgraded.
- Treat `summary_json_path` as provenance, not as a durable cross-machine path.
- Use `topic` as display text only after normal UI escaping/truncation.

## Versioning

The contract version is the numeric `v` field. Additive fields may appear within
the same version when consumers can safely ignore them. Any change that renames
fields, changes `source_path` semantics, or changes the primary join key requires
a new version.

## Verification

Current proof is covered by:

- `node --test test/cli.test.mjs`
- `node dist/cli.js export-index`

