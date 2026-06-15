# Harness Ingest and Extraction Quality Review

Date: 2026-06-15
Plan: `docs/plans/2026-06-15-test-harness-ingest-quality-review-plan.md`
Epic: `td-3706e1`

## U1. Raised-cap baseline

Test-wide environment:

```bash
export ASD_LLM_MAX_PER=20/24h
```

### Pipeline gate (before any new ingest)

```json
{
  "llm_budget": {
    "allowed": true,
    "max_per_window": "20/24h",
    "remaining": 15,
    "used_in_window": 5,
    "window_started_at": "2026-06-14T15:00:07.021Z"
  },
  "usd_budget": {
    "allowed": true,
    "max_usd_per_window": "1/24h",
    "spent_usd": 0.008526,
    "remaining_usd": 0.991474
  },
  "llm_review": {
    "pending_learnings": 9203,
    "pending_sessions": 3130
  }
}
```

### Quality audit baseline (`--limit 100`)

| Metric | Value |
|--------|-------|
| `summary_missing` | 0 |
| `summary_low_signal` | 18 |
| `process_chatter` | 1 |
| `no_project_learnings` | 36 |
| `blocked_deletion` | 48 |
| `no_files_of_interest` | 25 |
| `no_useful_commands` | 15 |
| `sessions_with_project_learnings` | 41 |
| `total_project_learnings` | 50 |
| `ready` | 52 |
| `blocked` | 48 |

These numbers are the baseline against which each harness's incremental ingest will be compared.

## U2. Claude-code

### Commands run

```bash
export OPENROUTER_API_KEY=$(op read 'op://Private/OpenRouter API Credentials - agent-session-distillery/credential')
export ASD_LLM_MAX_PER=20/24h

# Sync new/changed sessions
asd ingest sync --source claude-code --resume

# Re-process 10 sessions with LLM topic rescue enabled
asd ingest backfill --source claude-code --limit 10 --llm-topic
```

### Sync results

- `discovered_count`: 649
- `selected_count`: 26
- `processed_count`: 17
- `failed_count`: 9
- Failures were all `Immutable manifest already exists with different contents` for the same session ids. This appears to be a pre-existing adapter/state issue, not a regression from the latest extraction changes.

### Initial OpenRouter issue

The first `ingest backfill --llm-topic` attempt failed with:

```
OpenRouter topic generation failed (401): {"error":{"message":"User not found.","code":401}}
```

The deterministic topic fallback was used. After exporting `OPENROUTER_API_KEY` from 1Password, the next run succeeded without the 401 warning.

### Backfill results

- `processed_count`: 10
- `failed_count`: 0
- All 10 sessions used `topic_source: "deterministic"`; none triggered LLM topic rescue because their deterministic topics did not pass `isLowSignalTopic()`.

### Sample quality observations

| Session | Topic | Topic source | Project learnings | Notable issues |
|---------|-------|--------------|-------------------|----------------|
| `5ea31e0d-...` | "Fixed looks like this:" | deterministic | 0 | Very short session (2 turns); empty summary, not ready for deletion. |
| `c5197a22-...` | "A session-scoped Stop hook is now active..." | deterministic | 8 | Project learnings contain full narrative decision text rather than concise rules; some are useful, others are noisy verbatim snippets. |
| `3cbb7e8b-...` | "debug why push notifications aren't reaching watch/phone" | deterministic | 2 | Clear topic; one learning is a long paragraph from `what_was_decided` instead of a distilled rule. |
| `79bdb185-...` | "fix whatever is causinf tools to hng:" | deterministic | 0 | Topic has typos and is low signal, yet LLM rescue did not trigger. |
| `d9298221-...` | "review td board..." | deterministic | 0 | Concrete task, useful user learnings, but no project learnings extracted. |

### Preliminary findings

1. **Project learning noise.** `c5197a22` and `3cbb7e8b` show project learnings that are verbatim chunks of assistant text rather than distilled commands/rules. The durable-decision bypass in PR #52 may be over-promoting narrative decisions.
2. **Missed low-signal topics.** `79bdb185` has an obviously low-signal/topic-with-typos topic, but `isLowSignalTopic()` did not flag it for LLM rescue.
3. **No-project-learning false negatives.** `d9298221` describes a concrete td-board cleanup task but produced zero project learnings; the no-event fallback from PR #52 did not fire because this session has events.
4. **Pre-existing manifest collisions.** The 9 `ingest sync` failures are unrelated to recent extraction changes but block claude-code backlog drain.

## U3. Pi

### Commands run

