# Contributing

Thanks for looking. This is a personal tool that I have tried to make legible to
other people, so the most useful contributions are usually a new adapter, a
fixture that breaks an existing parser, or a correction to something the docs
claim but the code does not do.

## Getting set up

```bash
script/setup      # install toolchain and dependencies (Node 22.x)
script/test       # run the suite
script/cibuild    # exactly what CI runs: install, lint, test, build
```

`script/cibuild` is the gate. If it passes locally it passes in CI, because CI
runs that same script. Run it before opening a pull request.

## Making a change

1. Branch from `main`.
2. Keep the change focused. One reviewable idea per pull request.
3. Add or update a test that would fail without your change.
4. Update the docs in the same commit when you change a command, a path, an
   environment variable or an output shape.
5. Run `script/cibuild`.
6. Open a pull request using the template.

Commits follow [Conventional Commits](https://www.conventionalcommits.org):
`type(scope): subject`, imperative mood, subject under 50 characters. The
repository ships a template you can adopt with
`git config commit.template .gitmessage`.

## Tests

The suite is `node --test` over `test/**/*.test.mjs`, running against the built
output in `dist/`, so `npm test` builds first.

Two rules matter more than the rest:

- **Test behavior through a real runtime.** Point `MARROW_ROOT` at a temporary
  directory and let the code write real files. Most existing tests do this; copy
  the nearest one.
- **Never let a test depend on the wall clock.** Fixtures carry fixed dates. If
  the code under test compares a date against "now", pass the clock in rather
  than reading it, the way `mineWorkflowCandidates` takes `now`. A test that
  passes today and fails in thirty days is worse than no test, and CI runs on a
  daily schedule specifically to catch that class of rot.

## Adding a source adapter

An adapter lives in `src/adapters/<tool>/` and needs four pieces: `discover.ts`
to find transcripts, `parse-transcript.ts` to turn one file into canonical
turns, `workspace-map.ts` to resolve which project a session belongs to, and
`intermediate.ts` to shape the parsed record. Wire it into the source list in
`src/cli.ts`.

Bring fixtures. Put them under `test/fixtures/<tool>/`, keep the real transcript
structure, and make every identifier in them synthetic: no real home
directories, repository names, hostnames or client names. Fixtures are public
forever once merged.

## Documentation

- Architecture decisions go in `docs/decisions/` as a new numbered ADR. Copy
  `docs/decisions/0000-template.md`. Accepted decisions are not rewritten; write
  a new one that supersedes the old.
- Format contracts go in `docs/specs/`.
- End-to-end walkthroughs go in `docs/recipes/`.

Do not document a command you have not run.

## Reporting bugs

Use the issue templates. For a parsing bug, the single most useful thing you can
attach is a minimal transcript that reproduces it, with every identifier
replaced by a synthetic one.

## Security

Do not open a public issue for a security problem. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the MIT
License in [LICENSE](LICENSE).
