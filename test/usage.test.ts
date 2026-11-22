import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentContext } from "../src/context.ts";
import { readContextReport } from "../src/contextread.ts";
import { EXIT } from "../src/exit.ts";
import { collectUsage, combineReports, readUsage, sumUsage } from "../src/usage.ts";
import { renderUsage } from "../src/usageview.ts";
import { makeClone, makeHome, publish, runFleet, installFakeSsh, toolCalls } from "./helpers.ts";
import { addRow, addSession, agoIso, assistant, claudeSession, currentSchema, DAY, NOW, openOpencode, prompt, SECRET_ARGS, SECRET_INPUT, SECRET_PROMPT, SECRET_RESULT, SECRETS, toolMessage, typed, userMessage, uuid } from "./usagefixture.ts";

const put = (home: string, rel: string, text: string) => {
  mkdirSync(dirname(join(home, rel)), { recursive: true });
  writeFileSync(join(home, rel), text);
};
const skill = (home: string, name: string, description: string) => put(home, `.claude/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`);

/** A host with two Claude Code servers and two skills, one of each heavy (a long description) and one light, and opencode with one server. */
function host() {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  mkdirSync(join(clone, "hosts"), { recursive: true });
  writeFileSync(join(clone, "hosts/laptop.yaml"), "{}\n");
  publish(clone, "hosts");
  put(home, ".claude.json", JSON.stringify({ mcpServers: { tracker: { type: "http", url: "https://tracker.example" }, notes: { type: "http", url: "https://notes.example" } } }));
  skill(home, "review", "Reviews a change. " + "It reads the diff and says what it finds. ".repeat(150));
  skill(home, "debug", "Finds a bug.");
  put(home, ".config/opencode/opencode.jsonc", JSON.stringify({ mcp: { tracker: { type: "remote", url: "https://tracker.example" } } }));
  return { clone, home };
}

/** Every file below `dir` with its size, so a run that wrote something shows. */
function listing(dir: string, into: Record<string, number> = {}): Record<string, number> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat?.isDirectory()) listing(path, into);
    else if (stat) into[path] = stat.size;
  }
  return into;
}

/** The real clock, which the command reads: records are made relative to now. */
const now = new Date();

type Doc = { agents: { agent: string; items: { kind: string; name: string }[] }[]; usage: { windowDays: number; note: string; agents: { agent: string; status: string; reason: string | null; days: number; sessions: number; servers: { name: string; calls: number; sessions: number }[]; skills: { name: string; calls: number; sessions: number }[] }[] }; hosts?: unknown[]; usageAll?: unknown };
const asClaude = (doc: Doc) => doc.usage.agents.find((a) => a.agent === "claude")!;

