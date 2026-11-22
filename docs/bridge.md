# The bridge

`fleet bridge` opens a full-screen view of every host: a card each, the matrix of what each host gets, conflicts, the config's git history, secret names, the catalog, and each host's startup context. It needs a terminal.

It reads, and the cards fill at once from what the last run saw, labelled "seen 2h ago, not live" until the host answers. That memory is `~/.local/state/fleet/bridge-hosts.json`, which only the bridge reads and which holds no secrets. It keeps each host's startup context next to its status, cut to the fields the context screen shows.

## Opening on a screen or a host

```sh
fleet bridge --view matrix --host server
```

`--view` opens on a screen: `home` (the default), `matrix`, `conflicts`, `timeline`, `secrets`, `catalog`, `push` or `context`. These are the tabs, so a screen that gets a tab later gets a view. `--host` selects a host on that screen: its card on Home, its column in the Matrix, and its conflicts first on Conflicts. `--host` alone opens Home on that host's card. Both work in `fleet demo`'s bridge.

A name that is not one is refused with exit 2 before the screen is taken over, and the valid names are listed. `--view push` opens the push screen the way the `7` key does: nothing is reviewed or started until you press `P`.

## Keys

- `?` lists the keys, `ctrl-k` opens a palette, and `r` asks the hosts again.
- `P` reviews a push. Nothing runs until you type `push` and press enter. `tab` moves to an optional commit message (the same as `fleet push -m`); a message never starts a push. A push goes on by itself if you quit or the terminal closes, and the bridge waits for it when it can.
- `h` on the push screen opens the push history; `enter` replays the selected push, `u` undoes it after a confirmation, and `esc` goes back (see "The push journal").
- `d` runs `fleet doctor --json` (`--all` across hosts) after you confirm. It starts real MCP servers with real credentials, so opening the bridge never does it. The result fills a health mark beside each server in the matrix; a server that only needs a login is shown as neutral, a server that rejected a configured secret is shown as failing, and any result the bridge does not know is shown as unknown.

## Startup context

Tab `8` shows how much each agent on each host loads before its first prompt, as in `fleet context --all`: one stacked bar per host and agent (instructions, skills, MCP servers), all on one scale, so the heaviest host and agent are obvious. Under the bars are the selected host's parts and its largest items. `↑` and `↓` choose the host. An item fleet did not put there is marked `not from config`. A server nobody measured is shown as `unknown`, never as zero, and the agent's total ends in `+` because it is a lower bound; `d` measures the servers. Without colour the parts use `█`, `▓` and `░`.

Each home card has one line, `context ~18.6k`: the largest agent's total, with a `+` when a server is not measured. A host whose fleet is too old to have `fleet context` shows nothing there.

Press `u` on this tab to switch on usage: how often each MCP server and skill was used. It replaces the largest items under the bars with the selected host's servers and skills, each with its size, its calls and the share of sessions it was called in, then a line for each one that was never called and costs real tokens. Every host is asked again to count its own history, which takes longer than reading config, so it is asked only while usage is on (a refresh with `r` counts again); `u` again goes back. What a host counts is described in [usage](#usage) below. The bridge keeps usage in memory only and never writes it to its memory file.

The bridge asks each host for it by itself, together with the status: when it opens and on `r`, and again when a doctor run finishes, since the sizes just changed. For another host that is one more ssh call, `fleet context --json`. It reads files and starts no server, so it needs no confirmation, and doctor still runs only on `d`. What an earlier run saw is shown at once, marked "seen 2h ago, not live", until the host answers.

## Usage

`fleet context` says what each MCP server and skill costs before the first prompt. `fleet context --usage` adds whether anyone uses them: for each server and skill, its calls and the share of sessions it was called in, in the last 30 days, next to its size.

```
Claude Code: 41 sessions
  tracker  mcp    ~14.2k   0 calls  in 0% of sessions
  review   skill   ~410   26 calls  in 29% of sessions
```

Plain `fleet context` stays instant, because it reads no history. `--usage` reads each agent's own history on the host, which can take a second or two. Claude Code's transcripts and opencode's database are read; Antigravity CLI keeps its conversations in a format that is not documented, so it says "no readable history". An agent whose history cannot be read, such as an opencode database fleet does not recognise or a Node without `node:sqlite`, says `usage unavailable for opencode: <reason>` and the others are still shown. That is never an error.

The window is the last 30 days, or less where an agent keeps less. The output says how much history each agent had (`Claude Code: 30 days, opencode: 9 days`), and "never called" is said only where there are at least 30 days of it, since with less a server may just not have been needed yet. For each server or skill that was never called and costs real tokens, one line says so: `never called in 30 days, 3.5k tokens per session: consider exclude`. Fleet only reports; it changes nothing.

