# Setting up machines

## What each machine needs

The machine you work from reaches the others over SSH with a key and no prompt. `ssh <destination> true` should succeed without asking anything. Put the destination in the machine's host file as its `ssh:` line.

Every machine pulls from and pushes to your config repo, at the address the repo has on the machine you work from. `fleet init` hands that address to each new machine. A machine with only HTTPS access to GitHub needs a git setting to reach an SSH address:

```sh
git config --global url."https://github.com/you/".insteadOf "git@github.com:you/"
```

## Which agents a machine gets

A machine gets the agents installed on it. Fleet looks for each agent's program (`claude`, `opencode`, `agy`) on the usual paths and in the directory of the Node that fleet runs under, where `npm -g` puts agent CLIs. Install an agent and the next apply sets it up. An agent that is not installed is left alone: nothing of its is written, and what fleet applied for it earlier stays where it is. An agent you never had is never mentioned, however many agents the shared config names. One you had, and fleet applied config for, is mentioned, so that a lost install does not go unnoticed:

```
warning opencode: not installed, its config is left as is. Install it, or pin `agents:`
```

To choose instead of detect, name the agents in the machine's host file. The list replaces the defaults' list, and a named agent is set up whether or not it is installed (Claude's MCP servers still wait for `claude`, because they are written through it):

```yaml
agents: [claude]
```

`fleet status` shows what a machine gets, as `agents: claude 2.1.4 (opencode not installed)`, and `fleet context` and `fleet doctor` cover only those agents. Antigravity CLI was added after the others, so `fleet status` says nothing about it on a machine that does not have it.

### Antigravity CLI

Antigravity CLI (`agy`) keeps its files in `~/.gemini`, a folder Gemini CLI uses too. Fleet only touches `~/.gemini/antigravity-cli`, `~/.gemini/config` and `~/.gemini/GEMINI.md`, and links skills into `~/.gemini/config/skills`, so what other tools put there stays. A skill of the same name that another tool linked there is a conflict, as anywhere else.

It does not support SSE servers. An `sse` server with an `only` list that names `antigravity` is an error in the config. An `sse` server without one goes to the other agents, is left out of Antigravity's file, and a machine that has `agy` says so in one warning line:

```
warning Antigravity CLI does not support sse servers, so events is left out of ~/.gemini/config/mcp_config.json
```

### Taking an agent's config off a machine

Naming an agent out of a host file, or uninstalling it, only stops fleet from touching it. To remove what fleet put there:

1. Take the agent's config out of the config repo for that machine: its `settings.<agent>` keys, the `files` records for its paths, and its servers (leave the name out of `mcp.include`, or take the agent out of the server's `only`).
2. Run `fleet push` while the agent is still installed or named in `agents`. Apply removes the keys and links it recorded, and leaves what you made by hand.
3. Then name the agents the machine keeps in its host file, such as `agents: [claude]`, and push again. Fleet leaves the other agent alone from then on and stops warning about it.

Do it in this order: a pinned-out agent is never touched, so a pin first would leave its files in place.

## Servers

The timer runs in a systemd user session. On a server, keep that session alive after you log out:

```sh
sudo loginctl enable-linger <user>
```

Without systemd, run `fleet apply` by hand or from cron.

## macOS

Use macOS 12.3 or newer: the scripts use `readlink -f`. `fleet init` reads the version with `sw_vers -productVersion` and stops with a missing prerequisite on an older one.

Install what fleet needs with Homebrew, on Apple Silicon (`/opt/homebrew`) or Intel (`/usr/local`):

```sh
brew install node sops age
xcode-select --install   # for git, if you have no other
```

Fleet finds Homebrew's tools without a login shell, so the timer works without `brew shellenv`.

On a Mac the timer is a LaunchAgent, `~/Library/LaunchAgents/io.github.rolfkoenders.fleet.apply.plist`. It runs `fleet apply` when it loads (at login) and at :00 and :30 each hour, and a run missed while the Mac slept happens when it wakes. The output goes to `~/Library/Logs/fleet.log`. When that file passes 1 MB, the start of each apply cuts it down in place to its last 256 KB, at a line boundary. A log that is a symlink is left alone. Check it with `fleet status`, or `launchctl print gui/$(id -u)/io.github.rolfkoenders.fleet.apply`.

A LaunchAgent runs only while its user is logged in at the desktop. `fleet init` over ssh to a Mac nobody is logged in to writes the file and stops with exit code 1, asking you to log in at the Mac, then run `fleet init <host>` again.

Headless Macs, with nobody ever logged in, are out of scope: there is no timer for them. Two workarounds: turn on automatic login for the agent user, or leave the Mac without a timer and run `fleet push` from another machine over ssh to apply on it.

Git must be able to read and push your config repo without a prompt, from a launchd job. A key kept in the macOS Keychain may need `UseKeychain yes` and `AddKeysToAgent yes` in `~/.ssh/config` (Apple documents those two options). `fleet init` tests a push before it installs the timer, so a key the timer cannot use shows up there.

## Machines that already have a setup

`fleet init` ends with a first apply and then turns on the timer. Fleet stops at anything it did not write, lists it as a conflict, and writes nothing. Back up what you want to keep, clear each conflict, and run `fleet init` again. Init is safe to run as often as you need.

`fleet diff` shows the same list without applying anything.

## The age key

Init prints the key of the machine you work from once, when it makes the key. That key opens every secret, so save it in your password manager.

If an agent runs your commands, the printed key ends up in its session. Run this step yourself, or create the key first. Init then prints nothing:

```sh
mkdir -p ~/.config/fleet
age-keygen -o ~/.config/fleet/age.key
chmod 600 ~/.config/fleet/age.key
```

Init never prints the key of another machine. That key stays on that machine.
