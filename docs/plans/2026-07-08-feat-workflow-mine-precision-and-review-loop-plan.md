---
date: 2026-07-08
origin: session roadmap (Fable session 2026-07-08, workflow-mine improvement analysis; no brainstorm doc)
td_epic: td-667d28
---

# Workflow mine: precision fixes + review/apply loop

**Summary:** Make `asd workflow mine` a trustworthy candidate generator (fix mis-signed matches, contradiction poisoning, unstable ids, unexplainable evidence, already-adopted noise), then close the loop with a durable decision ledger, `workflow review/show/dismiss`, draft-only `workflow apply --dry-run`, an instinct-store candidate tier, and a budget-gated LLM judge.

## Requirements

- R1. Candidate ids are stable across runs and across guidance-wording edits, so downstream decisions can key on them.
- R2. Evidence signals are correctly signed: negated verification statements never count as supporting evidence, and one contradiction cannot poison a heavily supported candidate; supporting/contradicting counts are visible.
- R3. Each evidence entry carries a short sanitized excerpt and the rule that matched, so a reviewer can triage a candidate without running `explain` per session; evidence lists are capped with a total count.
- R4. Candidates whose guidance is already encoded (global instinct store / curated memory) are flagged, not recommended for adoption.
- R5. `workflow mine` supports `--cluster` and `--recommendation` filters; `--limit` semantics are documented honestly (rule-table output is bounded).
- R6. Reviewer decisions (adopt/dismiss/defer) persist in an append-only ledger keyed by candidate id; repeat mines annotate or exclude decided candidates instead of re-surfacing them forever.
- R7. `workflow apply <id> --dry-run` drafts the artifact (rule snippet / skill skeleton / doc section per `artifact_kind`) to a staging path plus an apply report; it never writes to vault, skills, or global rules.
- R8. Reviewed instincts (established/proven) become a first-class candidate source, so candidate generation is no longer bounded by the 9-rule table.
- R9. An optional LLM judge (`workflow judge`) scores candidate wording and artifact-kind fit, reusing the existing judge cache, count+USD budget gate, and telemetry; provider guardrail failures skip cleanly at $0.

## Key technical decisions

- **Stable ids come from a new `rule_id`, not guidance prose.** Today `candidate_id = wf_ + sha256(cluster + guidance)[0..10]` (`src/workflow/mine.ts`, `buildCandidateId`), so editing a guidance string silently mints a new id. Every rule in `markerRules` gets a literal `rule_id` slug; the hash input becomes `cluster + "\0" + rule_id`. Instinct-sourced candidates (U8) hash the instinct's canonical key instead. This must land before the ledger (U6) or decisions won't stick.
- **Contradiction becomes a ratio, not a flag.** `classifyConfidence` currently marks the whole candidate `contradicted` if any single seed has `evidenceKind === "contradiction"`. Replace with supporting/contradicting counts on the candidate and a threshold (contradicted only when contradicting share > 20%); below threshold, keep the confidence tier but surface both counts.
- **Excerpts reuse the existing sanitizers.** `sanitizeEvidenceText` (paths, secrets) already runs over the matched corpus; excerpts additionally need markdown-residue cleanup per `docs/solutions/tooling/markdown-sanitization-pipeline.md` (decision/workflow statements previously leaked tables, `**` emphasis, and framing tokens — reuse the universal sanitizer path from that fix rather than writing a new one).
- **The decision ledger is append-only JSONL, never an overwritten sidecar.** td-02d1fe documented the exact failure: `quality review-learnings` overwrote its sidecar each run, so repeat sweeps re-selected the same items forever. The workflow ledger follows the corrected pattern: `reports/workflow-decisions.jsonl` under the runtime root, one `{candidate_id, decision, decided_at, note}` line per decision, read-and-exclude at mine time.
- **The judge reuses `judge-cache.ts` + `llm-budget.js` + `llm-telemetry.js` as-is.** `judgeGlobalApplicability` (`src/v2/promotion/judge.ts`) is typed to instincts, so U9 adds a parallel prompt/verdict-schema/content-hash function for workflow candidates but imports the cache store, count+USD budget gate, circuit breaker, and telemetry unchanged. Budget accounting must use effective upstream cost per `docs/solutions/tooling/openrouter-byok-effective-cost.md` (already handled inside `llm-budget`/`llm-telemetry` — reusing them satisfies this). Provider guardrail 404s must produce `skipped: true` / `skip_reason: "llm_provider_error"` at $0 per `docs/solutions/tooling/openrouter-data-policy-404.md` (same handling as `promote-judge`).
- **No new keyword rules.** The rule table is a bounded dead end (≤9 candidates ever). Precision work goes into fixing existing rules and adding the instinct tier (U8), not expanding regexes.

