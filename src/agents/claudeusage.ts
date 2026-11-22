import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { daysSince, serverOfTool, Tally } from "./history.ts";
import type { HistoryRead, HistoryRequest } from "./history.ts";

/**
 * Reads Claude Code's transcripts for `fleet context --usage`.
 *
 * - A session is `~/.claude/projects/<project>/<session-uuid>.jsonl`, and `CLAUDE_CONFIG_DIR` moves the tree
 *   (https://code.claude.com/docs/en/claude-directory, https://code.claude.com/docs/en/agent-sdk/sessions).
 *   A subagent's calls are in `<session-uuid>/subagents/agent-*.jsonl` and count toward the session that started it.
 *   `*.orphaned-*` and `*.superseded-*` files are copies Claude set aside, and are skipped.
 * - A call is a `tool_use` block in an `assistant` record. An MCP tool is `mcp__<server>__<tool>` (https://code.claude.com/docs/en/mcp,
 *   https://code.claude.com/docs/en/hooks); characters of a server's name outside `A-Za-z0-9_-` become `_`, so a plugin's
 *   server `plugin:p:s` is `mcp__plugin_p_s__<tool>`. A skill the model runs is the `Skill` tool, with the name in `input.skill`.
 * - A skill the user typed is a `user` record whose text begins with `<command-message>` or `<command-name>`. Only the
 *   name inside `<command-name>` is read: the text from `<command-args>` on is cut off unread.
 * - Records are filtered by their own `timestamp`, never by the file's time, because Claude rewrites a file when a session resumes.
 * - History is kept for `cleanupPeriodDays` of `settings.json`, 30 by default (https://code.claude.com/docs/en/settings).
 *
 * Lines are streamed one at a time and only a line holding `"tool_use"` or `<command-name>` is parsed; the rest
 * are dropped unread. Nothing from a parsed record is kept but a tool name, a skill name, a session id and a time.
 */

const SESSION = /^[0-9a-f-]{36}\.jsonl$/;
const SESSION_DIR = /^[0-9a-f-]{36}$/;
const SUBAGENT = /^agent-.+\.jsonl$/;
const SET_ASIDE = /\.(?:orphaned|superseded)-/;
const DEFAULT_RETENTION_DAYS = 30;
/** The first records of a file are read from its first bytes, to find when its history starts. */
const HEAD_BYTES = 65_536;
const HEAD_RECORDS = 5;
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z/;

type Obj = Record<string, unknown>;
const object = (v: unknown): Obj | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : null);

const entries = (dir: string): string[] => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};