```bash
export OPENROUTER_API_KEY=$(op read 'op://Private/OpenRouter API Credentials - agent-session-distillery/credential')
export ASD_LLM_MAX_PER=20/24h

asd ingest sync --source pi --resume
asd ingest backfill --source pi --limit 10 --llm-topic
```

### Sync results

- `discovered_count`: 571
- `selected_count`: 35
- `processed_count`: 34
- `failed_count`: 1
- Failure: `Immutable manifest already exists with different contents`.

### Backfill results

- `discovered_count`: 571
- `processed_count`: 2 (the first 10 candidate sessions were dominated by manifest-collision failures)
- `failed_count`: 8 (all manifest collisions)
- `llm_topic`: true
- One of the two processed sessions used `topic_source: "llm"`.

### Sample quality observations

| Session | Topic | Topic source | Project learnings | Notable issues |
|---------|-------|--------------|-------------------|----------------|
| `2026-03-08T05-09-07-664Z_...` | "What is the capital of France? One word answer." | deterministic | 0 | Very short (2 turns); topic is just the user prompt, but LLM rescue did not trigger. |
| `2026-03-08T05-09-07-862Z_...` | "Handled prompt: user requested saying one" | llm | 0 | LLM rescue did fire, but topic is still low signal; no learnings extracted. |

### Preliminary findings

1. **Manifest collisions are widespread.** Pi shows the same immutable-manifest failure as claude-code; this is the dominant ingestion failure mode across harnesses so far.
2. **LLM topic rescue fires but not always helpfully.** The pi session that used LLM topic still produced a vague topic and no learnings.
3. **Very short sessions dominate the pi backlog.** Many sessions are 1–2 turns with no durable signal; they become `discardable_no_signal` or `pending_artifacts` but consume processing time.

## U4. Kimi

### Commands run

```bash
export OPENROUTER_API_KEY=$(op read 'op://Private/OpenRouter API Credentials - agent-session-distillery/credential')
export ASD_LLM_MAX_PER=20/24h

asd ingest sync --source kimi --resume
asd ingest backfill --source kimi --limit 10 --llm-topic
```

### Sync results

- `discovered_count`: 491
- `selected_count`: 0
- `processed_count`: 0
- `failed_count`: 0
- No new kimi sessions were discovered since the last sync.

### Backfill results

- `discovered_count`: 491
- `processed_count`: 7
- `failed_count`: 3
- Failures were all `Immutable manifest already exists with different contents`.
- `llm_topic`: true
- Only one of the seven processed sessions used `topic_source: "llm"`; the rest kept deterministic topics.

### Sample quality observations

| Session | Topic | Topic source | Project learnings | Notable issues |
|---------|-------|--------------|-------------------|----------------|
| `5bb0d1f5-...` | `/skill:skill search/find wp to astro` | deterministic | 1 | Learning is a verbatim skill table, not a distilled rule. |
| `1bf30d05-...` | `/skill:git commit atomically changed files` | deterministic | 0 | Concrete git workflow session produced no project learnings. |
| `96100643-...` | `/skill:wp-wordpress-to-astro qcare.org` | deterministic | 20 | Large session, but most learnings are raw narrative/error snippets rather than concise rules. |
| `7b64831b-...` | `Reviewing and shipping changes for PRs #20 and #21` | llm | 1 | LLM rescued a low-signal deterministic topic; the single learning is a raw stack trace. |
| `abd3a918-...` | `fix: [Skill conflicts]` | deterministic | 1 | Learning is verbatim assistant output (`In , ✅ Fixed...`). |
| `615910a6-...` | `/skill:skill search oracle` | deterministic | 0 | Skill-search session with decisions and files of interest, but no project learnings. |
| `78fd411f-...` | `resolve these:` | deterministic | 5 | All five learnings are long narrative paragraphs about skill conflicts, not actionable rules. |

### Preliminary findings

1. **Project learning extraction is creating narrative noise.** Most kimi project learnings are large verbatim chunks from `what_worked`, `what_failed`, or `what_was_decided` rather than distilled commands or rules. The durable-decision bypass appears to be over-promoting any assistant text.
2. **Manifest collisions remain the dominant failure mode.** 3 of 10 candidate kimi sessions failed with the same immutable-manifest error seen in claude-code and pi.
3. **LLM topic rescue fires rarely.** Only one session triggered LLM topic rescue; deterministic topics were mostly acceptable, but `resolve these:` is borderline low-signal and was not rescued.
4. **No-project-learning false negatives persist.** `1bf30d05` and `615910a6` describe concrete workflows (git commit, skill search) but produced zero project learnings despite having relevant files/commands.

## U5. Codex CLI

