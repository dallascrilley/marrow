# Wiki Memory Export Contract

Status: current v1 contract
Schema version: `asd.wiki_memory.v1`
Command: `node dist/cli.js memory export-wiki`
Output: `<runtime-root>/exports/wiki-memory/reviewed-memory.jsonl`

The wiki export is a JSONL handoff format for downstream memory importers. Each
line is one project-learning record.

## Source Selection

`memory export-wiki` prefers reviewed project learnings when they exist:

1. If `<runtime-root>/knowledge/projects-reviewed/` exists and contains entries,
   export from that reviewed namespace.
2. Otherwise, fall back to deterministic project learnings under
   `<runtime-root>/knowledge/projects/`.

The source is visible in `review.source`:

- `reviewed-export` means the record came from `knowledge/projects-reviewed/`.
- `deterministic-export` means the record came from `knowledge/projects/`.

## Record Schema

Required top-level fields:

- `schema_version`: must be `asd.wiki_memory.v1`.
- `id`: stable `sha256:<hex>` record id.
- `kind`: currently always `project_learning`.
- `project`: project identity object.
- `title`: short learning title.
- `body`: importer-facing learning text.
- `evidence`: provenance and source evidence.
- `review`: review/export source metadata.
- `created_at`: deterministic timestamp inferred from the first source ref line.

Required `project` fields:

- `key`: project key from the source learning scope.
- `root`: currently `null`; reserved for a future project-root handoff.

Required `evidence` fields:

- `learning_id`: source learning id.
- `promotion_basis`: reason the learning was promoted.
- `evidence`: source evidence snippets.
- `source_refs`: source transcript references with `source_path`, `source_hash`,
  `session_id`, `turn_id`, `event_id`, and `line`.

Required `review` fields:

- `verdict`: currently always `keep`.
- `confidence`: source learning confidence.
- `source`: `reviewed-export` or `deterministic-export`.

## Stable ID Inputs

The record id is the SHA-256 digest of a stable JSON payload containing:

- `schema_version`
- `learning_id`
- `project_key`
- `title`
- `body`
- `source_refs`

Changing review wording, source refs, title, or source learning id intentionally
changes the exported record id. Changing runtime paths outside `source_refs`
does not affect the id.

## Example Record

```json
{
  "schema_version": "asd.wiki_memory.v1",
  "id": "sha256:75bfd1d21945d1990c86d4c6992a7877785e5ade6a4485d100fe97ecf287643a",
  "kind": "project_learning",
  "project": {
    "key": "agent-session-distillery",
    "root": null
  },
  "title": "Decision: I decided to keep the reducers local to the pipeline layer for now.",
  "body": "Use reviewed project learnings for wiki export proof.",
  "evidence": {
    "learning_id": "session-e2e:project:decision:session-e2e:turn-0000:decision:000002",
    "promotion_basis": "Derived from an explicit implementation decision in the reduced event stream. LLM-reviewed with rewrite verdict.",
    "evidence": [
      "I decided to keep the reducers local to the pipeline layer for now."
    ],
    "source_refs": [
      {
        "source_path": "/tmp/.../agent-transcripts/session-e2e.jsonl",
        "source_hash": "sha256:371971ebc817fd899095323ceb8cc273aafab588541f2eec00682c3c91d09b78",
        "session_id": "session-e2e",
        "turn_id": "session-e2e:turn-0000",
        "event_id": "session-e2e:turn-0000:decision:000002",
        "line": 2
      }
    ]
  },
  "review": {
    "verdict": "keep",
    "confidence": "medium",
    "source": "reviewed-export"
  },
  "created_at": "1970-01-01T00:00:02.000Z"
}
```

## Importer Assumptions

Downstream importers should:

- Treat `id` as the upsert/deduplication key.
- Ignore unknown future fields.
- Reject records with an unknown `schema_version` unless explicitly upgraded.
- Preserve `evidence.source_refs` so exported memory can be traced back to a
  source transcript line.
- Prefer `reviewed-export` records over deterministic records if both are
  available for the same learning.
- Treat `created_at` as a deterministic ordering hint, not the original chat
  timestamp.

## Verification

Current proof:

- Reviewed-memory export summary:
  `/tmp/agent-session-distillery/2026-05-18_reviewed-memory-export/SUMMARY.md`
- One-command dry-run proof:
  `/tmp/agent-session-distillery/2026-05-18_reviewed-memory-export/05-memory-pipeline-dry-run.json`
