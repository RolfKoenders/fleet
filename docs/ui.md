# The page

`fleet ui` starts a small web server inside the fleet process, prints its URL and opens your browser on it. The page shows this host, and pushes with live progress. It is a way to do from a browser what the bridge does in a terminal. Like the bridge, it is for you, not for an agent: `fleet agent` does not list it, and it has no `--json` form.

```sh
fleet ui                  # a free port, opens the browser
fleet ui --port 8765      # a fixed port
fleet ui --no-open        # print the URL and do not open a browser
```

It stops on ctrl-c, or by itself after 10 minutes with no page open.

## Who can reach it

The page can change your config and push, so nothing but you may reach it.

- It listens on `127.0.0.1` only. There is no option to listen elsewhere.
- The URL is `http://127.0.0.1:<port>/#t=<token>`: a random port and a random token. The page reads the token from the part after `#` (which a browser never sends to the server), keeps it in memory and sends it as a header on every call. There is no cookie. Opening the URL without the token shows a page that cannot do anything.
- A request whose `Host` is not `127.0.0.1:<port>` is refused, so a web page on another site cannot reach the server by pointing its own name at your machine (DNS rebinding). A write whose `Origin` is not the page itself is refused too.
- The server sends no CORS header, so no other page can read an answer.
- The one call that cannot carry a header is the stream of live updates (a browser's `EventSource` cannot), so that call takes the token in its query instead. Nothing logs a URL.
- A secret's value is never sent to the browser. Nothing the page sends is logged.

## Pushing

A push from the page runs the real `fleet push`, so it takes the same push lock as a push from a terminal or the bridge. While another push is running, the page shows `a push is already running (pid N)` and starts nothing.

## On a server

With `SSH_CONNECTION` set, fleet does not try to open a browser. The URL is printed, and you reach it from your own machine through a tunnel:

```sh
ssh -L 8765:127.0.0.1:8765 <the host>     # on your machine
fleet ui --port 8765 --no-open            # on the host
```

Then open the printed URL (with the same port) on your machine.
