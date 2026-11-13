# Changelog

What changed in fleet, newest first. Each version lists what you can do now, what changed, and anything you have to do yourself.

## Unreleased

### Added

- The landing page has a section on why not just dotfiles, a release pill and a What's new section, and `rolflab.nl/fleet/changelog/` lists every release with a filter for each kind of change. They are generated from this file: `npm run site:changelog` rewrites them, and a test fails when this file changes without it.

### Changed

- The landing page's feature cards are trimmed to conflicts, skill review and startup context, plus one strip for secrets, pinned skills, the MCP doctor and agent use.

## 2.2.0 - 2026-11-12

### Security

- `fleet apply` no longer puts a Claude MCP server's decrypted secrets on a command line. It used to add a server with `claude mcp add-json`, which takes the whole entry as an argument, and any user on the host could read that from the process list while it ran. Fleet now writes the entry into `~/.claude.json` itself, holding the same `~/.claude.json.lock` Claude takes around its own writes, so a running Claude session neither loses fleet's entry nor has its own save lost. Removing a server still uses `claude mcp remove`, which carries no secret.

### Added

- The landing page is served from `rolflab.nl/fleet`. `deploy/Dockerfile` builds it as a container that serves `site/` under `/fleet/`. The old GitHub Pages address redirects there, keeping the section of the link.
- `track: releases` in `fleet.yaml` makes `fleet update` follow releases instead of a branch. It moves the pin to the newest release, the highest `vX.Y.Z` tag (tags with a suffix such as `v3.0.0-rc.1` are ignored), and prints `tool: <old> -> v2.2.0 (a1b2c3d)` with the changelog sections in between; `--json` adds `release`. On the newest release it says `up to date (v2.1.0)`; a pin that is already past it stays where it is until the next release. A move to a new major version adds a line to read "You need to do" before you push. A repo with no release tag exits 2. Any other `track` is a branch, as before.
- `fleet status --json` and `status --all --json` carry `conflictList` for each host: its first 5 conflicts as `kind` and `path`, in the order `status --conflicts` lists them, so a row can name what is wrong. `conflicts` is still the count. A host that cannot plan its conflicts has `null` for both, and a host on an older fleet has no `conflictList`. The Omarchy widget shows the first one on the host's row.

### Changed

- The README and the landing page show a new screenshot of the Omarchy widget, with a host's row naming its first conflict.
- `fleet new` writes `track: releases`, so a new config takes finished versions and not every commit on `main`. To keep following a branch, change `track` in `fleet.yaml`.
- The landing page's title is now "fleet · One config. Every machine.", the same line as its heading, in the browser tab and in link previews.

### Fixed

- `fleet doctor` in a shell with no user session, as after `sudo -iu`, no longer reports a running timer as a problem: systemd cannot be asked from there, so the timer is `unknown`, with the reason and that doctor over ssh or from a login shell can see it. It does not count as a problem or change the exit code. With a session, a timer that gives no answer is still a problem.
- `fleet context` and the bridge's context screen say why a server has no size. A server that wants a login says it needs one, so doctor cannot list its tools, instead of telling you to run `fleet doctor` again. A server whose last doctor run failed names that result. `--json` items have a `doctor` field with what the last doctor run found.
- On the landing page, the bridge's keys keep working after you click one of its tabs or key chips; before, they only worked while the terminal itself had focus. The feature cards with an example now span the row, text beside the example, so the short cards next to them no longer stretch into tall empty boxes.

## 2.1.0 - 2026-11-08

### Added

- `fleet context` shows how much each agent on this host loads before the first prompt: its instructions, the descriptions of its skills and the MCP tool definitions, as a coloured bar per agent and an estimate in tokens, with the largest items and what fleet did not put there. It reads only: it starts no MCP server and decrypts no secret, and an MCP server's size comes from the last `fleet doctor`.
- `fleet context --all` asks every host over ssh, the way `fleet status --all` does, and prints one block per host in the layout of `fleet context` with every bar on one scale: the largest agent on any host. A host whose fleet is too old to have `fleet context` is shown as needing a newer pin and does not fail the run; an unreachable host exits 4, as in `status --all`. `--json` has one record per host.
- `fleet doctor` measures how large each MCP server's tool definitions are, shown as an estimate in tokens (`~28.4k tokens`), and keeps the result on the host in `~/.local/state/fleet/doctor.json`. A server that fails keeps its last measurement.
- The bridge shows each host's startup context: a new tab `8` draws one stacked bar per host and agent on one scale, with the largest items of the selected host, and each home card has a line such as `context ~18.6k`, marked `+` when a server is not measured. The bridge asks each host for it with the status (one more ssh call), again after a doctor run, and remembers it between runs like the status. It starts no MCP server, and doctor still runs only on `d`.
- `fleet skills update --review [<source>]` shows what changed in a pinned skill source before its pin moves: the commits, each skill you use that changed with its diff size, and a flag for anything risky (a file with the exec bit, a new script, a new URL, a new `bash` block, a change to `allowed-tools`, a new hooks or settings file, a changed `description`). On a terminal you press `d` for the full diff, `y` to move the pin or `n` to keep it. Without a terminal, or with `--json`, it only reports, and a pin moves only with `--yes`. Without `--review`, `fleet skills update` is unchanged.
- A pinned skill source may have `review: true` in `catalog/skills.yaml`. `fleet skills update` then reviews that source as if you had passed `--review`, and moves the sources without it as before. The bridge catalog shows "review" next to such a source. A followed source cannot have it.
- `fleet update` prints what changed between your pin and the new one: the changelog sections the new commit has that the old one lacks, or the commit subjects when the changelog says nothing. `--json` adds it as `changes`. It is text from the tool's repo, so only printable characters are shown and long output is cut.
- `fleet bridge --view <screen> --host <name>` opens the bridge on a screen with a host selected, for scripts and bar widgets. A name that is not a screen or a host is refused before the screen is taken over.
- The README and the landing page show the Omarchy widget, with a link to its repo. The page also plays the bridge's context tab and shows startup context and skill review output, recorded from the real commands.

### You need to do

- Move your pin with `fleet update`, read what it prints, and `fleet push`. Every host has to be on 2.1.0 before your catalog uses `review: true`: an older fleet rejects a key it does not know.
- Run `fleet doctor` (or `d` in the bridge) once on each host, so `fleet context` and the bridge have the size of each MCP server. Until then those servers show as not measured.
- For the bar widget on Omarchy, install https://github.com/RolfKoenders/fleet-omarchy. Its shortcuts into the bridge need a host on 2.1.0.

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
