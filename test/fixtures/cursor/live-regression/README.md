# Live Regression Corpus

This fixture set is copied from real local Cursor transcript files that exposed
quality gaps during the first live smoke of `agent-session-distillery`.

Purpose:
- reproduce nested session-directory discovery behavior
- reproduce real `role` + `message.content[]` transcript structure
- preserve noisy review/plan/prose cases that break command and failure extraction
- keep one compact subagent transcript in the corpus

Current fixtures:
- `6edabde1-32b9-47cb-b4e8-0e5884f98a14.jsonl`
  - short planning session
  - useful for the "no durable learnings extracted" blocked-retention path
- `0fc0a884-3413-44fa-bdd4-77984f40e413.jsonl`
  - medium review-driven fix request
  - useful for parser/summary quality checks on short assistant-heavy sessions
- `6e8197bb-269e-43a8-bc58-e965468c3f82.jsonl`
  - rich PR review + attached-plan session
  - useful for noisy command extraction, failure false positives, and summary quality
- `17070617-45b1-4a0d-ab57-e218f45e6fc9.jsonl`
  - short multi-turn example with user follow-up
- `d2d8b0e7-3fae-4506-927b-8f80a301ccb0.jsonl`
  - longer test-performance planning session with repeated assistant chatter
- `faa99040-0737-4728-837e-9b017393476a-subagent.jsonl`
  - compact subagent transcript

These files are intentionally kept close to the original transcript structure so
they exercise the same parser and reduction paths as production Cursor data.
