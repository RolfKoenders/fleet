# Changelog

What changed in fleet, newest first. Each version lists what you can do now, what changed, and anything you have to do yourself.

## Unreleased

### Added

- `fleet doctor` now reports `bad-auth` when a server answers HTTP 401 or 403 with configured credentials, naming the `secret:NAME` values the server uses, which secrets file holds each one, and when that value was last set in the file's git history. The text and `--json` output include this, and the bridge marks it as a failure. A server that wants a login and has no configured credentials is still `auth-needed` (neutral). Set a new value with `fleet secrets set` or in the Secrets screen of `fleet ui`.
- The docs are pages on the site at rolflab.nl/fleet/docs/, with a side navigation, a search field on every page and a docs home that links to every page. `npm run site:docs` builds them from `docs/*.md` (the releasing guide stays for maintainers), and a test fails when a doc changes without it. `docs/getting-started.md` is new and holds the README's Getting started and Working with fleet sections. The landing page and the changelog page link to the docs now.
- `fleet undo [--no-push] [--yes] [<commit>]`: revert the last recorded push, or a named one, and push the revert to the same scope. `--no-push` stops after the revert commit, and `--yes` skips the prompt. If the revert clashes with a newer commit, undo refuses with exit 3, commits nothing and names the clashing files and newer commit. When the push changed a secrets file, the message says the revert brings back the old encrypted values. The bridge's push history screen has a `u` key that runs the same undo on the selected entry after the same confirmation.

### Changed

- Removing the last key under a map from a host file now takes the map too. Before, fleet deleted only the key, so a provider or section you took out of `settings` left empty maps behind in the tool's file (`"provider": {"x": {"models": {"m": {}}}}`), and a tool that lists those names, such as opencode's model picker, kept showing them. Fleet now deletes each map above a removed key that the removal leaves empty, nearest first, and stops at the first one that still holds anything. The top level stays, and an empty map elsewhere in the file is not touched. A map that is emptied and refilled in the same apply keeps its place in the file.

## 2.6.0 - 2026-11-18

### Added

