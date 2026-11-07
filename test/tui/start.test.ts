import { test } from "node:test";
import assert from "node:assert/strict";
import { bridgeFor, makeConfig, ok } from "./fixture.ts";
import { SCREENS } from "../../src/tui/palette.ts";
import { loadModel } from "../../src/tui/model.ts";
import { resolveStart, viewNames } from "../../src/tui/start.ts";
import { conflictEntries } from "../../src/tui/views/conflicts.ts";
import type { Pusher } from "../../src/tui/pusher.ts";

const item = (path: string) => ({ kind: "link" as const, path, detail: `${path} is a file`, fix: "move it" });

/** What each screen draws that no other screen does, to tell which one is open. */
const MARKER: Record<string, RegExp> = {
  home: /this host/,
  matrix: /Matrix|bundle|core/i,
  conflicts: /conflicts? across hosts|no conflicts known/,
  timeline: /no history in this test/,
  secrets: /secret/i,
  catalog: /catalog|skills/i,
  push: /push/i,
};

test("the valid views are the bridge's tabs, home first, so a new tab is a new view", () => {
  assert.deepEqual(viewNames(), SCREENS.map((s) => s.id));
  assert.equal(viewNames()[0], "home");
  assert.deepEqual(viewNames(), ["home", "matrix", "conflicts", "timeline", "secrets", "catalog", "push"]);
});

for (const { id } of SCREENS) {
  test(`--view ${id} opens the ${id} screen`, async () => {
    const b = await bridgeFor(makeConfig(), {}, { app: { view: id } });
    assert.equal(b.state.screen, id);
    assert.match(b.frame(), MARKER[id]!);
    // The tab bar shows the same thing as pressing the key would.
    const keyed = await bridgeFor(makeConfig());
    keyed.press(SCREENS.find((s) => s.id === id)!.key);
    assert.equal(b.frame(), keyed.frame(), "the same screen as the tab opened by key");
  });
}

test("no view opens on home, with this host selected", async () => {
  const b = await bridgeFor(makeConfig());
  assert.equal(b.state.screen, "home");
  assert.equal(b.state.home.selected, 0);
});

test("--view push shows the push screen without a review, and runs nothing the tab key would not", async () => {
  const calls: string[] = [];
  const pusher: Pusher = {
    preview: async () => (calls.push("preview"), { ok: false, detail: "no" }),
    run: async () => (calls.push("run"), { exit: 0, code: null, conflicts: {}, messages: [], hosts: [] }),
  } as unknown as Pusher;
  const opened = await bridgeFor(makeConfig(), {}, { app: { view: "push", pusher } });
  assert.equal(opened.state.screen, "push");
  assert.equal(opened.state.push.phase, "idle");
  assert.equal(opened.state.reviews, 0);
  assert.deepEqual(calls, []);
  const keyed = await bridgeFor(makeConfig(), {}, { app: { pusher } });
  keyed.press("7");
  await keyed.settle();
  assert.deepEqual(calls, [], "the tab by key starts nothing either");
  assert.deepEqual(opened.state.push, keyed.state.push);
});

test("--view does not start doctor or any read that opening by key would not", async () => {
  const asked: string[] = [];
  const doctor = async () => (asked.push("doctor"), { ok: false as const, reason: "error" as const, detail: "no" });
  const b = await bridgeFor(makeConfig(), { doctor: doctor as never }, { app: { view: "matrix" } });
  assert.equal(b.state.doctor.phase, "idle");
  assert.deepEqual(asked, []);
});

test("--host selects its card on home, and --host alone opens home", async () => {
  const b = await bridgeFor(makeConfig(), {}, { app: { host: "box" } });
  assert.equal(b.state.screen, "home");
  const names = b.state.model.hosts.map((h) => h.name);
  assert.equal(b.state.home.selected, names.indexOf("box"));
  assert.notEqual(names.indexOf("box"), 0);
});

test("--host selects its column in the matrix", async () => {
  const b = await bridgeFor(makeConfig(), {}, { app: { view: "matrix", host: "box" } });
  assert.equal(b.state.screen, "matrix");
  const names = b.state.model.hosts.map((h) => h.name);
  assert.equal(b.state.matrix.col, names.indexOf("box"));
  assert.equal(b.state.matrix.row, 0);
  // Moving from the selected column goes on from there.
  b.press("l");
  assert.equal(b.state.matrix.col, names.indexOf("box") + 1);
});

