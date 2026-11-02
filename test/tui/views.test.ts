import { test } from "node:test";
import assert from "node:assert/strict";
import { bridgeFor, cannedProbe, makeConfig, noReads, ok } from "./fixture.ts";
import type { Canned } from "./fixture.ts";
import { createApp } from "../../src/tui/app.ts";
import { Headless } from "../../src/tui/headless.ts";
import { loadModel } from "../../src/tui/model.ts";
import { motionAllowed } from "../../src/tui/bridge.ts";
import type { HostInfo } from "../../src/tui/model.ts";
import type { Probe } from "../../src/tui/probe.ts";

const unreachable = { result: "unreachable" as const, status: null, detail: "ssh: connect to host box port 22: Connection timed out" };

test("home: every host has a card from the config at once, before any host has answered", async () => {
  const b = await bridgeFor(makeConfig(), { hosts: { server: "never", box: "never" } }, { settle: false });
  const f = b.frame();
  for (const name of ["laptop", "server", "box", "edge"]) assert.match(f, new RegExp(name));
  assert.match(f, /config 3 skills · 2 servers/);
  assert.match(f, /asking over ssh/);
  assert.match(f, /this host/);
  assert.match(f, /me@server/);
});

test("home: other hosts fill in as they answer, each on its own, and an unreachable one says so", async () => {
  const answers: Record<string, (v: unknown) => void> = {};
  const probe: Probe = {
    host: (h: HostInfo) => (h.self ? Promise.resolve(ok()) : h.ssh === null ? Promise.resolve({ result: "timer", status: null }) : new Promise((resolve) => (answers[h.name] = resolve as never))),
    conflicts: async () => ({ ok: true, items: [] }),
    ...noReads,
  };
  const model = loadModel(makeConfig(), "laptop");
  const b = new Headless(createApp({ model, probe, motion: true, boot: false }), { cols: 100, rows: 32 });
  await Promise.resolve();
  b.advance(100);
  assert.match(b.frame(), /server[\s\S]*asking over ssh/);
  answers.server!(ok({ pending: 4, conflicts: 1 }));
  await new Promise((r) => setImmediate(r));
  b.advance(33);
  const mid = b.frame();
  assert.match(mid, /pending 4   conflicts 1/);
  assert.match(mid, /box[\s\S]*asking over ssh/, "box has not answered and still shows it is being asked");
  answers.box!(unreachable);
  await new Promise((r) => setImmediate(r));
  b.advance(33);
  assert.match(b.frame(), /unreachable over ssh/);
  assert.match(b.frame(), /Connection/);
});

test("home: a timer host is honest that its status is unknown", async () => {
  const f = (await bridgeFor(makeConfig())).frame();
  assert.match(f, /No ssh destination, so it applies on its own[\s\S]*schedule\. Its status is unknown from here\./);
  assert.match(f, /1 on timer, status unknown/);
});

test("home: the age is the last change, not the last apply", async () => {
  const f = (await bridgeFor(makeConfig())).frame();
  assert.match(f, /last change 12m ago/);
  assert.doesNotMatch(f, /applied/i);
});

test("home: r asks every host again, and an answer to the earlier question is ignored", async () => {
  const model = loadModel(makeConfig(), "laptop");
  const resolvers: ((r: ReturnType<typeof ok>) => void)[] = [];
  const probe: Probe = {
    host: (h) => (h.name === "server" ? new Promise((resolve) => resolvers.push(resolve as never)) : Promise.resolve(h.ssh === null && !h.self ? { result: "timer" as const, status: null } : ok())),
    conflicts: async () => ({ ok: true, items: [] }),
    ...noReads,
  };
  const b = new Headless(createApp({ model, probe, motion: true, boot: false }), { cols: 100, rows: 32 });
  b.press("r");
  assert.equal(resolvers.length, 2);
  resolvers[0]!(ok({ pending: 9 }));
  await new Promise((r) => setImmediate(r));
  b.advance(33);
  assert.doesNotMatch(b.frame(), /pending 9/, "the first question was superseded");
  resolvers[1]!(ok({ pending: 5 }));
  await new Promise((r) => setImmediate(r));
  b.advance(33);
  assert.match(b.frame(), /pending 5/);
});