## Implementation units

### U1. Stable rule identity and candidate ids
- **Goal:** Candidate ids survive guidance rewording; every candidate exposes its source rule.
- **Requirements:** R1
- **Files:** `src/workflow/mine.ts`, `src/workflow/schema.ts`, `test/workflow-mine.test.mjs`
- **Approach:** Add a literal `rule_id` slug to each `markerRules` entry (e.g. `validation-explicit-verify`, `validation-skip-verify-contradiction`). Emit `rule_id` on `WorkflowCandidate`. Change `buildCandidateId` to hash `cluster + "\0" + rule_id`. Group seeds by `cluster\0rule_id` instead of `cluster\0guidance`.
- **Tests:** Same candidate_id before/after editing a rule's guidance string in a fixture copy of the table; `rule_id` present in JSON output; existing tests updated for new ids.
- **Verification:** `npm test -- test/workflow-mine.test.mjs` and `node dist/cli.js workflow mine --days 30 --json` shows `rule_id` on every candidate.

### U2. Correct evidence signing and contradiction ratio
- **Goal:** Negated verification text stops counting as support; one contradiction stops poisoning a well-supported candidate.
- **Requirements:** R2
- **Files:** `src/workflow/mine.ts`, `src/workflow/schema.ts`, `test/workflow-mine.test.mjs`
- **Approach:** Split the validation positive pattern so `never` only matches when followed by a skip-verb construction ("never skip/ship without ... verify"), and route "never need to verify"-shaped text to the contradiction rule. In `classifyConfidence`, compute `supporting_count` and `contradicting_count` per candidate; mark `contradicted` only when `contradicting_count / (supporting + contradicting) > 0.2`; emit both counts on the candidate.
- **Tests:** "you never need to verify" produces contradiction evidence, not support; a candidate with 9 supporting + 1 contradicting session stays `strong/adopt` with counts visible; 1 supporting + 1 contradicting → `contradicted/ask`.
- **Verification:** `npm test -- test/workflow-mine.test.mjs`.

### U3. Evidence excerpts, cap, and count
- **Goal:** A reviewer can judge a candidate from the mine output alone.
- **Requirements:** R3
- **Files:** `src/workflow/mine.ts`, `src/workflow/schema.ts`, `test/workflow-mine.test.mjs`
- **Approach:** During `extractSeeds`, capture the sentence containing the first regex match per rule (bounded to ~200 chars), run it through `sanitizeEvidenceText` plus the markdown-residue sanitizer from the event-tagging pipeline, and store it as `excerpt` on `WorkflowEvidence` alongside `matched_rule_id`. Cap `evidence_sessions` at 10 (most recent `updated_at` first) and add `evidence_count` (total distinct sessions) on the candidate.
- **Tests:** Excerpt present, ≤200 chars, contains no `/Users/` path, no secret pattern, no markdown table/emphasis residue; 15 matching fixture sessions produce `evidence_sessions.length === 10` and `evidence_count === 15`.
- **Verification:** `npm test -- test/workflow-mine.test.mjs`.

### U4. Already-encoded suppression
- **Goal:** Guidance that is already adopted (global instincts / curated memory) is flagged instead of recommended.
- **Requirements:** R4
- **Files:** `src/workflow/mine.ts`, `src/workflow/schema.ts`, new helper beside `src/v2/instinct/global-store.ts` usage, `test/workflow-mine.test.mjs`
- **Approach:** Load global instincts (`loadGlobalInstinctIds` / global store) and compare each candidate's guidance against instinct findings using the existing stemmed keyword machinery in `src/v2/instinct/id.ts` (canonical-key overlap above a threshold, e.g. ≥60% of guidance content words present in one instinct's key set). On match, set a new candidate field `status: "already_encoded"` with `encoded_in: <instinct-id>` and downgrade `recommendation` to `dismiss` (reason visible). Heuristic match is acceptable; false negatives are fine, false positives must be rare (threshold tuned by test fixtures).
- **Tests:** Fixture global instinct "run verification before claiming completion" causes the validation candidate to emit `already_encoded` + `encoded_in`; unrelated instinct does not trigger suppression.
- **Verification:** `npm test -- test/workflow-mine.test.mjs`; live check `node dist/cli.js workflow mine --days 30 --json` no longer recommends adopting verify-before-complete.

