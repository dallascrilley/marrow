# Security policy

## Reporting a vulnerability

Report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/dallascrilley/marrow/security/advisories/new)
on this repository. Please do not open a public issue for a security problem.

Include what you need to reproduce it: the command, the input shape, the
observed behavior and the version or commit. I aim to acknowledge a report
within seven days and to agree on a disclosure timeline with you before any
public write-up.

## What this project touches

Marrow reads AI coding-session transcripts from your home directory and writes
derived artifacts under `~/.marrow` (or `MARROW_ROOT`). That means it routinely
handles the most sensitive text on a developer machine: prompts, source code,
file paths, and anything a transcript happened to capture.

Design constraints that follow from that:

- The core pipeline is offline. Ingest, summarize, extract, index and search
  make no network calls.
- Network calls happen only in the explicitly LLM-assisted commands, only when
  `OPENROUTER_API_KEY` is set, and only within the budgets those commands take
  as flags.
- Transcript text is sanitized before it is sent anywhere or written into a
  draft artifact. See [`src/pipeline/prompt-sanitize.ts`](src/pipeline/prompt-sanitize.ts).
- Source transcripts are never deleted unless you pass an explicit `--apply`,
  and only after the durable artifacts that replace them exist on disk.

## Things that are in scope

- Any path where transcript content reaches the network without an explicit
  opt-in.
- Any way to make Marrow write outside its runtime root, or delete a source
  file without a completed retention receipt.
- Injection through transcript content that changes what Marrow executes or
  what it sends to a model.
- Secrets leaking into stored artifacts, reports, logs or drafts.

## Things that are not

- The security of the upstream agent tools whose transcripts Marrow reads.
- The security of OpenRouter or any model provider you point it at.
- Anything requiring an attacker who already has write access to your home
  directory or your `~/.marrow` tree.
