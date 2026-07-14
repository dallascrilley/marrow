---
title: secret and environment preflight before blaming ASD integrations
date: 2026-07-13
category: tooling
module: cli/operators
tags: [secrets, env, openrouter, doctor, troubleshooting]
applies_when:
  - An LLM-gated ASD command skips, 401s, or reports provider unavailability
  - Scheduled automation behaves differently from an interactive shell
  - A command works locally but fails in launchd, cron, or another session
related: [docs/solutions/tooling/openrouter-data-policy-404.md, docs/recipes/scheduled-memory-pipeline.md]
---
# secret and environment preflight before blaming ASD integrations

## Problem

Recurring ASD failures come from missing or mismatched environment, not from the command itself:

- `OPENROUTER_API_KEY` is unset in the current shell or launcher
- a scheduled runner has a different environment from the interactive terminal
- the key exists, but the route/model policy is blocked and the symptom is misread as a missing credential
- operators paste secrets into commands instead of resolving them from the documented source

These failures usually surface in `quality review-learnings`, scheduled memory pipeline runs, or provider-health checks. `quality apply-learning-review` is a local batch-application step; if it fails directly, inspect its batch and runtime state rather than provider credentials.

## What works

1. Check the provider surface before running a paid or LLM-gated command:

```bash
asd doctor provider
```

This is the intended preflight command. It resolves credentials, checks the model catalog, and performs live route/data-policy probes, including a one-token completion request. It may incur a small provider charge; budget headroom is reported but does not prevent the route probe.

2. Resolve the key from the documented source of truth instead of typing or copying it manually.

ASD documentation already names the 1Password item:

```bash
export OPENROUTER_API_KEY="$(op read 'op://Private/OpenRouter API Credentials - agent-session-distillery/credential')"
```

Never commit the key, print it, or store it in repo files.

3. For scheduled automation, keep secrets in the operator-local launcher environment, not in tracked config.

The scheduled recipe documents the current pattern:

- launchd runs `~/.agent-session-distillery/run-pipeline.sh`
- that launcher sources `~/.agent-session-distillery/secrets.env`
- the repo script runs without embedding the secret in the plist or repo

4. Distinguish "missing key" from "route blocked".

If the key resolves but the model route is unavailable, use:

- `asd doctor provider`
- `docs/solutions/tooling/openrouter-data-policy-404.md`

Do not rotate or re-enter credentials until the provider check says auth is actually missing.

## Why it works

ASD already has one explicit diagnostic surface for provider readiness (`asd doctor provider`) and one documented source of truth for the OpenRouter key (the 1Password item plus operator-local `secrets.env` launcher flow). Running those checks first separates credential absence, launcher-env drift, and route-policy failures into different branches with different fixes.

## Prevention

- Run `asd doctor provider` before debugging `quality review-learnings` failures by hand; remember that the provider check itself performs live probes.
- Load `OPENROUTER_API_KEY` from 1Password or the operator-local launcher, never from repo files.
- For scheduled runs, document or inspect the launcher environment first; launchd and interactive shells are not equivalent.
- Treat a missing key as an operator-env problem, and a 404/data-policy response as a provider-routing problem.

## Quick checks

```bash
# Preflight the provider surface
asd doctor provider

# Interactive shell: load the documented key source
export OPENROUTER_API_KEY="$(op read 'op://Private/OpenRouter API Credentials - agent-session-distillery/credential')"

# Then retry the intended command
asd quality review-learnings --if-new
```