test("home: arrows move the selection, enter opens the matrix on that host", async () => {
  const b = await bridgeFor(makeConfig());
  b.press("right", "enter");
  assert.match(b.frame(), /SKILL BUNDLES/);
  assert.match(b.frame(), /\bbundles?\b/i);
  // The second host, box, is the cursor column.
  b.press("down");
  assert.match(b.frame(), /on box/);
});

test("matrix: the cursor says why a cell is on, and which exclude took it away", async () => {
  const b = await bridgeFor(makeConfig());
  b.press("2");
  // columns: laptop (this host), box, edge, server. Row core.
  b.press("right", "right", "right");
  let f = b.frame();
  assert.match(f, /core on server/);
  assert.match(f, /removed by exclude in hosts\/server\.yaml/);
  assert.match(f, /hosts\/_defaults\.yaml \(or\b|bundles in hosts\/_defaults\.yaml picks core, but an exclude wins/);
  b.press("left", "left", "left");
  f = b.frame();
  assert.match(f, /core on laptop/);
  assert.match(f, /picked by bundles in hosts\/_defaults\.yaml/);
  b.press("down");
  assert.match(f = b.frame(), /extra on laptop/);
  assert.match(f, /picked by bundles in hosts\/laptop\.yaml/);
  b.press("right", "right");
  assert.match(b.frame(), /no file picks extra: it is in neither hosts\/_defaults\.yaml nor hosts\/edge\.yaml/);
});

test("matrix: servers explain themselves through mcp.include and mcp.exclude, without values", async () => {
  const b = await bridgeFor(makeConfig());
  b.press("2", "G");
  let f = b.frame();
  assert.match(f, /tracker-local on laptop/);
  assert.match(f, /stdio server for claude, uses 1 secret/);
  assert.doesNotMatch(f, /TRACKER_API_KEY|tracker\.example/);
  b.press("up", "up", "right", "right", "right");
  f = b.frame();
  assert.match(f, /docs on server/);
  assert.match(f, /removed by mcp\.exclude in hosts\/server\.yaml/);
});

test("matrix: enter expands a bundle into its skills and again collapses it", async () => {
  const b = await bridgeFor(makeConfig());
  b.press("2");
  assert.doesNotMatch(b.frame(), /└ review/);
  b.press("enter");
  assert.match(b.frame(), /└ review/);
  assert.match(b.frame(), /└ debug/);
  b.press("down");
  assert.match(b.frame(), /review on laptop/);
  assert.match(b.frame(), /in bundle core: picked by bundles in hosts\/_defaults\.yaml/);
  b.press("enter");
  assert.doesNotMatch(b.frame(), /└ review/);
});

test("matrix: reading the config asks no host anything", async () => {
  let asked = 0;
  const base = cannedProbe();
  const probe: Probe = { ...base, host: (h, s) => (asked++, base.host(h, s)) };
  const b = new Headless(createApp({ model: loadModel(makeConfig(), "laptop"), probe, motion: true, boot: false }), { cols: 100, rows: 32 });
  const after = asked;
  b.press("2", "down", "right", "enter", "G", "up", "left");
  assert.equal(asked, after);
});

test("matrix: a broken host file shows a problem and the screen still opens", async () => {
  const dir = makeConfig();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`${dir}/hosts/edge.yaml`, "bundles: not-a-list\n");
  const b = await bridgeFor(dir);
  b.press("2");
  assert.match(b.frame(), /SKILL BUNDLES/);
});

