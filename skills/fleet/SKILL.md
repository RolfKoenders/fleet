---
name: fleet
description: Use when changing agent config, skills, MCP servers, settings or secrets on this machine, or when asked about fleet, its status, a conflict or a push.
---

This machine's agent setup is managed by fleet. Run `fleet agent` for the concepts, commands and current state. Pass `--json` when you will read the output.

`fleet status` and `fleet diff` are always safe.

Never run `fleet push`, `fleet apply`, or a command that changes secrets unless the user asked for that action in this turn.