- Antigravity CLI (`agy`) is a supported agent, the first one beyond Claude Code and opencode. A machine that has it gets its settings (`settings.antigravity` in a host file, written to `~/.gemini/antigravity-cli/settings.json`; the keys the CLI writes itself, such as `trustedWorkspaces`, `model` and `permissions`, are refused), its MCP servers in `~/.gemini/config/mcp_config.json`, skills linked into `~/.gemini/config/skills` and instructions linked to `~/.gemini/GEMINI.md`. Fleet touches only `~/.gemini/antigravity-cli`, `~/.gemini/config` and `~/.gemini/GEMINI.md`, so Gemini CLI, which shares `~/.gemini`, and other tools that link skills into the same directory are left alone. Antigravity CLI does not support SSE servers: an `sse` server whose `only` names `antigravity` is an error, and one without `only` goes to the other agents, is left out of its file, and a machine that has `agy` says so in one `warning` line in `fleet diff` and `fleet apply`. `docs/mcp-logins.md` says how Antigravity CLI signs in to MCP servers.
- `docs/adding-an-agent.md` and `CONTRIBUTING.md` say what it takes to add an agent: the adapter and its registry line, an official documentation link for every path, key and format, the conformance suite, a fake binary and the lists, and the bar an agent has to meet. The README, the landing page and `fleet agent` each have a Supported agents list, and the one in `fleet agent` comes from the registry.
- A machine now gets only the agents installed on it. Fleet finds an agent by its program (`claude`, `opencode`, `agy`) on the usual paths, in mise's shims (`~/.local/share/mise/shims`, where Omarchy installs `agy`) and in the directory of the Node it runs under, where `npm -g` puts agent CLIs, which also covers the timer, whose `PATH` has no fnm. Config for an agent that is not installed is not applied, and what fleet applied for it earlier is left as it is, never removed; installing the agent sets it up at the next apply. Skills are linked while any agent that reads their directory is installed. When an agent that fleet applied config for earlier is gone, fleet says so on every apply, diff and status, and on the bridge's host card. It says nothing about an agent the machine never had, opencode included: `fleet status` on a machine without it no longer ends in `(opencode not installed)`. The warning reads "opencode: not installed, its config is left as is. Install it, or pin `agents:`". Nothing changes for a machine that has every agent. See [setting up machines](docs/setting-up-machines.md#which-agents-a-machine-gets).
- `agents: [claude, opencode]` in a host file (or the defaults) names the agents a machine gets instead of detecting them. A host file's list replaces the defaults' list, an unknown id is an error, and a named agent is set up whether or not it is installed (Claude's MCP servers still wait for `claude`). `fleet agent` has a recipe for taking an agent's config off a machine: take it out of the config and push while the agent is still installed, then pin it out.
- `fleet status` shows the agents a machine gets (`agents: claude 2.1.4, opencode 1.4.2`, with `(opencode not installed)` and `(pinned)` where they apply). `status --json` has `agents`, one `{id, version, active, pinned}` per agent the machine has installed, names in `agents:` or applied config for, and `notInstalled`, the ids of the agents that warning is about. `tools` keeps its `claude` and `opencode` keys (null when not found) and gains a key for any other agent only where the machine names it; a host on an older fleet that sends neither `agents` nor `notInstalled` is still read. A host card in the bridge lists only the agents its machine gets.
- `fleet ui`: the Agents boxes of the MCP server form show the agents some machine has or names, and "Show all agents" reveals the rest. An agent that is not shown keeps its value, so hiding it never narrows a server's `only`.

### Changed

- `fleet context --json` (and `context --all`) lists only the agents a machine gets, so a machine without opencode has no opencode entry. `fleet doctor` likewise checks only their servers.

### Fixed

- `fleet doctor --all` and the bridge no longer fail on a host whose fleet knows an agent this one does not: that agent's servers are left out of the doctor grid, and the bridge's context view skips the agent, instead of rejecting the host's whole answer.

### You need to do

- Nothing, if your config is unchanged and every agent you use is installed on each host: the plan and `fleet context --json` are the same as before, and `fleet status --json` only gains fields. What changes with 2.6.0 is this. A host now gets only the agents installed on it, and config for an agent it lacks is not applied there and is never removed (`agents:` in a host file names the agents instead of detecting them). `fleet status` and `status --json` gain `agents` and `notInstalled` and no longer mention an agent a host has never had (a host without opencode no longer shows `opencode` in the text); `tools` keeps its keys. `fleet context --json` lists only the agents of the host. A host with Antigravity CLI installed gets its config at the next apply; one without it is not changed and does not hear of it. To give Antigravity CLI the shared instructions, add `{ source: config/AGENTS.md, target: ~/.gemini/GEMINI.md }` to `files`.
- Every host has to be on 2.6.0 before a host file uses `agents:` or `settings.antigravity`, because an older fleet rejects a key it does not know. Move your pin with `fleet update`, read what it prints, and `fleet push`.

## 2.5.0 - 2026-11-15

### Added

- `fleet ui` can edit an existing skill source, bundle, MCP server or host: every card on the Catalog and on Hosts has an Edit button that opens the Add dialog for that kind with its current values, the name read-only and the same live YAML diff and checks. An edit writes only the fields that changed and keeps every other key and comment byte for byte (a changed value keeps the comment at the end of its line), goes on To push like any edit, and is dropped as stale, never overwriting a newer value, when the file has moved on. A skill source can change its path, branch, pin or follow and review (the repo stays, because machines keep each clone under the source's name) and moves its pin to the head of a new branch; an addition that is still on To push is changed in place; an entry fleet cannot change safely (anchors, aliases, flow maps) opens read-only with the reason and the file to edit by hand. See [the page](docs/ui.md).
- `fleet ui` can remove a skill source, bundle, MCP server or host: every card on the Catalog and on Hosts has a Remove button that asks first, showing what changes and the YAML diff of every file touched. Removing a server or bundle takes its entry and every reference to it (`bundles`, `exclude`, `mcp.include`, `mcp.exclude`) out of the defaults and each host file, and goes on To push as one edit that Remove from push undoes; removing a skill source takes its skills out of every bundle that lists them and says what each bundle loses (a bundle left with no skills is kept and flagged), and leaves the clones on your machines alone. An item whose addition is still on To push is just dropped. A host is removed at once after you confirm, like adding one: it deletes its host file and secrets file, runs the real `fleet secrets rekey`, commits and pushes, streams the output, and puts everything back if that fails before the commit; the dialog says the machine keeps its files and its timer will report errors, lists the secret names the host could read and asks you to change them, because rekeying does not change a value. The host the page runs on and the only admin are refused. The check on Review & push now also catches a bundle that names a skill no known source provides, which until now only `fleet push` found. See [the page](docs/ui.md).
- Search in the Matrix and the Catalog of `fleet ui`: one field at the top filters rows and cards by name as you type, without regard to case, and a bundle also matches by its skills. Press `/` to reach it and Esc to clear it. The filter is kept in the page address, so a reload keeps it. To push and Review & push are never filtered, and the field says when it hides rows that have an edit on To push. See [the page](docs/ui.md).

## 2.4.0 - 2026-11-14

### Added

- New: `fleet ui`, a web page for your whole fleet that you open from the terminal and use in your browser. A Matrix shows every skill bundle and MCP server against every host, and a click gives an item to a host or takes it away with the smallest edit to its host file. Dialogs add an MCP server, a skill source, a skill bundle or a host (which runs the real `fleet init` and streams its output in), and the Secrets screen shows which host is missing which secret and sets a value, encrypted with sops at once and never kept or shown. Every edit shows as a live YAML diff with comments and layout kept and waits on To push; Review & push checks that each host still loads, then writes, commits and runs the real `fleet push` with each host's progress live. Every item has a YAML toggle that shows how it is written in the config repo. Only you can reach it: the server listens on `127.0.0.1` only, refuses another `Host` or a write from another `Origin`, needs the random token in the URL it prints on every call, and stops on ctrl-c or after 10 minutes with no page open. The page survives a reload or a stopped server, has no build step and no dependencies, and loads nothing from another origin. `--port <n>` picks the port and `--no-open` keeps the browser closed. See [the page](docs/ui.md).

### Fixed

- A host file (or any config file) that holds only comments is read as empty instead of failing with "expected a document, but the input is empty".
- A credential in a skill source's repo URL (`https://user:token@...`) is refused when the config loads, and messages that echo a URL leave out its userinfo.

## 2.3.0 - 2026-11-14

### Added

- The landing page has a section on why not just dotfiles, a release pill and a What's new section, and `rolflab.nl/fleet/changelog/` lists every release with a filter for each kind of change. They are generated from this file: `npm run site:changelog` rewrites them, and a test fails when this file changes without it.
- Every `fleet push` now writes a journal on the host that ran it: `~/.local/state/fleet/pushes/<time>-<pid>.jsonl`, a header (time, commit pushed, which host or all, how it ended) and the push's events with their times. The last 20 are kept, the file is private to you (0600), it is never shared between hosts, and it never makes a push fail. In the bridge, `h` on the push screen lists the recorded pushes, `enter` replays one at its real speed, and the end of a push says how much faster or slower it was than the last push of the same scope, such as `1.4s faster than the last push`. There is no command for it.
- `fleet push --host <name>` publishes as usual, then applies only on that host: this one, or one with an `ssh:` destination. From the laptop, `--host box` does not apply here, so a conflict on this host does not stop it; `--host` with this host's own name is the same as publishing and then `fleet apply`. A host without an `ssh:` destination (it applies on its own timer) or an unknown name is refused with exit 2 before anything is published, and the unknown-name message lists the valid names. It takes the push lock. `--host` was already a `fleet bridge` flag and still is.
- `fleet push --json` lists what changed on each host. Each entry in `hosts` gains `created`, `updated` and `removed`, copied from that host's `apply --json` (key entries are `{file, path}`, link entries carry a `target`; no values), and `changes` is still the count. A host that gave no document (timer, unreachable, error) has empty lists. The text summary shows the counts by kind and the time of each host's apply, such as `server: ok · 2 links, 1 key (1.8s)`.

### Changed

- The landing page's feature cards are trimmed to conflicts, skill review and startup context, plus one strip for secrets, pinned skills, the MCP doctor and agent use.
- The bridge's push screen shows time and what each host got. The pipeline row has the total elapsed time and each lane its own, and a host that is connecting over ssh says so from the start, with its time running. An activity feed lists every event with its time and host, and a host pane (`↑` and `↓` pick the host) shows what was written there so far and how many writes remain, then after the push what it got, from the `created`, `updated` and `removed` lists of the end document. From 100 columns everything shows, below 100 the host pane goes, and below 80 the feed goes too. `r` on a lane after the push runs `fleet push --host <name>` for it, and `f` on a lane with a conflict opens the Conflicts screen on that host.
- `fleet push` shows each host's progress live on a terminal: a block on stderr with validate, publish and apply, then one line per host with its stage, a bar for its step and its time, replaced when the push ends by a summary that stays in the scrollback (on a terminal the same lines are not printed again on stdout). Piped, or in CI, it prints one timestamped line when each host starts and when it has a result, plus the host's own text; stdout and `--json` are unchanged. Ctrl-C prints the summary so far and exits 130, and this corrects the 2.0.0 line that push "reports each machine as it finishes", which it did not.
- Only one `fleet push` runs at a time. A second one, from a terminal or the bridge, stops at once with `a push is already running (pid N)` and exit 7 (`locked`), instead of racing the first. The lock is `~/.local/state/fleet/push.lock`, held from validate until the last host is done and let go on every way out; one left by a process that is gone is taken over. It is separate from the apply lock, which still covers one host's files.

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
