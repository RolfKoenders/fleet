import { isObject } from "../yamlfile.ts";
import { stringMap, strings, withoutEmpty } from "./shape.ts";
import type { Agent } from "./types.ts";

/**
 * Antigravity CLI (`agy`), Google's agent for personal accounts. Its folders sit inside `~/.gemini`, which Gemini CLI
 * shares, so its homes are the three places that are Antigravity's alone. Install: https://antigravity.google/docs/getting-started
 * (`curl -fsSL https://antigravity.google/cli/install.sh | bash`, binary `~/.local/bin/agy`, `agy --version`).
 */
export const antigravity: Agent<"antigravity"> = {
  id: "antigravity",
  name: "Antigravity CLI",
  binary: "agy",
  binDirs: [],
  version: ["--version"],
  homes: ["~/.gemini/antigravity-cli", "~/.gemini/config", "~/.gemini/GEMINI.md"],

  // https://antigravity.google/docs/settings/ : plain JSON, unknown keys are kept, the CLI replaces the file when it saves
  // and then makes it readable by its user only (0600), which is the mode fleet writes every merged file in.
  settings: {
    file: "~/.gemini/antigravity-cli/settings.json",
    // The CLI writes some keys itself (`trustedWorkspaces` when a folder is trusted, `model` after /model, `permissions` when
    // a prompt is answered with always allow, `gcp` at sign-in, `colorScheme` is the theme), some hold an account choice or a
    // credential (`modelProvider`, `customModelsConfig`, `useG1Credits`, `sandboxProxy`), and three are not read from this
    // file (`$schema` is only kept, `enableTelemetry` is saved with the account, `hooks` live in `~/.gemini/config/hooks.json`).
    // Reference: https://antigravity.google/docs/settings/ and the schema at https://antigravity.google/schemas/v1/settings.json
    denied: [
      "$schema", "model", "modelProvider", "customModelsConfig", "useG1Credits", "gcp", "trustedWorkspaces", "permissions",
      "sandboxProxy", "colorScheme", "enableTelemetry", "hooks",
    ],
  },

  // https://antigravity.google/docs/mcp/ : `mcpServers` in `~/.gemini/config/mcp_config.json`. A stdio entry has `command`,
  // `args` and `env`; a remote one has `serverUrl` (or `url`) and `headers`, and takes exactly one of the two. There is no `type`
  // key, and the legacy HTTP+SSE transport is not supported, so an SSE server is not rendered. `disabled: true` suspends a server.
  mcp: {
    file: "~/.gemini/config/mcp_config.json",
    key: "mcpServers",
    transports: ["stdio", "http"],
    render: (server) =>
      server.command !== null
        ? withoutEmpty({ command: server.command[0], args: server.command.slice(1), env: server.env })
        : withoutEmpty({ serverUrl: server.url, headers: server.headers }),
    read(entry, cwd) {
      if (typeof entry.command === "string") {
        return { transport: "stdio", target: { kind: "stdio", command: [entry.command, ...(strings(entry.args) ?? [])], env: stringMap(entry.env), cwd }, credentials: false };
      }
      const url = typeof entry.serverUrl === "string" ? entry.serverUrl : entry.url;
      if (typeof url === "string") {
        const headers = stringMap(entry.headers);
        return { transport: "http", target: { kind: "network", transport: "http", url, headers }, credentials: Object.keys(headers).length > 0 };
      }
      return null;
    },
    skip: (entry) => isObject(entry) && entry.disabled === true,
  },

  // https://antigravity.google/docs/skills/ and https://antigravity.google/docs/customization-discovery : a skill is a folder
  // with a `SKILL.md`, one level below the directory. `~/.gemini/config/skills` is read by the app, the CLI and the IDE. The CLI
  // also reads the other two, which override it and are not ranked against each other. `~/.gemini/skills` is Gemini CLI's too.
  skills: {
    target: "~/.gemini/config/skills",
    dirs: ["~/.gemini/config/skills", "~/.gemini/skills", "~/.gemini/antigravity-cli/skills"],
    setting: null,
    // `description` is what the agent sees when it decides whether to use a skill, and the docs make it required.
    hidden: (meta) => typeof meta.description !== "string" || meta.description === "",
  },

  // https://antigravity.google/docs/rules/ : `GEMINI.md` and `AGENTS.md` in `~/.gemini` and `~/.gemini/config` are always on and
  // take no front matter; `~/.gemini/config/rules/*.md` are modular rules. Every rule found is loaded, none replaces another.
  // `~/.gemini/GEMINI.md` is the file Gemini CLI reads too (https://antigravity.google/docs/cli/gcli-migration), so it is where fleet links.
  // `~/.gemini/AGENTS.md` is read as well but sits outside the homes, which are only what is Antigravity's alone: fleet counts
  // it in the context an agent loads and never writes it.
  instructions: {
    files: ["~/.gemini/GEMINI.md", "~/.gemini/config/AGENTS.md", "~/.gemini/config/GEMINI.md", "~/.gemini/AGENTS.md"],
    dirs: ["~/.gemini/config/rules"],
    setting: null,
  },
};
