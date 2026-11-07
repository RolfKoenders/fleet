# The bridge

`fleet bridge` opens a full-screen view of every host: a card each, the matrix of what each host gets, conflicts, the config's git history, secret names, and the catalog. It needs a terminal.

It reads, and the cards fill at once from what the last run saw, labelled "seen 2h ago, not live" until the host answers. That memory is `~/.local/state/fleet/bridge-hosts.json`, which only the bridge reads and which holds no secrets.

## Opening on a screen or a host

```sh
fleet bridge --view matrix --host server
```

`--view` opens on a screen: `home` (the default), `matrix`, `conflicts`, `timeline`, `secrets`, `catalog` or `push`. These are the tabs, so a screen that gets a tab later gets a view. `--host` selects a host on that screen: its card on Home, its column in the Matrix, and its conflicts first on Conflicts. `--host` alone opens Home on that host's card. Both work in `fleet demo`'s bridge.

A name that is not one is refused with exit 2 before the screen is taken over, and the valid names are listed. `--view push` opens the push screen the way the `7` key does: nothing is reviewed or started until you press `P`.

## Keys

- `?` lists the keys, `ctrl-k` opens a palette, and `r` asks the hosts again.
- `P` reviews a push. Nothing runs until you type `push` and press enter. `tab` moves to an optional commit message (the same as `fleet push -m`); a message never starts a push. A push goes on by itself if you quit or the terminal closes, and the bridge waits for it when it can.
- `d` runs `fleet doctor --json` (`--all` across hosts) after you confirm. It starts real MCP servers with real credentials, so opening the bridge never does it. The result fills a health mark beside each server in the matrix; a server that only needs a login is shown as neutral, and any result the bridge does not know is shown as unknown.

## Pushing from the bridge

A file that looks like a plaintext secret (`.env`, `*.pem`, `*.key`, names with `secret` or `token`) blocks a push from the bridge until you remove it or add it to `.gitignore`. `fleet push` itself does not check.

## Conflicts

The conflicts screen lists every host's conflicts, read with `fleet status --conflicts` (read-only, no clone or fetch). A host on an older pin shows "detail needs a newer pin".

## Look

The look is dark first. `FLEET_THEME=light` selects a best-effort palette for light terminals; it is less polished, and `NO_COLOR` and `FLEET_NO_MOTION` are honoured.

## Trying it on made-up hosts

```sh
fleet demo
```

This builds a throwaway fleet in a temporary directory: three made-up hosts, a config repo, and local folders standing in for GitHub. On a terminal it opens the bridge on them, marked DEMO, with a conflict already waiting on `server`; press `P` to watch a push. It needs only git and Node, touches nothing outside that directory, and deletes it when you quit.

Without a terminal, or with `--json`, it runs a scripted walk-through itself and exits. `fleet demo --shell` gives a shell in the made-up fleet instead, with a printed list of commands to try.
