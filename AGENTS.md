# fleet

Fleet describes how every machine that runs coding agents should be set up (shared instructions, skills, MCP servers, Claude Code and opencode settings, secrets) and makes each machine match that config. The tool lives in this repo. A user's own config is a separate private repo, and a commented example of one is in `examples/`; `fleet new <dir>` copies it.

Terms are defined in `GLOSSARY.md`. Use them as written there.

## Development

`npm install` is for development and CI only; `fleet` itself has no runtime dependencies.

- `npm run typecheck` and `npm test` need Node 22.18 or newer, plus `sops` 3.11 or newer and `age-keygen` on the probe path (`~/.local/bin` first). The secrets tests use the real ones. Tests that need one of them missing are skipped when it is installed in a system directory, so they run in CI.
- Tests run in a temp `HOME`.
- Never run `fleet apply` or `fleet init` against a real `HOME` while developing.

## Writing style

No em dashes anywhere in this repo: docs, comments, issues, commit messages.
