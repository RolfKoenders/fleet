import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { daysSince, serverOfTool, Tally, withoutSqliteWarning } from "./history.ts";
import type { HistoryRead, HistoryRequest } from "./history.ts";

/**
 * Reads opencode's history for `fleet context --usage`.
 *
 * - One SQLite database, `~/.local/share/opencode/opencode.db`; `OPENCODE_DB` replaces the path (`opencode debug paths db`
 *   prints it; https://opencode.ai/docs/cli/). It is in WAL mode, so it is opened read-only and never written.
 * - It is read with `node:sqlite` (https://nodejs.org/api/sqlite.html), imported when needed. Where it cannot be imported the
 *   agent is reported as unavailable, and so it is when the tables are not the ones below.
 * - Two schemas exist. The current one is `session_v2` and `session_message`, whose assistant messages hold `data.content[]`
 *   items `{type: "tool", name, ...}`. The legacy one is `session`, `message` and `part`, where `part.data` is
 *   `{type: "tool", tool, ...}`. The current one is used when it is there and the legacy one only when it is not, never both,
 *   because the current one holds the migrated history. Tables and columns are checked before any query.
 * - An MCP tool is `<server>_<tool>` (https://opencode.ai/docs/mcp-servers/), so the longest configured server name that
 *   is a prefix is the server. A skill the model runs is the `skill` tool, with the name in its input. A skill the user
 *   invoked is `data.skills[].name` on a user message; the message's text is never read.
 * - A session with a `parent_id` is a sub-session and is not counted.
 *
 * Only a tool's name, a skill's name, a session id and a time are read out of a row. Tool output, which holds a skill's
 * whole text, and a message's text are never looked at.
 */

type Obj = Record<string, unknown>;
const object = (v: unknown): Obj | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : null);

/** The part of `node:sqlite` that is used, so the types do not need the module. */
type Db = { prepare(sql: string): { all(...args: unknown[]): Obj[] }; close(): void };
type Sqlite = { DatabaseSync: new (path: string, options: { readOnly: boolean }) => Db };

type Schema = {
  sessions: string;
  /** The table of messages whose rows hold a user's invoked skills. */
  messages: string;
  /** The table whose rows hold the tool calls, and how to read one row's tools. */
  tools: string;
  /** Where the tool calls are in a row's data: the `content` list of a message, or the row is one part. */
  shape: "content" | "part";
};

const unavailable = (reason: string): HistoryRead => ({ ok: false, kind: "unavailable", reason });

function dbPath(request: HistoryRequest): string {
  const given = request.env.OPENCODE_DB;
  const base = join(request.home, ".local/share/opencode");
  if (given === undefined || given === "") return join(base, "opencode.db");
  return isAbsolute(given) ? given : join(base, given);
}

const tablesOf = (db: Db): Set<string> => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => String(r.name)));
const columnsOf = (db: Db, table: string): Set<string> => new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((r) => String(r.name)));

/** The schema this database has, or null when it is neither. */
function schemaOf(db: Db): Schema | null {
  const tables = tablesOf(db);
  const has = (table: string, ...columns: string[]) => tables.has(table) && columns.every((c) => columnsOf(db, table).has(c));
  if (has("session_v2", "id") && has("session_message", "session_id", "time_created", "data")) return { sessions: "session_v2", messages: "session_message", tools: "session_message", shape: "content" };
  if (has("session", "id") && has("message", "session_id", "time_created", "data") && has("part", "session_id", "time_created", "data")) return { sessions: "session", messages: "message", tools: "part", shape: "part" };
  return null;
}

/** A tool call in one row's data: its name and the one input field fleet may read. */
function toolsIn(data: Obj, shape: Schema["shape"]): { name: string; input: Obj | null }[] {
  const calls = shape === "content" ? (Array.isArray(data.content) ? data.content : []) : [data];
  return calls.flatMap((raw) => {
    const call = object(raw);
    const name = shape === "content" ? call?.name : call?.tool;
    if (call === null || call.type !== "tool" || typeof name !== "string") return [];
    return [{ name, input: object(call.input) ?? object(object(call.state)?.input) }];
  });
}

function parse(text: unknown): Obj | null {
  try {
    return typeof text === "string" ? object(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}

function readDatabase(db: Db, request: HistoryRequest): HistoryRead {
  const schema = schemaOf(db);
  if (schema === null) return unavailable("its database has tables this fleet does not recognise");
  const to = request.now.getTime();
  const from = to - request.windowDays * 86_400_000;
  const tally = new Tally(request.servers, request.skills);

  const children = new Set<string>();
  if (columnsOf(db, schema.sessions).has("parent_id")) for (const row of db.prepare(`SELECT id FROM ${schema.sessions} WHERE parent_id IS NOT NULL`).all()) children.add(String(row.id));

  const oldest = db.prepare(`SELECT MIN(time_created) AS oldest FROM ${schema.messages}`).all()[0]?.oldest;
  for (const row of db.prepare(`SELECT DISTINCT session_id FROM ${schema.messages} WHERE time_created >= ?`).all(from)) {
    if (!children.has(String(row.session_id))) tally.sessions.add(String(row.session_id));
  }

  const names = (rows: Obj[], read: (data: Obj, session: string) => void) => {
    for (const row of rows) {
      const session = String(row.session_id);
      if (children.has(session)) continue;
      const data = parse(row.data);
      if (data !== null) read(data, session);
    }
  };
  names(db.prepare(`SELECT session_id, data FROM ${schema.tools} WHERE time_created >= ? AND data LIKE '%tool%'`).all(from), (data, session) => {
    for (const { name, input } of toolsIn(data, schema.shape)) {
      if (name === "skill") {
        const given = input?.name;
        if (typeof given === "string") tally.call("skills", given, session);
      } else {
        const server = serverOfTool(name, request.servers, "_");
        if (server !== null) tally.call("servers", server, session);
      }
    }
  });
  names(db.prepare(`SELECT session_id, data FROM ${schema.messages} WHERE time_created >= ? AND data LIKE '%skills%'`).all(from), (data, session) => {
    if (!Array.isArray(data.skills)) return;
    for (const skill of data.skills) {
      const name = object(skill)?.name;
      if (typeof name === "string") tally.call("skills", name, session);
    }
  });

  const first = typeof oldest === "number" ? oldest : null;
  return { ok: true, days: Math.min(request.windowDays, daysSince(first, to)), sessions: tally.sessions.size, servers: tally.counts("servers"), skills: tally.counts("skills") };
}

export async function readOpencodeHistory(request: HistoryRequest): Promise<HistoryRead> {
  const path = dbPath(request);
  if (!existsSync(path)) {
    const none = new Tally(request.servers, request.skills);
    return { ok: true, days: 0, sessions: 0, servers: none.counts("servers"), skills: none.counts("skills") };
  }
  return withoutSqliteWarning(async () => {
    let sqlite: Sqlite;
    try {
      sqlite = (await import("node:sqlite")) as unknown as Sqlite;
    } catch {
      return unavailable("node:sqlite is not available in this version of Node");
    }
    let db: Db;
    try {
      db = new sqlite.DatabaseSync(path, { readOnly: true });
    } catch {
      return unavailable("its database cannot be opened");
    }
    try {
      return readDatabase(db, request);
    } catch {
      return unavailable("its database could not be read");
    } finally {
      db.close();
    }
  });
}
