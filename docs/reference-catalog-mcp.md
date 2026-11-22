# catalog/mcp.yaml

`catalog/mcp.yaml` defines your MCP servers once. A host file picks servers by name with `mcp.include`, and fleet writes each picked server into the file of every agent the host gets, in that agent's own shape. The file is optional. It has one key, `servers`, a map from a server name to its definition.

A server name is letters, digits, `_` and `-`, and starts with a letter or digit.

## Placeholders

Values may hold two kinds of placeholder:

- `{{ vars.NAME }}` is replaced from the `vars` of the defaults or the host file. It works in `command`, `env`, `url` and `headers`. `vars.HOME` is built in.
- `secret:NAME` is replaced from the encrypted files in `secrets/`. `NAME` is capital letters, digits and `_`, and starts with a letter. It works in `env`, `headers` and `url`. It never works in `command`, because any user on the machine can read a command line. Set the value with `fleet secrets set <host> NAME`.

## Example

```yaml
servers:
  docs:
    command: [npx, -y, "@example/docs-mcp@1.0.0"]
    env:
      DOCS_BASE_URL: "{{ vars.DOCS_URL }}"

  tracker:
    transport: http
    url: https://tracker.example.com/mcp

  tracker-local:
    command: [npx, -y, "@example/tracker-mcp@2.0.0"]
    env:
      TRACKER_API_KEY: secret:TRACKER_API_KEY
    only: [claude]
```

## Keys

A server is either a stdio server, which has `command` and runs on the machine, or a network server, which has `transport` and `url` and is something you connect to. It needs exactly one of `command` and `transport`.

### `servers.<name>.command`

Type: list of strings. Default: none. Added in: 1.0.0.

The program and its arguments, program first. This makes the server a stdio server. A first element of `npx` is rewritten to the `npx` beside the Node that fleet runs under, with a `PATH` that finds it, so the server starts from the timer, which has no shell profile. Pin the package version in the arguments so a new release cannot change a machine unreviewed. The list cannot be empty, and cannot hold a `secret:NAME`.

```yaml
servers:
  docs:
    command: [npx, -y, "@example/docs-mcp@1.0.0"]
```

### `servers.<name>.env`

Type: map of name to string. Default: empty. Added in: 1.0.0.

Environment variables for a stdio server. It is an error on a network server. This is where a secret goes for a stdio server.

```yaml
servers:
  tracker-local:
    command: [npx, -y, "@example/tracker-mcp@2.0.0"]
    env:
      TRACKER_API_KEY: secret:TRACKER_API_KEY
```

### `servers.<name>.transport`

Type: string, `http` or `sse`. Default: none. Added in: 1.0.0.

How a network server speaks. This makes the server a network server, and it then needs a `url`. Antigravity CLI takes `http` only: an `sse` server is left out of its file, with a warning from `fleet diff` and `fleet apply`, and an `sse` server whose `only` names `antigravity` is an error.

```yaml
servers:
  tracker:
    transport: http
    url: https://tracker.example.com/mcp
```

### `servers.<name>.url`

Type: string, a URL. Default: none, required with `transport`. Added in: 1.0.0.

Where the server is. It may not hold spaces or control characters, and may not hold credentials (`user:password@`). Put them in `headers` as a `secret:NAME`. It is an error on a stdio server.

```yaml
servers:
  tracker:
    transport: http
    url: https://tracker.example.com/mcp
```

### `servers.<name>.headers`

Type: map of name to string. Default: empty. Added in: 1.0.0.

HTTP headers sent to a network server, such as an authorization token. It is an error on a stdio server.

```yaml
servers:
  tracker:
    transport: http
    url: https://tracker.example.com/mcp
    headers:
      Authorization: Bearer secret:TRACKER_TOKEN
```

### `servers.<name>.only`

Type: list of strings. Default: every agent that can take MCP servers. Added in: 1.0.0.

Limits the server to some agents. The values are `claude`, `opencode` and `antigravity`. The list cannot be empty, and an agent that cannot take the server's transport is an error. Without `only`, an agent that cannot take the transport leaves the server out, and says so.

```yaml
servers:
  tracker-local:
    command: [npx, -y, "@example/tracker-mcp@2.0.0"]
    only: [claude]
```

## See also

- [MCP logins](mcp-logins.md) for servers that need a login in the tool itself.
- [Host files and defaults](reference-hosts.md) for `mcp.include`, `mcp.exclude` and `vars`.
