# Fleet

Fleet describes how every machine that runs coding agents should be set up, and makes each machine match that config.

## Machines

**Host**:
One machine fleet manages, as one agent user on it (`laptop` as `alice`, `server` as `deploy`).
_Avoid_: Machine, server, node, box

**Agent user**:
The OS user on a host whose agent setup fleet manages. Other users on the same host are not fleet's business.
_Avoid_: Account

## Config

**Config repo**:
The user's config: the private repo a user keeps their catalog, host files, shared instructions and encrypted secrets in. The tool itself lives apart from it, in the fleet clone.
_Avoid_: Description, dotfiles

**Fleet clone**:
The copy of the fleet tool a host runs from, kept at the commit its config pins. It holds no one's config, and nobody works in it.
_Avoid_: Tool repo

**Catalog**:
The place where every MCP server and skill source is defined once, independent of host and tool.
_Avoid_: Registry, inventory

**Host file**:
What one host gets, picked from the catalog and layered on the defaults.
_Avoid_: Host config, profile

**Skill source**:
A repo, at a pinned commit or followed branch, that skills are taken from.
_Avoid_: Skill repo, upstream

**Bundle**:
A named group of skills that a host file picks as a unit.
_Avoid_: Pack, set, collection

## Applying

**Apply**:
Making one host match its config, on that host.
_Avoid_: Sync, deploy, install

**Push**:
Publishing a change to GitHub and then applying it on every host.
_Avoid_: Sync, deploy, rollout

**Adopt**:
Recording something that already exists on a host and matches the catalog in applied state, so fleet owns it from then on without changing it.
_Avoid_: Import

**Linked file**:
A file fleet places as a symlink into the repo, so the repo copy is the only copy.
_Avoid_: Symlinked file, managed file

**Merged file**:
A file that a tool also writes, where fleet sets only its owned keys and leaves the rest alone.
_Avoid_: Patched file, managed file

**Owned key**:
A path inside a merged file whose whole value fleet declares and controls. Everything beside it is left alone, and a host file's owned key replaces the defaults' owned key at the same path.
_Avoid_: Managed key, fleet key

**Applied state**:
The record, per host, of what fleet created there, so removal is possible and everything else is left alone.
_Avoid_: Lockfile, manifest

**Conflict**:
A difference fleet will not resolve by itself during apply, so it stops and reports instead of overwriting.
_Avoid_: Drift (drift is any difference; only some drift is a conflict)