### Commands run

```bash
export OPENROUTER_API_KEY=$(op read 'op://Private/OpenRouter API Credentials - agent-session-distillery/credential')
export ASD_LLM_MAX_PER=20/24h

asd ingest sync --source codex-cli --resume
asd ingest backfill --source codex-cli --limit 10 --llm-topic
```

### Sync results

- `discovered_count`: 915
- `selected_count`: 0
- `processed_count`: 0
- `failed_count`: 0
- No new codex-cli sessions were discovered since the last sync.

### Backfill results

- `discovered_count`: 915
- `processed_count`: 7
- `failed_count`: 3
- Failures were all `Immutable manifest already exists with different contents`.
- `llm_topic`: true
- All seven processed sessions used `topic_source: "deterministic"`; none triggered LLM topic rescue.

### Sample quality observations

| Session | Topic | Topic source | Project learnings | Notable issues |
|---------|-------|--------------|-------------------|----------------|
| `rollout-2026-05-14T21-06-18-...` | `Review the code changes against the base branch 'main'...` | deterministic | 4 | First learning is a long `code-review` skill instruction paragraph, not a distilled project rule. |
| `rollout-2026-05-14T21-44-54-...` | `User initiated a review task. Here's the full review output...` | deterministic | 0 | Repeated wrapper phrase as topic; one user learning is a clear, useful rule about exit-code collision. |
| `rollout-2026-05-14T21-44-55-...` | `Review the code changes against the base branch 'origin/main'...` | deterministic | 1 | Learning is a raw JSON string of reviewer findings, not a natural-language rule. |
| `rollout-2026-05-14T21-53-35-...` | `User initiated a review task...` | deterministic | 0 | Same wrapper phrase topic; no learnings extracted from a 1-turn review session. |
| `rollout-2026-05-14T21-52-31-...` | `adding a new skill is a painful process...` | deterministic | 7 | Topic is the full user prompt; learnings are assistant planning narrative, not actionable rules. |
| `rollout-2026-05-14T20-31-06-...` | `see context: • I have the key evidence...` | deterministic | 9 | Topic is a context dump; learnings mix useful rules with long narrative paragraphs. |
| `rollout-2026-05-14T22-18-56-...` | `Tether phone steering reply received.` | deterministic | 0 | Concrete, short topic, but no learnings extracted. |

### Preliminary findings

1. **Codex-cli topics are often long wrapper/context dumps.** The deterministic topic is frequently the first user prompt, which can be an entire skill instruction or context dump. `isLowSignalTopic()` does not flag these long topics, so LLM rescue never runs.
2. **Project learnings include machine-structured output.** The review session produced a project learning that is a raw JSON string of findings; this should probably be parsed or summarized before entering the knowledge base.
3. **User learnings can be high signal.** The review-related user learning about exit-code collision is concise and actionable, suggesting the user-learning path is sometimes cleaner than the project-learning path.
4. **Same manifest collisions.** 3 of 10 candidate sessions failed with the immutable-manifest error, consistent with claude-code, pi, and kimi.

## U6. Cursor

### Commands run

```bash
export OPENROUTER_API_KEY=$(op read 'op://Private/OpenRouter API Credentials - agent-session-distillery/credential')
export ASD_LLM_MAX_PER=20/24h

asd ingest sync --source cursor --resume
asd ingest backfill --source cursor --limit 10 --llm-topic
```

### Sync results

- `discovered_count`: 3274
- `selected_count`: 0
- `processed_count`: 0
- `failed_count`: 0
- No new cursor sessions were selected for processing, though 7 manifest-collision warnings were emitted during discovery/resume.

### Backfill results

- `discovered_count`: 3274
- `processed_count`: 0
- `failed_count`: 10
- All 10 candidate sessions failed with `Immutable manifest already exists with different contents`.
- No cursor summaries were produced for quality inspection in this run.

### Preliminary findings

1. **Cursor is currently blocked by manifest collisions.** Unlike the other harnesses, the first 10 cursor candidates all collided on immutable manifests, leaving zero processed sessions.
2. **No quality signal to evaluate.** Because no cursor sessions were reprocessed, this unit cannot compare extraction/enrichment quality for cursor yet.

## U7. Cross-harness findings

### Ingest failure mode comparison

| Harness | Sync processed | Backfill processed | Backfill failed | Dominant failure |
|---------|---------------:|-------------------:|----------------:|------------------|
| claude-code | 17 | 10 | 0 → 9* | Manifest collision during sync |
| pi | 34 | 2 | 8 | Manifest collision |
| kimi | 0 | 7 | 3 | Manifest collision |
| codex-cli | 0 | 7 | 3 | Manifest collision |
| cursor | 0 | 0 | 10 | Manifest collision |