test("conflicts: every host's conflicts are listed under its name, with the detail and fix of the selected one", async () => {
  const canned: Canned = {
    hosts: { server: ok({ conflicts: 2 }), box: ok({ conflicts: 1 }) },
    conflicts: { ok: true, items: [{ kind: "link", path: "~/.claude/CLAUDE.md", detail: "~/.claude/CLAUDE.md is a file", fix: "Move or delete it, then run 'fleet apply'." }] },
    remote: {
      server: { ok: true, items: [{ kind: "link", path: "~/.claude/rules/host.md", detail: "host.md is a file, not a link", fix: "rm it on server" }, { kind: "key", path: "~/.claude.json mcpServers.docs", detail: "changed outside fleet", fix: "claude mcp remove docs" }] },
      box: { ok: false, reason: "old", detail: "detail needs a newer pin" },
    },
  };
  const b = await bridgeFor(makeConfig(), canned);
  b.press("3");
  let f = b.frame();
  assert.match(f, /3 conflicts across hosts/);
  assert.match(f, /laptop \(this host\)\s*\n› +link +~\/\.claude\/CLAUDE\.md/);
  assert.match(f, /server\s*\n +link +~\/\.claude\/rules\/host\.md\n +key +~\/\.claude\.json mcpServers\.docs/);
  assert.match(f, /fix\s+Move or delete it/);
  assert.match(f, /box +1 conflict; detail needs a newer pin/);
  assert.doesNotMatch(f, /error/i);
  assert.match(f, /edge +unknown: no ssh destination/);
  b.press("down");
  f = b.frame();
  assert.match(f, /server: link/);
  assert.match(f, /fix\s+rm it on server/);
});

test("conflicts: what a host reports is cut to printable text, and a host that cannot say is an explained failure", async () => {
  const b = await bridgeFor(makeConfig(), {
    hosts: { server: ok({ conflicts: 1 }), box: ok({ conflicts: 1 }) },
    remote: { server: { ok: false, reason: "error", detail: "unreachable over ssh" }, box: { ok: true, items: [] } },
  });
  const f = b.press("3").frame();
  assert.match(f, /server +1 conflict; the detail could not be read: unreachable over ssh/);
  assert.match(f, /box +1 conflict reported, none listed/);
});

test("conflicts: none, and a plan that failed, are said plainly", async () => {
  assert.match((await bridgeFor(makeConfig())).press("3").frame(), /✓ no conflicts known on any host/);
  const b = await bridgeFor(makeConfig(), { conflicts: { ok: false, detail: "no host name set" } });
  assert.match(b.press("3").frame(), /could not be planned: no host name set/);
});

test("palette: ctrl-k and : open it, typing narrows it fuzzily, each result shows the fleet command it equals", async () => {
  const b = await bridgeFor(makeConfig());
  b.press("ctrl+k");
  let f = b.frame();
  assert.match(f, /go to/);
  assert.match(f, /equals fleet status --all/);
  b.type("cnf");
  f = b.frame();
  assert.match(f, /screen\s+Conflicts/);
  assert.match(f, /equals fleet diff/);
  b.press("escape");
  assert.doesNotMatch(b.frame(), /go to/);
  b.press(":");
  b.type("tracker-l");
  f = b.frame();
  assert.match(f, /server\s+tracker-local/);
  assert.match(f, /equals reads the config files; no fleet command shows it/);
  b.press("enter");
  assert.match(b.frame(), /tracker-local on laptop/);
});

test("palette: a host jumps to its card, a bundle to its row, and quit quits", async () => {
  const b = await bridgeFor(makeConfig());
  b.press("ctrl+k").type("serv").press("enter");
  assert.equal(b.state.screen, "home");
  assert.equal(b.state.home.selected, 3);
  b.press("ctrl+k").type("extra").press("enter");
  assert.equal(b.state.screen, "matrix");
  assert.match(b.frame(), /extra on laptop/);
  b.press("ctrl+k").type("quit").press("enter");
  await b.settle();
  assert.equal(b.runtime.quitCode, 0);
});

test("palette: every item names a command or says it has none", async () => {
  const { items } = await import("../../src/tui/palette.ts");
  for (const item of items(loadModel(makeConfig(), "laptop"))) assert.ok(item.command !== null || item.note !== "", item.label);
});

test("help: ? opens it with the legend, and says the bridge only reads", async () => {
  const b = await bridgeFor(makeConfig());
  b.press("?");
  const f = b.frame();
  assert.match(f, /keys/);
  assert.match(f, /from the defaults/);
  assert.match(f, /only reads/);
  b.press("?");
  assert.doesNotMatch(b.frame(), /legend/);
});

test("the footer shows key hints for the open screen", async () => {
  const b = await bridgeFor(makeConfig());
  assert.match(b.frame(), /enter matrix.*r refresh.*ctrl-k palette.*\? help.*q quit/);
  assert.match(b.press("2").frame(), /enter skills/);
});

