# Getting started

Install fleet and create your config:

```sh
curl -fsSL https://raw.githubusercontent.com/RolfKoenders/fleet/main/install.sh | sh
fleet new ~/fleet-config
```

The new repo is a commented example with placeholder skills and MCP servers. Ask your agent to run `fleet agent` and follow the onboarding recipe, or edit `hosts/` and `catalog/` yourself. Every key you can write is listed in the reference: [`fleet.yaml`](reference-fleet-yaml.md), [host files and defaults](reference-hosts.md), [`catalog/mcp.yaml`](reference-catalog-mcp.md) and [`catalog/skills.yaml`](reference-catalog-skills.md). `fleet init` fails until the placeholders are gone.

Publish it as a private repo:

```sh
cd ~/fleet-config
git add -A && git commit -m "Start my fleet config"
gh repo create fleet-config --private --source . --remote origin --push
```

Set up this machine, using its name from `hosts/`. Init prints an age key once, so save it in your password manager:

```sh
cd ~/fleet-config
fleet init laptop
```

Then add your other machines from this one:

```sh
fleet init server
```

## Working with fleet

Change the config, check the result, and publish it:

```sh
fleet diff
fleet push -m "Add a skill"
```

`fleet push` applies the change on every machine with an `ssh:` line in its host file. Every machine also pulls and applies by itself on a timer, every 30 minutes by default, and `timer:` in a host file or the defaults changes that. On a terminal it shows each host's progress live and leaves a summary; piped, it prints one timestamped line per host start and result.

| Command | What it does |
|---|---|
| `fleet status` | Report this machine; `--all` asks every machine over ssh; `--conflicts` lists this machine's conflicts in full, reading only |
| `fleet bridge [--view <screen>] [--host <name>]` | The full-screen view of every host (needs a terminal), optionally opened on a screen and a host; pushes and doctor only on your confirmation. See [the bridge](bridge.md) |
| `fleet ui [--port <n>] [--no-open]` | Open a page in your browser to see and search what every host gets, add, edit and remove MCP servers, skill sources, bundles and hosts, set secrets, and push with live progress; it listens on `127.0.0.1` only and stops after 10 minutes with no page open. See [the page](ui.md) |
| `fleet card [--style machines\|map] [--names] [--badge]` | Write `fleet-card.svg` (1200 x 630), an image of your fleet to share: its counts, each machine with its agents and OS, and a year of changes; hosts are `host 1`, `host 2` unless `--names`, and no server, skill, source or secret name is ever on it. `--badge` writes a small `fleet-badge.svg` for a README instead. It reads what fleet last saw of each host and asks none. See [the page](ui.md#card) |
| `fleet notify --test` | Send a test alert through every channel this machine has (desktop, ntfy, webhook) and say what became of each. Alerts themselves come from the timer's apply, when a conflict or a failure starts or ends. See [alerts](setting-up-machines.md#alerts) |
| `fleet doctor` | Start this machine's MCP servers, check each answers and measure how large its tools are (saved as the doctor result); `--all` asks every machine over ssh. Runs commands with real credentials and may download packages, so it runs only when you ask |
| `fleet context` | Show how much each agent on this machine loads before the first prompt (instructions, skill descriptions, MCP tool definitions) as coloured bars and an estimate in tokens, with the largest items; `--all` asks every machine over ssh and draws all the bars on one scale, so you can see which machine carries the most. MCP sizes come from the last `fleet doctor`; reads only, starts no server; `--usage` also counts, in each agent's history of the last 30 days, how often each MCP server and skill was used, next to its size |
| `fleet diff` | Show what an apply would change |
| `fleet apply` | Make this machine match its config |
| `fleet push` | Publish the config and apply it; `--host <name>` applies only on that host |
| `fleet undo [--no-push] [--yes] [<commit>]` | Revert the last recorded push, or a named one, and push the revert to the same scope; `--no-push` stops after the revert commit, `--yes` skips the prompt |
| `fleet capture [mcp\|skill <name> --host\|--all\|--ignore] [--yes] [--no-push]` | Turn the MCP servers and skills this machine has, and the config does not, into config: it asks about each, writes and commits the config (secrets go to sops, never in the catalog) and asks before it pushes; without a terminal it only reports. See [Capture](capture.md) |
| `fleet adopt` | Take ownership of an MCP server or skill that already matches |
| `fleet secrets` | Edit, set, rekey or rotate encrypted secrets; `rotate` replaces values one by one with hidden input after a leak or a removed machine |
| `fleet host remove <name>` | Retire a machine: delete its files, rekey, commit and push, stop its timer over ssh if it answers, and offer to rotate the secrets it could read. See [Retiring a machine](setting-up-machines.md#retiring-a-machine) |
| `fleet skills update` | Move pinned skill sources to their latest commit; `--review` shows what changed first and asks per source |
| `fleet update` | Move the pinned tool version to the newest release (or the latest commit of a branch, see `track` in `fleet.yaml`) and print what changed |
| `fleet demo` | Try the bridge on made-up hosts in a throwaway sandbox; `--shell` gives a shell instead |
| `fleet agent` | Print what an agent needs to know, including task recipes |

Add `--json` to any command for output a script can read. Every command and option is in the [command reference](commands.md).

### Reading a skill update before it moves

A skill is instructions your agents follow, so a third-party update changes what they do. `fleet skills update --review [<source>]` reads each pinned source that would move, without moving anything, and reports the commits between the pins, each skill you use that changed with its diff size (other changed skills are only counted), and what to look at:

```
acme-skills  c19e2a1 → 7d04f6b, 14 commits, 6 of your 38 skills changed (3 others)

  ~ grilling                 +12 −3
  ! diagnose  scripts/trace.sh   new script; new URL https://…
  ! tdd       SKILL.md           allowed-tools: + Bash(curl:*)
  i triage    SKILL.md           description changed
```

Warnings (`!`) are a file with the exec bit, a new script, a new URL, a new `bash` or `sh` code block in `SKILL.md`, a change to `allowed-tools`, and a new hooks or settings file. A changed `description` is info (`i`), because it changes when the skill triggers. The flags are a reading aid, not a verdict.

On a terminal it then asks for each source: `d` shows the full diff of the skills you use, `y` moves the pin, `n` keeps it. Without a terminal, or with `--json`, it only reports, and a pin moves only with `--yes`. Followed sources are never reviewed.

To review a source every time without typing `--review`, put `review: true` on it in `catalog/skills.yaml`. Switch it on for skills other people write and leave it off for your own: a plain `fleet skills update` then reviews the first and moves the second as before. Only a pinned source can have it.