test("context --usage: calls and the share of sessions next to each size, the history of each agent, the hint, and the closing line", () => {
  const { clone, home } = host();
  // 31 days of history in one file, written now, and calls in the window.
  claudeSession(home, uuid(1), [prompt(31, now), assistant(2, [{ name: "mcp__tracker__list" }, { name: "mcp__tracker__get" }, { name: "Skill", input: { skill: "debug" } }], now), typed(2, "debug", SECRET_ARGS, now)], "-work-demo", now);
  claudeSession(home, uuid(2), [assistant(1, [{ name: "mcp__tracker__list" }], now)], "-work-demo", now);
  claudeSession(home, uuid(3), [prompt(1, now)], "-work-demo", now);
  claudeSession(home, uuid(4), [prompt(1, now)], "-work-demo", now);
  const db = openOpencode(home);
  currentSchema(db);
  addSession(db, "session_v2", "s1");
  addRow(db, "session_message", "s1", 8.5, toolMessage(["tracker_list"]), now);
  db.close();

  const r = runFleet(clone, ["context", "--usage"], { home });
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(r.stderr, "", "sqlite's warning is not printed");
  assert.match(r.stdout, /usage, last 30 days \(Claude Code: 30 days, opencode: 9 days\)/);
  assert.match(r.stdout, /Claude Code: 4 sessions/);
  assert.match(r.stdout, /tracker +mcp +3 calls +in 50% of sessions/);
  assert.match(r.stdout, /debug +skill +~?[\d.]+k? +2 calls +in 25% of sessions/);
  assert.match(r.stdout, /notes +mcp .* 0 calls +in 0% of sessions/);
  assert.match(r.stdout, /opencode: 1 session/);
  assert.doesNotMatch(r.stdout, /opencode: 0 sessions/);
  assert.match(r.stdout, /review \(skill, Claude Code\): never called in 30 days, [\d.]+k tokens per session: consider exclude/);
  assert.doesNotMatch(r.stdout, /debug \(skill[^\n]*never called/, "a skill that was called gets no hint");
  assert.doesNotMatch(r.stdout, /notes \(mcp[^\n]*never called/, "a server that costs nothing to speak of gets none either");
  assert.ok(r.stdout.trimEnd().endsWith("read locally, names and counts only"));
});

test("context --usage: with less than 30 days of history nothing is called never called, and the output says how much there is", () => {
  const { clone, home } = host();
  claudeSession(home, uuid(1), [prompt(4.5, now), assistant(2, [{ name: "mcp__tracker__list" }], now)], "-work-demo", now);
  const r = runFleet(clone, ["context", "--usage"], { home });
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stdout, /\(Claude Code: 5 days, opencode: no history\)/);
  assert.doesNotMatch(r.stdout, /never called/);
  assert.doesNotMatch(r.stdout, /suggestions/);
});

test("context --usage --json adds `usage` with counts and names only, and plain context has none", () => {
  const { clone, home } = host();
  claudeSession(home, uuid(1), [prompt(31, now), assistant(2, [{ name: "mcp__tracker__list" }], now)], "-work-demo", now);
  const doc = JSON.parse(runFleet(clone, ["context", "--usage", "--json"], { home }).stdout) as Doc;
  assert.equal(doc.usage.windowDays, 30);
  assert.equal(doc.usage.note, "read locally, names and counts only");
  assert.deepEqual(asClaude(doc).servers.find((s) => s.name === "tracker"), { name: "tracker", calls: 1, sessions: 1 });
  assert.equal(asClaude(doc).status, "ok");
  assert.equal(asClaude(doc).days, 30);
  assert.equal(JSON.parse(runFleet(clone, ["context", "--json"], { home }).stdout).usage, undefined);
  const plain = runFleet(clone, ["context"], { home });
  assert.doesNotMatch(plain.stdout, /calls|read locally/);
});

test("context --usage: an agent that cannot be read says why, the others are still shown, and it is not an error", () => {
  const { clone, home } = host();
  claudeSession(home, uuid(1), [assistant(2, [{ name: "mcp__tracker__list" }], now)], "-work-demo", now);
  const db = openOpencode(home);
  db.exec("CREATE TABLE something_new (id TEXT)");
  db.close();
  const r = runFleet(clone, ["context", "--usage"], { home });
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stdout, /usage unavailable for opencode: its database has tables this fleet does not recognise/);
  assert.match(r.stdout, /Claude Code: 1 session/);
  const doc = JSON.parse(runFleet(clone, ["context", "--usage", "--json"], { home }).stdout) as Doc;
  assert.equal(doc.usage.agents.find((a) => a.agent === "opencode")!.status, "unavailable");
});

test("context --usage: no prompt, tool input, tool result or command argument reaches stdout, stderr, --json or any file", () => {
  const { clone, home } = host();
  claudeSession(home, uuid(1), [prompt(31, now), assistant(2, [{ name: "mcp__tracker__list" }, { name: "Skill", input: { skill: "review", args: SECRET_INPUT } }], now), typed(1, "debug", SECRET_ARGS, now)], "-work-demo", now);
  writeFileSync(join(home, ".claude/projects/-work-demo", `${uuid(1)}.jsonl`), readFileSync(join(home, ".claude/projects/-work-demo", `${uuid(1)}.jsonl`), "utf8") + JSON.stringify({ type: "user", timestamp: agoIso(1, now), message: { content: [{ type: "tool_result", content: SECRET_RESULT }] } }) + "\n");
  const db = openOpencode(home);
  currentSchema(db);
  addSession(db, "session_v2", "s1");
  addRow(db, "session_message", "s1", 2, toolMessage(["tracker_list"], ["skill", { name: "debug" }]), now);
  addRow(db, "session_message", "s1", 2, userMessage("review"), now);
  db.close();

  const before = listing(home);
  const outputs = [runFleet(clone, ["context", "--usage"], { home }), runFleet(clone, ["context", "--usage", "--json"], { home }), runFleet(clone, ["context", "--usage", "--all"], { home }), runFleet(clone, ["context", "--usage", "--all", "--json"], { home })];
  for (const r of outputs) {
    for (const secret of SECRETS) {
      assert.ok(!r.stdout.includes(secret), `${secret} is not in stdout`);
      assert.ok(!r.stderr.includes(secret), `${secret} is not in stderr`);
    }
  }
  const after = listing(home);
  const written = Object.keys(after).filter((f) => !(f in before) || before[f] !== after[f]);
  // The runs may write what fleet always writes (state, caches), and none of it may hold a secret.
  for (const file of written) {
    const text = readFileSync(file).toString("latin1");
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `${secret} is not in ${file}`);
  }
  assert.ok(outputs[1]!.stdout.includes('"tracker"'), "the run did count");
});

