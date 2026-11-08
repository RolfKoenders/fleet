import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readContextReport } from "../src/contextread.ts";
import { EXIT } from "../src/exit.ts";
import { git, installFakeSsh, installStatusTools, makeClone, makeHome, publish, runFleet, tempDir, toolCalls } from "./helpers.ts";
import type { SshPlan } from "./helpers.ts";

const REMOTE_COMMAND = "~/.local/bin/fleet context --json";
const ESC = "\u001b";

type Item = Record<string, unknown>;
const instructions = (tokens: number, name = "~/.claude/CLAUDE.md"): Item => ({ kind: "instructions", name, path: name, tokens, fromConfig: true, measurement: null });
const server = (name: string, tokens: number | null): Item => ({
  kind: "mcp",
  name,
  path: null,
  tokens,
  fromConfig: true,
  measurement: tokens === null ? null : { tools: 4, measuredAt: "2026-11-01T10:00:00Z", ageSeconds: 600, current: true },
});
const agentDoc = (agent: string, items: unknown[], extra: Record<string, unknown> = {}) => ({ agent, tokens: 0, complete: true, items, notes: [], ...extra });

/** What a host's `fleet context --json` prints. Its own totals are not looked at, so the fixture leaves them out. */
const contextDoc = (claude: Item[], over: Record<string, unknown> = {}) =>
  JSON.stringify({ ok: true, code: "ok", host: "remote", messages: [], agents: [agentDoc("claude", claude), agentDoc("opencode", [])], notes: [], ...over });

const OK: SshPlan = { stdout: contextDoc([instructions(100)]) };
const UNREACHABLE: SshPlan = { exit: 255, stderr: "ssh: connect to host x port 22: Connection timed out" };

type Host = { name: string; ssh: string | null };
type Agent = { agent: string; tokens: number; complete: boolean; instructions: { tokens: number; count: number; unmeasured: number }; mcp: { count: number; unmeasured: number }; items: any[]; notes: string[] };
type HostRecord = { host: string; result: string; context: { agents: Agent[]; notes: string[] } | null; detail?: string };

function setup(hosts: Host[], ssh: Record<string, SshPlan>, localClaude = "") {
  const { clone, remote } = makeClone();
  const home = makeHome("laptop");
  mkdirSync(join(clone, "hosts"), { recursive: true });
  for (const h of [{ name: "laptop", ssh: "alice@laptop" }, ...hosts]) writeFileSync(join(clone, "hosts", `${h.name}.yaml`), h.ssh === null ? "{}\n" : `ssh: ${h.ssh}\n`);
  publish(clone, "hosts");
  if (localClaude !== "") {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude/CLAUDE.md"), localClaude);
  }
  // Always installed: with the real ssh on the probe path a test could reach a real host.
  installFakeSsh(home, ssh);
  const json = () => {
    const r = runFleet(clone, ["context", "--all", "--json"], { home });
    return { r, doc: JSON.parse(r.stdout) as { ok: boolean; code: string; host: string; agents: Agent[]; hosts: HostRecord[] } };
  };
  return { clone, remote, home, json, human: (env: Record<string, string> = {}) => runFleet(clone, ["context", "--all"], { home, env }), calls: () => toolCalls(home, "ssh") };
}

const byHost = (records: HostRecord[], name: string) => records.find((r) => r.host === name)!;

test("context --all asks each host with ssh for its context over ssh, in name order, and not this host", () => {
  const s = setup([{ name: "server", ssh: "alice@server" }, { name: "box", ssh: "alice@box" }], { "alice@server": OK, "alice@box": OK, "alice@laptop": OK });
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(s.calls(), [
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "alice@box", REMOTE_COMMAND],
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "alice@server", REMOTE_COMMAND],
  ]);
  assert.deepEqual(doc.hosts.map((h) => [h.host, h.result]), [["box", "ok"], ["laptop", "ok"], ["server", "ok"]]);
});

