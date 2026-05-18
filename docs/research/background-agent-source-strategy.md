---
date: 2026-05-18
status: research-only
launch_criteria_gate: background-agent-source-research
---

# Cursor background-agent source strategy

This note documents the source surfaces available for Cursor background-agent
chats so that any future adapter is built on an evidence-backed choice rather
than guesswork. Background-agent chats are out of scope for `agent-session-distillery` v1; the v1 README says so explicitly. This note exists to satisfy the
P2 launch-criteria gate `background-agent-source-research`.

## What we mean by "background-agent chats"

In Cursor, the in-editor Composer / Chat is one surface. A separate surface is
"background agents" — long-running agents invoked from the Cursor web app
(`cursor.com/agents`) that run on Cursor-managed infrastructure, often against
a cloned repo in their cloud sandbox. v1 of this tool ingests the first kind
because Cursor writes those transcripts to local disk. The second kind is not
written to local disk and is what this note is about.

## Filesystem probe (2026-05-18)

A direct probe of this machine confirms that there is no local cache of
background-agent conversations:

- `~/.cursor/projects/<workspace>/agent-transcripts/` — only contains
  in-editor agent transcripts.
- `~/.cursor/chats/` — empty on this machine.
- `~/.cursor/agents/` — only contains agent-definition markdown files
  (`architect.md`, `planner.md`, etc.), not chat logs.
- `~/.cursor/ai-tracking/` — telemetry-shaped state, not transcripts.
- `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` — the
  VS Code state DB. Used by v1 for attribution hints, never contains full
  background-agent transcripts.
- `~/Library/Application Support/Cursor/Workspaces/` — per-workspace VS Code
  state, not background-agent state.

If Cursor changes this in a future build, the probe is the place to start.

## Candidate source surfaces

### 1. Cursor web app session (`cursor.com/agents`)

The web app shows the full transcript and metadata for every background-agent
run owned by the signed-in account.

- Surface: authenticated HTML/JSON over HTTPS, gated by Cursor login.
- Pros: complete, ground-truth content; renders the same things the operator
  sees.
- Cons: no published API contract; HTML structure can change; requires
  storing or reusing an auth session; rate limits unknown.

Probable adapter shape: a `chrome-devtools-axi` (CDP) session that reuses the
operator's logged-in profile, navigates to each agent run, and captures the
rendered transcript JSON from the page's `fetch` calls, or the rendered DOM
as a fallback.

### 2. Cursor internal REST/GraphQL (undocumented)

The web app talks to a backend. Inspecting network traffic reveals JSON
endpoints, but none are publicly documented.

- Pros: structured data, no HTML parsing.
- Cons: undocumented, can break without notice; using it long-term risks
  violating Cursor's terms; auth scheme is owned by Cursor (likely a session
  cookie plus CSRF or JWT-like header).

Adapter shape: capture the requests once via CDP, replay them with stored
session credentials. Brittle, and would need a refresh mechanism.

### 3. Cursor CLI / official export (if and when it exists)

As of 2026-05-18 there is no documented `cursor` CLI command or settings UI
toggle that exports background-agent history to disk. The `cursor-agent` CLI
inside `~/.cursor` is for installation, not history export.

- Pros: would be the right long-term answer.
- Cons: does not exist yet. We cannot rely on this surface today.

Watch for: future Cursor release notes mentioning background-agent export, a
`cursor agent export` subcommand, or a settings toggle that writes
transcripts to `~/.cursor/agents-remote/` or similar.

### 4. Operator-driven manual capture

Operators copy transcript JSON out of the web app on demand (e.g. via a
browser bookmarklet or "copy raw transcript" action if Cursor adds one), and
then feed the file into `ingest backfill` from a configurable path.

- Pros: lowest implementation cost; no scraping; no credential storage.
- Cons: not automatic. Useful only as an interim or low-volume fallback.

### 5. Defer

Accept that background-agent chats are unsupported in v1 and v1.x, and
revisit when Cursor publishes a stable export surface. Document this clearly
in the README.

## Cross-cutting constraints

- **Auth.** Surfaces 1, 2, 3 require Cursor login. Storing credentials inside
  this repo's runtime path is out of scope; reusing the operator's Chrome
  profile via CDP avoids credential storage but couples ingestion to the
  operator's browser session.
- **Terms of service.** Scraping (surface 1) and undocumented endpoints
  (surface 2) both carry ToS risk. An adapter built on either should be
  opt-in, off by default, and labeled experimental.
- **Idempotency and provenance.** Whatever surface is chosen, the adapter
  must produce a transcript shape compatible with
  `src/adapters/cursor/parse-transcript.ts` so the rest of the pipeline
  (summarize, extract, archive, retention receipts, wiki export) reuses
  v1 invariants without forks.
- **Rate limits and reproducibility.** Any networked source requires a
  re-run plan when a session is partially captured. The launch contract's
  `deletion-readiness-safety` rules already cover the artifact-presence side;
  the new risk is partial fetches from the network.

## Recommendation

Take surface 5 (defer) as the default and surface 4 (operator-driven manual
capture) as the bridge until Cursor publishes an export contract. Both can be
implemented behind feature flags without committing to surface 1 or 2, which
are the only ones that would auto-ingest but also carry the most risk.

If automatic ingestion of background-agent chats becomes a forcing function
for adoption before Cursor ships an export contract, revisit surface 1 (CDP
against the logged-in web app) as the first experimental adapter, scoped
explicitly opt-in.

## Next operator action

Read this note, pick one of the five surfaces, and either:

- Mark `background-agent-source-research` validated in `LAUNCH_CRITERIA.md`
  with the chosen surface as the `proof`, or
- File a new launch-criteria gate that names the chosen surface and the
  proof required to ship it.
