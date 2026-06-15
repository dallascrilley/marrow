---
title: Reasoning tokens dominate cost on trivial LLM classify tasks — cap reasoning effort
date: 2026-06-14
category: performance
module: pipeline/llm-learning-review
tags: [openrouter, llm-cost, reasoning-tokens, gpt-5-nano, memory-lint]
severity: high
related: [docs/solutions/tooling/openrouter-byok-effective-cost.md]
---

# Reasoning tokens dominate cost on trivial LLM classify tasks — cap reasoning effort

## Problem
The OpenRouter memory-lint review (`reviewLearningWithOpenRouter`, model
`openai/gpt-5-nano`) emits a tiny JSON verdict, yet the U4 calibration baseline
showed each call spent ~2,123 output tokens — **~2,000 of them (≈94%) reasoning
tokens**. On a trivial structured-output classify task that reasoning is pure
waste, and it was the single largest driver of cost/learning ($0.000867).

## Solution
Set a minimal reasoning effort on the request body in `completeOpenRouterJson`
(covers both review and topic generation):

```ts
body: JSON.stringify({
  messages: input.messages,
  model: input.model,
  reasoning: { effort: lowReasoningEffort }, // "low" — lowest portable effort
  response_format: { type: "json_object" },
  temperature: 0,
  usage: { include: true },
}),
```

Measured on the $5 BYOK key (12 real reviews): `reasoning_mean` 2,000 → **138.7**
(~14x), `cost_per_learning_usd` $0.000867 → **$0.000132** (~6.6x), full-drain
projection (3,078 learnings) ~$2.67 → **~$0.41**.

## Why it works
GPT-5 models default to substantial internal reasoning. For a deterministic
keep/reject/rewrite verdict the model needs almost none, so lowering the effort
removes most output tokens (the billed dimension) without hurting verdict quality.

## Prevention
For any LLM call that produces short structured output on a mechanical task,
explicitly cap reasoning effort and check `tokens_per_call.reasoning_mean` in
`quality cost-report` — if reasoning is a large fraction of output tokens, it is
almost certainly waste. Prove the cut with a bounded re-run vs the prior baseline,
never by assumption.