test("--json has one record per host with the context document, and this host is read in place", () => {
  const s = setup([{ name: "server", ssh: "alice@server" }], { "alice@server": { stdout: contextDoc([instructions(300), server("alpha", 900), server("beta", null)]) } }, "c".repeat(400));
  const { doc } = s.json();
  assert.equal(doc.host, "laptop");
  const remote = byHost(doc.hosts, "server").context!;
  assert.deepEqual(remote.agents.map((a) => a.agent), ["claude", "opencode"]);
  assert.equal(remote.agents[0]!.tokens, 1200);
  assert.equal(remote.agents[0]!.complete, false, "a server without a measurement keeps the total a lower bound");
  assert.equal(remote.agents[0]!.mcp.unmeasured, 1);
  assert.equal(remote.agents[0]!.items.length, 3);
  const local = byHost(doc.hosts, "laptop");
  assert.equal(local.result, "ok");
  assert.equal(local.context!.agents[0]!.tokens, 100, "400 characters of CLAUDE.md");
  assert.deepEqual(doc.agents.map((a) => a.agent), ["claude", "opencode"], "the top level is this host, as in status --all");
  assert.equal(doc.agents[0]!.tokens, 100);
  assert.equal(byHost(doc.hosts, "server").detail, undefined);
});

test("every bar is drawn on one scale: the largest agent across all hosts", () => {
  const s = setup(
    [{ name: "big", ssh: "alice@big" }, { name: "half", ssh: "alice@half" }],
    { "alice@big": { stdout: contextDoc([instructions(1200)]) }, "alice@half": { stdout: contextDoc([instructions(600)]) } },
    "c".repeat(120),
  );
  const r = s.human();
  assert.equal(r.code, EXIT.ok, r.stderr);
  const blocks = Object.fromEntries(r.stdout.split("\n\n").flatMap((b) => (/^\S+ ?(?:\(this host\))?: ok/.test(b) ? [[b.split(":")[0]!.split(" ")[0]!, b]] : [])));
  assert.match(blocks.big!, /^ {2}claude +█{30} {2}~1\.2k/m);
  assert.match(blocks.half!, /^ {2}claude +█{15} {15} {2}~600/m);
  assert.match(blocks.laptop!, /^ {2}claude +█{1} {29} {2}~30/m, "30 tokens of 1200 keeps its one cell");
  assert.match(r.stdout, /All bars share one scale: a full bar is ~1\.2k, claude on big\./);
});

test("an unreachable host is marked, the others are still asked, and the exit is 4", () => {
  const s = setup([{ name: "a", ssh: "alice@a" }, { name: "b", ssh: "alice@b" }, { name: "c", ssh: "alice@c" }], { "alice@a": OK, "alice@b": UNREACHABLE, "alice@c": OK });
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.unreachable, r.stderr);
  assert.equal(doc.ok, false);
  assert.equal(doc.code, "unreachable");
  assert.equal(byHost(doc.hosts, "b").result, "unreachable");
  assert.equal(byHost(doc.hosts, "b").context, null);
  assert.equal(byHost(doc.hosts, "a").result, "ok");
  assert.equal(byHost(doc.hosts, "c").result, "ok");
  assert.equal(s.calls().length, 3);
  assert.match(r.stderr, /b: unreachable over ssh/);
  const human = s.human();
  assert.match(human.stdout, /^b: unreachable$/m);
});

test("an ssh that cannot even start counts as unreachable", () => {
  const s = setup([{ name: "a", ssh: "alice@a" }], {});
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.unreachable);
  assert.equal(byHost(doc.hosts, "a").result, "unreachable");
});

test("a host with no ssh destination is listed as timer and leaves the exit code alone", () => {
  const s = setup([{ name: "quiet", ssh: null }, { name: "a", ssh: "alice@a" }], { "alice@a": OK });
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(byHost(doc.hosts, "quiet").result, "timer");
  assert.equal(byHost(doc.hosts, "quiet").context, null);
  assert.deepEqual(s.calls().map((c) => c[4]), ["alice@a"]);
  assert.match(s.human().stdout, /^quiet: timer \(no ssh destination; it applies on its own schedule\)$/m);
});

test("a host whose fleet has no context command says it needs a newer pin and does not fail the run", () => {
  const unknown = JSON.stringify({ ok: false, code: "invalid", host: "old", messages: ["fleet: unknown command 'context'. Run 'fleet help' for the commands."] });
  const s = setup([{ name: "old", ssh: "alice@old" }, { name: "new", ssh: "alice@new" }], { "alice@old": { stdout: unknown, exit: 2 }, "alice@new": OK });
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(doc.ok, true);
  const old = byHost(doc.hosts, "old");
  assert.equal(old.result, "old");
  assert.equal(old.detail, "needs a newer pin");
  assert.equal(old.context, null);
  assert.equal(byHost(doc.hosts, "new").result, "ok");
  const human = s.human();
  assert.equal(human.code, EXIT.ok);
  assert.match(human.stdout, /^old: needs a newer pin$/m);
  assert.equal(human.stderr.includes("old"), false, "nothing to report: it is not a problem");
});

