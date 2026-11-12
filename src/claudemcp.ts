import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmdirSync, statSync } from "node:fs";
import { MissingToolError } from "./git.ts";
import { readDoc, writeKeys } from "./keys.ts";
import type { KeyChange } from "./keys.ts";
import { CLAUDE_JSON } from "./mcp.ts";
import { expandTarget } from "./plan.ts";
import { firstLine } from "./sops.ts";
import type { KeyRecord } from "./state.ts";
import { findTool } from "./tools.ts";
import { isObject } from "./yamlfile.ts";

// Claude rewrites `~/.claude.json` constantly. Every Claude process writes it holding `~/.claude.json.lock`, a
// directory, and reads the file again inside it; fleet's own write takes the same lock. A removal still goes
// through `claude mcp remove`, which carries no secret.
const PREFIX = "mcpServers.";
const LOCK_WAIT_MS = 5000;
/** A lock this old was left by a process that died: a writer holds it for milliseconds. */
const LOCK_STALE_MS = 10_000;

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

const sleep = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Runs `write` holding Claude's own lock on `~/.claude.json`, as `claude mcp` does around its writes. */
function withClaudeLock<T>(home: string, write: () => T): T {
  const lock = `${expandTarget(CLAUDE_JSON, home)}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // released between the two calls
      }
      if (age > LOCK_STALE_MS) {
        rmdirSync(lock);
        continue;
      }
      if (Date.now() > deadline) throw new Error(`${CLAUDE_JSON} is locked by a running Claude; apply again in a moment`);
      sleep(50);
    }
  }
  try {
    return write();
  } finally {
    rmdirSync(lock);
  }
}

/**
 * Adds or replaces one server in `~/.claude.json` and returns its record, with `actual` read back from the
 * file. It is written by fleet, not by `claude mcp add-json`: that command takes the entry, secrets and all,
 * as an argument, where any user on the host can read it.
 */
export function addServer(home: string, change: KeyChange): KeyRecord {
  return withClaudeLock(home, () => writeKeys(CLAUDE_JSON, [], [change], home)[0]!);
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
