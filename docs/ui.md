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

Clicking a cell holds the smallest edit to that host's file: an item the defaults give is taken away with `exclude` in the host's file (the defaults are not edited), an item the host added is taken out of its list, an exclude is taken back. Clicking the same cell again takes the held edit back. A pane beside the table shows the host's file as it will be written, with comments, blank lines and list style kept; nothing is on disk yet. Hosts and Secrets list what the config has, read-only for now. A server, skill source or bundle you add in the Catalog is a row of the Matrix at once, off for every host, held like any edit.

### Catalog

The MCP servers, skill sources and skill bundles your hosts can pick from, each with an add card. Adding one gives it to no host: pick it in the Matrix. An addition is a held edit, so it shows in Review & push like a pick does, and a held one has a Take back button (which takes back the picks of it too).

- **An MCP server.** A name, whether it runs on the machine (a command) or at a URL (http or sse), the environment (or, for a URL, headers) as a plain value or `secret:NAME`, and which agents get it. The YAML it will add shows beside the form, as the server splices it into `catalog/mcp.yaml`. A secret can never be in the command (the loader's rule, with its message), and a command such as `npx pkg` or `uvx pkg` with no version gets a warning and can still be held.
- **Check it starts.** Runs doctor's probe on the one server you are adding, on this machine, and shows its tools and their size in tokens. It asks first, naming the command: it runs with the real credentials fleet can read for this host and may download packages. A secret that has no value on this host is left out and named, so the server starts without it. Nothing is written.
- **A skill source.** A name, a repo (a URL, an scp-style address or a path on this machine), a path and an optional branch. Look at the repo clones it shallowly into a temp directory, lists its skills and reads its head commit. A pinned source (the default) is written with that commit, `track` for the branch and `review: true`; a followed one with its `branch`. The temp clone is deleted when you close the form, when a newer one replaces it and when the server stops.
- **A bundle.** A name and its skills, picked from the sources fleet has cloned and from a source you hold, or typed in.

### Review & push

- The real diff of every file the held edits change.
- A check per host: whether its config loads with the edits (the same load `fleet push` starts with, and a host that would fail shows its problems), and its pick changes worked out from the config, such as `+ skills notes, deploy; − server docs`.
- This host only: the full plan, from `fleet diff` run on the edited config. It is worked out in memory and writes nothing. Other hosts are not planned, because that needs ssh; they get the pick summary instead.
- A commit message, suggested from the edits and yours to change.

Write and push writes the files, commits them with the message, runs the real `fleet push` and shows each host's lane as it goes. Discard all drops the held edits; until you push, nothing has touched the disk.

The page holds the edits as operations (`add` or `remove` of a bundle or server for a host, and `addServer`, `addSource` and `addBundle` for the catalog). The server rebuilds each from the fields it may have and checks an entry with the loader's own code, so the page can add nothing the loader would refuse. Every preview replays them, through the edit engine in `src/edit/`, on the files as they are on disk at that moment. An edit that no longer applies (the file changed under it) is listed as dropped with its reason, and nothing is written while any is.

**Changes the page did not make.** When the config repo has uncommitted changes of its own (`git status --porcelain`), the page lists them and refuses to write or push until you commit or discard them outside the page. The server checks again right before writing, so a change made after the page last looked is still caught. The server also refuses, before writing anything, while a push is running (`a push is already running (pid N)`), when an edit is stale, and when the edited config would not load for a host.

## API

Every route is JSON under `/api/` and sits behind the checks below. Request bodies are used, never logged.

| Route | Does |
| --- | --- |
| `GET /api/status` | what `fleet status --json` knows about this host |
| `GET /api/matrix` | hosts, bundles with their skills, servers, and each host's cell; plus `outside`, the uncommitted changes in the config repo |
| `GET /api/secrets` | secret names and who can read them, never a value |
| `GET /api/skills` | the skills in the source clones fleet already has, and the bundle that holds each; nothing is cloned or fetched |
| `POST /api/catalog/clone` | `{repo, path?, branch?}`: a shallow clone in a temp directory; answers its `id`, head `commit`, `branch` and `skills`. The repo must be a URL, an scp-style address or an absolute path, never something git reads as an option, and goes after `--` |
| `POST /api/catalog/discard` | `{id}`: deletes that temp clone |
| `POST /api/catalog/probe` | `{name, entry, confirm: true}`: doctor's probe on one entry that is not on disk, on this machine; refused unless `confirm` is true. Answers `result`, `tools`, `tokens` and `unset` (secret names with no value here), never a value |
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