test("an answer that is not a context document is an error with exit 1, and unreachable still wins over it", () => {
  const s = setup([{ name: "a", ssh: "alice@a" }, { name: "b", ssh: "alice@b" }], { "alice@a": { stdout: "sh: fleet: not found", exit: 127 }, "alice@b": OK });
  const first = s.json();
  assert.equal(first.r.code, EXIT.error, first.r.stderr);
  assert.equal(first.doc.code, "error");
  assert.equal(byHost(first.doc.hosts, "a").result, "error");
  assert.match(byHost(first.doc.hosts, "a").detail ?? "", /not a fleet context document \(exit 127\)/);
  assert.equal(byHost(first.doc.hosts, "b").result, "ok");
  assert.match(first.r.stderr, /a: its output was not a fleet context document/);

  const t = setup([{ name: "a", ssh: "alice@a" }, { name: "b", ssh: "alice@b" }], { "alice@a": { stdout: "garbage", exit: 1 }, "alice@b": UNREACHABLE });
  assert.equal(t.json().r.code, EXIT.unreachable);
});

test("a host whose context could not be made is an error that says which code it gave", () => {
  const s = setup([{ name: "a", ssh: "alice@a" }], { "alice@a": { stdout: JSON.stringify({ ok: false, code: "error", host: "a", messages: ["fleet: no such thing"] }), exit: 1 } });
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.error, r.stderr);
  assert.match(byHost(doc.hosts, "a").detail ?? "", /gave error: fleet: no such thing/);
});

test("what a remote host sends is cut down to the expected fields and printable text", () => {
  const evil = JSON.stringify({
    ok: true,
    code: "ok",
    extra: "ignored",
    notes: [`note\u001b[31m`],
    agents: [
      agentDoc("claude", [
        { ...instructions(100, `~/.claude/\u001b[2JCLAUDE.md`), secret: "sk-1", path: "p\u0007" },
        { kind: "skills", name: "s".repeat(500), path: "~/.claude/skills/s", tokens: 5.5, fromConfig: "yes" },
        { kind: "mcp", name: "m", path: "/leak", tokens: 50, fromConfig: true, measurement: { tools: -1, measuredAt: "2026-11-01\u001b[0m", ageSeconds: 5, current: "maybe", detail: "x" } },
        { kind: "bogus", name: "dropped", tokens: 9 },
        { kind: "mcp", name: "huge", tokens: 1e300 },
        "not an object",
      ], { tokens: 999999, complete: true, notes: ["claude note\u0007"], plus: 1 }),
      agentDoc("pi", [instructions(5000)]),
    ],
  });
  const s = setup([{ name: "a", ssh: "alice@a" }], { "alice@a": { stdout: evil } });
  const { doc } = s.json();
  const a = byHost(doc.hosts, "a").context as any;
  assert.deepEqual(a.agents.map((x: Agent) => x.agent), ["claude"], "an agent fleet does not know is dropped");
  assert.equal((a as any).extra, undefined);
  assert.deepEqual(a.notes, ["note?[31m"]);
  const claude = a.agents[0] as Agent;
  assert.deepEqual(claude.notes, ["claude note?"]);
  assert.equal(claude.tokens, 150, "the totals come from the items, not from the host");
  assert.equal(claude.complete, false, "the server 'huge' has no usable size");
  assert.equal(claude.items.length, 4);
  assert.equal(claude.items[0].name, "~/.claude/?[2JCLAUDE.md");
  assert.equal(claude.items[0].path, "p?");
  assert.equal(claude.items[0].secret, undefined);
  assert.equal(claude.items[1].name.length, 200);
  assert.equal(claude.items[1].tokens, null);
  assert.equal(claude.items[1].fromConfig, false);
  assert.equal(claude.items[2].path, null);
  assert.deepEqual(claude.items[2].measurement, { tools: null, measuredAt: "2026-11-01?[0m", ageSeconds: 5, current: null });
  const human = s.human();
  for (const bad of [ESC, "\u0007"]) assert.equal(human.stdout.includes(bad), false);
  // With colour on, the only escapes are the colours fleet draws.
  const colored = s.human({ FORCE_COLOR: "1", COLORTERM: "truecolor", TERM: "xterm-256color" });
  assert.equal(colored.stdout.includes(ESC), true);
  assert.equal(colored.stdout.replace(/\u001b\[[0-9;]*m/g, "").includes(ESC), false);
});

test("readContextReport reads a document, or says why it is not one", () => {
  const ok = readContextReport(contextDoc([instructions(40), server("alpha", 80)]));
  assert.ok(ok.ok);
  assert.equal(ok.ok && ok.report.agents[0]!.tokens, 120);
  assert.equal(ok.ok && ok.report.agents[0]!.mcp.count, 1);
  for (const [text, reason] of [
    ["", /not a fleet context document/],
    ["[]", /not a fleet context document/],
    ["{}", /not a fleet context document/],
    [JSON.stringify({ code: "ok", agents: "x" }), /not a fleet context document/],
    [JSON.stringify({ code: "ok", agents: [] }), /no agent fleet knows/],
    [JSON.stringify({ code: "ok", agents: [{ agent: "pi", items: [] }] }), /no agent fleet knows/],
    [JSON.stringify({ code: "invalid", messages: ["fleet: bad\u001b"] }), /^its context gave invalid: fleet: bad\?$/],
  ] as const) {
    const read = readContextReport(text);
    assert.ok(!read.ok);
    assert.match(read.ok ? "" : read.reason, reason);
  }
  const many = readContextReport(JSON.stringify({ code: "ok", agents: [agentDoc("claude", Array.from({ length: 5000 }, (_, i) => instructions(1, `f${i}`)))] }));
  assert.equal(many.ok && many.report.agents[0]!.items.length, 2000);
});

test("without --all, context never calls ssh", () => {
  const s = setup([{ name: "a", ssh: "alice@a" }], { "alice@a": OK });
  const r = runFleet(s.clone, ["context", "--json"], { home: s.home });
  assert.equal(r.code, EXIT.ok);
  assert.deepEqual(s.calls(), []);
  assert.equal(JSON.parse(r.stdout).hosts, undefined);
});

test("--all is for status, doctor and context only", () => {
  const s = setup([{ name: "a", ssh: "alice@a" }], { "alice@a": OK });
  const r = runFleet(s.clone, ["diff", "--all"], { home: s.home });
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /--all is only for 'status', 'doctor' and 'context'/);
  assert.deepEqual(s.calls(), []);
});

