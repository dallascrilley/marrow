# Workflow mining

Mine distilled sessions for durable workflow guidance without writing skills, rules,
or docs automatically.

## Command

```bash
asd workflow mine --days 7 --json
asd workflow mine --days 30 --source cursor --limit 20
asd workflow mine --days 30 --cluster validation --recommendation adopt --json
asd workflow review --days 30
asd workflow show wf_cd61247b3c --days 30
asd workflow apply wf_cd61247b3c --target rule --dry-run --days 30
```

`workflow mine` reads the session index, summaries, and reduced-session artifacts.
It emits reviewable candidates with:

- `candidate_id`
- `cluster` (`shipping`, `review`, `debugging`, `validation`, etc.)
- `artifact_kind` (`skill`, `rule`, `workflow_doc`, or `none`)
- `confidence` (`strong`, `medium`, `weak`, or `contradicted`)
- `recommendation` (`adopt`, `consider`, `dismiss`, or `ask`)
- parent-session evidence (`asd_session_id`, source, topic, updated timestamp)
- supporting/contradicting evidence counts and capped sanitized excerpts

## Interpretation

- `strong` candidates may become skills or rules after review.
- `medium` candidates are advisory and should be compared against more sessions.
- `weak` candidates are dismissed by default and use `artifact_kind: "none"`.
- `contradicted` candidates must be resolved by the operator before writing any artifact.

`--cluster` filters to one workflow cluster before `--limit`; `--recommendation`
filters to one recommendation before `--limit`. `--limit` truncates the final
candidate list only. Keyword-tier mining is bounded by the built-in marker rule
table, so `--limit` is mostly useful once instinct-sourced candidates are present.

`workflow mine` is intentionally read-only. Use it to prepare a candidate list,
then write or update skills/rules/docs through the normal reviewed workflow.

`workflow apply` is draft-only in v1. It requires `--dry-run` and writes a
Markdown draft plus JSON apply report under `reports/workflow-drafts/` without
modifying skills, rules, docs, or vault files. Dismissed and already-encoded
candidates are refused.

## Privacy boundary

The report cites ASD session IDs and topics. It does not include local transcript
paths or raw private transcript bodies.
