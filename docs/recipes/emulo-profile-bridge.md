# Emulo Profile Bridge

Agent Session Distillery can export its validated reduced-session evidence for the private
Emulo mirror without reparsing raw harness logs or invoking a model.

## Export and inspect

Build ASD, export the current immutable generation, and run Emulo's read-only preflight:

```bash
npm run build
node dist/cli.js profile export-emulo
python /Users/operator/Code/emulo-private/emulo.py plugin preflight --source asd
```

Set `AGENT_SESSION_DISTILLERY_ROOT` on both commands when using a non-default runtime. The ASD
command writes `exports/emulo/generations/<hash>/` and atomically points
`exports/emulo/current.json` at the complete generation. Emulo reads only that pointer and
fails closed on invalid schemas, paths, counts, provenance, or content hashes.

The export includes sanitized, substantive user messages plus ASD session/source provenance.
It excludes assistant text, tool output, raw transcript paths, and embedded agent prompts.
ASD remains the canonical evidence producer; Emulo remains the profile compiler and runtime.

## Approval boundary

`plugin preflight` is read-only. Review its session/token counts, planned calls, and
`approval_hash`. Do not run `plugin prepare`, workers, reducers, or activation without separate
approval for the displayed plan. If the source changes, rerun the ASD export and preflight;
Emulo will require a new matching approval hash.

The public Emulo plugin installation is unchanged. This bridge runs from the private
`dallascrilley/emulo-private` mirror until that runtime is explicitly installed.

## Verified proof

On July 17, 2026, an isolated Node 22 runtime exported one fixture session with two user
messages. Private Emulo preflight accepted one session in `quick_preview` mode, returned an
approval hash, exported no assistant prose, and created no `runs/` directory. The local proof
receipt is `/tmp/asd-emulo-bridge-proof.q8upxA/`.
