# The page

`fleet ui` starts a small web server inside the fleet process, prints its URL and opens your browser on it. The page shows this host, and pushes with live progress. It is a way to do from a browser what the bridge does in a terminal. Like the bridge, it is for you, not for an agent: `fleet agent` does not list it, and it has no `--json` form.

```sh
fleet ui                  # a free port, opens the browser
fleet ui --port 8765      # a fixed port
fleet ui --no-open        # print the URL and do not open a browser
```

It stops on ctrl-c, or by itself after 10 minutes with no page open.

## What is on the page

A header with this host, its checkout and whether the live connection is up (it reconnects by itself if the server drops it), and a menu: Matrix, Catalog, Hosts, Secrets, Review & push and Status. The page is plain files under `src/ui/static/` that fleet serves as they are: no build step, no framework and no dependency, and nothing is loaded from another origin, including its font (JetBrains Mono, bundled in `src/ui/static/fonts/` with its licence, a copy of the landing page's).

### Matrix

The first screen, named like the bridge's Matrix screen and read the same way. One row per skill bundle and per MCP server, one column per host. A bundle row opens to show its skills, which are read-only. A cell says where the item comes from for that host:

| Cell | Meaning |
| --- | --- |
| `✓ default` | the defaults give it |
| `+ added` | the host's own file adds it |
| `✕ excluded` | the host (or the defaults) excludes it |
| `· off` | nothing picks it |

Clicking a cell makes the smallest edit to that host's file, as a change to push: an item the defaults give is taken away with `exclude` in the host's file (the defaults are not edited), an item the host added is taken out of its list, an exclude is taken back. Clicking the same cell again takes that edit back. A pane beside the table shows the host's file as it will be written, with comments, blank lines and list style kept; nothing is on disk yet. A server, skill source or bundle you add in the Catalog is a row of the Matrix at once, off for every host, held like any edit.

### Catalog

The MCP servers, skill sources and skill bundles your hosts can pick from. The **+ Add** button in the header offers an MCP server, a skill source or a skill bundle, and so does the dashed tile at the end of each section. Adding one gives it to no host: pick it in the Matrix. An addition is a change to push, so it shows in Review & push like a pick does, and one that is on To push has a Remove from push button (which takes back the picks of it too).

Each choice opens a dialog (a native modal `<dialog>`): focus goes to its first field and stays inside (Tab wraps), the page behind does not scroll, and Esc or Cancel closes it and leaves nothing behind, no edit to push and no form state, so it opens blank next time. Enter in a field does what the main button does. Beside the form the dialog shows the YAML that will be written as a diff against the file (`catalog/mcp.yaml` or `catalog/skills.yaml`), asked from the server as you type, so it is the server's own splice and not a copy of its rules. While the input is not valid yet, the pane lists what is still missing instead. **Add to push** puts the edit on To push and closes the dialog. On a phone the dialog fills the screen and the diff stacks under the form.

- **An MCP server.** A name, whether it runs on the machine (a command) or at a URL (http or sse), the environment (or, for a URL, headers) as a plain value or `secret:NAME`, and which agents get it. A secret can never be in the command (the loader's rule, with its message), and a command such as `npx pkg` or `uvx pkg` with no version gets a warning and can still be held.
- **Check it starts.** Runs doctor's probe on the one server you are adding, on this machine, and shows its tools and their size in tokens. It asks first, naming the command: it runs with the real credentials fleet can read for this host and may download packages. A secret that has no value on this host is left out and named, so the server starts without it. Nothing is written.
- **A skill source.** A name, a repo (a URL, an scp-style address or a path on this machine), a path and an optional branch. Look at the repo clones it shallowly into a temp directory, lists its skills and reads its head commit. A pinned source (the default) is written with that commit, `track` for the branch and `review: true`; a followed one with its `branch`. The temp clone is deleted when you close the dialog, when a newer one replaces it and when the server stops.
- **A bundle.** A name and its skills, picked from the sources fleet has cloned and from a source you hold, or typed in.

### Hosts

One card per host: how it is reached, and what it gets. **+ Add host**, in the header and as the tile after the cards, opens a dialog that sets up a new machine from the page. Like the Catalog's, it is modal, takes focus, closes on Esc or Cancel with nothing written, and shows the host file that will be written (`hosts/<name>.yaml`, a new file) as a diff while you type, or what is still missing. Esc and Cancel are off while `fleet init` runs, because the run goes on without the page; after it ends, a failure keeps the form to try again and a success is closed with Done.

- A name (the loader's rule for a host name), an ssh destination and where it starts from: the defaults only, or a copy of another host. ssh is required, because `fleet init` refuses a host without it; for a machine fleet cannot reach over ssh the form links [setting up machines](setting-up-machines.md). A destination that starts with `-`, or has a space or another symbol, is refused.
- A copy takes `bundles`, `exclude`, `mcp`, `settings` and `vars` of the other host, with the comments inside them, and not its `ssh`, `age` or `files`.
- This is not a change to push. After you confirm (the page names the machine and what will run there), the server takes the push lock, writes `hosts/<name>.yaml` with the edit engine and runs the real `fleet init <name>` as a child process, so it commits and pushes itself (the host file, `.sops.yaml` and the re-encrypted secrets), exactly as from the CLI. Its output is streamed into the page as it comes.
- It refuses while there are changes to push (the page asks you to push or discard them first, so init's commit does not sweep them in), while a push runs, while the config repo has changes the page did not make, and for a host that already exists.
- When init fails before it committed anything, the host file is deleted and the files init rewrote are restored, so the repo is as it was. When init had already committed and pushed (for example the timer step failed on the host), the host file stays, because that commit is published; the page says so, and `fleet init <name>` finishes the rest when run again.
- Retiring a host is not here.

### Secrets

A table of every secret name against every host, by name only. A cell is **set** (the host's own secrets file has the name, or `shared` has it and the host can read `shared`), **missing** (a server the host picks, or its settings, use the name and neither file has it) or **not used**. A value to push shows as `set` with `to push`, and the tab counts the missing cells. Set value (Replace value when it is set everywhere it is needed) opens a password field:

- Typing a value here is allowed. It is sent to the server once, over the page's own connection, and is never logged, echoed, kept or sent back. The field is not named (a password manager does not offer to save it), asks for no autofill, and is emptied before the request goes; the page holds no copy of it in its state, storage or address.
- The value is encrypted at once: the server copies the host's secrets file into a private temp directory (mode 0700), runs `sops set --value-stdin` there (the value goes on sops' stdin, never in argv or the environment) and reads the new file back. The directory is removed whatever happens, and the repo is not touched.
- The result is a change to push that carries the encrypted file, shown in Review & push by its names with a short mark of each ciphertext. It is checked as strictly as a pick: the path must be a secrets file of `shared` or of a host with an age recipient, the text must hold nothing but ciphertext, it must be encrypted for exactly the recipients `.sops.yaml` names for that file, and it may add or replace only the names it says (no delete, no rename). It is written over the file it was made from only: when that file changed on disk since, the edit is dropped as `stale` and nothing is overwritten, and you set the value again.
- It goes to the hosts that pick a server using the secret and do not have it yet, unticked others can be added, and `shared` is a choice of its own. A host with no age key cannot be chosen.
- A failure is one of a few fixed sentences. What sops said is never passed on, because it can quote what it was given.
- This sets and replaces. It does not delete or rename a secret: use `fleet secrets` for that.

### Review & push

- The real diff of every file the changes to push change.
- A check per host: whether its config loads with the edits (the same load `fleet push` starts with, and a host that would fail shows its problems), and its pick changes worked out from the config, such as `+ skills notes, deploy; − server docs`.
- This host only: the full plan, from `fleet diff` run on the edited config. It is worked out in memory and writes nothing. Other hosts are not planned, because that needs ssh; they get the pick summary instead.
- A commit message, suggested from the edits and yours to change.

Write and push writes the files, commits them with the message, runs the real `fleet push` and shows each host's lane as it goes. Discard all drops the changes to push; until you push, nothing has touched the disk.

The page holds the edits as operations (`add` or `remove` of a bundle or server for a host, and `addServer`, `addSource` and `addBundle` for the catalog). The server rebuilds each from the fields it may have and checks an entry with the loader's own code, so the page can add nothing the loader would refuse. Every preview replays them, through the edit engine in `src/edit/`, on the files as they are on disk at that moment. An edit that no longer applies (the file changed under it) is listed as dropped with its reason, and nothing is written while any is.

**Changes the page did not make.** When the config repo has uncommitted changes of its own (`git status --porcelain`), the page lists them and refuses to write or push until you commit or discard them outside the page. The server checks again right before writing, so a change made after the page last looked is still caught. The server also refuses, before writing anything, while a push is running (`a push is already running (pid N)`), when an edit is stale, and when the edited config would not load for a host.

## API

Every route is JSON under `/api/` and sits behind the checks below. Request bodies are used, never logged.

| Route | Does |
| --- | --- |
| `GET /api/status` | what `fleet status --json` knows about this host |
| `GET /api/matrix` | hosts, bundles with their skills, servers, and each host's cell; plus `outside`, the uncommitted changes in the config repo |
| `GET /api/secrets` | secret names and who can read them, and `table`: each name against each host as set, missing or unused, never a value |
| `POST /api/secrets/set` | `{name, value, files, ops}`: encrypts one value into the secrets file of each of `files` (`shared` or a host) with sops in a private temp dir, and answers the `setSecret` edits to push that carry those files. Nothing is written to the repo, and the value is in no answer, error, log or event; 400 `invalid`, 409 `stale`, 422 `no-recipient`, `needs-secret`, `sops-failed`, `recipients` or `invalid` |
| `GET /api/skills` | the skills in the source clones fleet already has, and the bundle that holds each; nothing is cloned or fetched |
| `POST /api/catalog/clone` | `{repo, path?, branch?}`: a shallow clone in a temp directory; answers its `id`, head `commit`, `branch` and `skills`. The repo must be a URL, an scp-style address or an absolute path, never something git reads as an option, and goes after `--` |
| `POST /api/catalog/discard` | `{id}`: deletes that temp clone |
| `POST /api/catalog/probe` | `{name, entry, confirm: true}`: doctor's probe on one entry that is not on disk, on this machine; refused unless `confirm` is true. Answers `result`, `tools`, `tokens` and `unset` (secret names with no value here), never a value |
| `POST /api/preview` | `{ops, show?}`: the files the edits change (before and after), dropped edits, the matrix after, a check per host |
| `POST /api/plan` | `{ops}`: this host's plan from `fleet diff` on the edited config |
| `POST /api/hosts/preview` | `{name, ssh, from?}`: the host file `/api/hosts/init` would write, as `{path, before, after}`; needs no confirmation, writes and runs nothing; 400 `invalid`, 409 `stale` for a host that exists |
| `POST /api/hosts/init` | `{name, ssh, from?, confirm: true}`: writes `hosts/<name>.yaml` and runs the real `fleet init`, streaming its output as `init` events and answering when it ends; 409 `locked`, `outside-changes` or `exists`, 422 `invalid` |
| `POST /api/write` | `{ops, message}`: writes, commits, then pushes; 409 `locked`, `outside-changes` or `stale`, 422 `invalid` |
| `POST /api/push` | runs `fleet push` with what is already committed |
| `GET /api/events` | the stream of live push events, and of `init` output |

## Who can reach it

The page can change your config and push, so nothing but you may reach it.

- It listens on `127.0.0.1` only. There is no option to listen elsewhere.
- The URL is `http://127.0.0.1:<port>/#t=<token>`: a random port and a random token. The page reads the token from the part after `#` (which a browser never sends to the server), keeps it in memory and sends it as a header on every call. There is no cookie. Opening the URL without the token shows a page that cannot do anything.
- A request whose `Host` is not `127.0.0.1:<port>` is refused, so a web page on another site cannot reach the server by pointing its own name at your machine (DNS rebinding). A write whose `Origin` is not the page itself is refused too.
- The server sends no CORS header, so no other page can read an answer.
- The one call that cannot carry a header is the stream of live updates (a browser's `EventSource` cannot), so that call takes the token in its query instead. Nothing logs a URL.
- A secret's value is never sent to the browser. Nothing the page sends is logged, and the one route that takes a value (`/api/secrets/set`) answers with the encrypted file and fixed messages only.

## Pushing

A push from the page (and the one after Write and push) runs the real `fleet push`, so it takes the same push lock as a push from a terminal or the bridge. While another push is running, the page shows `a push is already running (pid N)` and starts nothing.

## On a server

With `SSH_CONNECTION` set, fleet does not try to open a browser. The URL is printed, and you reach it from your own machine through a tunnel:

```sh
ssh -L 8765:127.0.0.1:8765 <the host>     # on your machine
fleet ui --port 8765 --no-open            # on the host
```

Then open the printed URL (with the same port) on your machine.
