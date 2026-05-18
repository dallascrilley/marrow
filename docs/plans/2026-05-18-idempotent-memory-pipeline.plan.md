# Idempotent Canonical Memory Pipeline Plan

## Goal

Automate promotion of durable project memory from immutable Cursor transcript sources without human review.

The pipeline should be conservative, reproducible, and idempotent:

```text
source transcripts
  -> deterministic candidates in knowledge/projects/
  -> OpenRouter memory-lint sidecar
  -> post-validated reviewed learnings in knowledge/projects-reviewed/
  -> deterministic finalize/dedupe/quarantine
  -> canonical promoted memory
```

Core rule:

```text
If uncertain, quarantine or reject. Do not remember it canonically.
```

## Current State

Implemented today:

- deterministic candidate extraction in `src/pipeline/extract.ts`
- priority-aware semantic dedupe for deterministic candidates
- `quality review-learnings` command
- `quality apply-learning-review` command
- OpenRouter review helper in `src/pipeline/llm-learning-review.ts`
- strict post-validation before writing `knowledge/projects-reviewed/`

Current reviewed-memory outputs:

- `reports/llm-learning-review.jsonl`
- `reports/llm-learning-review-apply.json`
- `knowledge/projects-reviewed/<project-key>/*.jsonl`

The original deterministic candidates remain untouched in `knowledge/projects/`.

## Idempotency Contract

For the same source material, outputs should be stable when these inputs are unchanged:

- source transcript hash
- deterministic learning candidate payload
- extractor version
- OpenRouter model id
- review prompt version
- validator version
- dedupe/finalize version

Derived artifacts may be deleted and rebuilt. Source transcripts, source hashes, and derivation manifests are the durable evidence.

## Recommended Hashing/Cache Packages

Use small deterministic primitives instead of semantic LLM cache packages.

Recommended dependency:

```bash
npm install json-stable-stringify-without-jsonify
```

Use Node built-in crypto for hashing:

```ts
import { createHash } from "node:crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
```

Avoid semantic cache packages for this layer. The cache must be exact-input based, not similarity based.

## LLM Review Cache

Add a simple content-addressed JSON file cache:

```text
cache/llm-learning-review/<sha256>.json
```

Cache-key input:

```ts
type LearningReviewCacheInput = {
  cache_schema_version: "llm-learning-review-cache-v1";
  model: string;
  prompt_version: string;
  validator_version: string;
  learning_id: string;
  project_key: string;
  kind: string;
  statement: string;
  evidence: string[];
  source_refs: string[];
};
```

Compute:

```text
sha256(stableStringify(cacheInput))
```

Default behavior:

- read cache if present and valid
- otherwise call OpenRouter
- validate response
- write cache atomically

Flags to add:

- `--refresh-llm` — ignore existing cache and overwrite
- `--no-cache` — call model without reading/writing cache
- `--cache-dir <path>` — useful for tests and CI

## Finalize Stage

Add:

```bash
asd quality finalize-reviewed-learnings
```

Inputs:

```text
knowledge/projects-reviewed/
```

Outputs:

```text
knowledge/projects-reviewed-final/
knowledge/projects-quarantine/
reports/reviewed-learning-finalize.json
```

Behavior:

1. clear and rebuild output directories
2. validate reviewed statements again
3. group same-project near duplicates
4. deterministically choose a winner
5. quarantine duplicate losers
6. detect same-subject opposing policy statements
7. quarantine all contradiction/supersession participants
8. write clean winners to reviewed-final
9. write stable sorted reports

Contradiction policy is automatic:

```text
possible contradiction or supersession = promote none for that subject
```

## Promotion Stage

Add:

```bash
asd quality promote-reviewed-learnings --apply
```

Default is dry-run. With `--apply`, clear and rebuild:

```text
knowledge/projects-canonical/
```

from:

```text
knowledge/projects-reviewed-final/
```

Write:

```text
reports/reviewed-learning-promote.json
```

## One-command Pipeline

Add:

```bash
asd quality memory-pipeline --model openai/gpt-5-nano --apply
```

Internal steps:

1. `quality audit`
2. `quality review-learnings`
3. `quality apply-learning-review`
4. `quality finalize-reviewed-learnings`
5. `quality promote-reviewed-learnings --apply`

Write:

```text
reports/memory-pipeline.json
```

Expected policy:

- duplicate losers are quarantined, not failures
- contradiction groups are quarantined, not failures
- infrastructure failures fail the command
- excessive quarantine ratio can fail as extraction drift
- canonical count of zero for non-empty input should fail

## Validation Targets

Add tests for:

- exact cache-key stability regardless of object key order
- cache hit avoids OpenRouter call
- `--refresh-llm` bypasses cache
- invalid cache is rejected safely
- duplicate CSP statements choose one winner
- psycopg SQL composition duplicates choose one winner
- mixed error-channel add/remove policy conflict quarantines all participants
- truncation/ellipsis validation quarantines statements
- dry-run promotion does not write canonical output
- apply promotion writes stable canonical output
- repeated runs produce byte-identical outputs

## Current Working Edge

Next implementation slice should start with the cache because it makes the LLM sidecar idempotent before adding finalize/promotion stages.
