import { MCP_URL_CREDENTIALS, URL_SPACE, urlHoldsCredentials } from "./redact.ts";
import { dirname, join } from "node:path";
import { SETTINGS_FILE } from "./settings.ts";
import type { DesiredKey, Tool } from "./settings.ts";
import { fillVars, hasSecretRef } from "./template.ts";
import { isObject, isStringList, parseFile } from "./yamlfile.ts";
import type { Overlay } from "./yamlfile.ts";
import type { Obj } from "./yamlfile.ts";

/** Where Claude keeps its user-scope servers. Fleet writes its entries holding Claude's lock; see `claudemcp.ts`. */
export const CLAUDE_JSON = "~/.claude.json";

const SERVER_PATH: Record<Tool, string> = { claude: "mcpServers", opencode: "mcp" };
const SERVER_FILE: Record<Tool, string> = { claude: CLAUDE_JSON, opencode: SETTINGS_FILE.opencode };

export type Server = {
  name: string;
  /** Stdio: program and arguments. Null for a network server. */
  command: string[] | null;
  env: Record<string, string>;
  /** Network: `http` or `sse`. Null for a stdio server. */
  transport: "http" | "sse" | null;
  url: string | null;
  headers: Record<string, string>;
  only: Tool[];
};

const SERVER_KEYS = ["command", "env", "transport", "url", "headers", "only"];
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const TOOLS: Tool[] = ["claude", "opencode"];

const isStringMap = (v: unknown): v is Record<string, string> => isObject(v) && Object.values(v).every((x) => typeof x === "string");

function parseServer(at: string, name: string, raw: unknown, problems: string[]): Server | null {
  if (!SERVER_NAME.test(name)) {
    problems.push(`${at}: server name '${name}' must be letters, digits, '_' or '-', and start with a letter or digit`);
    return null;
  }
  if (!isObject(raw)) {
    problems.push(`${at}: server '${name}' must be a map`);
    return null;
  }
  const where = `${at}: server '${name}'`;
  const before = problems.length;
  for (const key of Object.keys(raw)) {
    if (!SERVER_KEYS.includes(key)) problems.push(`${where}: unknown key '${key}'`);
  }
  const { command, env, transport, url, headers, only } = raw;

  if ((command === undefined) === (transport === undefined)) {
    problems.push(`${where}: needs exactly one of 'command' (stdio) or 'transport' (network)`);
  } else if (command !== undefined) {
    if (!isStringList(command) || command.length === 0 || command[0] === "") problems.push(`${where}: 'command' must be a list of strings, program first`);
    else if (command.some(hasSecretRef)) problems.push(`${where}: 'command' cannot refer to a secret, a command line is visible to every user; use 'env'`);
    for (const key of ["url", "headers"]) if (raw[key] !== undefined) problems.push(`${where}: '${key}' belongs to a network server`);
  } else {
    if (transport !== "http" && transport !== "sse") problems.push(`${where}: 'transport' must be http or sse`);
    if (typeof url !== "string" || url === "") problems.push(`${where}: a network server needs a 'url'`);
    // A `{{ vars.NAME }}` has spaces of its own: they are not the URL's.
    else if (/[\u0000-\u0020\u007f]/.test(url.replace(/\{\{[^}]*\}\}/g, ""))) problems.push(`${where}: ${URL_SPACE}`);
    else if (urlHoldsCredentials(url)) problems.push(`${where}: ${MCP_URL_CREDENTIALS}`);
    if (env !== undefined) problems.push(`${where}: 'env' belongs to a stdio server`);
  }
  for (const [key, value] of [["env", env], ["headers", headers]] as const) {
    if (value !== undefined && !isStringMap(value)) problems.push(`${where}: '${key}' must be a map of strings`);
  }
  if (only !== undefined && (!isStringList(only) || only.length === 0 || only.some((t) => !TOOLS.includes(t as Tool)))) {
    problems.push(`${where}: 'only' must be a list of claude, opencode`);
  }
  if (problems.length > before) return null;
  return {
    name,
    command: (command as string[] | undefined) ?? null,
    env: (env as Record<string, string> | undefined) ?? {},
    transport: (transport as "http" | "sse" | undefined) ?? null,
    url: (url as string | undefined) ?? null,
    headers: (headers as Record<string, string> | undefined) ?? {},
    only: (only as Tool[] | undefined) ?? TOOLS,
  };
}

export function parseMcpCatalog(configDir: string, problems: string[], overlay?: Overlay): Map<string, Server> {
  const path = join(configDir, "catalog/mcp.yaml");
  const servers = new Map<string, Server>();
  const doc = parseFile(path, true, problems, overlay);
  if (doc === null) return servers;
  for (const key of Object.keys(doc)) {
    if (key !== "servers") problems.push(`${path}: unknown key '${key}'`);
  }
  if (doc.servers === undefined) return servers;
  if (!isObject(doc.servers)) {
    problems.push(`${path}: 'servers' must be a map`);
    return servers;
  }
  for (const [name, raw] of Object.entries(doc.servers)) {
    const server = parseServer(path, name, raw, problems);
    if (server) servers.set(name, server);
  }
  return servers;
}

/** The server with `{{ vars.NAME }}` filled in. Names with no value are returned in `unknown`. */
function fillServer(server: Server, vars: Record<string, string>): { server: Server; unknown: string[] } {
  const { value, unknown } = fillVars({ command: server.command, env: server.env, url: server.url, headers: server.headers }, vars);
  return { server: { ...server, ...(value as Pick<Server, "command" | "env" | "url" | "headers">) }, unknown };
}

export const withoutEmpty = (entry: Obj): Obj =>
  Object.fromEntries(Object.entries(entry).filter(([, v]) => !(Array.isArray(v) ? v.length === 0 : isObject(v) && Object.keys(v).length === 0)));

/**
 * Program, arguments and environment as the server runs them. A first element of `npx` becomes
 * the `npx` beside Node, with a `PATH` that finds that Node, because a GUI-launched tool has no fnm.
 */
function launch(command: string[], env: Record<string, string>, node: string): { command: string[]; env: Record<string, string> } {
  if (command[0] !== "npx") return { command, env };
  const bin = dirname(node);
  return { command: [join(bin, "npx"), ...command.slice(1)], env: { ...env, PATH: `${bin}:/usr/local/bin:/usr/bin:/bin` } };
}

export function renderFor(tool: Tool, server: Server, node: string): Obj {
  if (server.command !== null) {
    const { command, env } = launch(server.command, server.env, node);
    return tool === "claude"
      ? withoutEmpty({ type: "stdio", command: command[0], args: command.slice(1), env })
      : withoutEmpty({ type: "local", command, environment: env });
  }
  return withoutEmpty({ type: tool === "claude" ? server.transport : "remote", url: server.url, headers: server.headers });
}

/**
 * The owned keys for the picked servers: one per server per tool it renders to. Variables are
 * filled here and problems reported; `secret:NAME` is left for the secrets step.
 */
export function mcpKeys(servers: Server[], vars: Record<string, string>, node: string, problems: string[]): DesiredKey[] {
  const keys: DesiredKey[] = [];
  for (const picked of servers) {
    const { server, unknown } = fillServer(picked, vars);
    for (const name of unknown) problems.push(`catalog/mcp.yaml: server '${server.name}': {{ vars.${name} }} is not defined in any 'vars'`);
    for (const tool of server.only) {
      keys.push({ file: SERVER_FILE[tool], path: `${SERVER_PATH[tool]}.${server.name}`, value: renderFor(tool, server, node) });
    }
  }
  return keys;
}
