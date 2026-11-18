# Adding an agent

What fleet knows about an agent is one module in `src/agents/` and one line in the registry. Nothing else names an agent: the rest of the tool loops over the registry. Antigravity CLI (`src/agents/antigravity.ts`) was added this way and is the example to read next to this page.

## What an agent has to be

An agent is accepted when all of these hold:

- It keeps its configuration in **user-level files** fleet can merge: a settings file, an MCP file, instructions or a skills directory under the user's home. An agent that is configured only in a cloud console, an app database or per project does not fit.
- It is **maintained**: it has releases, and its documentation is current.
- It installs on **Linux and macOS**, with a program on the path (or in a directory its installer uses) that prints a version.
- It is **documented**: the official documentation says where each file is and what its keys mean. Fleet cannot check a path against the code, so the module cites the page.

## The steps

1. **Read the documentation, then the real agent.** Install it in a throwaway home (`HOME=$(mktemp -d)`) and look at what it reads and writes. Never run it against your own home to find out.
2. **Write `src/agents/<id>.ts`.** It exports an `Agent` (see `src/agents/types.ts`): an id that host files will use (renaming it later breaks every config), a name, the binary, the arguments that print its version, and `homes`, the paths that belong to it alone. Then the optional parts it has:
   - `settings`: the file the agent also writes, and `denied`, the dotted paths no config may own (what the agent writes itself, account and credential keys, keys it ignores).
   - `mcp`: the file, the key the servers are under, `render` for the entry of a server in the agent's shape, `read` for the way back (doctor uses it), `skip` for an entry the agent does not load, and `transports` when it cannot take all of stdio, http and sse.
   - `skills`: the directory fleet links skills into, and every directory the agent reads, lowest precedence first.
   - `instructions`: the files and directories it reads as instructions.
3. **Cite the documentation** in a comment for every path, key and format the module uses: one URL per fact, so a reviewer can check it. A path or key with no source is not merged.
4. **Add one line to `AGENTS` in `src/agents/index.ts`**, last, because the order is the order fleet lists agents in. The compiler then asks for the rest: the demo's version line in `src/demo/fakes.ts`.
5. **Set `quiet: true`** so a host that does not have the agent sees no change from fleet adding it: `fleet status` says nothing about it there.
6. **Run the conformance suite.** `test/agents.conformance.test.ts` runs against every registered agent: identity, MCP render and read for each transport, denied keys refused as they are, below them and above them, the location checks, and an apply followed by taking everything away in a temp home. It needs no edit to cover the new agent. An agent whose MCP writes must go through its own binary needs a fake of its own in `FAKES`; most need none, because the suite installs a fake that prints a version.
7. **Add the agent's own tests** for what is particular to it (`test/antigravity.test.ts`): the shape of its entries, the keys it refuses, a host without it.
8. **List it.** Add it to the Supported agents lists in `README.md` and `site/index.html`, to the term Agent in `GLOSSARY.md` and in `src/agent.ts` (a test keeps the two equal), and give `examples/hosts/_defaults.yaml` the link of the shared instructions into its file. The list in `fleet agent` comes from the registry.
9. **Add a line to `CHANGELOG.md`** under `## Unreleased`.

## Checking it

```sh
npm run typecheck
npm test
```

Then apply the example config in a temp `HOME` with the real agent on the path and ask the agent itself what it sees: `HOME=<tmp> agy mcp list` lists the servers fleet wrote, for example. If the agent only reads a file once you sign in, say so in the pull request and show what you could check.

Never run `fleet apply`, `fleet init` or the agent against your real home while you work on this.

## What review looks at

- Every path, key and format has a documentation link, and the link says what the comment claims.
- `homes` hold only what is the agent's: a folder shared with another tool (Antigravity CLI and Gemini CLI both use `~/.gemini`) is listed by the files and directories that are the agent's alone.
- `denied` has what the agent writes itself, so a config cannot own a key the agent keeps rewriting.
- A host without the agent is unchanged: no file written, no word in `diff`, `apply` or `status`.
- Config that already exists keeps working after the agent is registered. If the new agent cannot take something existing config says (an sse server for every agent), it leaves it out and says so, and does not turn the config into an error.
