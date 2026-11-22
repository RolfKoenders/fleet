import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readClaudeHistory } from "../src/agents/claudeusage.ts";
import type { HistoryRead, HistoryRequest } from "../src/agents/history.ts";
import { makeHome } from "./helpers.ts";
import { assistant, claudeSession, NOW, prompt, result, SECRETS, typed, uuid, writeLines } from "./usagefixture.ts";

const read = async (home: string, over: Partial<HistoryRequest> = {}): Promise<Extract<HistoryRead, { ok: true }>> => {
  const r = await readClaudeHistory({ home, env: {}, now: NOW, windowDays: 30, servers: ["tracker", "notes"], skills: ["review", "debug"], ...over });
  assert.ok(r.ok, "the history is read");
  return r;
};
const callsOf = (r: Extract<HistoryRead, { ok: true }>, kind: "servers" | "skills", name: string) => r[kind].find((c) => c.name === name)!;

test("claude: MCP calls are counted per server, with the sessions that made them, and a server never called is there with 0", async () => {
  const home = makeHome();
  claudeSession(home, uuid(1), [prompt(2), assistant(2, [{ name: "mcp__tracker__list" }, { name: "mcp__tracker__get" }, { name: "mcp__notes__find" }]), result(2)]);
  claudeSession(home, uuid(2), [assistant(1, [{ name: "mcp__tracker__list" }, { name: "Bash" }, { name: "mcp__unknown__thing" }])]);
  const r = await read(home, { servers: ["tracker", "notes", "idle"] });
  assert.deepEqual(callsOf(r, "servers", "tracker"), { name: "tracker", calls: 3, sessions: 2 });
  assert.deepEqual(callsOf(r, "servers", "notes"), { name: "notes", calls: 1, sessions: 1 });
  assert.deepEqual(callsOf(r, "servers", "idle"), { name: "idle", calls: 0, sessions: 0 });
  assert.equal(r.servers.length, 3, "a server fleet does not know is not kept");
  assert.equal(r.sessions, 2);
});

test("claude: a plugin's server is matched by its configured name with the characters Claude replaces", async () => {
  const home = makeHome();
  claudeSession(home, uuid(1), [assistant(1, [{ name: "mcp__plugin_acme_search__find" }, { name: "mcp__a_b__x" }, { name: "mcp__a__y" }])]);
  const r = await read(home, { servers: ["plugin:acme:search", "a", "a_b"] });
  assert.equal(callsOf(r, "servers", "plugin:acme:search").calls, 1);
  assert.equal(callsOf(r, "servers", "a_b").calls, 1, "the longest name that matches wins");
  assert.equal(callsOf(r, "servers", "a").calls, 1);
});

test("claude: the Skill tool counts for the skill, a plugin's skill by the part after the colon, and an unknown skill not at all", async () => {
  const home = makeHome();
  claudeSession(home, uuid(1), [assistant(1, [{ name: "Skill", input: { skill: "review" } }, { name: "Skill", input: { skill: "acme:debug" } }, { name: "Skill", input: { skill: "other" } }, { name: "Skill", input: { args: SECRETS[0] } }])]);
  const r = await read(home);
  assert.equal(callsOf(r, "skills", "review").calls, 1);
  assert.equal(callsOf(r, "skills", "debug").calls, 1);
  assert.equal(r.skills.length, 2);
});

test("claude: a typed /name counts when fleet knows the skill, never reads its arguments, and a built-in does not count", async () => {
  const home = makeHome();
  claudeSession(home, uuid(1), [
    typed(1, "review"),
    typed(1, "compact"),
    // The arguments name a skill too; they are cut off before anything is matched.
    typed(1, "compact", "<command-name>/debug</command-name> and then some"),
    { type: "user", timestamp: new Date(NOW.getTime() - 3600_000).toISOString(), message: { role: "user", content: [{ type: "text", text: "<command-name>/debug</command-name>\n<command-args>x</command-args>" }] } },
  ]);
  const r = await read(home);
  assert.equal(callsOf(r, "skills", "review").calls, 1);
  assert.equal(callsOf(r, "skills", "debug").calls, 1, "only the one whose name is outside the arguments");
});

test("claude: a subagent's calls count toward the session that started it, which is one session", async () => {
  const home = makeHome();
  const main = claudeSession(home, uuid(1), [assistant(1, [{ name: "mcp__tracker__list" }])]);
  writeLines(join(main, "..", uuid(1), "subagents", "agent-ab12.jsonl"), [assistant(1, [{ name: "mcp__tracker__list" }, { name: "mcp__notes__find" }])]);
  const r = await read(home);
  assert.deepEqual(callsOf(r, "servers", "tracker"), { name: "tracker", calls: 2, sessions: 1 });
  assert.equal(callsOf(r, "servers", "notes").sessions, 1);
  assert.equal(r.sessions, 1);
});

