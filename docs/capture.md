# Capture

You often set something up on a machine first: `claude mcp add`, or a skill folder copied into `~/.claude/skills`. Then you have to type it again as YAML. `fleet capture` turns what the machine has into config instead.

`fleet adopt` only takes over items that already match the config. Capture goes the other way: it finds what the machine has that the config does not, asks what to do with each item, writes the config for you and takes the machine over as it stands, so the next apply has nothing to change.

```sh
fleet capture                                   # on a terminal: ask about each item
fleet capture --json                            # report what it found, write nothing
fleet capture mcp linear --host                 # add one item for this host
fleet capture skill review --all                # add one item for every host
fleet capture mcp scratch --ignore              # stop listing it on this host
fleet capture --yes                             # every item the way the defaults say, then push
fleet capture --no-push                         # stop after the commit
```

## What it covers

- **MCP servers and skills only.** Settings keys and instruction files are not captured: a settings file is mostly yours and the agent's, and instruction files are rarely added by hand.
- **Only the machine it runs on.** Reading another machine's agent files would move pasted tokens over ssh. Other machines show a count instead: `fleet status` has a `not from config` line, `fleet status --json` has `unmanaged`, and each host card of [the bridge](bridge.md) and of [the page](ui.md) says `3 not from config`.
- **Nothing is ever removed from the machine.** The agent's own command (`claude mcp remove`) does that.

An item is one of these:

| What capture says | What you can do |
| --- | --- |
| Not in the catalog | Add it for this host, add it for every host, or ignore it. |
| Matches the catalog, and this host does not pick it | Add it for this host or every host: the pick is the edit, and the machine is taken over once it is written. |
| Matches the config (this host picks it, but fleet did not write it) | Take it over. This does what `fleet adopt` does, and `fleet adopt` stays for scripts. |
| Has the name of a catalog entry and another definition | Capture does not handle it. It is a conflict: the list says `2 differ from the catalog: see fleet status --conflicts`. |
| Cannot be captured | Ignore it. The list says why. |

## MCP servers

A captured server goes to every agent by default. Capture sets `only:` itself when a server cannot work for an agent, such as an SSE server and Antigravity CLI. On a terminal it also asks whether only the agents that had it should get it.

**Two agents, two definitions.** When Claude Code and opencode have the same name in different forms, it is one item. Capture shows both side by side and you pick one. The other agent gets the catalog's version at the next apply, and capture says so.

**Secrets.** Every env variable and header value is a possible secret.

- A value whose name looks like a secret (`*_TOKEN`, `*_KEY`, `*SECRET*`, `*PASSWORD*`, `Authorization`) becomes `secret:NAME` by default. For every other value capture asks: secret or plain.
- The name comes from the server and the key: `LINEAR_API_KEY`, or `LINEAR_AUTHORIZATION` for a header. An env key that already looks like a secret name and is unused elsewhere is kept as it is. You can rename before it is written, and a name that exists already is never replaced.
- "This host" puts the value in that host's secrets file, "every host" in `secrets/shared.enc.yaml`. Fleet encrypts it with sops, one value at a time.
- A secret never reaches the catalog, a log, an error, `--json` or the page as plain text. Capture shows the names of the keys and never their values, not even in the questions it asks.

Two things capture will not copy, because the catalog cannot hold them safely: a credential in a command line (`--token abc`, which every user on the machine can read) and a credential in a URL (`https://user:pass@host`, or `?api_key=`). Those items are listed as not capturable. Move the value into an environment variable or a header, then capture again.

A command that fetches a package with no version (`npx pkg`, `uvx pkg`) is captured as it is, with the same warning `fleet ui` gives when you add one: it changes whenever the package does.

## Skills

- A skill inside a git repo with a remote makes that repo a pinned skill source with `review: true`. When the repo is a source already, only the bundle step happens.
- A loose folder with no repo is listed with a message to put it in a repo first. Skills stored inside the config repo are not handled yet.
- Capture asks for an existing bundle or a new one; the default is a new bundle named after the source. "This host" adds the bundle to that host's file, "every host" to the defaults.

The repo's latest commit must be on its remote, because the pin is a commit every machine has to be able to fetch. A skill folder that is a link of your own, or a copy, is not fleet's link, and capture does not remove it: after the capture it says what to delete, and the next apply links the skill from fleet's own copy of the source.

## After a capture: nothing left for apply

After a capture for this host, capture takes ownership on this machine the way `adopt` does. What fleet would render for each captured entry, with its secret filled in, equals what is on disk, so the next apply changes nothing. When they differ, because you picked the other agent's definition, capture says the next apply will rewrite that entry.

## Ignore

`unmanaged:` in a host file lists the items capture should not list or count again:

```yaml
unmanaged: [mcp:scratch-server, skill:my-notes]
```

It is versioned with the config, so it survives a reinstall. See [`unmanaged`](reference-hosts.md#unmanaged). Every host has to run a fleet version that knows the key before a host file uses it, because an older fleet rejects it as unknown.

## Writing and pushing

On a terminal, `fleet capture` walks through each item and asks. At the end it writes the config files (comments and style kept, the same engine `fleet ui` uses), commits, and asks `Push now? [y/N]`, as `fleet undo` does. `--no-push` stops after the commit. The config repo must have no changes of its own first.

Without a terminal, or with `--json`, it only reports what it found and writes nothing. `--yes` takes the defaults: this host, a secret for each key named like one, plain for the rest, and it pushes unless `--no-push` is given. `fleet capture mcp|skill <name> --host|--all|--ignore` answers for one item; on a terminal it asks before it pushes, and without one it pushes only with `--yes`.

`--json` lists each item with its `kind`, `name`, `state`, `message`, `agents` and, for a server, its definitions with the names of their env variables and headers. It has no value. When something was written it adds `captured`, `commit`, `takenOver`, `rewrites` and `pushed`.

## In the page

`fleet ui` has a Capture screen after Hosts. It shows the machine the page runs on, with the same choices and secret questions. Each choice goes on To push with its YAML diff, like Add. See [the page](ui.md#capture).