test("--host puts its conflicts first on the conflicts screen", async () => {
  const canned = {
    hosts: { server: ok({ conflicts: 1 }), box: ok({ conflicts: 2 }) },
    conflicts: { ok: true as const, items: [item("~/own.md")] },
    remote: {
      server: { ok: true as const, items: [item("~/server.md")] },
      box: { ok: true as const, items: [item("~/box-a.md"), item("~/box-b.md")] },
    },
  };
  const plain = await bridgeFor(makeConfig(), canned, { app: { view: "conflicts" } });
  assert.deepEqual(conflictEntries(plain.state).map((e) => e.host), ["laptop", "box", "box", "server"], "host order without --host");

  const b = await bridgeFor(makeConfig(), canned, { app: { view: "conflicts", host: "box" } });
  assert.deepEqual(conflictEntries(b.state).map((e) => e.host), ["box", "box", "laptop", "server"]);
  assert.equal(b.state.conflicts.selected, 0, "the first conflict, which is box's");
  const f = b.frame();
  assert.match(f, /box-a\.md/);
  assert.ok(f.indexOf("box") < f.indexOf("laptop"), "box is listed above laptop");
  assert.ok(f.indexOf("box-a.md") < f.indexOf("own.md"));
  // The answers arriving later keep the order.
  assert.deepEqual(conflictEntries(b.state).map((e) => e.item.path), ["~/box-a.md", "~/box-b.md", "~/own.md", "~/server.md"]);
});

test("--host and --view work together on every screen", async () => {
  for (const { id } of SCREENS) {
    const b = await bridgeFor(makeConfig(), {}, { app: { view: id, host: "edge" } });
    assert.equal(b.state.screen, id);
    const i = b.state.model.hosts.findIndex((h) => h.name === "edge");
    assert.equal(b.state.home.selected, i);
    assert.equal(b.state.matrix.col, i);
  }
});

test("a refresh keeps the selected host and the order of conflicts", async () => {
  const b = await bridgeFor(makeConfig(), { hosts: { server: ok({ conflicts: 1 }) }, remote: { server: { ok: true, items: [item("~/server.md")] } }, conflicts: { ok: true, items: [item("~/own.md")] } }, { app: { view: "conflicts", host: "server" } });
  b.press("r");
  await b.settle();
  assert.equal(conflictEntries(b.state)[0]!.host, "server");
  assert.equal(b.state.home.selected, b.state.model.hosts.findIndex((h) => h.name === "server"));
});

test("resolveStart: a known view and host resolve, the host without a view is home", () => {
  const model = loadModel(makeConfig(), "laptop");
  assert.deepEqual(resolveStart(model, undefined, undefined), { view: "home", host: null });
  assert.deepEqual(resolveStart(model, "matrix", "server"), { view: "matrix", host: "server" });
  assert.deepEqual(resolveStart(model, undefined, "box"), { view: "home", host: "box" });
});

test("resolveStart: an unknown view or host is refused with the valid names listed", () => {
  const model = loadModel(makeConfig(), "laptop");
  const view = resolveStart(model, "inbox", undefined);
  assert.ok("code" in view && view.code === "invalid");
  assert.match(view.messages![0]!, /unknown view 'inbox'.*home, matrix, conflicts, timeline, secrets, catalog, push/);
  const host = resolveStart(model, "home", "mainframe");
  assert.ok("code" in host && host.code === "invalid");
  assert.match(host.messages![0]!, /unknown host 'mainframe'.*laptop, box, edge, server/);
  assert.ok("code" in resolveStart(model, "", undefined), "an empty view is unknown");
  assert.ok("code" in resolveStart(model, undefined, ""), "an empty host is unknown");
  assert.ok("code" in resolveStart(model, "Home", undefined), "names are exact");
});

test("resolveStart: a config with no hosts has none to name", () => {
  const model = { ...loadModel(makeConfig(), "laptop"), hosts: [] };
  const r = resolveStart(model, undefined, "laptop");
  assert.ok("code" in r);
  assert.match(r.messages![0]!, /unknown host 'laptop'.*no hosts/);
});

