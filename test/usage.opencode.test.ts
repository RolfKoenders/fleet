import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { antigravity } from "../src/agents/antigravity.ts";
import type { HistoryRead, HistoryRequest } from "../src/agents/history.ts";
import { withoutSqliteWarning } from "../src/agents/history.ts";
import { readOpencodeHistory } from "../src/agents/opencodeusage.ts";
import { makeHome } from "./helpers.ts";
import { addRow, addSession, currentSchema, legacySchema, NOW, openOpencode, SECRETS, toolMessage, toolMessageAsWritten, toolPart, userMessage } from "./usagefixture.ts";

const request = (home: string, over: Partial<HistoryRequest> = {}): HistoryRequest => ({ home, env: {}, now: NOW, windowDays: 30, servers: ["tracker", "notes"], skills: ["review", "debug"], ...over });
const read = async (home: string, over: Partial<HistoryRequest> = {}): Promise<Extract<HistoryRead, { ok: true }>> => {
  const r = await readOpencodeHistory(request(home, over));
  assert.ok(r.ok, JSON.stringify(r));
  return r;
};
const callsOf = (r: Extract<HistoryRead, { ok: true }>, kind: "servers" | "skills", name: string) => r[kind].find((c) => c.name === name)!;

test("opencode: the current schema: tool calls in a message's content, counted per server and skill, with the sessions", async () => {
  const home = makeHome();
  const db = openOpencode(home);
  currentSchema(db);
  addSession(db, "session_v2", "s1");
  addSession(db, "session_v2", "s2");
  addRow(db, "session_message", "s1", 2, toolMessage(["tracker_list"], ["tracker_get"], ["notes_find"], ["bash"]));
  addRow(db, "session_message", "s1", 2, toolMessage(["skill", { name: "review" }], ["skill", { name: "unknown" }]));
  addRow(db, "session_message", "s2", 1, toolMessage(["tracker_list"]));
  addRow(db, "session_message", "s2", 1, userMessage("debug"));
  db.close();
  const r = await read(home);
  assert.deepEqual(callsOf(r, "servers", "tracker"), { name: "tracker", calls: 3, sessions: 2 });
  assert.deepEqual(callsOf(r, "servers", "notes"), { name: "notes", calls: 1, sessions: 1 });
  assert.deepEqual(callsOf(r, "skills", "review"), { name: "review", calls: 1, sessions: 1 });
  assert.deepEqual(callsOf(r, "skills", "debug"), { name: "debug", calls: 1, sessions: 1 }, "a skill the user invoked counts");
  assert.equal(r.skills.length, 2);
  assert.equal(r.sessions, 2);
});

test("opencode: the current schema names a skill the model ran in state.input.id, as opencode writes it", async () => {
  const home = makeHome();
  const db = openOpencode(home);
  currentSchema(db);
  addSession(db, "session_v2", "s1");
  addRow(db, "session_message", "s1", 2, toolMessageAsWritten("skill", { id: "review" }));
  db.close();
  const r = await read(home);
  assert.deepEqual(callsOf(r, "skills", "review"), { name: "review", calls: 1, sessions: 1 });
});

test("opencode: the legacy schema: tool calls in parts, and invoked skills on messages", async () => {
  const home = makeHome();
  const db = openOpencode(home);
  legacySchema(db);
  addSession(db, "session", "s1");
  addRow(db, "part", "s1", 3, toolPart("tracker_list"));
  addRow(db, "part", "s1", 3, toolPart("skill", { name: "review" }));
  addRow(db, "part", "s1", 3, toolPart("webfetch"));
  addRow(db, "message", "s1", 3, userMessage("debug"));
  db.close();
  const r = await read(home);
  assert.equal(callsOf(r, "servers", "tracker").calls, 1);
  assert.equal(callsOf(r, "skills", "review").calls, 1);
  assert.equal(callsOf(r, "skills", "debug").calls, 1);
  assert.equal(r.sessions, 1);
});

test("opencode: when both schemas are there the current one is read and the legacy one never", async () => {
  const home = makeHome();
  const db = openOpencode(home);
  currentSchema(db);
  legacySchema(db);
  addSession(db, "session_v2", "s1");
  addSession(db, "session", "old");
  addRow(db, "session_message", "s1", 1, toolMessage(["tracker_list"]));
  addRow(db, "part", "old", 1, toolPart("tracker_list"));
  db.close();
  const r = await read(home);
  assert.deepEqual(callsOf(r, "servers", "tracker"), { name: "tracker", calls: 1, sessions: 1 });
});

test("opencode: the longest configured server name that is a prefix wins, since tool names hold underscores too", async () => {
  const home = makeHome();
  const db = openOpencode(home);
  currentSchema(db);
  addSession(db, "session_v2", "s1");
  addRow(db, "session_message", "s1", 1, toolMessage(["my_tracker_list_all"], ["my_other"], ["mytracker"], ["plugin_acme_search_find"]));
  db.close();
  const r = await read(home, { servers: ["my", "my_tracker", "plugin:acme:search"] });
  assert.equal(callsOf(r, "servers", "my_tracker").calls, 1);
  assert.equal(callsOf(r, "servers", "my").calls, 1, "only my_other: 'mytracker' has no underscore after the name");
  assert.equal(callsOf(r, "servers", "plugin:acme:search").calls, 1);
});

