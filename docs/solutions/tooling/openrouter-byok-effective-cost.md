---
title: OpenRouter BYOK keys report usage.cost = 0 — budget on effective upstream cost
date: 2026-06-14
category: tooling
module: pipeline/llm-telemetry, pipeline/llm-budget
tags: [openrouter, byok, llm-cost, budget, telemetry]
severity: high
related: [docs/solutions/performance/openrouter-reasoning-tokens-dominate-trivial-tasks.md]
---

# OpenRouter BYOK keys report usage.cost = 0 — budget on effective upstream cost

## Context
When the OpenRouter key is **BYOK** (`is_byok: true`), OpenRouter does not bill
its own margin, so the chat-completions response returns `usage.cost: 0`. The real
money is spent on the *upstream* provider key and is reported separately in
`cost_details.upstream_inference_cost`. Calibration on the $5 test key first
showed cost $0 across all calls for exactly this reason.

## What didn't work
Reading only `usage.cost` (the obvious field): it is `0` for BYOK, so cost capture
and any USD budget computed from it silently report zero spend and **never
trigger**, while the upstream key is still being drained.

## Solution
Capture the **effective** cost: prefer `usage.cost` when non-zero, else fall back
to `cost_details.upstream_inference_cost`, and record which source was used.
`LlmCallUsage.cost` carries this effective value with `cost_source` ∈
`{openrouter, upstream, cache, none}`. The USD ceiling (`assessUsdBudget`) sums
this effective `cost` from telemetry receipts, so it fires for BYOK keys too:

```ts
// telemetry receipts → trailing-window sum of effective cost
spent += record["gen_ai.usage.cost"] ?? 0; // only when cost_is_known
```

Requires `usage: { include: true }` on the request so `cost_details` is returned
inline (no separate `GET /api/v1/generation` call needed here).

## Why it works
Budgeting on effective/upstream cost reflects actual money spent regardless of
whether OpenRouter bills directly or passes through to a BYOK upstream key.

## When to apply
Any time spend is tracked or capped against an OpenRouter key that might be BYOK.
Never estimate cost from a pricing table — capture it from the response and fail
closed (`cost_is_known: false`, counted as `unknown_cost_calls`) when absent.
