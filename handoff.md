# Handoff — post v1 launch

## Current state

Branch `main` is clean and at `a8cbd9f`. All P0 and P1 launch gates in
`LAUNCH_CRITERIA.md` are validated as of 2026-05-18, with proof artifacts
linked from `docs/launch-proof-index.md`. `npm test` passes 71/71 locally and
on GitHub Actions for Node 22.

The earlier feature branches (`feat/wiki-memory-export-import`,
`feat/quality-improvements`) have been merged. There is no in-flight uncommitted
work in this repo.

## Most recent landings

- `a8cbd9f` Add local Cursor ingestion demo
- `ac2baf0` Document wiki memory export contract
- `c88f17b` Add memory pipeline dry run
- `6c16187` Add retention decision report
- `4402a28` Publish launch proof index

## Remaining work

Only the P2 fast-follow item is open:

- `background-agent-source-research` — research note now exists at
  `docs/research/background-agent-source-strategy.md`. Mark validated in
  `LAUNCH_CRITERIA.md` once it has been read by an operator.

There is no scheduled v1.1 scope yet. Candidates if scope reopens:

- Wire the wiki-memory exporter into a scheduled local job.
- Replace the manual rerun commands in `docs/launch-proof-index.md` with a
  reproducible smoke script.
- Investigate the background-agent strategy options from the research note and
  pick one before any adapter implementation.

## Verification commands

```bash
npm test
node dist/cli.js --help
```

## Do not

- Do not re-open the four `td` review items as if they were active work; they
  shipped on 2026-05-18.
- Do not implement a background-agent adapter before an operator approves the
  source strategy in `docs/research/background-agent-source-strategy.md`.
- Do not run `delete apply --apply` against the real runtime root during
  smoke or demo work; use `AGENT_SESSION_DISTILLERY_ROOT` sandboxes.