test("q and ctrl-c quit", async () => {
  for (const key of ["q", "ctrl+c"]) {
    const b = await bridgeFor(makeConfig());
    b.press(key);
    assert.equal(b.runtime.quitCode, 0);
  }
});

test("narrow windows: a list of hosts at 32 columns, cards at 100, a clear message below the minimum", async () => {
  const cfg = makeConfig();
  const narrow = (await bridgeFor(cfg, {}, { size: { cols: 32, rows: 12 } })).frame();
  assert.match(narrow, /laptop\s+12m ago/);
  assert.ok(narrow.split("\n").every((l) => [...l].length <= 32));
  const tiny = (await bridgeFor(cfg, {}, { size: { cols: 28, rows: 7 } })).frame();
  assert.match(tiny, /needs a window of\s*\n\s*30 x 8 or more\s*\n\s*now 28 x 7/);
  const b = await bridgeFor(cfg, {}, { size: { cols: 100, rows: 32 } });
  b.resize(20, 5);
  assert.match(b.frame(), /30 x 8/);
  b.resize(100, 32);
  assert.match(b.frame(), /┏ ● laptop/);
});

test("every screen fits every size from the minimum up without drawing outside it", async () => {
  const cfg = makeConfig();
  for (const [cols, rows] of [[30, 8], [40, 12], [60, 20], [80, 24], [120, 40], [200, 60]] as const) {
    const b = await bridgeFor(cfg, {}, { size: { cols, rows } });
    for (const screen of ["1", "2", "3"]) {
      b.press(screen);
      const lines = b.frame().split("\n");
      assert.equal(lines.length, rows);
      assert.ok(lines.every((l) => [...l].length <= cols), `${cols}x${rows} screen ${screen}`);
    }
    b.press("?");
    assert.equal(b.frame().split("\n").length, rows);
    b.press("escape", "ctrl+k");
    assert.equal(b.frame().split("\n").length, rows);
  }
});

test("boot: the logo draws itself, any key skips it, and nothing else happens meanwhile", async () => {
  const b = await bridgeFor(makeConfig(), {}, { boot: true });
  assert.doesNotMatch(b.frame(), /read-only/);
  b.advance(100);
  assert.match(b.frame(), /┌──────┐/);
  b.advance(1100);
  assert.match(b.frame(), /f l e e t/);
  b.press("x");
  assert.match(b.frame(), /fleet bridge/);
  const second = await bridgeFor(makeConfig(), {}, { boot: true });
  second.advance(1800);
  assert.match(second.frame(), /fleet bridge/);
});

test("boot: skipped when a tick runs late, as on a slow link", async () => {
  const b = await bridgeFor(makeConfig(), {}, { boot: true });
  b.send({ type: "tick", now: 300, late: 400 });
  assert.match(b.frame(), /fleet bridge/);
});

test("motion: off for FLEET_NO_MOTION and for a plain terminal", () => {
  assert.equal(motionAllowed({ TERM: "xterm-256color" }), true);
  assert.equal(motionAllowed({ TERM: "xterm-256color", FLEET_NO_MOTION: "1" }), false);
  assert.equal(motionAllowed({ TERM: "dumb" }), false);
  assert.equal(motionAllowed({ TERM: "linux" }), false);
});

test("without motion the spinner holds still", async () => {
  const b = await bridgeFor(makeConfig(), { hosts: { box: "never" } }, { motion: false, settle: false });
  const first = b.frame();
  b.advance(500);
  assert.equal(b.frame(), first);
  assert.match(first, /…/);
});

test("with motion the spinner and the shimmer move", async () => {
  const b = await bridgeFor(makeConfig(), { hosts: { box: "never" } }, { settle: false });
  const first = b.frame();
  b.advance(400);
  assert.notEqual(b.frame(), first);
});

test("no frame ever holds a control character", async () => {
  const b = await bridgeFor(makeConfig(), { hosts: { box: unreachable } });
  for (const keys of [["1"], ["2"], ["enter"], ["3"], ["?"], ["escape", "ctrl+k"]]) {
    b.press(...keys);
    assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(b.frame()));
  }
});
