import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../src/tui/app.ts";
import { Headless } from "../../src/tui/headless.ts";
import { loadModel } from "../../src/tui/model.ts";
import { paintDiff } from "../../src/tui/buffer.ts";
import { PARTS } from "../../src/contextview.ts";
import { shown } from "../../src/tui/contextshown.ts";
import { realProbe } from "../../src/tui/probe.ts";
import type { Probe } from "../../src/tui/probe.ts";
import { theme } from "../../src/tui/theme.ts";
import { installFakeSsh, installStatusTools, makeClone, makeHome, publish, repoRoot } from "../helpers.ts";
import type { SshPlan } from "../helpers.ts";
import { bridgeFor, cannedProbe, CONTEXTS, contextOf, item, makeConfig, noReads, ok } from "./fixture.ts";
import type { Canned } from "./fixture.ts";

const hosts: Canned["hosts"] = {
  laptop: ok({ pending: 2 }),
  server: ok({ conflicts: 2, pending: 1, timer: "inactive" }),
  box: { result: "unreachable", status: null, detail: "timed out" },
  edge: { result: "timer", status: null },
};

const SIZE = { cols: 100, rows: 30 };
const open = (over: { plain?: boolean; contexts?: Canned["contexts"] } = {}) =>
  bridgeFor(makeConfig(), { hosts, contexts: over.contexts ?? CONTEXTS }, { size: SIZE, app: { plain: over.plain === true } });

/** The lines of a frame between the tab bar and the footer, without trailing spaces. */
const body = (frame: string): string[] => frame.split("\n").slice(2, -1).map((l) => l.trimEnd());

test("context: 8 and tab reach the screen, which ? and the palette list", async () => {
  const b = await open();
  b.press("8");
  assert.equal(b.state.screen, "context");
  assert.match(b.frame(), /8 Context/);
  assert.match(b.frame(), /↑↓ host/);
  b.press("1", "7", "tab");
  assert.equal(b.state.screen, "context", "tab goes on from the last screen to the next one");
  b.press("tab");
  assert.equal(b.state.screen, "home", "and round to the first");
  b.press("?");
  assert.match(b.frame(), /1-8 +tab/);
  b.press("escape", "ctrl+k");
  b.type("context");
  assert.match(b.frame(), /screen\s+Context/);
  assert.match(b.frame(), /equals fleet context --all/);
  b.press("enter");
  assert.equal(b.state.screen, "context");
});

test("context: one bar per host and agent on one scale, the largest items of the selected host below, and the unmeasured server unknown, not zero", async () => {
  const b = await open();
  b.press("8");
  assert.deepEqual(body(b.frame()), [
    " What each agent loads before the first prompt, in estimated tokens.",
    " █ instructions  █ skills  █ mcp   a full bar is ~20.3k (claude, laptop)",
    "",
    "›laptop      claude   ████████████████████████████████████████  ~20.3k+",
    "›            opencode ███████████                                ~5.6k+",
    " box         needs a newer pin: its fleet has no context command yet",
    " edge        on a timer: no ssh destination, so it is not asked",
    " server      claude   ███████████████████████████████            ~15.5k",
    "             opencode ██                                           ~980",
    "",
    "╭─ laptop ─────────────────────────────────────────────────────────────────────────────────────────╮",
    "│ claude   instructions ~1.2k · skills ~920 (3) · mcp up to ~18.1k (3, 1 not measured)             │",
    "│ opencode instructions ~1.2k · skills ~410 (1) · mcp up to ~4.0k (2, 1 not measured)              │",
    "│ ~14.2k   tracker                       mcp                                                       │",
    "│ ~4.0k    docs                          mcp                                                       │",
    "│ ~1.2k    ~/.claude/CLAUDE.md           instructions                                              │",
    "│ ~1.2k    ~/.config/opencode/AGENTS.md  instructions                                              │",
    "│ ~410     review                        skill                                                     │",
    "│ ~330     debug                         skill                                                     │",
    "│ ~180     scratch                       skill        not from config                              │",
    "│ unknown  analytics                     mcp          not from config                              │",
    "│                                                                                                  │",
    "│                                                                                                  │",
    "│                                                                                                  │",
    "│                                                                                                  │",
    "│                                                                                                  │",
    "╰──────────────────────────────────────────────────────────────────────────────────────────────────╯",
  ]);
  const f = b.frame();
  assert.doesNotMatch(f, /analytics\s+mcp.*~0\b/, "a server nobody measured is not zero");
});

