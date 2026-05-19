# v2 Test Fixtures

Inputs and golden outputs for v2 schema work ([td-839bd1] and
downstream). Curated, scrubbed, committed.

## What goes here

```
test/fixtures/v2/
├── transcripts/        # raw inputs, one transcript per file
│   ├── cursor-short.jsonl
│   ├── cursor-long.jsonl
│   ├── codex-cli-typical.jsonl
│   └── pi-chat.jsonl
├── golden/             # expected outputs from the pipeline
│   ├── cursor-short.bundle.yaml
│   ├── cursor-short.instincts/   # one yaml per instinct
│   └── …
├── migration/          # ADR-0001 migration test inputs
│   ├── v1-blobs/       # sample asd-learnings/*.md
│   └── expected-v2/    # expected instinct store after `asd migrate`
└── README.md           # this file
```

## Capture procedure

Fixtures are captured from real transcripts then scrubbed. Do not
commit transcripts before running the scrubber.

1. **Pick a representative session** for each adapter. Aim for one
   short (5–10 turns) and one long (50+ turns) at minimum. Avoid
   sessions touching credentials, secrets, customer data, or any
   client work.

2. **Copy the raw transcript** to `test/fixtures/v2/transcripts/<adapter>-<descriptor>.jsonl`.

3. **Run the scrubber** (to be written as part of fixture capture
   work, [td-30af15]):

   ```bash
   asd dev scrub-fixture test/fixtures/v2/transcripts/<file>.jsonl
   ```

   Scrubber removes:
   - Absolute filesystem paths (replaced with `<HOME>/code/example`).
   - Tokens matching common secret patterns (API keys, OAuth, basic
     auth, JWT).
   - Email addresses (replaced with `user@example.com`).
   - Anything inside `<redacted>...</redacted>` markers.
   - Real project / client / hostname strings flagged in a
     project-local denylist at `~/.asd-fixture-denylist`.

4. **Diff before committing.** `git diff` the staged fixture, eyeball
   every changed line. Scrubbers miss things.

5. **Generate golden outputs.** Once schema work lands, run:

   ```bash
   asd dev capture-golden test/fixtures/v2/transcripts/<file>.jsonl \
     --out test/fixtures/v2/golden/
   ```

   Commit the golden outputs alongside the inputs.

## Why fixtures matter for v2

The v2 epic refactors the storage unit (ADR-0001). Without fixtures,
"the schema works" is opinion. With fixtures, "the schema works"
means the same transcript produces the same instinct set on every
run.

The migration test (`v1-blobs/` → `expected-v2/`) is the only way to
verify the migration script doesn't silently lose learnings. Capture
this set carefully.

## Fixture coverage matrix (target for v2 readiness)

| Adapter | Short | Long | Edge cases |
|---|---|---|---|
| cursor | ✅ todo | ✅ todo | tool-heavy, error-heavy, multi-day |
| codex-cli | ✅ todo | ✅ todo | nested sub-agents, long file edits |
| pi | ✅ todo | — | mobile chat-style, no tool calls |

Minimum to unblock [td-839bd1]: one short + one long per adapter.
Edge cases can land alongside the features they cover.

## Privacy contract

Fixtures are committed to the public-ish repo. Anything that gets
through the scrubber lives in git history forever. When in doubt,
exclude. Add a denylist entry in `~/.asd-fixture-denylist` and
re-scrub.

Project, client, and hostname strings worth pre-denylisting:

```
# ~/.asd-fixture-denylist (one pattern per line)
RealNewsPR
realnewspr.com
crilley
# …
```

This file is operator-private and not part of the repo.

## TODO

- [ ] Implement `asd dev scrub-fixture` (part of [td-30af15]).
- [ ] Implement `asd dev capture-golden` (after [td-839bd1] schema is
      stable).
- [ ] Capture initial fixture set (one short + one long per adapter).
- [ ] Capture migration test set (~5 representative v1 blobs).
