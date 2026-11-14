import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ADD, CATALOG_KINDS, closable, confirmLabel, fileOf, freshAdd, hostAsDraft, hostMissing, nearChanges, paneView } from "../src/ui/static/adding.js";
import { blankHost } from "../src/ui/static/hosts.js";
import { lineDiff, splitLines } from "../src/ui/static/diff.js";

const host = (over: Record<string, string> = {}) => ({ ...blankHost(), ...over });
const ready = { op: { op: "addBundle", name: "writing", skills: ["alpha"] }, problems: [] };
const live = (d: { op: unknown }, doc: unknown, error: string | null = null) => ({ key: JSON.stringify(d.op), doc, error });
const answer = (after: string, over: Record<string, unknown> = {}) => ({ dropped: [], checks: [{ host: "laptop", loads: true, problems: [] }], files: [{ path: "catalog/skills.yaml", before: "bundles:\n  core: [review]\n", after }], ...over });

test("each dialog names the file it writes, and a host's file has the name typed so far", () => {
  assert.deepEqual(CATALOG_KINDS, ["server", "source", "bundle"]);
  assert.equal(fileOf("server"), "catalog/mcp.yaml");
  assert.equal(fileOf("source"), "catalog/skills.yaml");
  assert.equal(fileOf("bundle"), "catalog/skills.yaml");
  assert.equal(fileOf("host", " mini "), "hosts/mini.yaml");
  assert.equal(fileOf("host"), "hosts/<name>.yaml");
  assert.equal(ADD.server.title, "Add an MCP server");
});

test("the confirm button says what happens: an addition goes to push, a host is set up", () => {
  for (const k of CATALOG_KINDS) assert.equal(confirmLabel(k), "Add to push");
  assert.equal(confirmLabel("host"), "Add and set it up");
});

test("a form that is not valid yet shows what is missing, and no diff", () => {
  const p = paneView("bundle", { op: null, problems: ["give it a name", "pick at least one skill"] }, null, null);
  assert.equal(p.state, "missing");
  assert.deepEqual(p.problems, ["give it a name", "pick at least one skill"]);
  assert.deepEqual(p.lines, []);
  assert.equal(p.path, "catalog/skills.yaml");
  assert.equal(p.tag, "not ready");
});

test("a valid form waits for the server's answer for exactly that edit, then shows the diff against the file", () => {
  assert.equal(paneView("bundle", ready, null, null).state, "reading");
  assert.equal(paneView("bundle", ready, { key: "an older edit", doc: answer(""), error: null }, null).state, "reading", "an answer for another edit is not shown");
  const p = paneView("bundle", ready, live(ready, answer("bundles:\n  core: [review]\n  writing: [alpha]\n")), null);
  assert.equal(p.state, "diff");
  assert.equal(p.tag, "+ added at the end of bundles");
  assert.deepEqual(p.lines.filter(([o]) => o !== " "), [["+", "  writing: [alpha]"]]);
  assert.equal(p.broken, null);
});

test("against the file with the edits already to push, so only this addition shows", () => {
  const held = "bundles:\n  core: [review]\n  other: [x]\n";
  const p = paneView("bundle", ready, live(ready, answer(held + "  writing: [alpha]\n")), held);
  assert.deepEqual(p.lines.filter(([o]) => o !== " "), [["+", "  writing: [alpha]"]]);
});

test("a refusal, an edit that does not apply and a config that would not load are said, not drawn as a diff", () => {
  const refused = paneView("bundle", ready, live(ready, null, "the file could not be previewed"), null);
  assert.deepEqual([refused.state, refused.message, refused.tone], ["refused", "the file could not be previewed", "bad"]);
  const dropped = paneView("bundle", ready, live(ready, answer("", { dropped: [{ op: ready.op, reason: "'writing' is already in catalog/skills.yaml" }] })), null);
  assert.deepEqual([dropped.state, dropped.message], ["refused", "'writing' is already in catalog/skills.yaml"]);
  const broken = paneView("bundle", ready, live(ready, answer("x\n", { checks: [{ host: "box", loads: false, problems: ["skill 'alpha' is in no source"] }, { host: "laptop", loads: true, problems: [] }] })), null);
  assert.equal(broken.state, "diff");
  assert.equal(broken.broken, "With this, the config does not load for box: skill 'alpha' is in no source");
});

