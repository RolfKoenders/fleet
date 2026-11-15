import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeAction, filterRows, hashWithQuery, hiddenWithChanges, nameMatches, queryOf, rowOfOp, skillHits, slashFocuses } from "../src/ui/static/filter.js";
import { routeOf, tokenOf } from "../src/ui/static/state.js";

test("the filter is kept in the hash query and the screen and token handling ignore it", () => {
  assert.equal(queryOf("#/matrix?q=git"), "git");
  assert.equal(queryOf("#/matrix"), "");
  assert.equal(queryOf("#/matrix?q="), "");
  assert.equal(queryOf("#/catalog?q=a%20b%26c"), "a b&c");
  assert.equal(routeOf("#/matrix?q=git"), "matrix");
  assert.equal(routeOf("#/catalog?q=git"), "catalog");
  assert.equal(routeOf("#/hosts?q=x"), "hosts");
  assert.equal(tokenOf("#/matrix?q=git"), null);
  assert.equal(tokenOf("#t=abc"), "abc");
});

test("a query round-trips through the hash, and a blank one leaves none", () => {
  for (const q of ["git", "a b", "x&y=z", "100%", "é #"]) assert.equal(queryOf(hashWithQuery("#/matrix", q)), q);
  assert.equal(hashWithQuery("#/matrix", ""), "#/matrix");
  assert.equal(hashWithQuery("#/matrix", "   "), "#/matrix");
  assert.equal(hashWithQuery("#/matrix?q=old", "new"), "#/matrix?q=new");
  assert.equal(hashWithQuery("#/matrix?q=old", ""), "#/matrix");
});

test("names match without regard to case, and a blank filter matches everything", () => {
  assert.equal(nameMatches("GitHub", "git"), true);
  assert.equal(nameMatches("github", "  HUB "), true);
  assert.equal(nameMatches("github", "lab"), false);
  assert.equal(nameMatches("anything", ""), true);
  assert.equal(nameMatches("anything", "  "), true);
});

test("a bundle matches by its name or by one of its skills", () => {
  const bundles = [
    { name: "core", skills: ["git-flow", "notes"] },
    { name: "web", skills: ["deploy"] },
    { name: "Git-tools", skills: [] },
  ];
  const skills = (b: { skills: string[] }) => b.skills;
  assert.deepEqual(filterRows(bundles, "git", skills).map((b) => b.name), ["core", "Git-tools"]);
  assert.deepEqual(filterRows(bundles, "deploy", skills).map((b) => b.name), ["web"]);
  assert.deepEqual(filterRows(bundles, "zzz", skills), []);
  assert.equal(filterRows(bundles, "", skills).length, 3);
  assert.deepEqual(filterRows(bundles, "git").map((b) => b.name), ["Git-tools"], "without skills only names count");
  assert.deepEqual(skillHits(["git-flow", "notes", "GIT"], "git"), ["git-flow", "GIT"]);
  assert.deepEqual(skillHits(["a"], ""), []);
});

test("an edit says which row it is about, and a secret is about none", () => {
  assert.deepEqual(rowOfOp({ op: "add", host: "box", kind: "mcp", name: "docs" }), { kind: "mcp", name: "docs" });
  assert.deepEqual(rowOfOp({ op: "remove", host: "box", kind: "bundles", name: "core" }), { kind: "bundles", name: "core" });
  assert.deepEqual(rowOfOp({ op: "addServer", name: "s", entry: {} }), { kind: "mcp", name: "s" });
  assert.deepEqual(rowOfOp({ op: "addSource", name: "src", entry: {} }), { kind: "source", name: "src" });
  assert.deepEqual(rowOfOp({ op: "addBundle", name: "b", skills: [] }), { kind: "bundles", name: "b" });
  assert.equal(rowOfOp({ op: "setSecret", file: "shared", names: ["A"], base: "", content: "" }), null);
});

test("the filter says how many hidden rows have an edit on To push", () => {
  const hidden = [
    { kind: "mcp", name: "docs" },
    { kind: "bundles", name: "core" },
    { kind: "bundles", name: "docs" },
    { kind: "mcp", name: "tracker" },
  ] as const;
  const ops = [
    { op: "add", host: "box", kind: "mcp", name: "docs" },
    { op: "remove", host: "box", kind: "mcp", name: "docs" },
    { op: "addBundle", name: "core", skills: [] },
    { op: "setSecret", file: "shared", names: ["T"], base: "", content: "" },
  ] as any[];
  assert.deepEqual(hiddenWithChanges([...hidden], ops), ["docs", "core"], "a row counts once, and a bundle is not the server of the same name");
  assert.deepEqual(hiddenWithChanges([...hidden], []), []);
  assert.deepEqual(hiddenWithChanges([], ops), []);
});

test("/ goes to the search field only as a bare key, outside other fields and dialogs; Esc clears, then leaves", () => {
  const key = (k: string, more: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; defaultPrevented: boolean }> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, ...more });
  assert.equal(slashFocuses(key("/"), false, false), true);
  assert.equal(slashFocuses(key("/"), true, false), false, "typed in another field");
  assert.equal(slashFocuses(key("/"), false, true), false, "a dialog is open");
  for (const mod of ["ctrlKey", "metaKey", "altKey", "defaultPrevented"] as const) assert.equal(slashFocuses(key("/", { [mod]: true }), false, false), false, mod);
  assert.equal(slashFocuses(key("?"), false, false), false);
  assert.equal(escapeAction("git"), "clear");
  assert.equal(escapeAction(" "), "clear", "what was typed is cleared, even a space");
  assert.equal(escapeAction(""), "blur");
});
