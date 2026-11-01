# Logging in to MCP servers

Fleet writes each server's entry, not your login. A server that uses OAuth needs one login per machine and per tool.

| Tool | How to log in |
|---|---|
| Claude Code | `/mcp` in a session |
| opencode | `opencode mcp auth <name>` |

## Logging in on a machine you reach over SSH

After you log in, the browser redirects to a localhost port. That port has to reach the machine running the login, so connect with a tunnel and start the login from that session. Port 19876 is the one opencode uses:

```sh
ssh -L 19876:127.0.0.1:19876 server
opencode mcp auth <name>
```

Open the printed link in the browser on your own machine.

## Servers on plain HTTP

Claude Code refuses to send OAuth credentials to a plain HTTP address unless it is on localhost. A server on your local network needs an HTTPS address before you can log in to it.