test("context: a server from config that nobody measured says to run doctor, and its total is marked incomplete", async () => {
  const b = await open();
  b.press("8", "down", "down", "down");
  assert.match(b.frame(), /server\s+claude/);
  b.press("up", "up", "up");
  const laptop = await open({ contexts: { ...CONTEXTS, laptop: contextOf({ claude: [item("instructions", "~/.claude/CLAUDE.md", 400), item("mcp", "tracker", null)], opencode: [item("mcp", "docs", 100)] }) } });
  laptop.press("8");
  const f = laptop.frame();
  assert.match(f, /claude\s+█+\s+~400\+/, "a lower bound, with a plus");
  assert.match(f, /mcp not measured \(1\)/);
  assert.match(f, /unknown\s+tracker\s+mcp\s+run fleet doctor/);
  assert.doesNotMatch(f, /opencode\s+█+\s+~100\+/, "a complete agent has no plus");
});

test("context: where colour is off the parts differ by character, and the screen is the same width", async () => {
  const b = await open({ plain: true });
  b.press("8", "down", "down", "down");
  assert.deepEqual(body(b.frame()), [
    " What each agent loads before the first prompt, in estimated tokens.",
    " █ instructions  ▓ skills  ░ mcp   a full bar is ~20.3k (claude, laptop)",
    "",
    " laptop      claude   ██▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ~20.3k+",
    "             opencode ██▓░░░░░░░░                                ~5.6k+",
    " box         needs a newer pin: its fleet has no context command yet",
    " edge        on a timer: no ssh destination, so it is not asked",
    "›server      claude   ██▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░            ~15.5k",
    "›            opencode ██                                           ~980",
    "",
    "╭─ server ─────────────────────────────────────────────────────────────────────────────────────────╮",
    "│ claude   instructions ~980 · skills ~330 (1) · mcp up to ~14.2k (1)                              │",
    "│ opencode instructions ~980 · skills none · mcp none                                              │",
    "│ ~14.2k   tracker                       mcp                                                       │",
    "│ ~980     ~/.claude/CLAUDE.md           instructions                                              │",
    "│ ~980     ~/.config/opencode/AGENTS.md  instructions                                              │",
    "│ ~330     debug                         skill                                                     │",
    "│                                                                                                  │",
    "│                                                                                                  │",
    "│                                                                                                  │",
    "│                                                                                                  │",
    "│                                                                                                  │",
    "│                                                                                                  │",
    "│                                                                                                  │",
    "│                                                                                                  │",
    "│                                                                                                  │",
    "╰──────────────────────────────────────────────────────────────────────────────────────────────────╯",
  ]);
  // On the terminal with NO_COLOR, nothing is painted in a colour: the characters carry the split.
  const painted = paintDiff(null, b.buffer(), "none");
  assert.doesNotMatch(painted, /\u001b\[[0-9;]*[34]8;/, "no colour code reaches the terminal");
  assert.match(painted, /▓/);
});

test("context: the bars are drawn in the colours fleet context gives its parts", async () => {
  const b = await open();
  b.press("8");
  const buf = b.buffer();
  const row = buf.toText().split("\n").findIndex((l) => l.startsWith("›laptop"));
  const colours = new Set<number>();
  for (let x = 22; x < 66; x++) if (buf.chars[row * buf.cols + x] === "█") colours.add(buf.fg[row * buf.cols + x]!);
  assert.deepEqual([...colours].sort(), PARTS.map((p) => p.colour).sort());
  assert.deepEqual(PARTS.map((p) => p.colour), [theme.brand, theme.info, theme.warn]);
});

test("context: FLEET_THEME=light draws the same screen in the light palette", () => {
  const script = `
    const { bridgeFor, CONTEXTS, makeConfig, ok } = await import(${JSON.stringify(join(repoRoot, "test/tui/fixture.ts"))});
    const { PARTS } = await import(${JSON.stringify(join(repoRoot, "src/contextview.ts"))});
    const b = await bridgeFor(makeConfig(), { hosts: { laptop: ok(), server: ok() }, contexts: CONTEXTS }, { size: { cols: 100, rows: 30 } });
    b.press("8");
    const buf = b.buffer();
    const row = buf.toText().split("\\n").findIndex((l) => l.startsWith("›laptop"));
    const seen = new Set();
    for (let x = 22; x < 66; x++) if (buf.chars[row * buf.cols + x] === "█") seen.add(buf.fg[row * buf.cols + x]);
    console.log(JSON.stringify({ bars: [...seen].sort((a, b) => a - b), parts: PARTS.map((p) => p.colour), text: buf.toText().includes("a full bar is ~20.3k") }));
  `;
  const run = (theme?: string) => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { PATH: process.env.PATH ?? "", HOME: makeHome("elsewhere"), ...(theme === undefined ? {} : { FLEET_THEME: theme }) }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout) as { bars: number[]; parts: number[]; text: boolean };
  };
  const light = run("light");
  assert.deepEqual(light.parts, [0x1a7f37, 0x0969da, 0x9a6700], "brand, info and warn of the light palette");
  assert.deepEqual(light.bars, [...light.parts].sort((a, b) => a - b));
  assert.ok(light.text);
  assert.deepEqual(run().parts, [0x3fb950, 0x58a6ff, 0xd29922]);
});

