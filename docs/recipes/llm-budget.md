# LLM budget defaults

The `asd` pipeline makes optional LLM calls for topic rescue and learning
review. Two independent guardrails control those calls:

| Guardrail | Default | Env override | Purpose |
|-----------|---------|--------------|---------|
| Count cap | `50/24h` | `ASD_LLM_MAX_PER` | Courtesy throttle: prevents runaway loops from flooding the provider. |
| USD ceiling | `1/24h` | `ASD_LLM_MAX_USD` | Hard financial guardrail: stops real spend based on effective (upstream-aware) cost. |

## Why the count cap is higher than the old `5/24h`

The previous `5/24h` count cap was the bottleneck for draining the learning
review backlog, even though the effective 24-hour spend stayed well under the
$1 ceiling. Raising the count cap to `50/24h` lets the backlog drain at the
cost pace, while the USD ceiling remains the binding guardrail.

For BYOK keys whose OpenRouter `usage.cost` is $0, the effective-cost tracker
still counts the upstream-aware cost, so the USD ceiling protects against
runaway spend even when OpenRouter's own charge is zero.

## When to change the defaults

- If you see `429` rate-limit responses, lower `ASD_LLM_MAX_PER` or add backoff.
- If your corpus is much larger or your model is more expensive, lower
  `ASD_LLM_MAX_USD` before changing the count cap.
- The count cap should never be the only guardrail in production; always keep
  a USD ceiling in place.
