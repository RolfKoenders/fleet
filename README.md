<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img alt="fleet" src="assets/logo-light.svg">
  </picture>
</p>

# fleet

Fleet keeps the setup of your coding agents the same on every machine. You keep instructions, skills, MCP servers, settings and encrypted secrets in one private git repo, called your config, and fleet makes each machine match it.

If a machine holds something different, fleet stops and reports a conflict instead of overwriting it.

## Try it first

```sh
fleet demo
```

This builds a throwaway fleet in a temporary directory: three made-up hosts, a config repo, and local folders standing in for GitHub. On a terminal it opens the bridge on them, marked DEMO, with a conflict already waiting on `server`; press `P` to watch a push. It needs only git and Node, touches nothing outside that directory, and deletes it when you quit. Without a terminal, or with `--json`, it runs a scripted walk-through itself and exits. `fleet demo --shell` gives a shell in the made-up fleet instead, with a printed list of commands to try.

To record a GIF of it for this page, run `fleet demo` inside a terminal recorder such as [vhs](https://github.com/charmbracelet/vhs) or asciinema with agg: set the window to about 110 columns by 34 rows, let the boot animation play, press `P`, type `push`, press enter, and quit with `q`. Nothing from the real machine appears in it, because the demo's hosts are made up.

## The bridge

`fleet bridge` opens a full-screen view of every host: a card each, the matrix of what each host gets, conflicts, the config's git history, secret names, and the catalog. It needs a terminal. It reads, and the cards fill at once from what the last run saw, labelled "seen 2h ago, not live" until the host answers (that memory is `~/.local/state/fleet/bridge-hosts.json`, which only the bridge reads and which holds no secrets). Keys: `?` lists them, `ctrl-k` is a palette, `r` asks the hosts again.

- `P` reviews a push. Nothing runs until you type `push` and press enter. `tab` moves to an optional commit message (the same as `fleet push -m`); a message never starts a push. A file that looks like a plaintext secret (`.env`, `*.pem`, `*.key`, names with `secret` or `token`) blocks a push from the bridge until you remove it or add it to `.gitignore`; `fleet push` itself does not check. A push goes on by itself if you quit or the terminal closes, and the bridge waits for it when it can.
- `d` runs `fleet doctor --json` (`--all` across hosts) after you confirm. It starts real MCP servers with real credentials, so opening the bridge never does it. The result fills a health mark beside each server in the matrix; a server that only needs a login is shown as neutral, and any result the bridge does not know is shown as unknown.
- The conflicts screen lists every host's conflicts, read with `fleet status --conflicts` (read-only, no clone or fetch). A host on an older pin shows "detail needs a newer pin".

The look is dark first. `FLEET_THEME=light` selects a best-effort palette for light terminals; it is less polished, and `NO_COLOR` and `FLEET_NO_MOTION` are honoured.

## Getting started

Install fleet and create your config:

```sh
curl -fsSL https://raw.githubusercontent.com/RolfKoenders/fleet/main/install.sh | sh
fleet new ~/fleet-config
```

The new repo is a commented example with placeholder skills and MCP servers. Ask your agent to run `fleet agent` and follow the onboarding recipe, or edit `hosts/` and `catalog/` yourself. `fleet init` fails until the placeholders are gone.

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

`fleet push` applies the change on every machine with an `ssh:` line in its host file. Every machine also pulls and applies by itself every 30 minutes.

| Command | What it does |
|---|---|
| `fleet status` | Report this machine; `--all` asks every machine over ssh; `--conflicts` lists this machine's conflicts in full, reading only |
| `fleet bridge` | The full-screen view of every host (needs a terminal); pushes and doctor only on your confirmation |
| `fleet doctor` | Start this machine's MCP servers and check each answers; `--all` asks every machine over ssh. Runs commands with real credentials and may download packages, so it runs only when you ask |
| `fleet diff` | Show what an apply would change |
| `fleet apply` | Make this machine match its config |
| `fleet push` | Publish the config and apply it |
| `fleet adopt` | Take ownership of an MCP server or skill that already matches |
| `fleet secrets` | Edit, set or rekey encrypted secrets |
| `fleet skills update` | Move pinned skill sources to their latest commit |
| `fleet update` | Move the pinned tool version to the latest commit |
| `fleet demo` | Try the bridge on made-up hosts in a throwaway sandbox; `--shell` gives a shell instead |
| `fleet agent` | Print what an agent needs to know, including task recipes |

Add `--json` to any command for output a script can read.

## Requirements

- Linux with systemd, or macOS 12.3 or newer with Homebrew (see [Setting up machines](docs/setting-up-machines.md#macos-experimental))
- Claude Code or opencode
- Node 22.18 or newer
- git
- [sops](https://github.com/getsops/sops) 3.11 or newer
- [age](https://github.com/FiloSottile/age)

macOS is experimental. Fleet has never run on a real Mac: the support is written from Apple's documentation and tested only against fakes. Headless Macs are out of scope ([details](docs/setting-up-machines.md#macos-experimental)).

## Docs

- [Setting up machines](docs/setting-up-machines.md)
- [Logging in to MCP servers](docs/mcp-logins.md)
- [FAQ](docs/faq.md)

## License

[MIT](LICENSE)