### U5. CLI filters and honest --limit docs
- **Goal:** Server-side filtering; no misleading knobs.
- **Requirements:** R5
- **Files:** `src/commands/workflow-mine.ts`, `docs/recipes/workflow-mining.md`, `README.md` (workflow section), `test/cli.test.mjs`
- **Approach:** Add `--cluster <name>` (validated against `workflowClusters`) and `--recommendation <value>` (validated against the recommendation union) to `parseWorkflowMineArgs`; filter candidates before `--limit`. Document in the recipe that rule-table output is bounded (≤ rule count) until the instinct tier lands, and what `--limit` actually truncates.
- **Tests:** CLI test for each flag (valid value filters; invalid value exits nonzero with the allowed list in the message).
- **Verification:** `npm test -- test/cli.test.mjs`.

### U6. Decision ledger + workflow review/show/dismiss
- **Goal:** Decisions persist; repeat mines advance the backlog instead of re-surfacing it.
- **Requirements:** R6
- **Files:** `src/cli.ts` (workflow subcommand wiring), new `src/commands/workflow-review.ts`, `src/commands/workflow-show.ts`, `src/commands/workflow-decide.ts` (or one file with three entrypoints), new `src/workflow/decisions.ts` (ledger read/append), `src/workflow/mine.ts` (exclude/annotate decided), tests.
- **Approach:** Ledger at `<runtimeRoot>/reports/workflow-decisions.jsonl`, append-only lines `{candidate_id, rule_id, decision: adopt|dismiss|defer, decided_at, note?}` — the corrected pattern from td-02d1fe, never an overwritten sidecar. `workflow show <candidate-id>` re-mines (bounded by stored days/source defaults or flags) and prints one candidate in full including excerpts and any prior decision. `workflow review` lists undecided candidates interactively-friendly (text) or as JSON. `workflow dismiss <id> [--note]` and `workflow adopt <id> [--note]` append to the ledger. `mine` gains `--include-decided` (default false: decided candidates get `decision` annotation and are excluded from the default listing).
- **Tests:** Append twice → two lines, latest decision wins on read; mine after dismiss excludes the candidate by default and includes it with `--include-decided`; `show` on unknown id exits nonzero.
- **Verification:** `npm test`; manual loop: mine → dismiss one id → mine again shows it gone.

### U7. workflow apply --dry-run (draft-only)
- **Goal:** One command turns an adopted candidate into a reviewable draft artifact; nothing is auto-published.
- **Requirements:** R7
- **Files:** `src/cli.ts`, new `src/commands/workflow-apply.ts`, new `src/workflow/draft.ts`, tests.
- **Approach:** `workflow apply <candidate-id> --target rule|skill|doc --dry-run` renders a draft to `<runtimeRoot>/reports/workflow-drafts/<candidate_id>-<target>.md` (rule: one-paragraph statement + trigger; skill: SKILL.md skeleton with trigger/steps/evidence; doc: reference section) plus an apply-report JSON, following the shape of `src/commands/quality-apply-learning-review.ts`. Run the drafted statement through `validateSuggestedStatement` (reuse from quality-apply) and refuse to draft on quality failure. v1 ships dry-run only: invoking without `--dry-run` exits with a message that non-dry apply is not yet supported. Applying a `dismiss`-ledgered or `already_encoded` candidate exits nonzero.
- **Tests:** Draft file created at the expected path with trigger + guidance content; apply on dismissed candidate fails; missing `--dry-run` fails with the not-yet-supported message; statement failing quality validation refuses with reason.
- **Verification:** `npm test`; manual: adopt a candidate, apply --dry-run, read the draft.

### U8. Instinct-sourced candidate tier
- **Goal:** Candidate generation unbounded by the rule table, sourced from reviewed data.
- **Requirements:** R8
- **Files:** `src/workflow/mine.ts` (or new `src/workflow/instinct-source.ts`), `src/workflow/schema.ts`, tests.
- **Approach:** Load project + global instincts via `loadAllInstincts` / global store; select `maturity in (established, proven)` (flag `--min-maturity` to widen to candidates). Group by the instinct `canonicalKey` (order-independent, stemmed — `src/v2/instinct/id.ts`); each group becomes a candidate with `source_tier: "instinct"`, guidance from the instinct finding, trigger from the instinct trigger, confidence mapped from instinct confidence/maturity (proven→strong, established→medium), evidence entries pointing at the instinct's source observations. Keyword-rule candidates get `source_tier: "keyword"` and rank below instinct candidates at equal confidence. Candidate id: `wf_ + sha256("instinct\0" + canonicalKey)[0..10]`.
- **Tests:** Fixture instinct store yields an instinct-tier candidate with correct mapping; keyword candidate with same confidence sorts after it; ledger decisions on instinct-tier ids persist (reuses U6 machinery).
- **Verification:** `npm test`; live: `node dist/cli.js workflow mine --days 90 --json | jq '[.candidates[].source_tier] | group_by(.) | map({tier: .[0], n: length})'` shows both tiers.

