# Host files and defaults

Every machine has a host file, `hosts/<name>.yaml`, and the name of the file is the name of the host. `hosts/_defaults.yaml` holds what every host gets. A host file is required for each machine; the defaults file is optional. Both are maps, and a file that holds only comments is an empty map.

Fleet reads the two files for the host it is on and merges them. A key in the defaults is a default for every host, and the host file adds to it, takes from it or replaces it.

## How a host file layers on the defaults

How the two files combine depends on the key:

| Key | What the host file does |
|---|---|
| `bundles`, `mcp.include` | Its list is added to the defaults' list. |
| `exclude`, `mcp.exclude` | Its names are taken off after both lists are added. Names in the defaults' `exclude` are taken off too. |
| `agents`, `timer` | Its value replaces the defaults' value. |
| `notify` | Merged field by field: a field the host file sets replaces the defaults' field, and `notify: off` in the host file turns every alert off for that host. |
| `vars` | Merged name by name. The host's value wins at the same name. |
| `settings` | Merged key by key, down to the leaves. The host's value wins at the same key. |
| `files` | Merged by `target`. A host record replaces the default record with the same target and keeps its place. |

`ssh`, `age`, `admin` and `unmanaged` are for one machine, so only a host file may set them. Fleet refuses them in the defaults.

An unknown key is an error in either file, and the message names the file and the key. This is why every host has to run a fleet version that knows a key before a file uses it.

## Example

`hosts/_defaults.yaml`:

```yaml
timer: 30m
vars:
  DOCS_URL: https://docs.example.com
bundles: [core]
mcp:
  include: [docs]
settings:
  claude:
    attribution:
      commit: ""
files:
  - { source: config/AGENTS.md, target: ~/.claude/CLAUDE.md }
```

`hosts/server.yaml`:

```yaml
ssh: me@server
age: ""
vars:
  DOCS_URL: https://docs.internal.example.com
agents: [claude]
exclude: [core]
files:
  - { source: config/rules/host/server.md, target: ~/.claude/rules/host.md }
```

The server gets no `core` bundle, the docs server with the internal URL, Claude Code only, and both linked files.

## Keys in both files

### `vars`

Type: map of name to string. Default: empty. Added in: 1.0.0.

Values for `{{ vars.NAME }}` in `catalog/mcp.yaml` and in `settings` values. A name that is used is letters, digits and `_`, and does not start with a digit. `HOME` is built in, holds the machine's home directory and cannot be set. A value cannot hold a `secret:NAME`, because variables are plain text in the repo; put secrets in `env`, `headers` or `url` of a catalog server instead. A name that is used and not defined in any file is an error.

```yaml
vars:
  DOCS_URL: https://docs.example.com
```

### `bundles`

Type: list of strings. Default: empty. Added in: 1.0.0.

Skill bundles this host gets, by the names in `catalog/skills.yaml`. A name that is not there is an error. Fleet links each skill of a picked bundle into the skills directory of every agent that reads one.

```yaml
bundles: [core, extra]
```

### `exclude`

Type: list of strings. Default: empty. Added in: 1.0.0.

Bundles to take away, even when the defaults or another list adds them. Use it in a host file to opt a machine out of a bundle the defaults give everyone. Names must be bundles in `catalog/skills.yaml`.

```yaml
exclude: [core]
```

### `mcp.include`

Type: list of strings. Default: empty. Added in: 1.0.0.

MCP servers this host gets, by the names under `servers` in `catalog/mcp.yaml`. A name that is not there is an error. Fleet writes each server into the file of every agent the host gets and the server's `only` allows.

```yaml
mcp:
  include: [docs, tracker]
```

### `mcp.exclude`

Type: list of strings. Default: empty. Added in: 1.0.0.

MCP servers to take away, even when the defaults or another list include them.

```yaml
mcp:
  exclude: [docs]
```

### `settings.<agent>`

