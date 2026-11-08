# Changelog

What changed in fleet, newest first. Each version lists what you can do now, what changed, and anything you have to do yourself.

## Unreleased

### Added

- `fleet bridge --view <screen> --host <name>` opens the bridge on a screen with a host selected, for scripts and bar widgets. A name that is not a screen or a host is refused before the screen is taken over.
- `fleet context` shows how much each agent on this host loads before the first prompt: its instructions, the descriptions of its skills and the MCP tool definitions, as a coloured bar per agent and an estimate in tokens, with the largest items and what fleet did not put there. It reads only: it starts no MCP server and decrypts no secret, and an MCP server's size comes from the last `fleet doctor`.
- `fleet doctor` measures how large each MCP server's tool definitions are, shown as an estimate in tokens (`~28.4k tokens`), and keeps the result on the host in `~/.local/state/fleet/doctor.json`. A server that fails keeps its last measurement.
- `fleet update` prints what changed between your pin and the new one: the changelog sections the new commit has that the old one lacks, or the commit subjects when the changelog says nothing. `--json` adds it as `changes`. It is text from the tool's repo, so only printable characters are shown and long output is cut.

## 2.0.0 - 2026-11-03

### Added

- `fleet doctor` starts every MCP server this machine renders and checks that each one answers, in both MCP protocol revisions. It also checks the timer, the age key and the skill links. `fleet doctor --all` asks every machine over ssh. A failing check exits with code 8. It runs commands with real credentials and may download packages, so it runs only when you ask.
- `fleet bridge` opens a full-screen view of every machine: a card each, the matrix of what each machine gets, conflicts, the config's git history, secret names and the catalog. It reads by default. It pushes only after you type `push`, and runs doctor only after you confirm. A push it starts carries on if you close the terminal. See [the bridge](docs/bridge.md).
- macOS 12.3 or newer is supported like Linux. The timer is a LaunchAgent that runs `fleet apply` at login and every 30 minutes, and its log trims itself. Homebrew's tools are found without a login shell, and `install.sh` finds Homebrew's Node. See [Setting up machines](docs/setting-up-machines.md#macos).
- `fleet status --conflicts` lists this machine's conflicts in full and what to do about each. It only reads: nothing is cloned, fetched or written.
- `fleet status` shows which commit of your config the last apply was made from.
- `fleet demo` opens the bridge on made-up machines in a throwaway sandbox, so you can try fleet without touching your own. `fleet demo --shell` gives a shell in that sandbox.

### Changed

- `fleet push` reports each machine as it finishes, so a long push shows progress.
- CI tests Node 22.18, 24 and 26 on Linux, and Node 26 on macOS, Apple Silicon and Intel.

### You need to do

- Nothing. A machine moves to 2.0.0 when you run `fleet update` and push the new pin. Until then it keeps running the pinned version. Machines on 1.0.0 still show up in `fleet bridge`, and a conflict on one reads "detail needs a newer pin".

## 1.0.0 - 2026-11-01

First release. Fleet keeps the setup of your coding agents the same on every machine, from one private git repo called your config.

### Added

- A config repo holds the catalog of MCP servers and skill sources, one host file per machine layered on shared defaults, shared instructions, and encrypted secrets. `fleet new <dir>` starts one from a commented example.
- `fleet init <host>` sets a machine up: it makes its age key, applies the config and turns on a timer. Every machine pulls and applies by itself every 30 minutes.
- `fleet apply` makes this machine match its config for Claude Code and opencode: instructions and skills are linked into place, MCP servers are written, and the settings your config names are set, leaving every other key alone. `fleet diff` shows what an apply would change.
- Fleet never overwrites what it did not write. Anything it finds in the way is a conflict: fleet stops, writes nothing and tells you how to clear it.
- `fleet push` publishes your config and applies it on every machine with an `ssh:` line in its host file.
- `fleet status` reports this machine, and `fleet status --all` asks every machine over ssh.
- `fleet secrets` edits, sets and rekeys encrypted secrets, using sops and age. Secrets reach a machine as plaintext in the settings files of your agents, at mode 600.
- `fleet adopt` takes ownership of an MCP server or skill that already matches your catalog.
- `fleet skills update` moves pinned skill sources to their latest commit, and `fleet update` moves the pinned fleet version to the latest commit.
- `fleet agent` prints what a coding agent needs to know, including recipes for common tasks, so you can hand setup to your agent.
- Every command takes `--json` for output a script can read.
- Fleet runs on Linux with systemd and needs Node 22.18 or newer, git, sops 3.11 or newer and age.