test("context: home cards carry one line, `context ~20.3k`, marked + when a server is not measured, and nothing on an older pin or a timer", async () => {
  const b = await open();
  const lines = b.frame().split("\n");
  assert.ok(lines.some((l) => /timer active\s+context ~20\.3k\+ ┃/.test(l)), "laptop: incomplete");
  assert.ok(lines.some((l) => /timer inactive\s+context ~15\.5k │/.test(l)), "server: complete");
  assert.equal(lines.filter((l) => l.includes("context ")).length, 2, "box is on an older pin and edge is a timer: no line");
});

test("context: a short window lists hosts in rows, and the total goes after the status", async () => {
  const b = await bridgeFor(makeConfig(), { hosts, contexts: CONTEXTS }, { size: { cols: 100, rows: 12 } });
  assert.match(b.frame(), /laptop\s+12m ago\s+p2 c0\s+context ~20\.3k\+/);
});

test("context: a host with a remembered context shows it at once, marked seen and not live, until it answers", async () => {
  const cachedContext = { server: { report: shown(CONTEXTS.server as never), agoSeconds: 2 * 3600 } };
  const b = await bridgeFor(makeConfig(), { hosts, contexts: { ...CONTEXTS, server: "never" } }, { settle: false, size: SIZE, app: { cachedContext } });
  assert.match(b.frame(), /timer \S+ +context ~15\.5k ◌ ┃?│/, "the card shows it, muted and marked");
  b.press("8");
  assert.match(b.frame(), /server\s+claude\s+█+\s+~15\.5k\s+seen 2h ago, not live/);
  b.press("down", "down", "down");
  assert.match(b.frame(), /seen 2h ago, not live; asking again/);
  b.advance(60_000);
  assert.match(b.frame(), /seen 2h ago/, "the age keeps counting");
});

test("context: a live answer replaces the remembered one and only good answers of other hosts are remembered, cut to what is shown", async () => {
  const saved: [string, unknown][] = [];
  const many = contextOf({ claude: Array.from({ length: 40 }, (_, i) => item("skills", `skill-${i}`, 10 + i)).concat(Array.from({ length: 12 }, (_, i) => item("mcp", `server-${i}`, null))) });
  const b = await bridgeFor(
    makeConfig(),
    { hosts, contexts: { ...CONTEXTS, server: many, box: "unreachable" } },
    { settle: false, size: SIZE, app: { cachedContext: { server: { report: shown(CONTEXTS.server as never), agoSeconds: 7200 } }, rememberContext: (host, report) => void saved.push([host, report]) } },
  );
  await b.settle();
  b.advance(100);
  b.press("8");
  assert.doesNotMatch(b.frame(), /seen 2h ago/);
  assert.deepEqual(saved.map(([h]) => h), ["server"], "not this host, not an unreachable one, not an older pin");
  const report = saved[0]![1] as ReturnType<typeof shown>;
  const claude = report.agents[0]!;
  assert.equal(claude.skills.count, 40, "the counts are those of the whole report");
  assert.equal(claude.mcp.unmeasured, 12);
  assert.ok(claude.items.length <= 16, "but only the largest items, and some of the unmeasured, are kept");
  assert.deepEqual(Object.keys(claude.items[0]!).sort(), ["fromConfig", "kind", "measurement", "name", "path", "tokens"]);
  assert.equal(claude.items[0]!.path, null);
});

test("context: a host that cannot be reached keeps the remembered context as old, and one on an older pin shows none", async () => {
  const cachedContext = { server: { report: shown(CONTEXTS.server as never), agoSeconds: 7200 }, box: { report: shown(CONTEXTS.server as never), agoSeconds: 7200 } };
  const b = await bridgeFor(makeConfig(), { hosts, contexts: { ...CONTEXTS, server: "unreachable", box: "old" } }, { size: SIZE, app: { cachedContext } });
  b.press("8");
  const f = b.frame();
  assert.match(f, /server\s+claude\s+█+\s+~15\.5k\s+seen 2h ago, not live/);
  assert.match(f, /box\s+needs a newer pin/, "a host that now says it is old has no context to show");
  assert.ok(!b.frame().split("\n").some((l) => /box/.test(l) && /context ~/.test(l)));
});

