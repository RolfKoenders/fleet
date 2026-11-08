# FAQ

## Where do my secrets end up?

They are encrypted in `secrets/` in your config repo. On apply, fleet decrypts the ones a machine needs and writes them in plaintext into the settings files of your agents, at mode 600, because the tools read them from there.

## What if I lose the age key?

Nobody can read the secrets without a key that can decrypt them, and the key of the machine you work from is the only one that opens all of them. Keep it in your password manager.

## Does fleet touch skills or settings it did not write?

No. It leaves other entries in `~/.claude/skills` alone, and in a settings file it changes only the keys your config names. If something is already at a path fleet wants to write, that is a conflict, and fleet stops.

## When does a change reach a machine?

`fleet push` applies it straight away on every machine with an `ssh:` line in its host file. Every machine also pulls and applies every 30 minutes, so one that was offline catches up. A machine with no `ssh:` line gets changes only this way.

## What does the install script do?

It checks for git and Node, clones the tool into `~/.local/share/fleet/fleet`, and links `fleet` into `~/.local/bin`. It uses no sudo and installs nothing else, and [you can read it first](../install.sh). Running it again changes nothing.

## How do I update fleet?

Your machines run the tool commit pinned in `fleet.yaml`, so a new version reaches them only when you choose to take it. `fleet update` moves the pin and prints what changed. Read that and `git diff`, then run `fleet push`.

## Should I work in `~/.local/share/fleet/fleet`?

No. That is the copy your machine runs, and fleet moves it to the pinned commit. To work on the tool, use a separate checkout and run its own `bin/fleet`.

## Does it run on macOS?

Yes, macOS 12.3 or newer. The timer is a LaunchAgent instead of a systemd timer, and the scripts and tool search know Homebrew. See [macOS](setting-up-machines.md#macos).