test("opencode: sub-sessions are not counted, and rows outside the window are skipped", async () => {
  const home = makeHome();
  const db = openOpencode(home);
  currentSchema(db);
  addSession(db, "session_v2", "top");
  addSession(db, "session_v2", "child", "top");
  addSession(db, "session_v2", "ancient");
  addRow(db, "session_message", "top", 1, toolMessage(["tracker_list"]));
  addRow(db, "session_message", "child", 1, toolMessage(["tracker_list"], ["tracker_get"]));
  addRow(db, "session_message", "top", 40, toolMessage(["tracker_list"]));
  addRow(db, "session_message", "ancient", 45, toolMessage(["tracker_list"]));
  db.close();
  const r = await read(home);
  assert.deepEqual(callsOf(r, "servers", "tracker"), { name: "tracker", calls: 1, sessions: 1 });
  assert.equal(r.sessions, 1);
  assert.equal(r.days, 30, "45 days of history, at most the window");
});

test("opencode: how much history there is, and OPENCODE_DB moves the database", async () => {
  const home = makeHome();
  const path = join(home, "elsewhere/other.db");
  const db = openOpencode(home, path);
  currentSchema(db);
  addSession(db, "session_v2", "s1");
  addRow(db, "session_message", "s1", 9, toolMessage(["tracker_list"]));
  db.close();
  const r = await read(home, { env: { OPENCODE_DB: path } });
  assert.equal(r.days, 9);
  assert.equal(callsOf(r, "servers", "tracker").calls, 1);
  const none = await read(home);
  assert.equal(none.days, 0, "no database is no history, and not an error");
  assert.equal(none.sessions, 0);
});

test("opencode: a database with tables it does not recognise is unavailable, and so is one with a missing column", async () => {
  const home = makeHome();
  const db = openOpencode(home);
  db.exec("CREATE TABLE unrelated (id TEXT)");
  db.close();
  const r = await readOpencodeHistory(request(home));
  assert.deepEqual(r, { ok: false, kind: "unavailable", reason: "its database has tables this fleet does not recognise" });

  const other = makeHome();
  const db2 = openOpencode(other);
  db2.exec("CREATE TABLE session_v2 (id TEXT)");
  db2.exec("CREATE TABLE session_message (session_id TEXT, data TEXT)");
  db2.close();
  assert.equal((await readOpencodeHistory(request(other))).ok, false);
});

test("opencode: a file that is not a database is unavailable, not an error", async () => {
  const home = makeHome();
  mkdirSync(join(home, ".local/share/opencode"), { recursive: true });
  (await import("node:fs")).writeFileSync(join(home, ".local/share/opencode/opencode.db"), "this is not sqlite ".repeat(100));
  const r = await readOpencodeHistory(request(home));
  assert.equal(r.ok, false);
  assert.equal(r.ok ? "" : r.kind, "unavailable");
});

test("opencode: it opens the database read-only and leaves it as it was", async () => {
  const home = makeHome();
  const db = openOpencode(home);
  currentSchema(db);
  addSession(db, "session_v2", "s1");
  addRow(db, "session_message", "s1", 1, toolMessage(["tracker_list"]));
  db.close();
  const { readFileSync } = await import("node:fs");
  const before = readFileSync(join(home, ".local/share/opencode/opencode.db"));
  await read(home);
  assert.ok(readFileSync(join(home, ".local/share/opencode/opencode.db")).equals(before));
});

test("opencode: nothing but names and counts comes back", async () => {
  const home = makeHome();
  const db = openOpencode(home);
  currentSchema(db);
  addSession(db, "session_v2", "s1");
  addRow(db, "session_message", "s1", 1, toolMessage(["tracker_list"], ["skill", { name: "review" }]));
  addRow(db, "session_message", "s1", 1, userMessage("debug"));
  db.close();
  const text = JSON.stringify(await read(home));
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `${secret} is not in what the reader returns`);
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["days", "ok", "servers", "sessions", "skills"]);
});

test("sqlite's ExperimentalWarning is dropped only while the database is read, and every other warning goes through", async () => {
  const seen: string[] = [];
  const original = process.emitWarning;
  process.emitWarning = ((w: string | Error, type?: unknown) => void seen.push(`${typeof w === "string" ? w : w.message}|${String(type)}`)) as typeof process.emitWarning;
  try {
    await withoutSqliteWarning(async () => {
      process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
      process.emitWarning("something else is experimental", "ExperimentalWarning");
      process.emitWarning("a plain warning");
    });
    process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
  } finally {
    process.emitWarning = original;
  }
  assert.deepEqual(seen, ["something else is experimental|ExperimentalWarning", "a plain warning|undefined", "SQLite is an experimental feature and might change at any time|ExperimentalWarning"]);
});

test("antigravity: its conversations are an undocumented binary format, so it reports no readable history and reads nothing", async () => {
  const r = await antigravity.usage!.read(request(makeHome()));
  assert.deepEqual(r, { ok: false, kind: "none", reason: "no readable history" });
});
