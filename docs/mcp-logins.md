# Logging in to MCP servers

Fleet writes each server's entry, not your login. A server that uses OAuth needs one login per machine and per tool.

| Tool | How to log in |
|---|---|
| Claude Code | `/mcp` in a session |
| opencode | `opencode mcp auth <name>` |
| Antigravity CLI | Not from the CLI. See [Antigravity CLI](#antigravity-cli) |

## Logging in on a machine you reach over SSH

After you log in, the browser redirects to a localhost port. That port has to reach the machine running the login, so connect with a tunnel and start the login from that session. Port 19876 is the one opencode uses:

```sh
ssh -L 19876:127.0.0.1:19876 server
opencode mcp auth <name>
```

Open the printed link in the browser on your own machine.

## Servers on plain HTTP

Claude Code refuses to send OAuth credentials to a plain HTTP address unless it is on localhost. A server on your local network needs an HTTPS address before you can log in to it.

## Antigravity CLI

Antigravity's documentation describes the login for an OAuth server in the Antigravity app only (Customizations, Installed, MCP Servers, Authenticate), not in the CLI. The CLI's `/mcp` panel shows each server's status, reloads the config and shows the connection log, so use it to see whether a server connected. The app keeps the tokens in `~/.gemini/antigravity/mcp_oauth_tokens.json`, and the documentation does not say whether the CLI reads that file. Check it for your server before you rely on it.

A server that takes a static header needs no login: put the header in the catalog entry (`headers`, with `secret:NAME` for the value). Antigravity passes `$VAR` and `${VAR}` in `env` and `headers` on as written, so put the value itself in the secret.

If `fleet doctor` reports `bad-auth` for such a server, the server answered HTTP 401 or 403 with that secret. The doctor output names the secret, which secrets file holds it, and when that file's git history last changed the secret's ciphertext. Replace the value with `fleet secrets rotate` or in the Secrets screen of `fleet ui`.

Fleet does not write `oauth` or `authProviderType` into the entry. Antigravity does not support SSE servers, so an `sse` server is left out of its file (see [Setting up machines](setting-up-machines.md#which-agents-a-machine-gets)).
