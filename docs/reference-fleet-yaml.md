# fleet.yaml

`fleet.yaml` sits at the root of your config repo and says which version of fleet every machine runs. A machine does not run the newest fleet. At each apply it checks out the commit named here in its own clone of the tool, and runs that code. A change to the tool reaches a machine only after you move the commit and push.

`fleet new` writes the file. `fleet update` is the only command that changes it, and it changes only `commit`. The file is required: without it, no config loads. It has one key, `tool`, and every key inside `tool` is required.

## Example

```yaml
tool:
  repo: https://github.com/example/fleet.git
  commit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  track: releases
```

## Keys

### `tool.repo`

Type: string, a URL. Default: none, required. Added in: 1.0.0.

Where machines clone the tool from. Use a plain URL. `fleet init` refuses a URL that holds a password or starts with `-`, because the URL travels to the other machine on a command line where `ps` shows it. Let git's credential helper or an SSH key do the signing in.

```yaml
tool:
  repo: https://github.com/example/fleet.git
```

### `tool.commit`

Type: string, a full commit sha. Default: none, required. Added in: 1.0.0.

The commit machines run, written as all 40 lowercase hex characters. A short sha or a tag name is refused. `fleet update` moves it; you can also set it by hand to pin an older version.

```yaml
tool:
  commit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

### `tool.track`

Type: string, `releases` or a branch name. Default: none, required. Added in: 1.0.0. The value `releases` is new in 2.2.0.

What `fleet update` follows. With `releases`, it moves `commit` to the newest release, the highest `vX.Y.Z` tag, and ignores tags with a suffix such as `v3.0.0-rc.1`. With any other value, that value is a branch, and `commit` moves to the branch's latest commit. `fleet new` writes `releases`, so a new config takes finished versions only.

```yaml
tool:
  track: main
```

## See also

- [Getting started](getting-started.md) for `fleet new` and `fleet update`.
- [Host files and defaults](reference-hosts.md) for the files that say what each machine gets.
