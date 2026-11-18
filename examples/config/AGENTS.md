# Shared instructions

These instructions reach every host, as ~/.claude/CLAUDE.md for Claude Code, as
~/.config/opencode/AGENTS.md for opencode and as ~/.gemini/GEMINI.md for Antigravity CLI,
because hosts/_defaults.yaml links this one file to each. Write here what you want every agent
on every machine to follow.

## Working style

- Say what you are about to do before a change that is hard to undo.
- Run the tests before calling a task done.

## Fleet

This machine's agent config is managed by fleet. Edit skills, MCP servers, settings and shared instructions through the fleet repo, not in place. Use the `fleet` skill.