test("claude: orphaned and superseded files, and files that are not sessions, are skipped", async () => {
  const home = makeHome();
  const calls = [assistant(1, [{ name: "mcp__tracker__list" }])];
  claudeSession(home, uuid(1), calls);
  const dir = join(home, ".claude/projects/-work-demo");
  writeLines(join(dir, `${uuid(2)}.jsonl.orphaned-1700000000`), calls);
  writeLines(join(dir, `${uuid(3)}.jsonl.superseded-1700000000`), calls);
  writeLines(join(dir, "notes.jsonl"), calls);
  writeLines(join(dir, uuid(4), "subagents", "agent-x.jsonl.orphaned-1"), calls);
  const r = await read(home);
  assert.deepEqual(callsOf(r, "servers", "tracker"), { name: "tracker", calls: 1, sessions: 1 });
});

test("claude: records outside the window are skipped, by their own time and not the file's, and an old session is not counted", async () => {
  const home = makeHome();
  // Written today (a resumed session) but holding old and new records.
  claudeSession(home, uuid(1), [assistant(45, [{ name: "mcp__tracker__list" }]), assistant(3, [{ name: "mcp__tracker__list" }])]);
  claudeSession(home, uuid(2), [assistant(40, [{ name: "mcp__tracker__list" }]), prompt(39)]);
  claudeSession(home, uuid(3), [assistant(50, [{ name: "mcp__tracker__list" }])], "-work-old", new Date(NOW.getTime() - 50 * 86_400_000));
  const r = await read(home);
  assert.deepEqual(callsOf(r, "servers", "tracker"), { name: "tracker", calls: 1, sessions: 1 });
  assert.equal(r.sessions, 1);
});

test("claude: a call copied into a resumed session is counted once", async () => {
  const home = makeHome();
  const same = assistant(1, [{ name: "mcp__tracker__list", id: "toolu_same" }]);
  claudeSession(home, uuid(1), [same]);
  claudeSession(home, uuid(2), [same, assistant(1, [{ name: "mcp__tracker__list", id: "toolu_other" }])]);
  assert.equal(callsOf(await read(home), "servers", "tracker").calls, 2);
});

test("claude: how much history there is: the oldest record, at most the window, and at most what settings.json keeps", async () => {
  const home = makeHome();
  claudeSession(home, uuid(1), [prompt(12), assistant(2, [])]);
  assert.equal((await read(home)).days, 12);
  claudeSession(home, uuid(2), [prompt(80), assistant(2, [])]);
  assert.equal((await read(home)).days, 30, "never more than the window");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ cleanupPeriodDays: 7 }));
  assert.equal((await read(home)).days, 7, "cleanupPeriodDays keeps less");
  assert.equal((await read(makeHome())).days, 0, "no history is no days");
});

test("claude: CLAUDE_CONFIG_DIR moves the tree", async () => {
  const home = makeHome();
  const elsewhere = join(home, "elsewhere");
  writeLines(join(elsewhere, "projects/-work-demo", `${uuid(1)}.jsonl`), [assistant(1, [{ name: "mcp__tracker__list" }])]);
  assert.equal(callsOf(await read(home, { env: { CLAUDE_CONFIG_DIR: elsewhere } }), "servers", "tracker").calls, 1);
  assert.equal(callsOf(await read(home), "servers", "tracker").calls, 0);
});

test("claude: nothing but names and counts comes back", async () => {
  const home = makeHome();
  claudeSession(home, uuid(1), [prompt(1), assistant(1, [{ name: "mcp__tracker__list" }, { name: "Skill", input: { skill: "review" } }]), result(1), typed(1, "debug")]);
  const text = JSON.stringify(await read(home));
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `${secret} is not in what the reader returns`);
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["days", "ok", "servers", "sessions", "skills"]);
});

test("claude: a damaged line, and a file that is not JSON, are skipped without failing the rest", async () => {
  const home = makeHome();
  const file = claudeSession(home, uuid(1), [assistant(1, [{ name: "mcp__tracker__list" }])]);
  writeFileSync(file, `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__tracker__li\nnot json at all "tool_use"\n${JSON.stringify(assistant(1, [{ name: "mcp__tracker__list" }]))}\n`);
  assert.equal(callsOf(await read(home), "servers", "tracker").calls, 1);
});
