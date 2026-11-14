import { test } from "node:test";
import assert from "node:assert/strict";
import { clickCell, cellState, opLabel, suggestMessage, summaryLine } from "../src/ui/static/matrix.js";
import { routeOf } from "../src/ui/static/state.js";

const cell = (on: boolean, picked: any, excluded: any = null) => ({ on, picked, excluded });

test("a cell is from the defaults, added by the host, excluded, or off", () => {
  assert.equal(cellState(cell(true, "defaults")), "defaults");
  assert.equal(cellState(cell(true, "both")), "defaults");
  assert.equal(cellState(cell(true, "host")), "added");
  assert.equal(cellState(cell(false, "defaults", "host")), "excluded");
  assert.equal(cellState(cell(false, null)), "off");
  assert.equal(cellState(undefined), "off");
});

test("a click holds the smallest edit, and a second click takes it back", () => {
  const given = clickCell([], "box", "mcp", "tracker", cell(false, null));
  assert.deepEqual(given, [{ op: "add", host: "box", kind: "mcp", name: "tracker" }]);
  assert.deepEqual(clickCell(given, "box", "mcp", "tracker", cell(false, null)), []);
  assert.deepEqual(clickCell([], "box", "bundles", "core", cell(true, "defaults")), [{ op: "remove", host: "box", kind: "bundles", name: "core" }]);
  assert.deepEqual(clickCell([], "box", "mcp", "docs", cell(false, "defaults", "host")), [{ op: "add", host: "box", kind: "mcp", name: "docs" }]);
  const other = clickCell(given, "box", "mcp", "docs", cell(true, "defaults"));
  assert.equal(other.length, 2);
  assert.equal(clickCell(other, "box", "mcp", "tracker", cell(false, null)).length, 1, "only that cell's edit is taken back");
});

test("a host's pick changes read as one line", () => {
  const none = { skills: { added: [], removed: [] }, servers: { added: [], removed: [] } };
  assert.equal(summaryLine(none), null);
  assert.equal(summaryLine({ skills: { added: ["notes", "deploy"], removed: [] }, servers: { added: [], removed: ["docs"] } }), "+ skills notes, deploy; − server docs");
  assert.equal(summaryLine({ skills: { added: ["a"], removed: ["b", "c"] }, servers: { added: ["x", "y"], removed: [] } }), "+ skill a; + servers x, y; − skills b, c");
});

test("the commit message is suggested from the edits", () => {
  const op = (o: string, host: string, name: string, kind = "mcp") => ({ op: o, host, kind, name }) as any;
  assert.equal(suggestMessage([]), "");
  assert.equal(suggestMessage([op("add", "box", "tracker")]), "Give box tracker");
  assert.equal(suggestMessage([op("add", "box", "extra", "bundles"), op("add", "box", "tracker"), op("remove", "server", "docs")]), "Give box extra and tracker; take docs from server");
  assert.equal(suggestMessage([op("remove", "box", "a"), op("remove", "box", "b"), op("remove", "box", "c")]), "Take a, b and c from box");
  const many = ["h1", "h2", "h3", "h4"].map((h) => op("add", h, "a-long-server-name"));
  assert.equal(suggestMessage(many), "Change what 4 hosts get");
  assert.equal(opLabel(op("remove", "server", "docs")), "take server docs from server");
});

test("the matrix is the first screen", () => {
  assert.equal(routeOf(""), "matrix");
  assert.equal(routeOf("#/status"), "status");
});

test("nothing is written while a push runs, the repo has outside changes, an edit is stale or a host would not load", async () => {
  const { blockers } = await import("../src/ui/static/matrix.js");
  const ok = { outside: [], dropped: [], checks: [{ host: "a", loads: true }], running: false };
  assert.deepEqual(blockers(ok), []);
  assert.equal(blockers({ ...ok, running: true }).length, 1);
  assert.match(blockers({ ...ok, outside: [" M x"] })[0]!, /changes the page did not make/);
  assert.match(blockers({ ...ok, dropped: [1] })[0]!, /no longer apply/);
  assert.match(blockers({ ...ok, checks: [{ host: "b", loads: false }] })[0]!, /does not load for b/);
});
