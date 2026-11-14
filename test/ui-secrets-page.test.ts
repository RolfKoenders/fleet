import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { actionOf, afterSet, cellView, dialogTargets, fileOf, heldNames, MAX_VALUE, missingCount, setBody, valueProblem } from "../src/ui/static/secrets.js";
import { opLabel, suggestMessage } from "../src/ui/static/matrix.js";
import { createClient } from "../src/ui/static/api.js";
import { repoRoot } from "./helpers.ts";

const cell = (state: string, from: string | null = null) => ({ state, from }) as any;
const table = {
  hosts: [{ name: "laptop", age: true }, { name: "edge", age: true }, { name: "remote", age: true }, { name: "bare", age: false }],
  names: [],
  problems: [],
} as any;
const docs = { name: "DOCS_TOKEN", usedBy: ["docs"], cells: { laptop: cell("unused"), edge: cell("missing"), remote: cell("missing"), bare: cell("unused") }, targets: ["edge", "remote"] } as any;
const op = (file: string, names: string[]) => ({ op: "setSecret", file, names, base: "absent", content: "x" }) as any;

test("a cell says set, set from shared, missing or not used, and whether its value is held", () => {
  assert.deepEqual(cellView(cell("set", "host"), "A", "box", []), { mark: "✓", word: "set", tone: "have", held: false });
  assert.deepEqual(cellView(cell("set", "shared"), "A", "box", []), { mark: "✓", word: "set (shared)", tone: "have", held: false });
  assert.deepEqual(cellView(cell("missing"), "A", "box", []), { mark: "!", word: "missing", tone: "miss", held: false });
  assert.equal(cellView(cell("unused"), "A", "box", []).tone, "na");
  assert.equal(cellView(undefined, "A", "box", []).word, "not used");
  assert.equal(cellView(cell("set", "host"), "A", "box", [op("secrets/box.enc.yaml", ["A"])]).held, true);
  assert.equal(cellView(cell("set", "host"), "B", "box", [op("secrets/box.enc.yaml", ["A"])]).held, false, "another name");
  assert.equal(cellView(cell("set", "host"), "A", "box", [op("secrets/other.enc.yaml", ["A"])]).held, false, "another host's file");
  assert.equal(cellView(cell("set", "shared"), "A", "box", [op("secrets/shared.enc.yaml", ["A"])]).held, true);
});

test("the button says Set for one host, Set value for several or none, and Replace value when it is set everywhere it is needed", () => {
  assert.equal(actionOf(docs).label, "Set value");
  assert.equal(actionOf({ ...docs, cells: { ...docs.cells, remote: cell("set", "host") } }).label, "Set for edge");
  assert.equal(actionOf({ ...docs, cells: { laptop: cell("set", "host"), edge: cell("unused") } }).label, "Replace value");
  assert.equal(actionOf({ ...docs, cells: { laptop: cell("unused") } }).label, "Set value");
});

test("the dialog ticks the hosts that need the secret and lack it, never shared, and never a host with no age key", () => {
  const t = dialogTargets(table, docs);
  assert.deepEqual(t.map((x) => [x.file, x.checked, x.disabled]), [["laptop", false, false], ["edge", true, false], ["remote", true, false], ["bare", false, true], ["shared", false, false]]);
  assert.equal(t.find((x) => x.file === "bare")!.note, "no age key");
  // A row that nobody needs offers nothing ticked; a ticked host with no key cannot be.
  assert.equal(dialogTargets(table, { ...docs, targets: [] }).some((x) => x.checked), false);
  assert.equal(dialogTargets(table, { ...docs, targets: ["bare"] }).find((x) => x.file === "bare")!.checked, false);
  assert.equal(dialogTargets({ ...table, hosts: [{ name: "bare", age: false }] }, docs).find((x) => x.file === "shared")!.disabled, true);
});

test("a value is checked without being repeated", () => {
  assert.match(valueProblem("")!, /Type the value/);
  assert.equal(valueProblem("x".repeat(MAX_VALUE)), null);
  const long = valueProblem("secret-".repeat(2000))!;
  assert.match(long, /at most 8192/);
  assert.equal(long.includes("secret-"), false);
});

