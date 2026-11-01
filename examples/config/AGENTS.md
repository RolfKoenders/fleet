# Shared instructions

These instructions reach every host, as ~/.claude/CLAUDE.md for Claude Code and as
~/.config/opencode/AGENTS.md for opencode, because hosts/_defaults.yaml links this one file
to both. Write here what you want every agent on every machine to follow.

## Working style

- Say what you are about to do before a change that is hard to undo.
- Run the tests before calling a task done.

## Fleet

This machine's agent config is managed by fleet. Edit skills, MCP servers, settings and shared instructions through the fleet repo, not in place. Use the `fleet` skill.
