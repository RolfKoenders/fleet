# catalog/skills.yaml

`catalog/skills.yaml` says where skills come from and how they are grouped. A skill is a directory named after the skill, with a `SKILL.md` in it. A source is a git repo that holds skills. A bundle is a named list of skills that a host file picks as one unit with `bundles`. The file is optional and has two keys, `sources` and `bundles`.

Fleet links each picked skill into the skills directory of every agent that reads one, such as `~/.claude/skills/<name>`. It also installs its own `fleet` skill from the tool. Do not list that one: `fleet`, `synced` and `.trash` are reserved names.

A source is either pinned or followed:

- A **pinned** source has a `commit` and a `track`. It sits at that commit until you run `fleet skills update`, so a change upstream cannot reach your machines unreviewed. Use it for skills other people write.
- A **followed** source has a `branch`. Fleet keeps it on the newest commit of that branch and moves it at every apply. `fleet push` also commits and pushes it. Use it for skills you write yourself.

A source has exactly one of `commit` and `branch`.

## Example

```yaml
sources:
  example-skills:
    repo: https://github.com/example/skills.git
    commit: 1234567890abcdef1234567890abcdef12345678
    track: main
    path: skills
    review: true

  my-skills:
    repo: https://github.com/you/my-skills.git
    branch: main
    path: .

bundles:
  core: [review, debug]
  extra: [notes]
```

## Keys

### `sources.<name>.repo`

Type: string, a URL. Default: none, required. Added in: 1.0.0.

The git repo that holds the skills. Credentials in the URL (`user:password@`) are refused: use a git credential helper or an SSH key. A source's name is letters, digits, `.`, `_` and `-`, and starts with a letter or digit. Each machine keeps its clone under that name, so renaming a source clones it again.

```yaml
sources:
  example-skills:
    repo: https://github.com/example/skills.git
```

### `sources.<name>.path`

Type: string, a directory in the repo. Default: none, required. Added in: 1.0.0.

The directory to search for skills. Skills are found at any depth below it. Use `.` for the whole repo. A path that is itself a skill, with a `SKILL.md` in it, offers just that skill. It cannot start with `/` or contain `..`.

```yaml
sources:
  example-skills:
    path: skills
```

### `sources.<name>.commit`

Type: string, a full commit sha. Default: none. Added in: 1.0.0.

Makes the source pinned: the commit to check out, as 40 lowercase hex characters. Needs `track`, and cannot be used with `branch`. `fleet skills update` moves it.

```yaml
sources:
  example-skills:
    commit: 1234567890abcdef1234567890abcdef12345678
    track: main
```

### `sources.<name>.track`

Type: string, a branch name. Default: none, required for a pinned source. Added in: 1.0.0.

The branch `fleet skills update` reads to find a newer commit. Only a pinned source has it.

```yaml
sources:
  example-skills:
    track: main
```

### `sources.<name>.branch`

Type: string, a branch name. Default: none. Added in: 1.0.0.

Makes the source followed: the branch fleet keeps it on. Cannot be used with `commit`, `track` or `review`.

```yaml
sources:
  my-skills:
    repo: https://github.com/you/my-skills.git
    branch: main
    path: .
```

### `sources.<name>.review`

Type: boolean. Default: `false`. Added in: 2.1.0.

With `true`, `fleet skills update` shows what a move of this source brings in and asks before the pin moves, as if you had passed `--review`. Switch it on for skills other people write. Only a pinned source can have it, because a followed source moves at every apply and has no pin to review. Every host has to run 2.1.0 or newer before the catalog uses it.

```yaml
sources:
  example-skills:
    review: true
```

### `bundles.<name>`

Type: list of strings, skill names. Default: none. Added in: 1.0.0.

A named group of skills. A host file picks it with `bundles`. Each entry is the directory name of a skill, with no `/`. A skill can be in only one bundle and once in it, a skill's name must match exactly one directory in exactly one source, and the reserved names are refused.

```yaml
bundles:
  core: [review, debug]
  extra: [notes]
```

## See also

- [Host files and defaults](reference-hosts.md) for `bundles` and `exclude`.
- [Getting started](getting-started.md) for `fleet skills update`.