test("a long file shows only the lines around the change, with a gap marked", () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  const after = [...before.slice(0, 15), "new", ...before.slice(15)];
  const lines = nearChanges(lineDiff(before, after), 2);
  assert.deepEqual(lines.map(([, l]) => l), ["...", "line 13", "line 14", "new", "line 15", "line 16"]);
  assert.equal(lines.filter(([o]) => o === "+").length, 1);
  assert.deepEqual(nearChanges(lineDiff(["a"], ["a"]), 2), [], "nothing changed, nothing shown");
});

test("the host dialog says what it still needs: a name and how to reach it, then what is wrong", () => {
  const names = ["laptop", "box"];
  assert.deepEqual(hostMissing(host(), names), ["give it a name", "say how to reach it over ssh, for example user@host: fleet init needs it"]);
  assert.deepEqual(hostMissing(host({ name: "mini" }), names), ["say how to reach it over ssh, for example user@host: fleet init needs it"]);
  assert.deepEqual(hostMissing(host({ name: "box", ssh: "-oX" }), names), ["box is already a host.", "A destination cannot start with '-': ssh would read it as an option."]);
  assert.deepEqual(hostMissing(host({ name: "mini", ssh: "me@mini", from: "gone" }), names), ["there is no host 'gone' to copy from"]);
  assert.deepEqual(hostMissing(host({ name: "mini", ssh: "me@mini", from: "box" }), names), []);
});

test("the host form is a draft like the others: the request it would make, or what is missing", () => {
  const names = ["laptop"];
  assert.deepEqual(hostAsDraft(host({ name: "mini", ssh: "me@mini" }), names), { op: { name: "mini", ssh: "me@mini", from: null }, problems: [], warnings: [] });
  const d = hostAsDraft(host({ name: "mini" }), names);
  assert.equal(d.op, null);
  assert.equal(d.problems.length, 1);
});

test("a new host's file is all additions, with its path from the request", () => {
  const d = hostAsDraft(host({ name: "mini", ssh: "me@mini" }), []);
  const p = paneView("host", d, live(d, { path: "hosts/mini.yaml", before: "", after: 'ssh: me@mini\nage: ""\n' }), null);
  assert.equal(p.path, "hosts/mini.yaml");
  assert.equal(p.tag, "+ new file");
  assert.deepEqual(p.lines, [["+", "ssh: me@mini"], ["+", 'age: ""']]);
  assert.equal(paneView("host", hostAsDraft(host({ name: "mini" }), []), null, null, "mini").path, "hosts/mini.yaml", "the path is named while it is not ready too");
  assert.deepEqual(lineDiff([], splitLines("a\n")), [["+", "a"]]);
});

test("Esc and Cancel close the dialog, except while a host is being set up", () => {
  for (const k of ["server", "source", "bundle", "host"] as const) assert.equal(closable(k, { running: false }), true, k);
  for (const k of ["server", "source", "bundle"] as const) assert.equal(closable(k, { running: true }), true, `${k}: a run is only a host's`);
  assert.equal(closable("host", { running: true }), false);
});

test("a dialog starts blank every time, and no two share a form", () => {
  const a = freshAdd("server");
  const b = freshAdd("server");
  a.server.rows.push({ key: "X", mode: "plain", value: "1" });
  a.bundle.picked.push("alpha");
  assert.equal(b.server.rows.length, 1);
  assert.deepEqual(b.bundle.picked, []);
  assert.deepEqual([b.live, b.confirm, b.check, b.clone.state], [null, false, null, "idle"]);
  assert.deepEqual(b.host, blankHost());
});

test("the page says to push, never to stage, and has no inline add forms left", () => {
  for (const file of ["app.js", "adding.js", "catalog.js", "hosts.js", "state.js", "matrix.js", "secrets.js", "index.html"]) {
    const text = readFileSync(new URL(`../src/ui/static/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(text, /\b[Uu]nstage|\bStage it|"Stage|Take back"/, file);
  }
  const app = readFileSync(new URL("../src/ui/static/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /addform|addhost|model\.hostForm|hostConfirm/);
  assert.match(app, /Remove from push/);
  assert.match(app, /showModal\(\)/);
});
