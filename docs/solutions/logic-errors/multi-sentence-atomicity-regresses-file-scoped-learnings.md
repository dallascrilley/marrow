---
title: Strict multi-sentence atomicity rejected legitimate file-scoped learnings
date: 2026-06-15
category: logic-errors
module: pipeline/extract.ts
tags: [extraction, learning-atomicity, file-scoped, regression]
severity: medium
---

# Strict multi-sentence atomicity rejected legitimate file-scoped learnings

## Problem

While enforcing atomic learning statements (one concise sentence), a blanket
rejection of any multi-sentence candidate caused a regression in
`test/integration/live-quality-regression.test.mjs`. Session
`58d2e1f7-50af-4cd5-921c-962c1b061d9d`, which should be deletion-ready because
it contains a concrete fix tied to a file, produced no project learnings and
flipped to `pending_artifacts`.

The file-scoped candidate statement was:

```text
In shared/logging/__init__.py, resolved by adding configure_logging to the main
repo's shared/logging/__init__.py. The worktree branch had it, but the main
branch did not, so the IDE couldn't find the symbol when resolving imports.
```

It has two sentences, so the `/.+[.!?]\s+./` heuristic rejected it entirely.

## What didn't work

Rejecting all multi-sentence statements regardless of kind. File-scoped pattern
learnings often include a short explanatory second sentence that does not make
the statement non-durable; dropping the whole candidate loses concrete,
project-specific signal.

## Solution

In `src/pipeline/extract.ts` `finalizeProjectLearningCandidate`:

- Reject multi-sentence statements only for `decision` and `failure_mode`
  candidates.
- For `pattern` and `workflow` candidates, truncate to the first sentence
  instead of dropping the candidate.

```typescript
function hasMultipleSentences(value: string): boolean {
  return /.+[.!?]\s+[A-Z0-9].+/.test(value);
}

function firstSentence(value: string): string {
  const match = value.match(/^(.+?[.!?])(?=\s+[A-Z0-9]|$)/);
  return match?.[1]?.trim() ?? value;
}

let atomicStatement = statement;
if (hasMultipleSentences(statement) && !statement.includes(";")) {
  if (candidate.kind === "decision" || candidate.kind === "failure_mode") {
    return null;
  }
  atomicStatement = firstSentence(statement);
}
atomicStatement = truncateInline(atomicStatement, MAX_LEARNING_STATEMENT_LENGTH);
```

## Why it works

Decisions and failures benefit most from strict atomicity because multi-sentence
statements in those kinds usually contain separate, unpromotable ideas.
File-scoped patterns derive their durability from the concrete file path; the
first sentence already captures the actionable outcome, and the rest is
context that can be discarded without losing the learning.

## Prevention

When adding broad rejection heuristics to extraction, test against the live
regression corpus (`test/integration/live-quality-regression.test.mjs`) before
assuming the filter is safe for all learning kinds. Prefer truncation over
rejection when the first sentence carries the durable signal.
