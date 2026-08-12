# Skill adherence report

Evaluate whether hub skills are followed in real distilled sessions.

## Prerequisites

1. Ingested corpus with summaries and reduced transcripts:
   ```bash
   marrow ingest sync --source claude-code --resume
   marrow export-index
   ```
2. Skill installed under `~/.claude/skills/<id>/`, `~/.cursor/skills/<id>/`, or
   another shared skills directory configured in your agent harness.

## Commands

```bash
# Sessions whose summaries mention the skill id
marrow skill evidence git --limit 10

# Checklist adherence score + improvement suggestions
marrow skill report git --limit 5
marrow skill report git --json > /tmp/git-skill-report.json
```

Fixture skill for tests: `test/fixtures/skills/demo-skill/`.

## Interpreting scores

- **Adherence score** — average across relevant sessions (summary mention and/or
  transcript invocation). Range 0–1.
- **Checklist hits** — SKILL.md bullet steps matched in reduced session text
  (reference-path bullets under `./references/` are excluded from scoring).
- **Suggestions** — heuristic gaps: never-observed steps, rarely followed steps,
  summary-only mentions, sessions with failures.

Start with router skills that match many sessions (`git`, `handoff`) or narrow
skills with explicit triggers (`verify-before-complete`).

## Limitations (v2 heuristic)

- No LLM judge; word-overlap matching only.
- Broad skill ids (e.g. `git`) match many sessions by substring.
- Improvement suggestions are advisory; edit SKILL.md manually.
