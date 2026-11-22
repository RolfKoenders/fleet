import { isObject } from "../yamlfile.ts";
import { readOpencodeHistory } from "./opencodeusage.ts";
import { stringMap, strings, withoutEmpty } from "./shape.ts";
import type { Agent } from "./types.ts";

const SETTINGS = "~/.config/opencode/opencode.jsonc";

export const opencode: Agent<"opencode"> = {
  id: "opencode",
  name: "opencode",
  binary: "opencode",
  binDirs: ["~/.opencode/bin"],
  version: ["--version"],
  homes: ["~/.config/opencode"],

  settings: {
    file: SETTINGS,
    denied: ["$schema", "mcp"],
    alsoLoaded: "~/.config/opencode/opencode.json",
  },

  mcp: {
    file: SETTINGS,
    key: "mcp",
    render: (server) =>
      server.command !== null
        ? withoutEmpty({ type: "local", command: server.command, environment: server.env })
        : withoutEmpty({ type: "remote", url: server.url, headers: server.headers }),
    read(entry, cwd) {
      if (entry.type === "local") {
        const command = strings(entry.command);
        return command === null || command.length === 0 ? null : { transport: "stdio", target: { kind: "stdio", command, env: stringMap(entry.environment), cwd }, credentials: false };
      }
      if (entry.type === "remote" && typeof entry.url === "string") {
        const headers = stringMap(entry.headers);
        return { transport: "remote", target: { kind: "network", transport: "remote", url: entry.url, headers }, credentials: Object.keys(headers).length > 0 };
      }
      return null;
    },
    // A server that is switched off is not started.
    skip: (entry) => isObject(entry) && entry.enabled === false,
  },

  // opencode reads Claude's skill directory as well as its own (https://opencode.ai/docs/skills), and a skill
  // of the same name in a later directory replaces the earlier one. Fleet links skills into Claude's only.
  skills: {
    target: null,
    dirs: ["~/.claude/skills", "~/.agents/skills", "~/.config/opencode/skills"],
    setting: SETTINGS,
    nested: true,
    hidden: (meta) =>
      meta["disable-model-invocation"] === true ||
      (isObject(meta.metadata) && meta.metadata["opencode/autoinvoke"] === false) ||
      // opencode offers no skill without a description.
      typeof meta.description !== "string" ||
      meta.description === "",
  },

  instructions: {
    files: ["~/.config/opencode/AGENTS.md"],
    dirs: [],
    setting: SETTINGS,
  },

  // One SQLite database under `~/.local/share/opencode`; see `opencodeusage.ts` for the schemas and its sources.
  usage: { read: readOpencodeHistory },
};