test("the request is the name, the value, the files and the held edits, and the value goes nowhere else", async () => {
  assert.deepEqual(setBody("A", "v", ["box"], []), { name: "A", value: "v", files: ["box"], ops: [] });
  const sent: { url: string; init: RequestInit }[] = [];
  const client = createClient("tok", (async (url: string, init: RequestInit) => (sent.push({ url, init }), new Response(JSON.stringify({ ok: true, ops: [], replaces: [] }), { status: 200 }))) as any);
  await client.setSecret("A", "FAKE-VALUE-1", ["box"], []);
  assert.equal(sent[0]!.url, "/api/secrets/set");
  assert.equal(sent[0]!.url.includes("FAKE-VALUE"), false, "not in the URL");
  assert.equal(JSON.stringify(sent[0]!.init.headers).includes("FAKE-VALUE"), false, "not in a header");
  assert.equal(JSON.parse(sent[0]!.init.body as string).value, "FAKE-VALUE-1");
  // An error from the server becomes a message that holds only the server's words.
  const failing = createClient("tok", (async () => new Response(JSON.stringify({ ok: false, code: "sops-failed", messages: ["fleet: sops could not set the value in secrets/box.enc.yaml"] }), { status: 422 })) as any);
  await assert.rejects(() => failing.setSecret("A", "FAKE-VALUE-2", ["box"], []), (e: any) => e.code === "sops-failed" && !e.message.includes("FAKE-VALUE") && !JSON.stringify(e.messages).includes("FAKE-VALUE"));
});

test("a set value replaces the held edit for its file and keeps the rest", () => {
  const a = op("secrets/box.enc.yaml", ["A"]);
  const other = op("secrets/edge.enc.yaml", ["A"]);
  const pick = { op: "add", host: "box", kind: "mcp", name: "docs" };
  const next = op("secrets/box.enc.yaml", ["A", "B"]);
  assert.deepEqual(afterSet([pick, a, other], { ops: [next], replaces: ["secrets/box.enc.yaml"] }), [pick, other, next]);
  assert.deepEqual(afterSet([], { ops: [a], replaces: [a.file] }), [a]);
  assert.equal(fileOf("shared"), "secrets/shared.enc.yaml");
});

test("held values are listed by name with the files they are for, and counted as missing by the table", () => {
  assert.deepEqual(heldNames([op("secrets/box.enc.yaml", ["A", "B"]), op("secrets/shared.enc.yaml", ["A"]), { op: "add", host: "x", kind: "mcp", name: "y" }]), [{ name: "A", files: ["box", "shared"] }, { name: "B", files: ["box"] }]);
  assert.equal(missingCount({ ...table, names: [docs, { ...docs, name: "X" }] }), 4);
  assert.equal(missingCount(null), 0);
});

test("the commit message and the list of dropped edits name the secret and never a value", () => {
  assert.equal(suggestMessage([op("secrets/box.enc.yaml", ["DOCS_TOKEN"]), op("secrets/edge.enc.yaml", ["DOCS_TOKEN"])]), "Set DOCS_TOKEN for box and edge");
  assert.equal(suggestMessage([op("secrets/shared.enc.yaml", ["DOCS_TOKEN"])]), "Set DOCS_TOKEN for every host");
  assert.equal(opLabel(op("secrets/box.enc.yaml", ["A", "B"])), "set A, B in secrets/box.enc.yaml");
});

test("the page keeps no value: the field is not named, not remembered and emptied, and nothing puts it in state, storage or the address", () => {
  const source = readFileSync(join(repoRoot, "src/ui/static/app.js"), "utf8");
  const dialog = source.slice(source.indexOf("function openSecretDialog"), source.indexOf("function reviewScreen"));
  assert.match(dialog, /type: "password"/);
  assert.match(dialog, /autocomplete: "new-password"/);
  assert.doesNotMatch(dialog, /\bname: "/, "an unnamed field is not offered to a password manager as a form entry");
  assert.match(dialog, /input\.value = ""/);
  // The value is read once, into a local; no assignment to the model, storage, history or location from it.
  assert.equal((dialog.match(/input\.value/g) ?? []).length >= 4, true);
  assert.doesNotMatch(dialog, /model\.[a-zA-Z]+ = [^;]*value|localStorage|sessionStorage|history\.|location\./);
  // The only storage is the tab's `sessionStorage` in session.js, which keeps the token and the To push list (edits, ciphertext only).
  for (const file of ["app.js", "api.js", "secrets.js", "state.js", "link.js", "jobs.js"]) {
    const text = readFileSync(join(repoRoot, "src/ui/static", file), "utf8");
    assert.doesNotMatch(text, /localStorage|sessionStorage/, file);
    assert.doesNotMatch(text, /console\.(log|info|debug)/, file);
  }
});
