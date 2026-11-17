import { stringMap, strings, withoutEmpty } from "./shape.ts";
import type { Agent } from "./types.ts";

/** Where Claude keeps its user-scope servers. Fleet writes its entries holding Claude's lock; see `claudemcp.ts`. */
export const CLAUDE_JSON = "~/.claude.json";

export const claude: Agent<"claude"> = {
  id: "claude",
  name: "Claude Code",
  binary: "claude",
  binDirs: [],
  version: ["--version"],
  homes: ["~/.claude", CLAUDE_JSON],

  settings: {
    file: "~/.claude/settings.json",
    // `mcpServers` is listed because Claude keeps its servers in `~/.claude.json`, not here.
    denied: [
      "model", "modelSettings", "effortLevel", "advisorModel", "fastMode", "alwaysThinkingEnabled", "tui",
      "remoteControlAtStartup", "agentPushNotifEnabled", "skipDangerousModePermissionPrompt", "theme", "mcpServers",
    ],
  },

  mcp: {
    file: CLAUDE_JSON,
    key: "mcpServers",
    render: (server) =>
      server.command !== null
        ? withoutEmpty({ type: "stdio", command: server.command[0], args: server.command.slice(1), env: server.env })
        : withoutEmpty({ type: server.transport, url: server.url, headers: server.headers }),
    read(entry, cwd) {
      if (entry.type === "stdio" && typeof entry.command === "string") {
        return { transport: "stdio", target: { kind: "stdio", command: [entry.command, ...(strings(entry.args) ?? [])], env: stringMap(entry.env), cwd }, credentials: false };
      }
      if ((entry.type === "http" || entry.type === "sse") && typeof entry.url === "string") {
        const headers = stringMap(entry.headers);
        return { transport: entry.type, target: { kind: "network", transport: entry.type, url: entry.url, headers }, credentials: Object.keys(headers).length > 0 };
      }
      return null;
    },
    needsBinary: true,
  },

  skills: {
    target: "~/.claude/skills",
    dirs: ["~/.claude/skills"],
    setting: null,
    hidden: (meta) => meta["disable-model-invocation"] === true,
  },

  instructions: {
    files: ["~/.claude/CLAUDE.md"],
    dirs: ["~/.claude/rules"],
    setting: null,
  },
};

