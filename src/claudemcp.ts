import { spawnSync } from "node:child_process";
import { chmodSync, statSync } from "node:fs";
import { MissingToolError } from "./git.ts";
import { readBack, readDoc } from "./keys.ts";
import type { KeyChange } from "./keys.ts";
import { CLAUDE_JSON } from "./mcp.ts";
import { expandTarget } from "./plan.ts";
import { firstLine } from "./sops.ts";
import type { KeyRecord } from "./state.ts";
import { findTool } from "./tools.ts";
import { isObject } from "./yamlfile.ts";

// Claude rewrites `~/.claude.json` constantly, so fleet's entries go in and out through `claude mcp` only.
const PREFIX = "mcpServers.";

export const isClaudeServer = (key: { file: string }): boolean => key.file === CLAUDE_JSON;

export const serverName = (key: { path: string }): string => key.path.slice(PREFIX.length);

export function findClaude(home: string): string {
  const path = findTool("claude", process.env, home);
  if (path === null) throw new MissingToolError("claude is not installed; it writes the MCP servers in ~/.claude.json");
  return path;
}

function claudeMcp(claude: string, home: string, args: string[]) {
  return spawnSync(claude, ["mcp", ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
}

export function removeServer(claude: string, home: string, key: { path: string }): void {
  const name = serverName(key);
  const r = claudeMcp(claude, home, ["remove", "--scope", "user", name]);
  if (r.status !== 0) throw new Error(`claude mcp remove ${name} failed: ${firstLine(r.stderr ?? "")}`);
}

/**
 * Adds one server and returns its record, with `actual` read back from the file. The entry holds
 * secrets, so a failure reports the exit status and nothing `claude` printed.
 */
export function addServer(claude: string, home: string, change: KeyChange): KeyRecord {
  const name = serverName(change);
  const r = claudeMcp(claude, home, ["add-json", "--scope", "user", name, JSON.stringify(change.value)]);
  if (r.status !== 0) throw new Error(`claude mcp add-json ${name} failed with exit status ${r.status}`);
  return readBack(CLAUDE_JSON, [change], home)[0]!;
}

/** The file holds tokens. Whatever mode Claude left it in, it ends up readable by this user only. */
export function ensurePrivate(home: string): void {
  const path = expandTarget(CLAUDE_JSON, home);
  try {
    if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Names of the projects whose own `mcpServers` define a server with the same name as a picked one. */
export function shadowWarnings(names: string[], home: string): string[] {
  const read = readDoc(expandTarget(CLAUDE_JSON, home));
  if ("problem" in read || !isObject(read.doc.projects)) return [];
  const warnings: string[] = [];
  for (const [project, entry] of Object.entries(read.doc.projects)) {
    if (!isObject(entry) || !isObject(entry.mcpServers)) continue;
    for (const name of names) {
      if (Object.hasOwn(entry.mcpServers, name)) {
        warnings.push(`project ${project} defines its own '${name}' server, which takes precedence over fleet's there`);
      }
    }
  }
  return warnings;
}
