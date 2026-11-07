# fleet

Fleet describes how every machine that runs coding agents should be set up (shared instructions, skills, MCP servers, Claude Code and opencode settings, secrets) and makes each machine match that config. The tool lives in this repo. A user's own config is a separate private repo, and a commented example of one is in `examples/`; `fleet new <dir>` copies it.

Terms are defined in `GLOSSARY.md`. Use them as written there.

## Development

`npm install` is for development and CI only; `fleet` itself has no runtime dependencies.

- `npm run typecheck` and `npm test` need Node 22.18 or newer, plus `sops` 3.11 or newer and `age-keygen` on the probe path (`~/.local/bin` first). The secrets tests use the real ones. Tests that need one of them missing are skipped when it is installed in a system directory, so they run in CI.
- Tests run in a temp `HOME`.
- Never run `fleet apply` or `fleet init` against a real `HOME` while developing.
- The landing page's terminal clips are recorded from the bridge: `npm run site:frames` rewrites `site/frames.js`, and a test fails when a change to the bridge makes the committed file stale. To add a clip, see the top of `scripts/site-frames/record.ts`.

## Changelog

Every user-facing change adds a line under `## Unreleased` in `CHANGELOG.md`, in the same commit or PR. Releases are described in `docs/releasing.md`.

## Writing style

No em dashes anywhere in this repo: docs, comments, issues, commit messages.