test("context: it is asked with the status, on open, on r and after a doctor run, and never starts a server", async () => {
  const asked: string[] = [];
  const doctored: boolean[] = [];
  const base = cannedProbe({ hosts, contexts: CONTEXTS });
  const probe: Probe = {
    ...base,
    context: async (host, signal) => (asked.push(host.name), base.context!(host, signal)),
    doctor: async (all) => (doctored.push(all), { ok: true, hosts: [] } as never),
  };
  const b = new Headless(createApp({ model: loadModel(makeConfig(), "laptop"), probe, motion: true, boot: false }), SIZE);
  await b.settle();
  assert.deepEqual(asked.sort(), ["box", "laptop", "server"], "once for each host that can be asked; edge has no ssh");
  assert.deepEqual(doctored, []);
  asked.length = 0;
  b.press("r");
  await b.settle();
  assert.deepEqual(asked.sort(), ["box", "laptop", "server"], "r asks again");
  asked.length = 0;
  b.press("8", "2", "3", "1");
  await b.settle();
  assert.deepEqual([asked, doctored], [[], []], "moving about asks nothing");
  b.press("d", "y");
  assert.deepEqual(asked, [], "the context is not asked until doctor has finished");
  await b.settle();
  assert.deepEqual(doctored, [true]);
  assert.deepEqual(asked.sort(), ["box", "laptop", "server"], "doctor finished, the sizes changed: ask again");
  asked.length = 0;
  b.press("d", "t");
  await b.settle();
  assert.deepEqual(asked, ["laptop"], "doctor on this host only changes only this host's sizes");
});

test("context: a host that never answers is still asking, and the screen keeps moving", async () => {
  const b = await bridgeFor(makeConfig(), { hosts, contexts: { ...CONTEXTS, server: "never" } }, { settle: false, size: SIZE });
  await new Promise((r) => setImmediate(r));
  b.press("8");
  b.advance(100);
  assert.match(b.frame(), /server\s+\S asking/);
});

// ---- the real probe ----

const contextDoc = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ok: true,
    code: "ok",
    host: "server",
    messages: [],
    notes: [],
    agents: [
      { agent: "claude", items: [{ kind: "instructions", name: "~/.claude/CLAUDE.md\u001b[31m", path: "~/x", tokens: 900, fromConfig: true }, { kind: "mcp", name: "tracker", tokens: null, fromConfig: false, measurement: null }], notes: [] },
      { agent: "unknown-agent", items: [] },
    ],
    ...over,
  });

function world(plans: Record<string, SshPlan>) {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  mkdirSync(join(clone, "hosts"), { recursive: true });
  writeFileSync(join(clone, "hosts/laptop.yaml"), "ssh: me@laptop\n");
  for (const name of [...Object.keys(plans), "edge"]) writeFileSync(join(clone, "hosts", `${name}.yaml`), name === "edge" ? "{}\n" : `ssh: me@${name}\n`);
  publish(clone, "hosts");
  installStatusTools(home);
  installFakeSsh(home, Object.fromEntries(Object.entries(plans).map(([n, p]) => [`me@${n}`, p])));
  const model = loadModel(clone, "laptop");
  return { home, model, probe: realProbe(clone, clone, home), ask: (name: string) => realProbe(clone, clone, home).context!(model.hosts.find((h) => h.name === name)!, new AbortController().signal) };
}

test("probe: another host is asked with fleet context --json over ssh and read like fleet context --all reads it; this host is measured in place", async () => {
  const w = world({ server: { stdout: contextDoc() }, old: { exit: 2, stderr: "fleet: unknown command 'context'" }, down: { exit: 255, stderr: "ssh: connect to host down port 22: Connection refused" }, junk: { stdout: "hello" } });
  const server = await w.ask("server");
  assert.equal(server.result, "ok");
  assert.deepEqual(server.context!.agents.map((a) => a.agent), ["claude"], "an agent fleet does not know is left out");
  assert.doesNotMatch(JSON.stringify(server.context), /\u001b/);
  assert.equal(server.context!.agents[0]!.mcp.unmeasured, 1, "an unmeasured server stays unknown");
  assert.equal((await w.ask("old")).result, "old");
  const down = await w.ask("down");
  assert.equal(down.result, "unreachable");
  assert.match(down.detail ?? "", /Connection refused/);
  assert.equal((await w.ask("junk")).result, "error");
  assert.deepEqual((await w.ask("edge")).result, "timer");
  const self = await w.ask("laptop");
  assert.equal(self.result, "ok");
  assert.deepEqual(self.context!.agents.map((a) => a.agent), ["claude", "opencode"]);
  const calls = readFileSync(join(w.home, "ssh-calls.log"), "utf8");
  assert.match(calls, /fleet context --json/);
  assert.doesNotMatch(calls, /doctor/);
});
