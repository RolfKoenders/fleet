# Setting up machines

## What each machine needs

The machine you work from reaches the others over SSH with a key and no prompt. `ssh <destination> true` should succeed without asking anything. Put the destination in the machine's host file as its `ssh:` line.

Every machine pulls from and pushes to your config repo, at the address the repo has on the machine you work from. `fleet init` hands that address to each new machine. A machine with only HTTPS access to GitHub needs a git setting to reach an SSH address:

```sh
git config --global url."https://github.com/you/".insteadOf "git@github.com:you/"
```

## Servers

The timer runs in a systemd user session. On a server, keep that session alive after you log out:

```sh
sudo loginctl enable-linger <user>
```

Without systemd, run `fleet apply` by hand or from cron.

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