Both a skill the agent ran and a `/name` you typed count. For a typed command only the command name is read, never the text after it, and only names that match a skill fleet knows (a built-in such as `/compact` does not count). A session is a top-level session: a subagent's calls count toward the session that started it. With `--all` each host counts its own history and sends back only names and numbers, and the local side adds them up per name.

**Privacy.** Transcripts hold your prompts, your files and tool output, and fleet does not keep any of it. It reads only tool names, skill names, session ids and times from each history, drops every other line as it goes, and neither stores nor sends the rest. What is printed, returned by `--json` or sent over ssh is names and counts, and the output ends with `read locally, names and counts only`. The bridge's `u` key shows the same counts, and its memory file never holds them. `--json` adds `usage`: for each agent its `status` (`ok`, `none` or `unavailable`), `days` of history, `sessions`, and the `calls` and `sessions` of each server and skill; with `--all` also `usageAll`, the hosts added up.

## Pushing from the bridge

A file that looks like a plaintext secret (`.env`, `*.pem`, `*.key`, names with `secret` or `token`) blocks a push from the bridge until you remove it or add it to `.gitignore`. `fleet push` itself does not check.

## The push screen

While a push runs the pipeline row ends with the total time, and each lane ends with its own, running until its host is done. A host that is connecting over ssh says so from the start, with its time counting, instead of showing nothing. Below the lanes, the activity feed lists every event as it arrives, with its time and host. Beside it, the host pane shows the selected host: what it has written so far and how many writes remain, and after the push what it got, from the receipts in the push's end document (`created`, `updated` and `removed`, one line each; never a value). The pane follows the host being applied until you pick one with `↑` and `↓`.

The layout follows the width. From 100 columns everything shows. From 80 to 99 the host pane goes, and below 80 the feed goes too, leaving the lanes and the clock. The bridge itself needs at least 30 x 8.

When the push is over, `r` on the selected lane runs `fleet push --host <name>`: it publishes as usual, then applies only on that host. A host without an ssh destination is refused with the reason. `f` on a lane with a conflict opens the Conflicts screen with that host first; it only shows the conflict and its fix.

## The push journal

Every `fleet push` writes what it did to a file in `~/.local/state/fleet/pushes/` on the host that ran it, whether it was started from a terminal, from the bridge or with `--host`, and keeps the last 20 (older files are deleted when a new one is written). The file is named by its UTC start time and pid, such as `20261113T094103.123Z-4242.jsonl`, and is private to you (mode 0600, in a 0700 directory). The first line is a header: the time, the commit pushed (the config repo's HEAD after publish, `null` when the push never got that far), which host `--host` named (or all), the hosts visited, how long it took, and how it ended. The other lines are the push's events as they arrived, each with `t`, the milliseconds since the push began. A push that is refused before it starts (locked, an unknown `--host`, an invalid config) writes nothing. A push that is cut short with ctrl-c keeps what it has and is marked interrupted. A journal that cannot be written is a message on stderr and never fails the push.

The journal is never shared: each host has only its own, and `fleet agent` does not read it. There is no command for it. In the bridge, `h` on the push screen lists the recorded pushes, newest first, with time, scope (all hosts or the one host), result, duration and host count. `enter` replays the selected one at its real speed through the same screen a live push uses, so the clock, lanes, feed and host pane replay too; `↑` and `↓` pick a host as they do live, and `esc` goes back. `u` on the selected entry asks once, then runs `fleet undo` with `--yes` so it does not prompt again. When a push that ended ok is over, the bridge says how much faster or slower it was than the last earlier push of the same scope that also ended ok (`1.4s faster than the last push`), and leaves the line out when there is none.

## Conflicts

The conflicts screen lists every host's conflicts, read with `fleet status --conflicts` (read-only, no clone or fetch). A host on an older pin shows "detail needs a newer pin".

## Look

The look is dark first. `FLEET_THEME=light` selects a best-effort palette for light terminals; it is less polished, and `NO_COLOR` and `FLEET_NO_MOTION` are honoured.

## Trying it on made-up hosts

```sh
fleet demo
```

This builds a throwaway fleet in a temporary directory: three made-up hosts, a config repo, and local folders standing in for GitHub. On a terminal it opens the bridge on them, marked DEMO, with a conflict already waiting on `server`; press `P` to watch a push, or `8` to see the made-up startup context (`devbox` has a server nobody measured and a skill nobody configured). It needs only git and Node, touches nothing outside that directory, and deletes it when you quit.

Without a terminal, or with `--json`, it runs a scripted walk-through itself and exits. `fleet demo --shell` gives a shell in the made-up fleet instead, with a printed list of commands to try.