Type: map. Default: none. Added in: 1.0.0. `settings.antigravity` is new in 2.6.0.

Settings fleet owns inside the settings file an agent also writes. `<agent>` is `claude` (`~/.claude/settings.json`), `opencode` (`~/.config/opencode/opencode.jsonc`) or `antigravity` (`~/.gemini/antigravity-cli/settings.json`). Fleet sets every key you list at each apply, so a change made by hand is a conflict. It never reads or touches a key you do not list.

Nested maps are followed down to the leaves, and each leaf is one owned key. A list is a leaf, so a list replaces the whole list. A value must be something JSON can hold. A key may not be empty, hold a `.` or be `__proto__`. Declaring a map and one of its members in the same file is an error: declare the whole value or its members, not both.

Each agent has keys fleet refuses, such as the keys the agent writes itself (a chosen model, a theme) and the place its MCP servers live. The error names the key and says why. A `secret:NAME` in a value is replaced from the encrypted secrets at apply, and shown as `***` in diffs.

```yaml
settings:
  claude:
    attribution:
      commit: ""
      pr: ""
  opencode:
    autoupdate: false
```

### `files`

Type: list of records. Default: empty. Added in: 1.0.0.

Files linked into place on the host. Each record is a map with a `source` and a `target`, described below. The target becomes a symlink to the file in your repo, so the repo holds the only copy. A directory works the same way. A real file already at the target is a conflict: fleet writes nothing and tells you how to clear it.

Fleet skips a record whose target belongs to an agent the host does not get, so one list can name the files of every agent. The target of the fleet skill (`~/.claude/skills/fleet` and its twins) is reserved, and so is any skill's directory that a bundle links.

```yaml
files:
  - { source: config/AGENTS.md, target: ~/.claude/CLAUDE.md }
  - { source: config/AGENTS.md, target: ~/.gemini/GEMINI.md }
```

### `files[].source`

Type: string, a path. Default: none, required. Added in: 1.0.0.

Where the file is, relative to the root of your config repo. It must exist, must not start with `/` and must not contain `..`.

```yaml
files:
  - { source: config/rules/claude.md, target: ~/.claude/rules/claude.md }
```

### `files[].target`

Type: string, a path. Default: none, required. Added in: 1.0.0.

Where the link goes. It starts with `~/` and has no `.`, `..` or empty segments. It cannot name the same target twice in one file. Neither `source` nor `target` can hold a `secret:NAME`.

```yaml
files:
  - { source: config/AGENTS.md, target: ~/.claude/CLAUDE.md }
```

### `agents`

Type: list of strings. Default: none, which means the agents installed on the host. Added in: 2.6.0.

