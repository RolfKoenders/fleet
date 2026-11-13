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
- `d` runs `fleet doctor --json` (`--all` across hosts) after you confirm. It starts real MCP servers with real credentials, so opening the bridge never does it. The result fills a health mark beside each server in the matrix; a server that only needs a login is shown as neutral, and any result the bridge does not know is shown as unknown.

## Startup context

Tab `8` shows how much each agent on each host loads before its first prompt, as in `fleet context --all`: one stacked bar per host and agent (instructions, skills, MCP servers), all on one scale, so the heaviest host and agent are obvious. Under the bars are the selected host's parts and its largest items. `↑` and `↓` choose the host. An item fleet did not put there is marked `not from config`. A server nobody measured is shown as `unknown`, never as zero, and the agent's total ends in `+` because it is a lower bound; `d` measures the servers. Without colour the parts use `█`, `▓` and `░`.

Each home card has one line, `context ~18.6k`: the largest agent's total, with a `+` when a server is not measured. A host whose fleet is too old to have `fleet context` shows nothing there.

The bridge asks each host for it by itself, together with the status: when it opens and on `r`, and again when a doctor run finishes, since the sizes just changed. For another host that is one more ssh call, `fleet context --json`. It reads files and starts no server, so it needs no confirmation, and doctor still runs only on `d`. What an earlier run saw is shown at once, marked "seen 2h ago, not live", until the host answers.

## Pushing from the bridge

A file that looks like a plaintext secret (`.env`, `*.pem`, `*.key`, names with `secret` or `token`) blocks a push from the bridge until you remove it or add it to `.gitignore`. `fleet push` itself does not check.

## The push screen

While a push runs the pipeline row ends with the total time, and each lane ends with its own, running until its host is done. A host that is connecting over ssh says so from the start, with its time counting, instead of showing nothing. Below the lanes, the activity feed lists every event as it arrives, with its time and host. Beside it, the host pane shows the selected host: what it has written so far and how many writes remain, and after the push what it got, from the receipts in the push's end document (`created`, `updated` and `removed`, one line each; never a value). The pane follows the host being applied until you pick one with `↑` and `↓`.

The layout follows the width. From 100 columns everything shows. From 80 to 99 the host pane goes, and below 80 the feed goes too, leaving the lanes and the clock. The bridge itself needs at least 30 x 8.

When the push is over, `r` on the selected lane runs `fleet push --host <name>`: it publishes as usual, then applies only on that host. A host without an ssh destination is refused with the reason. `f` on a lane with a conflict opens the Conflicts screen with that host first; it only shows the conflict and its fix.

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
