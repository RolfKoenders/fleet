# The page

`fleet ui` starts a small web server inside the fleet process, prints its URL and opens your browser on it. The page shows this host, and pushes with live progress. It is a way to do from a browser what the bridge does in a terminal. Like the bridge, it is for you, not for an agent: `fleet agent` does not list it, and it has no `--json` form.

```sh
fleet ui                  # a free port, opens the browser
fleet ui --port 8765      # a fixed port
fleet ui --no-open        # print the URL and do not open a browser
```

It stops on ctrl-c, or by itself after 10 minutes with no page open.

## What is on the page

A header with this host, its checkout and whether the live connection is up (it reconnects by itself if the server drops it), and a menu: Matrix, Catalog, Hosts, Secrets, Status, and Review & push. The page is plain files under `src/ui/static/` that fleet serves as they are: no build step, no framework and no dependency, and nothing is loaded from another origin, including its font (JetBrains Mono, bundled in `src/ui/static/fonts/` with its licence, a copy of the landing page's).

### Matrix

The first screen, named like the bridge's Matrix screen and read the same way. One row per skill bundle and per MCP server, one column per host. A bundle row opens to show its skills, which are read-only. A cell says where the item comes from for that host:

| Cell | Meaning |
| --- | --- |
| `✓ default` | the defaults give it |
| `+ added` | the host's own file adds it |
| `✕ excluded` | the host (or the defaults) excludes it |
| `· off` | nothing picks it |

Clicking a cell holds the smallest edit to that host's file: an item the defaults give is taken away with `exclude` in the host's file (the defaults are not edited), an item the host added is taken out of its list, an exclude is taken back. Clicking the same cell again takes the held edit back. A pane beside the table shows the host's file as it will be written, with comments, blank lines and list style kept; nothing is on disk yet. Version 1 edits host picks only: Catalog, Hosts and Secrets list what the config has, read-only (adding to them comes later).

### Review & push

- The real diff of every file the held edits change.
- A check per host: whether its config loads with the edits (the same load `fleet push` starts with, and a host that would fail shows its problems), and its pick changes worked out from the config, such as `+ skills notes, deploy; − server docs`.
- This host only: the full plan, from `fleet diff` run on the edited config. It is worked out in memory and writes nothing. Other hosts are not planned, because that needs ssh; they get the pick summary instead.
- A commit message, suggested from the edits and yours to change.

Write and push writes the files, commits them with the message, runs the real `fleet push` and shows each host's lane as it goes. Discard all drops the held edits; until you push, nothing has touched the disk.

The page holds the edits as operations (`add` or `remove` of a bundle or server for a host). Every preview replays them, through the edit engine in `src/edit/`, on the files as they are on disk at that moment. An edit that no longer applies (the file changed under it) is listed as dropped with its reason, and nothing is written while any is.

**Changes the page did not make.** When the config repo has uncommitted changes of its own (`git status --porcelain`), the page lists them and refuses to write or push until you commit or discard them outside the page. The server checks again right before writing, so a change made after the page last looked is still caught. The server also refuses, before writing anything, while a push is running (`a push is already running (pid N)`), when an edit is stale, and when the edited config would not load for a host.

## API

Every route is JSON under `/api/` and sits behind the checks below. Request bodies are used, never logged.

| Route | Does |
| --- | --- |
| `GET /api/status` | what `fleet status --json` knows about this host |
| `GET /api/matrix` | hosts, bundles with their skills, servers, and each host's cell; plus `outside`, the uncommitted changes in the config repo |
| `GET /api/secrets` | secret names and who can read them, never a value |
| `POST /api/preview` | `{ops, show?}`: the files the edits change (before and after), dropped edits, the matrix after, a check per host |
| `POST /api/plan` | `{ops}`: this host's plan from `fleet diff` on the edited config |
| `POST /api/write` | `{ops, message}`: writes, commits, then pushes; 409 `locked`, `outside-changes` or `stale`, 422 `invalid` |
| `POST /api/push` | runs `fleet push` with what is already committed |
| `GET /api/events` | the stream of live push events |

## Who can reach it

The page can change your config and push, so nothing but you may reach it.

- It listens on `127.0.0.1` only. There is no option to listen elsewhere.
- The URL is `http://127.0.0.1:<port>/#t=<token>`: a random port and a random token. The page reads the token from the part after `#` (which a browser never sends to the server), keeps it in memory and sends it as a header on every call. There is no cookie. Opening the URL without the token shows a page that cannot do anything.
- A request whose `Host` is not `127.0.0.1:<port>` is refused, so a web page on another site cannot reach the server by pointing its own name at your machine (DNS rebinding). A write whose `Origin` is not the page itself is refused too.
- The server sends no CORS header, so no other page can read an answer.
- The one call that cannot carry a header is the stream of live updates (a browser's `EventSource` cannot), so that call takes the token in its query instead. Nothing logs a URL.
- A secret's value is never sent to the browser. Nothing the page sends is logged.

## Pushing

A push from the page (and the one after Write and push) runs the real `fleet push`, so it takes the same push lock as a push from a terminal or the bridge. While another push is running, the page shows `a push is already running (pid N)` and starts nothing.

## On a server

With `SSH_CONNECTION` set, fleet does not try to open a browser. The URL is printed, and you reach it from your own machine through a tunnel:

```sh
ssh -L 8765:127.0.0.1:8765 <the host>     # on your machine
fleet ui --port 8765 --no-open            # on the host
```

Then open the printed URL (with the same port) on your machine.