test("a host file with an ssh destination ssh would read as an option exits 2 before any call", () => {
  const s = setup([{ name: "a", ssh: "-oProxyCommand=x" }], { "alice@a": OK });
  const r = runFleet(s.clone, ["context", "--all"], { home: s.home });
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /'ssh' must be a destination/);
  assert.deepEqual(s.calls(), []);
});

test("a remote that really runs fleet context answers with what is in its own home", () => {
  const s = setup([{ name: "server", ssh: "alice@server" }], {}, "c".repeat(80));
  // A second machine: its own HOME and clone of the same remote, with its own agent files.
  const base = tempDir("fleet-machine-");
  const mhome = join(base, "home");
  mkdirSync(join(mhome, ".config/fleet"), { recursive: true });
  writeFileSync(join(mhome, ".config/fleet/host"), "server\n");
  git(base, "clone", "--quiet", s.remote, "fleet");
  writeFileSync(join(mhome, ".config/fleet/config"), `${join(base, "fleet")}\n`);
  mkdirSync(join(mhome, ".local/bin"), { recursive: true });
  symlinkSync(join(base, "fleet/bin/fleet"), join(mhome, ".local/bin/fleet"));
  installStatusTools(mhome);
  mkdirSync(dirname(join(mhome, ".claude/CLAUDE.md")), { recursive: true });
  writeFileSync(join(mhome, ".claude/CLAUDE.md"), "r".repeat(4000));
  installFakeSsh(s.home, { "alice@server": { home: mhome } });

  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.ok, r.stderr);
  const remote = byHost(doc.hosts, "server");
  assert.equal(remote.result, "ok");
  assert.equal(remote.context!.agents[0]!.tokens, 1000, "the remote measured its own home, not ours");
  assert.equal(byHost(doc.hosts, "laptop").context!.agents[0]!.tokens, 20);
  assert.match(s.human().stdout, /^server: ok$/m);
});
