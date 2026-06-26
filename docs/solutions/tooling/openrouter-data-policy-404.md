---
title: OpenRouter review-learnings fails with 404 "data policy" — account guardrail, not a code bug
date: 2026-06-25
category: tooling
module: pipeline/llm-learning-review, pipeline/llm-budget
tags: [openrouter, byok, 404, data-policy, llm-review, provider-auth]
severity: high
related: [docs/solutions/tooling/openrouter-byok-effective-cost.md]
---

# OpenRouter review-learnings fails with 404 "data policy" — account guardrail, not a code bug

## Context
`asd quality review-learnings` (and any LLM-gated pass using
`openrouter.ai/api/v1/chat/completions`) aborts with:

```
OpenRouter learning review failed (404): {"error":{"message":"No endpoints
available matching your guardrail restrictions and data policy.
Configure: https://openrouter.ai/settings/privacy","code":404}}
```

The pipeline handles this correctly — it sets `skipped: true`,
`skip_reason: "llm_provider_error"`, and spends **$0** (the request 404s
before any billing). So no money is wasted, but no review/telemetry is
produced and the whole pass is blocked.

## What it is NOT (ruled out, $0 spent)
- **Not a missing key.** The 1Password item
  `op://Private/OpenRouter API Credentials - agent-session-distillery/credential`
  exists and authenticates — the request gets *past* auth to the routing stage.
- **Not a missing/renamed model.** `openai/gpt-5-nano` (the review default) and
  `openai/gpt-5.4-nano` (the topic default) are both present in the live
  `GET https://openrouter.ai/api/v1/models` list.
- **Not a budget block.** `pipeline gate` shows `allowed: true`, USD ceiling
  `$1/24h` with `$0` spent, and ≥25 calls of count headroom.

## Root cause
This is an **OpenRouter account-level setting**, not a repo bug. The account's
privacy / data-policy / guardrail configuration disallows *every* provider
endpoint that could serve the requested model, so OpenRouter has nowhere
compliant to route the call and returns 404 ("No endpoints available matching
your … data policy").

## Fix (account owner only)
1. Open https://openrouter.ai/settings/privacy for the account behind the
   `agent-session-distillery` BYOK key.
2. Enable provider endpoints compatible with the models in use (e.g. allow
   providers that may train on prompts, or whichever policy tier exposes an
   endpoint for `openai/gpt-5-nano`). OpenRouter only routes to endpoints that
   satisfy *all* enabled guardrails.
3. Re-run the cheap probe to confirm before any scaled spend:
   ```bash
   export OPENROUTER_API_KEY="$(op read 'op://Private/OpenRouter API Credentials - agent-session-distillery/credential')"
   node dist/cli.js quality review-learnings --max-per 25/24h --max-total-learnings 1
   ```
   A non-404 result with `total_reviewed_learnings: 1` confirms the route is open.

## Model swap does NOT help — the restriction is account-wide
A direct 1-token `chat/completions` probe across six models and four providers
(`openai/gpt-5-nano`, `openai/gpt-5.4-nano`, `openai/gpt-5.4-mini`,
`google/gemini-2.5-flash`, `anthropic/claude-haiku-4.5`,
`meta-llama/llama-3.3-70b-instruct`) returned the **same data-policy 404 for
every one**. So the guardrail applies to the whole account for fixed model ids.

**Exception (2026-06-26):** `openrouter/auto` succeeds because OpenRouter picks a
compliant endpoint dynamically. Use it for review-learnings until privacy settings
are relaxed:

```bash
export OPENROUTER_MODEL=openrouter/auto
# or per run:
node dist/cli.js doctor provider --model openrouter/auto
node dist/cli.js quality review-learnings --model openrouter/auto --max-total-learnings 1
```

Fixed-id swaps (`OPENROUTER_MODEL=openai/gpt-5-nano`, etc.) still 404; only
`openrouter/auto` (or changing account privacy) unblocks the route.

## Notes
- Diagnosis is cheap and safe: a single `--max-total-learnings 1` run makes at
  most one real call, and the `$1/24h` USD ceiling caps any scaled trial.
- Fast isolation probe (bypasses the slow session scan):
  ```bash
  curl -s https://openrouter.ai/api/v1/chat/completions \
    -H "Authorization: Bearer $OPENROUTER_API_KEY" -H "Content-Type: application/json" \
    -d '{"model":"openai/gpt-5-nano","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'
  ```
  A `200` with a `finish_reason` means the route is open; a `404` mentioning
  "data policy" means the account guardrail still blocks it.