Names the agents this host gets, instead of detecting them. The values are `claude`, `opencode` and `antigravity`; an unknown id or an empty list is an error. A named agent is set up whether or not it is installed. Without the key, a host gets the agents it has, and config for an agent that is not installed is not applied. See [which agents a machine gets](setting-up-machines.md#which-agents-a-machine-gets).

```yaml
agents: [claude, opencode]
```

### `timer`

Type: string. Default: `30m`. Added in: not yet released.

How often the timer runs `fleet apply` on a machine: `5m`, `10m`, `15m`, `20m`, `30m`, a whole number of hours `1h` to `24h`, or `off`, which removes the timer so the host applies only on `fleet push` or by hand. Any other value is an error that lists these. See [the timer's schedule](setting-up-machines.md#the-timers-schedule).

```yaml
timer: 1h
```

### `notify`

Type: map, or `off`. Default: none, which means no alerts. Added in: not yet released.

Where a machine sends an alert when an apply its timer started stops, or recovers: a new conflict, an apply that stops with an error, and back to ok. Each machine alerts about itself, and only after a timer run; `fleet push`, a manual `fleet apply` and `fleet init` show their result on screen. A machine that sets no `notify:` sends nothing. In a host file, `notify: off` turns all alerts off for that machine, whatever the defaults say. The fields below are merged one at a time with the defaults'. See [alerts](setting-up-machines.md#alerts).

```yaml
notify:
  desktop: true
  ntfy: secret:NTFY_URL
```

### `notify.desktop`

Type: boolean. Default: `false`. Added in: not yet released.

Shows a desktop notification: `notify-send` on Linux, `osascript` on a Mac. A machine with no desktop session, or without the program, skips it without an error.

```yaml
notify:
  desktop: true
```

### `notify.ntfy`

Type: string. Default: none. Added in: not yet released.

The full URL of an [ntfy](https://ntfy.sh) topic, on ntfy.sh or your own server. Fleet posts the alert there: a problem at high priority with a warning tag, back to ok at default priority. Anyone who knows the topic can read it, so keep it in a secret: `secret:NAME` is replaced from the machine's encrypted secrets when the alert is sent. Any other value must be an `http` or `https` URL.

```yaml
notify:
  ntfy: secret:NTFY_URL
```

### `notify.ntfy_token`

Type: string. Default: none. Added in: not yet released.

The access token for an ntfy server that needs a login, sent as a bearer token. Put it in a secret: `secret:NAME` is replaced from the machine's encrypted secrets when the alert is sent.

```yaml
notify:
  ntfy: secret:NTFY_URL
  ntfy_token: secret:NTFY_TOKEN
```

### `notify.webhook`

Type: string. Default: none. Added in: not yet released.

A URL that gets a POST of a small JSON body, `{ "v": 1, "host", "event": "conflict" | "failed" | "ok", "message", "conflict": { "kind", "path" } | null, "time", "fleet" }`. `fleet` is the short commit of the machine's fleet clone. New fields may be added later, so a receiver should ignore the ones it does not know. A webhook URL often holds its own secret: keep it in `secret:NAME`. Any other value must be an `http` or `https` URL.

```yaml
notify:
  webhook: secret:FLEET_WEBHOOK
```

## Keys only in a host file

### `ssh`

Type: string. Default: none. Added in: 1.0.0.

How to reach the host: any destination `ssh` accepts, for the user the config is for. `fleet push` applies on a host with an `ssh` line right away, and the admin host sets the machine up over it with `fleet init`. Without it, the host applies only on its own timer.

```yaml
ssh: me@server
```

### `age`

Type: string. Default: none. Added in: 1.0.0.

The host's age public key, which the secrets files are encrypted to. Leave it empty: `fleet init <host>` makes the key on the machine, writes the public half here and encrypts the secrets files again. A host whose `age` is empty cannot read any secret.

```yaml
age: ""
```

### `admin`

Type: boolean. Default: `false`. Added in: 1.0.0.

Marks the machine you work from. Exactly one host file has `admin: true`. Its key can read every secrets file, and it is the host that runs `fleet init` for the others. The admin host also needs an `age` key.

```yaml
admin: true
```

### `unmanaged`

Type: list of strings. Default: none. Added in: not yet released.

The MCP servers and skills on this machine that `fleet capture` and `fleet status` leave alone: each item is `mcp:<name>` or `skill:<name>`. An ignored item is not listed by capture, not counted as "not from config", and never touched: fleet only writes this list, it does not change the machine. A host file may have it; the defaults may not, because what one machine has by hand says nothing about another. `fleet capture mcp <name> --ignore` and the Ignore button of the Capture screen add to it. See [Capture](capture.md).

```yaml
unmanaged: [mcp:scratch-server, skill:my-notes]
```

## See also

- [`catalog/mcp.yaml`](reference-catalog-mcp.md) for the servers `mcp.include` picks from.
- [`catalog/skills.yaml`](reference-catalog-skills.md) for the bundles `bundles` picks from.
- [Setting up machines](setting-up-machines.md) for ssh, agents and the timer.
- [Capture](capture.md) for what `unmanaged` hides.
