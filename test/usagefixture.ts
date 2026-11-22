import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Fixtures for the usage tests. Every name here is made up. The `SECRET_*` strings stand for what a real transcript
 * holds besides names and times (a prompt, a tool's input, a tool's result, the text after a typed command); the tests
 * look for them in everything fleet prints, returns and writes, and must never find one.
 */

export const NOW = new Date("2026-11-22T12:00:00Z");
export const DAY = 86_400_000;

export const SECRET_PROMPT = "ZZ-FAKE-PROMPT-7731 my private plan for the quarter";
export const SECRET_INPUT = "ZZ-FAKE-TOOL-INPUT-4412";
export const SECRET_RESULT = "ZZ-FAKE-TOOL-RESULT-9083";
export const SECRET_ARGS = "ZZ-FAKE-COMMAND-ARGS-5520";
export const SECRETS = [SECRET_PROMPT, SECRET_INPUT, SECRET_RESULT, SECRET_ARGS, "ZZ-FAKE"];

export const agoIso = (days: number, now: Date = NOW): string => new Date(now.getTime() - days * DAY).toISOString();

export const uuid = (n: number): string => `${String(n).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Rec = Record<string, unknown>;

/** An assistant record with one tool call per `tools` entry: its name, and an input that holds a made-up secret. */
export const assistant = (days: number, tools: { name: string; input?: Rec; id?: string }[], now?: Date): Rec => ({
  type: "assistant",
  timestamp: agoIso(days, now),
  message: { role: "assistant", content: [{ type: "text", text: SECRET_PROMPT }, ...tools.map((t, i) => ({ type: "tool_use", id: t.id ?? `toolu_${Math.random().toString(36).slice(2)}${i}`, name: t.name, input: t.input ?? { query: SECRET_INPUT } }))] },
});

/** A user record that is a typed command, with arguments that hold a made-up secret. */
export const typed = (days: number, name: string, args: string = SECRET_ARGS, now?: Date): Rec => ({
  type: "user",
  timestamp: agoIso(days, now),
  message: { role: "user", content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>` },
});

/** A user record that is a prompt, and a tool result: no name in either. */
export const prompt = (days: number, now?: Date): Rec => ({ type: "user", timestamp: agoIso(days, now), message: { role: "user", content: SECRET_PROMPT } });
export const result = (days: number, now?: Date): Rec => ({ type: "user", timestamp: agoIso(days, now), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: SECRET_RESULT }] } });

/** Writes JSON lines to `file` and sets its time, which the reader may skip a file by. */
export function writeLines(file: string, records: Rec[], modified: Date = NOW): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  utimesSync(file, modified, modified);
}

export const claudeSession = (home: string, id: string, records: Rec[], project = "-work-demo", modified?: Date): string => {
  const file = join(home, ".claude/projects", project, `${id}.jsonl`);
  writeLines(file, records, modified);
  return file;
};

// ---- opencode ----

export type Db = DatabaseSync;

export const opencodeDbPath = (home: string): string => join(home, ".local/share/opencode/opencode.db");

export function openOpencode(home: string, path: string = opencodeDbPath(home)): Db {
  mkdirSync(dirname(path), { recursive: true });
  return new DatabaseSync(path);
}

/** The current schema: `session_v2` and `session_message`, with the tool calls in the message's `content`. */
export function currentSchema(db: Db): void {
  db.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT)");
  db.exec("CREATE TABLE session_message (id INTEGER PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)");
}

/** The legacy schema: `session`, `message` and `part`, with a tool call in a part. */
export function legacySchema(db: Db): void {
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT)");
  db.exec("CREATE TABLE message (id INTEGER PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)");
  db.exec("CREATE TABLE part (id INTEGER PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)");
}

export const addSession = (db: Db, table: string, id: string, parent: string | null = null): void => void db.prepare(`INSERT INTO ${table} (id, parent_id) VALUES (?, ?)`).run(id, parent);
export const addRow = (db: Db, table: string, session: string, days: number, data: Rec, now: Date = NOW): void =>
  void db.prepare(`INSERT INTO ${table} (session_id, time_created, data) VALUES (?, ?, ?)`).run(session, now.getTime() - days * DAY, JSON.stringify(data));

/** A current-schema assistant message holding tool calls, with an input and an output that hold made-up secrets. */
export const toolMessage = (...names: [name: string, input?: Rec][]): Rec => ({
  role: "assistant",
  content: [{ type: "text", text: SECRET_PROMPT }, ...names.map(([name, input]) => ({ type: "tool", name, input: input ?? { query: SECRET_INPUT }, output: SECRET_RESULT }))],
});

/** A tool call the way opencode writes it in the current schema: its input under `state`, with its output beside it. */
export const toolMessageAsWritten = (name: string, input: Rec): Rec => ({
  content: [{ type: "tool", id: "call-1", name, executed: true, state: { status: "completed", input, content: [{ type: "text", text: SECRET_RESULT }], metadata: { name: "Review", directory: "/x" } } }],
});

/** A legacy part for one tool call. */
export const toolPart = (tool: string, input: Rec = { query: SECRET_INPUT }): Rec => ({ type: "tool", tool, state: { status: "completed", input, output: SECRET_RESULT } });

export const userMessage = (...skills: string[]): Rec => ({ role: "user", text: SECRET_PROMPT, skills: skills.map((name) => ({ name, text: SECRET_ARGS })) });
