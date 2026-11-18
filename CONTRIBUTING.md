# Contributing

Bug reports and pull requests are welcome. Read `AGENTS.md` first: it says how to build and test, how the changelog works and the writing style.

Run `npm run typecheck` and `npm test` before you open a pull request. Add a line to `CHANGELOG.md` under `## Unreleased` for a change a user can see.

## Adding an agent

A new coding agent is one module in `src/agents/` and one line in the registry. [Adding an agent](docs/adding-an-agent.md) has the steps. What a pull request for one needs:

- The adapter file and its registry line, with an official documentation link in a comment for every path, key and format it uses.
- The conformance suite passes. It runs for every registered agent, so a registered agent gets it without a test of its own.
- A fake binary for the tests and the demo (the compiler asks for the demo's version line).
- An entry in the Supported agents lists in `README.md` and `site/index.html`, and in the glossary.
- A line in `CHANGELOG.md`.

The agent has to meet this bar: it keeps user-level config files that fleet can merge, it is maintained, it installs on Linux and macOS, and its configuration is documented.
