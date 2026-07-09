# Workflow mining

Mine distilled sessions for durable workflow guidance without writing skills, rules,
or docs automatically.

## Command

```bash
npm run asd -- workflow mine --days 7 --json
npm run asd -- workflow mine --days 30 --source cursor --limit 20
npm run asd -- workflow mine --days 30 --cluster validation --recommendation adopt --json
npm run asd -- workflow review --days 30 --limit 10
npm run asd -- workflow show wf_cd61247b3c --days 30
npm run asd -- workflow apply wf_cd61247b3c --target rule --dry-run --days 30
npm run asd -- workflow judge --limit 5 --max-per 5/24h --max-usd 1/24h
```

Use `npm run asd -- ...` from a source checkout: it rebuilds the gitignored
`dist/` tree before invoking the CLI, so newly merged workflow subcommands and
flags are available immediately. Installed `asd` binaries still run the built
`dist/cli.js` that was present at install time.

`workflow mine` reads the session index, summaries, and reduced-session artifacts.
It emits reviewable candidates with:

- `candidate_id`
- `cluster` (`shipping`, `review`, `debugging`, `validation`, etc.)
- `artifact_kind` (`skill`, `rule`, `workflow_doc`, or `none`)
- `confidence` (`strong`, `medium`, `weak`, or `contradicted`)
- `source_tier` (`keyword` or `instinct`)
- `recommendation` (`adopt`, `consider`, `dismiss`, or `ask`)
- parent-session evidence (`asd_session_id`, source, topic, updated timestamp)
- supporting/contradicting evidence counts and capped sanitized excerpts; generic policy boilerplate may keep the count while omitting the excerpt

## Interpretation

- `strong` candidates may become skills or rules after review.
- `medium` candidates are advisory and should be compared against more sessions.
- `weak` candidates are dismissed by default and use `artifact_kind: "none"`.
- `contradicted` candidates must be resolved by the operator before writing any artifact.

`--cluster` filters to one workflow cluster before `--limit`; `--recommendation`
filters to one recommendation before `--limit`. `--limit` truncates the final
candidate list only. Keyword-tier mining is bounded by the built-in marker rule
table, so `--limit` is mostly useful once instinct-sourced candidates are present.

Established and proven global workflow instincts also appear as `source_tier: "instinct"` candidates. Proven instincts rank as strong; established instincts
rank as medium. At the same confidence, instinct-tier candidates sort ahead of
keyword-tier candidates.

`workflow judge` is LLM-gated and budgeted. It judges undecided candidates,
reuses the shared judge cache, records OpenRouter telemetry, and appends a
`judged` decision note with wording/artifact/confidence advice. Cache hits do
not consume count or USD budget; budget-exhausted runs stop before paid calls.

`workflow apply` is draft-only in v1. It requires `--dry-run` and writes a
Markdown draft plus JSON apply report under `reports/workflow-drafts/` without
modifying skills, rules, docs, or vault files. Dismissed and already-encoded
candidates are refused.

## Privacy boundary

The report cites ASD session IDs and topics. It does not include local transcript
paths or raw private transcript bodies.