test("context --usage is for context only", () => {
  const { clone, home } = host();
  const r = runFleet(clone, ["status", "--usage"], { home });
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /--usage is only for 'context'/);
});

// ---- the module ----

const report = (usage?: ReturnType<typeof readUsage>) => ({ agents: [agentContext("claude", [{ kind: "mcp", name: "tracker", path: null, tokens: 3500, fromConfig: true, measurement: null, doctor: null }, { kind: "skills", name: "tiny", path: null, tokens: 50, fromConfig: true, measurement: null, doctor: null }], [])], notes: [], ...(usage ? { usage } : {}) });

test("the 30-day rule: never called is said only with at least 30 days of history, only for what costs real tokens", async () => {
  const home = makeHome();
  const base = report();
  const lines = async (days: number) => {
    claudeSession(home, uuid(1), [prompt(days), assistant(2, [{ name: "mcp__other__x" }])]);
    const usage = await collectUsage(base, home, {}, NOW);
    return renderUsage({ ...base, usage }).join("\n");
  };
  assert.match(await lines(30), /tracker \(mcp, Claude Code\): never called in 30 days, 3\.5k tokens per session: consider exclude/);
  assert.doesNotMatch(await lines(30), /tiny \(skill/, "a skill that costs 50 tokens is not worth a hint");
  const short = makeHome();
  claudeSession(short, uuid(1), [prompt(28.5), assistant(2, [{ name: "mcp__other__x" }])]);
  const text = renderUsage({ ...base, usage: await collectUsage(base, short, {}, NOW) }).join("\n");
  assert.match(text, /Claude Code: 29 days/);
  assert.doesNotMatch(text, /never called/);
});

test("collectUsage: an agent with no usage adapter is reported as having no readable history, and a reader that throws as unavailable", async () => {
  const home = makeHome();
  const withAnti = { agents: [agentContext("antigravity", [], [])], notes: [] };
  const usage = await collectUsage(withAnti, home, {}, NOW);
  assert.deepEqual(usage.agents[0], { agent: "antigravity", status: "none", reason: "no readable history", days: 0, sessions: 0, servers: [], skills: [] });
  assert.match(renderUsage({ ...withAnti, usage }).join("\n"), /no readable history/);
});

test("usage added up over hosts: counts sum per name, the history is the shortest, and one host that could not be read does not hide the others", () => {
  const mk = (days: number, calls: number, status: "ok" | "unavailable" = "ok") =>
    ({ windowDays: 30, note: "", agents: [{ agent: "claude" as const, status, reason: status === "ok" ? null : "why", days, sessions: 4, servers: [{ name: "tracker", calls, sessions: 2 }], skills: [] }] });
  const sum = sumUsage([mk(30, 5), mk(12, 7), mk(30, 100, "unavailable")]);
  assert.deepEqual(sum.agents[0]!.servers, [{ name: "tracker", calls: 12, sessions: 4 }]);
  assert.equal(sum.agents[0]!.days, 12, "a host with 12 days stops 'never called in 30 days'");
  assert.equal(sum.agents[0]!.sessions, 8);
  const all = sumUsage([mk(30, 1, "unavailable"), mk(30, 1, "unavailable")]);
  assert.equal(all.agents[0]!.status, "unavailable");
  const combined = combineReports([{ ...report(mk(30, 1)) }, { ...report(mk(30, 2)) }]);
  assert.equal(combined.usage!.agents[0]!.servers[0]!.calls, 3);
});

test("readUsage keeps only the known fields, printable names and bounded numbers", () => {
  const sent = { agents: [{ agent: "claude", status: "ok", reason: null, days: 99, sessions: 3, extra: SECRET_PROMPT, servers: [{ name: "tracker\u001b[31m", calls: 2, sessions: 1, text: SECRET_PROMPT }, { name: "huge", calls: 1e15, sessions: 1 }, { name: "bad", calls: -1, sessions: 1 }, "x"], skills: [{ name: "s", calls: 1, sessions: 1 }] }, { agent: "nobody", status: "ok", days: 1, sessions: 1 }] };
  const got = readUsage(sent)!;
  assert.equal(got.agents.length, 1);
  assert.equal(got.agents[0]!.days, 30);
  assert.deepEqual(got.agents[0]!.skills, [{ name: "s", calls: 1, sessions: 1 }]);
  assert.ok(!JSON.stringify(got).includes(SECRET_PROMPT));
  assert.ok(!JSON.stringify(got).includes("\u001b"));
  assert.equal(got.agents[0]!.servers.length, 1);
  assert.equal(readUsage(undefined), null);
  assert.equal(readUsage({ agents: "no" }), null);
});

// ---- --all ----

test("context --usage --all: each host counts its own history and sends names and numbers, and the local side adds them up", () => {
  const { clone, remote } = makeClone();
  void remote;
  const home = makeHome("laptop");
  mkdirSync(join(clone, "hosts"), { recursive: true });
  writeFileSync(join(clone, "hosts/laptop.yaml"), "ssh: alice@laptop\n");
  writeFileSync(join(clone, "hosts/server.yaml"), "ssh: alice@server\n");
  publish(clone, "hosts");
  put(home, ".claude.json", JSON.stringify({ mcpServers: { tracker: { type: "http", url: "https://tracker.example" } } }));
  claudeSession(home, uuid(1), [prompt(31, now), assistant(1, [{ name: "mcp__tracker__list" }], now)], "-work-demo", now);
  const items = [{ kind: "mcp", name: "tracker", path: null, tokens: 2000, fromConfig: true, measurement: null }];
  const agent = (agentName: string, usage: unknown) => ({ agent: agentName, tokens: 0, complete: true, items: agentName === "claude" ? items : [], notes: [], usage });
  const reply = JSON.stringify({
    ok: true,
    code: "ok",
    host: "server",
    messages: [],
    agents: [agent("claude", null), agent("opencode", null)],
    notes: [],
    usage: { windowDays: 30, note: "x", agents: [{ agent: "claude", status: "ok", reason: null, days: 30, sessions: 3, servers: [{ name: "tracker", calls: 4, sessions: 2, text: SECRET_PROMPT }], skills: [] }, { agent: "opencode", status: "unavailable", reason: "node:sqlite is not available in this version of Node", days: 0, sessions: 0, servers: [], skills: [] }] },
  });
  installFakeSsh(home, { "alice@server": { stdout: reply }, "alice@laptop": { stdout: reply } });
  const text = runFleet(clone, ["context", "--usage", "--all"], { home });
  assert.equal(text.code, EXIT.ok, text.stderr);
  assert.ok(toolCalls(home, "ssh").every((c) => c.at(-1) === "~/.local/bin/fleet context --usage --json"), "the remote command counts, and only names and numbers come back");
  assert.match(text.stdout, /usage, all 2 hosts added up, last 30 days/);
  assert.match(text.stdout, /tracker +mcp +~?2\.\dk +5 calls/);
  assert.match(text.stdout, /usage unavailable for opencode: node:sqlite is not available in this version of Node/);
  assert.ok(text.stdout.trimEnd().endsWith("read locally, names and counts only"));
  assert.ok(!text.stdout.includes(SECRET_PROMPT));
  const doc = JSON.parse(runFleet(clone, ["context", "--usage", "--all", "--json"], { home }).stdout) as Doc & { hosts: { host: string; context: { usage?: unknown } | null }[] };
  assert.ok(doc.usageAll);
  assert.ok(doc.hosts.every((h: { context?: { usage?: unknown } | null }) => h.context?.usage !== undefined));
  assert.ok(!JSON.stringify(doc).includes(SECRET_PROMPT));
  assert.equal(readContextReport(JSON.stringify({ agents: [] })).ok, false);
});