/** The time of a record, in ms, or null when it is not a plain time. */
function timeOf(value: unknown): number | null {
  if (typeof value !== "string" || !STAMP.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** The first `"timestamp":"..."` in a line, found without parsing it. Used only to know whether a session is active in the window. */
function stamp(line: string): number | null {
  const at = line.indexOf('"timestamp":"');
  return at < 0 ? null : timeOf(line.slice(at + 13, at + 13 + 30).split('"')[0]);
}

/** When a file's history starts: the time of its first record that has one. */
function startOf(file: string): number | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    const lines = buffer.toString("utf8", 0, read).split("\n").slice(0, HEAD_RECORDS);
    for (const line of lines) {
      try {
        const at = timeOf(object(JSON.parse(line))?.timestamp);
        if (at !== null) return at;
      } catch {
        // a cut line, or not a record
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Every session id with its main file and its subagents' files, below `projects`. */
function sessionFiles(projects: string): Map<string, string[]> {
  const sessions = new Map<string, string[]>();
  const add = (id: string, file: string) => sessions.set(id, [...(sessions.get(id) ?? []), file]);
  for (const project of entries(projects)) {
    const dir = join(projects, project);
    for (const name of entries(dir)) {
      if (SET_ASIDE.test(name)) continue;
      if (SESSION.test(name)) add(name.slice(0, -".jsonl".length), join(dir, name));
      else if (SESSION_DIR.test(name)) {
        for (const sub of entries(join(dir, name, "subagents"))) if (SUBAGENT.test(sub) && !SET_ASIDE.test(sub)) add(name, join(dir, name, "subagents", sub));
      }
    }
  }
  return sessions;
}

function retentionDays(configDir: string): number {
  try {
    const days = object(JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")))?.cleanupPeriodDays;
    return typeof days === "number" && Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS;
  } catch {
    return DEFAULT_RETENTION_DAYS;
  }
}

/** The name of a skill as the model passes it: a plugin's skill is `plugin:name`, and fleet knows the part after the colon. */
const skillNamed = (given: string, known: Tally): string | null => [given, given.slice(given.lastIndexOf(":") + 1)].find((n) => known.has("skills", n)) ?? null;

type Window = { from: number; to: number };

/** Counts the tool calls of one `assistant` record. `seen` holds the ids of calls already counted, so a record copied into a resumed or forked session is not counted twice. */
function countTools(line: string, session: string, window: Window, tally: Tally, servers: string[], seen: Set<string>): void {
  let record: Obj | null;
  try {
    record = object(JSON.parse(line));
  } catch {
    return;
  }
  const at = timeOf(record?.timestamp);
  if (record === null || record.type !== "assistant" || at === null || at < window.from || at > window.to) return;
  const content = object(record.message)?.content;
  if (!Array.isArray(content)) return;
  for (const raw of content) {
    const block = object(raw);
    if (block === null || block.type !== "tool_use" || typeof block.name !== "string") continue;
    if (typeof block.id === "string") {
      if (seen.has(block.id)) continue;
      seen.add(block.id);
    }
    if (block.name.startsWith("mcp__")) {
      const server = serverOfTool(block.name.slice("mcp__".length), servers, "__");
      if (server !== null) tally.call("servers", server, session);
    } else if (block.name === "Skill") {
      const given = object(block.input)?.skill;
      const name = typeof given === "string" ? skillNamed(given, tally) : null;
      if (name !== null) tally.call("skills", name, session);
    }
  }
}

/** Counts a skill the user typed, from the name in `<command-name>` alone. The arguments are cut off before anything is matched. */
function countTyped(line: string, session: string, window: Window, tally: Tally): void {
  let record: Obj | null;
  try {
    record = object(JSON.parse(line));
  } catch {
    return;
  }
  const at = timeOf(record?.timestamp);
  if (record === null || record.type !== "user" || at === null || at < window.from || at > window.to) return;
  const content = object(record.message)?.content;
  const first = Array.isArray(content) ? object(content.find((b) => object(b)?.type === "text"))?.text : content;
  if (typeof first !== "string" || !/^\s*<command-(?:message|name)>/.test(first)) return;
  const cut = first.indexOf("<command-args>");
  const head = cut < 0 ? first : first.slice(0, cut);
  const name = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(head)?.[1];
  const known = name === undefined ? null : skillNamed(name, tally);
  if (known !== null) tally.call("skills", known, session);
}

/** The latest time seen in a file, so the caller knows whether its session was active in the window. */
async function scan(file: string, session: string, window: Window, tally: Tally, servers: string[], seen: Set<string>): Promise<number | null> {
  let latest: number | null = null;
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const at = stamp(line);
      if (at !== null && at <= window.to && (latest === null || at > latest)) latest = at;
      if (line.includes('"tool_use"')) countTools(line, session, window, tally, servers, seen);
      if (line.includes("<command-name>")) countTyped(line, session, window, tally);
    }
  } catch {
    // a file that cannot be read counts for nothing
  }
  return latest;
}

export async function readClaudeHistory(request: HistoryRequest): Promise<HistoryRead> {
  const configDir = request.env.CLAUDE_CONFIG_DIR !== undefined && request.env.CLAUDE_CONFIG_DIR !== "" ? request.env.CLAUDE_CONFIG_DIR : join(request.home, ".claude");
  const to = request.now.getTime();
  const window: Window = { from: to - request.windowDays * 86_400_000, to: to + 86_400_000 };
  const tally = new Tally(request.servers, request.skills);
  const seen = new Set<string>();
  let oldest: number | null = null;

  for (const [session, files] of sessionFiles(join(configDir, "projects"))) {
    for (const file of files) {
      const start = startOf(file);
      if (start !== null && start <= to && (oldest === null || start < oldest)) oldest = start;
      let modified: number;
      try {
        modified = statSync(file).mtimeMs;
      } catch {
        continue;
      }
      // A file not written since before the window holds nothing in it.
      if (modified < window.from) continue;
      const latest = await scan(file, session, window, tally, request.servers, seen);
      if (latest !== null && latest >= window.from) tally.sessions.add(session);
    }
  }

  const days = Math.min(request.windowDays, retentionDays(configDir), daysSince(oldest, to));
  return { ok: true, days, sessions: tally.sessions.size, servers: tally.counts("servers"), skills: tally.counts("skills") };
}