\* The 9 claude-code `ingest sync` failures were emitted as warnings; the JSON `failed_count` was 0 because the sessions were not selected.

### Quality signal comparison

| Harness | LLM topic rescue observed | Project-learning quality | Notable pattern |
|---------|--------------------------:|--------------------------|-----------------|
| claude-code | 0 of 10 | Mixed; some verbatim narrative | Useful commands/files extracted well; decisions promoted too literally. |
| pi | 1 of 2 | Low; short sessions with no durable signal | Vague user prompts; LLM rescue did not improve topic quality. |
| kimi | 1 of 7 | Noisy; mostly verbatim narrative/error text | Skill-search sessions produced zero project learnings. |
| codex-cli | 0 of 7 | Noisy; includes raw JSON blobs | Long wrapper/context-dump topics bypass `isLowSignalTopic()`. |
| cursor | N/A (blocked) | N/A | No sessions processed for quality review. |

### Audit delta after U2–U6

`quality audit --limit 100` before vs. after the test ingests:

| Metric | Baseline (U1) | After U6 | Delta |
|--------|--------------:|---------:|------:|
| `summary_low_signal` | 18 | 18 | 0 |
| `process_chatter` | 1 | 1 | 0 |
| `no_project_learnings` | 36 | 34 | -2 |
| `blocked_deletion` | 48 | 48 | 0 |
| `sessions_with_project_learnings` | 41 | 45 | +4 |
| `ready` | 52 | 52 | 0 |

The audit moved slightly in the right direction (`no_project_learnings` down, more sessions with project learnings), but the sample is small and the dominant blocker remains unchanged.

### Ranked findings

1. **Manifest collisions are the primary ingestion blocker across every harness.** Cursor is completely blocked at the first 10 candidates; pi, kimi, and codex-cli lose 30–80% of candidates to the same error. This is a pre-existing state/adapter issue, not a regression from recent extraction changes, but it prevents the test from evaluating cursor quality at all.
2. **Project learnings are too often raw text, not distilled rules.** Across claude-code, kimi, and codex-cli, project learnings frequently contain full assistant paragraphs, JSON blobs, error snippets, or skill instructions. The durable-decision bypass and event summarization are promoting text verbatim instead of extracting an actionable statement.
3. **LLM topic rescue is underused.** Only 2 of ~36 reprocessed sessions triggered LLM topic rescue. Long codex-cli wrapper prompts and kimi’s `resolve these:` are obvious low-signal topics that `isLowSignalTopic()` did not flag.
4. **No-project-learning false negatives persist.** Concrete sessions with clear tasks (git commit, skill search, tether steering reply) produced zero project learnings despite having files, commands, and decisions.
5. **Pi sessions are mostly very short chatter.** Pi had the lowest signal density; even LLM-rescued topics remained vague.
6. **User learnings can be higher signal than project learnings.** The codex-cli review user learning about exit-code collision was concise and actionable, suggesting the user-learning path may be less noisy.

### Recommended next actions

1. **Fix or bypass the immutable-manifest collision.** Without this, cursor quality cannot be reviewed and large backlogs across harnesses stay stuck. Likely requires reconciling manifest generation with source hash stability.
2. **Tune project-learning distillation.** Add a length/structure filter to reject verbatim assistant text, JSON blobs, and error dumps; prefer short imperative statements.
3. **Expand `isLowSignalTopic()` heuristics.** Add detection for long wrapper phrases (`User initiated a review task...`), skill instruction dumps, and bare context lists.
4. **Investigate no-project-learning false negatives.** For sessions with files, commands, and concrete decisions but zero learnings, trace why the extraction path returns empty.
5. **Consider a separate pi low-signal path.** Many pi sessions are 1–2 turns with no durable signal; a fast discard path could reduce noise.

## U8. Reset cap and close test window

```bash
unset ASD_LLM_MAX_PER
asd pipeline gate --skip-ingest
```

### Result

```json
{
  "llm_budget": {
    "allowed": false,
    "max_per_window": "5/24h",
    "remaining": 0,
    "used_in_window": 5,
    "window_started_at": "2026-06-14T15:22:46.843Z"
  },
  "usd_budget": {
    "allowed": true,
    "max_usd_per_window": "1/24h",
    "spent_usd": 0.008526,
    "remaining_usd": 0.991474
  }
}
```

The per-call cap is back to the default `5/24h`. `remaining: 0` is expected because the test window consumed 5 calls; the sliding window will refresh automatically.