### U9. workflow judge (LLM, budget-gated)
- **Goal:** Optional LLM scoring of candidate wording and artifact-kind fit, cached and capped.
- **Requirements:** R9
- **Files:** `src/cli.ts`, new `src/commands/workflow-judge.ts`, new `src/workflow/judge.ts`, tests.
- **Approach:** Mirror `src/commands/promote-judge.ts`: per-candidate content hash over `{cluster, rule_id or canonicalKey, guidance, trigger, artifact_kind}` with a `WORKFLOW_JUDGE_PROMPT_VERSION` constant; verdict schema `{wording_ok: boolean, suggested_guidance?: string, artifact_kind: rule|skill|workflow_doc|none, confidence: 0..1, reason: ≤400}` via `completeOpenRouterJson`. Reuse `judge-cache.ts` store shape, `assessLlmBudget`/`assessUsdBudget` + `recordLlmBudgetUse` (count + USD windows, same $1/24h posture as promote judge), `MAX_CONSECUTIVE_ERRORS` circuit breaker, and `llm-telemetry` recording. Provider guardrail 404 → `skipped: true`, `skip_reason: "llm_provider_error"`, $0 (per docs/solutions/tooling/openrouter-data-policy-404.md). Verdicts append as ledger annotations (`decision: "judged"`, verdict payload) so `review`/`show` display them.
- **Tests:** Cache hit skips the network call (stub transport); budget-exhausted path skips with reason; verdict recorded and surfaced by `workflow show`.
- **Verification:** `npm test`; live smoke of ≤5 candidates under the existing budget gate, telemetry row present.

## Worktree & concurrency

- **worktree_slug:** feat/workflow-mine-review-loop
- **spine_owner:** self — `src/cli.ts` (workflow subcommand wiring) and `src/workflow/schema.ts` are owned by this plan for the merge window; U1–U4 and U6–U9 all touch them, so units within this plan serialize on those files (or land as sequential PRs).
- **Pre-flight:** no `scripts/worktree-posture.sh` in this repo; check `git worktree list` and open PRs before starting. td-02d1fe (review-learnings ledger, ses_4630b5, last touched 2026-07-06) edits `src/commands/quality-review-learnings.ts` territory — no file overlap with this plan, but U6 should read its landed ledger implementation for pattern consistency if it merges first.
- **Active conflicts:** none known.

### Write surfaces
- U1–U3: `src/workflow/mine.ts`, `src/workflow/schema.ts`, `test/workflow-mine.test.mjs`
- U4: same + read-only use of `src/v2/instinct/*`
- U5: `src/commands/workflow-mine.ts`, `docs/recipes/workflow-mining.md`, `README.md`, `test/cli.test.mjs`
- U6: `src/cli.ts`, `src/commands/workflow-*.ts` (new), `src/workflow/decisions.ts` (new)
- U7: `src/cli.ts`, `src/commands/workflow-apply.ts` (new), `src/workflow/draft.ts` (new)
- U8: `src/workflow/instinct-source.ts` (new), `src/workflow/mine.ts`, `src/workflow/schema.ts`
- U9: `src/cli.ts`, `src/commands/workflow-judge.ts` (new), `src/workflow/judge.ts` (new)

## Prior learnings applied

- td-02d1fe (tracker, in progress): overwritten review sidecars make repeat sweeps re-select the same items forever — the workflow decision ledger (U6) is append-only JSONL from day one.
- `docs/solutions/tooling/markdown-sanitization-pipeline.md`: decision/workflow statements leaked markdown tables, emphasis, and framing tokens; U3 excerpts and U7 drafts reuse the universal sanitizer + `validateSuggestedStatement` instead of new ad-hoc cleanup.
- `docs/solutions/tooling/openrouter-data-policy-404.md`: provider guardrail 404s are an account setting, not a code bug — U9 must skip at $0 with `skip_reason: "llm_provider_error"`, same as promote-judge.
- `docs/solutions/tooling/openrouter-byok-effective-cost.md`: BYOK responses report `usage.cost = 0`; budgeting must use effective upstream cost — satisfied by reusing `llm-budget`/`llm-telemetry` unchanged in U9.

## Deferred / out of scope

- Non-dry `workflow apply` (writing into skills/rules/vault directly) — needs its own carve-out discussion; v1 drafts only.
- New keyword rules or rule-table expansion — deliberately excluded; generation scale comes from U8.
- Frequency weighting of matches within a session (counting repeated hits) — revisit after U8 shows whether keyword tier still matters.
- Cross-project mining (other projects' instinct stores) — global store only, via U4/U8.

## Open questions

- None blocking. Threshold values (20% contradiction ratio, 60% suppression overlap, evidence cap 10) are defensible defaults marked as assumptions; tune via test fixtures and live output rather than pre-deciding.
