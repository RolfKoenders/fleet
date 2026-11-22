import { test } from "node:test";
import assert from "node:assert/strict";
import { decisionOf, differsLine, doneWords, draftOf, problemOf, rowsOf, sourceWord, withVariant } from "../src/ui/static/capture.js";
import { loadCaptured, saveCaptured } from "../src/ui/static/session.js";
import { opLabel, suggestMessage } from "../src/ui/static/matrix.js";
import { ROUTES, routeOf } from "../src/ui/static/state.js";
import { jobsOf } from "../src/ui/static/jobs.js";

const keys = (names: [string, string, boolean, string | null][]) => names.map(([where, key, secret, name]) => ({ where, key, secret, name }));
const server = (variants: any[]) => ({ kind: "mcp" as const, name: "docs", state: "new" as const, message: null, agents: ["claude", "opencode"], variants });
const variant = (agents: string[], k: any[]) => ({ agents, command: null, transport: "http", url: "https://a.example.com/mcp", keys: k, warning: null });

test("a draft starts from the defaults: this host, the first definition, a secret for each key named like one", () => {
  const item = server([variant(["claude"], keys([["headers", "Authorization", true, "DOCS_AUTHORIZATION"], ["env", "REGION", false, "DOCS_REGION"]]))]);
  const d = draftOf(item as any);
  assert.deepEqual([d.scope, d.variant, d.onlyHad], ["host", 0, false]);
  assert.deepEqual(rowsOf(item as any, d).map((r) => [r.key, r.secret, r.name]), [["Authorization", true, "DOCS_AUTHORIZATION"], ["REGION", false, "DOCS_REGION"]]);
  assert.deepEqual(decisionOf(item as any, "add", d), { kind: "mcp", name: "docs", action: "add", scope: "host", variant: 0, onlyHad: false, secrets: [{ where: "headers", key: "Authorization", name: "DOCS_AUTHORIZATION" }] });
});

test("turning a plain key into a secret, and another definition, change the request", () => {
  const item = server([variant(["claude"], keys([["env", "A", false, "DOCS_A"]])), variant(["opencode"], keys([["env", "B", true, "DOCS_B"]]))]) as any;
  let d = draftOf(item);
  d = { ...d, secrets: { "env:A": { secret: true, name: "DOCS_A" } } };
  assert.deepEqual((decisionOf(item, "add", d) as any).secrets, [{ where: "env", key: "A", name: "DOCS_A" }]);
  d = withVariant(item, d, 1);
  assert.deepEqual(decisionOf(item, "add", d), { kind: "mcp", name: "docs", action: "add", scope: "host", variant: 1, onlyHad: false, secrets: [{ where: "env", key: "B", name: "DOCS_B" }] });
});

test("a bad secret name, a repeated one and a bad bundle name are caught before the request", () => {
  const item = server([variant(["claude"], keys([["env", "A", true, "DOCS_A"], ["env", "B", true, "DOCS_B"]]))]) as any;
  const d = draftOf(item);
  assert.equal(problemOf(item, d), null);
  assert.match(problemOf(item, { ...d, secrets: { ...d.secrets, "env:A": { secret: true, name: "lower" } } })!, /capital letters/);
  assert.match(problemOf(item, { ...d, secrets: { ...d.secrets, "env:A": { secret: true, name: "DOCS_B" } } })!, /same secret name/);
  const skill = { kind: "skill", name: "review", state: "new", message: null, path: "~/x", repo: { repo: "git@example.com:me/skill-box.git", path: "skills", commit: "a".repeat(40), track: "main", dirty: false, source: null }, bundle: null } as any;
  const s = draftOf(skill);
  assert.equal(s.bundle, "skill-box", "named after the source");
  assert.equal(problemOf(skill, s), null);
  assert.match(problemOf(skill, { ...s, bundle: "no spaces" })!, /bundle name/);
  assert.deepEqual(decisionOf(skill, "add", { ...s, scope: "all" }), { kind: "skill", name: "review", action: "add", scope: "all", bundle: "skill-box" });
  assert.equal(sourceWord("https://example.com/me/skills/"), "skills");
});

test("ignore and take over carry no choices, and the words and the route are the page's", () => {
  const item = server([variant(["claude"], [])]) as any;
  assert.deepEqual(decisionOf(item, "ignore", draftOf(item)), { kind: "mcp", name: "docs", action: "ignore", scope: "host" });
  assert.equal(doneWords("add", "all"), "added for every host");
  assert.equal(differsLine(2), "2 differ from the catalog: see fleet status --conflicts");
  assert.equal(differsLine(0), null);
  assert.equal(routeOf("#/capture"), "capture");
  assert.equal(ROUTES.indexOf("capture"), ROUTES.indexOf("hosts") + 1, "after Hosts in the menu");
});

test("an ignore is labelled and in the suggested message", () => {
  const op = { op: "ignore", host: "box", item: "mcp:x" } as const;
  assert.equal(opLabel(op), "ignore mcp:x on box");
  assert.equal(suggestMessage([op]), "Ignore mcp:x");
  assert.deepEqual(jobsOf({ jobs: [{ kind: "secret", name: "docs" }] }), [{ kind: "secret", name: "docs" }]);
});

test("what Capture answered is kept for a reload as names only, and damaged storage restores nothing", () => {
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  saveCaptured(store, { captured: [{ kind: "mcp", name: "docs" }], done: { "mcp:docs": "added for this host" } });
  assert.deepEqual(loadCaptured(store), { captured: [{ kind: "mcp", name: "docs" }], done: { "mcp:docs": "added for this host" } });
  saveCaptured(store, { captured: [], done: {} });
  assert.equal(mem.size, 0);
  mem.set("fleet-ui-captured", "{not json");
  assert.deepEqual(loadCaptured(store), { captured: [], done: {} });
  mem.set("fleet-ui-captured", JSON.stringify({ captured: [{ kind: "x", name: 1 }, { kind: "skill", name: "ok" }], done: { a: 1, b: "fine" } }));
  assert.deepEqual(loadCaptured(store), { captured: [{ kind: "skill", name: "ok" }], done: { b: "fine" } });
});

// ---- the screen, drawn on a minimal DOM: no browser here, so this holds that it builds, and that its buttons answer.

class El {
  attrs = new Map<string, string>();
  kids: (El | string)[] = [];
  listeners = new Map<string, ((e: any) => void)[]>();
  readonly tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  addEventListener(k: string, f: (e: any) => void) {
    this.listeners.set(k, [...(this.listeners.get(k) ?? []), f]);
  }
  append(...kids: (El | string)[]) {
    this.kids.push(...kids);
  }
  text(): string {
    return this.kids.map((k) => (typeof k === "string" ? k : k.text())).join(" ");
  }
  find(id: string): El | null {
    if (this.attrs.get("id") === id) return this;
    for (const k of this.kids) if (typeof k !== "string") {
      const f = k.find(id);
      if (f) return f;
    }
    return null;
  }
}

test("the Capture screen draws a card for each item, and its buttons give the answer the page acts on", async () => {
  (globalThis as any).document = { createElement: (tag: string) => new El(tag) };
  const { captureScreen } = await import("../src/ui/static/captureview.js");
  const item = server([variant(["claude"], keys([["headers", "Authorization", true, "DOCS_AUTHORIZATION"]])), variant(["opencode"], [])]) as any;
  const loose = { kind: "skill", name: "loose", state: "blocked", message: "it is not in a git repo: put it in a repo with a remote first", path: "~/.claude/skills/loose", repo: null, bundle: null };
  const same = { kind: "mcp", name: "stats", state: "takeover", message: null, agents: ["claude"], variants: [variant(["claude"], [])] };
  const drafts = Object.fromEntries([item, loose, same].map((i) => [`${i.kind}:${i.name}`, draftOf(i)]));
  const answered: string[] = [];
  const changed: string[] = [];
  const screen = (done: Record<string, string> = {}) =>
    captureScreen({ doc: { host: "laptop", items: [item, loose, same], differs: [{ kind: "mcp", name: "x" }], notes: [] }, error: null, usable: true, busy: null, drafts, done, agents: [{ id: "claude", used: true }, { id: "opencode", used: true }], notice: null, change: (id) => void changed.push(id), answer: (i, a) => void answered.push(`${a}:${i.name}`) }) as unknown as El;
  const root = screen();
  const text = root.text();
  assert.match(text, /docs/);
  assert.match(text, /cannot be captured/);
  assert.match(text, /put it in a repo/);
  assert.match(text, /1 differs from the catalog: see fleet status --conflicts/);
  assert.match(text, /Take the one in claude/);
  for (const id of ["cap-add-mcp:docs", "cap-ignore-mcp:docs", "cap-ignore-skill:loose", "cap-takeover-mcp:stats"]) root.find(id)!.listeners.get("click")![0]!({});
  assert.deepEqual(answered, ["add:docs", "ignore:docs", "ignore:loose", "takeover:stats"]);
  assert.equal(root.find("cap-add-skill:loose"), null, "a blocked item can only be ignored");
  root.find("cap-scope-all-mcp:docs")!.listeners.get("click")![0]!({});
  assert.deepEqual(changed, ["mcp:docs"]);
  // Once chosen, an item says so and offers no second answer.
  const after = screen({ "mcp:docs": "added for this host" });
  assert.match(after.text(), /added for this host, to push/);
  assert.equal(after.find("cap-add-mcp:docs"), null);
  // Nothing is drawn from a value: the doc holds none, and a disabled screen disables the answers.
  const off = captureScreen({ doc: { host: "laptop", items: [item], differs: [], notes: [] }, error: null, usable: false, busy: null, drafts, done: {}, agents: [], notice: null, change: () => {}, answer: () => {} }) as unknown as El;
  assert.ok(off.find("cap-add-mcp:docs")!.attrs.has("disabled"));
  const empty = captureScreen({ doc: { host: "laptop", items: [], differs: [], notes: [] }, error: null, usable: true, busy: null, drafts: {}, done: {}, agents: [], notice: null, change: () => {}, answer: () => {} }) as unknown as El;
  assert.ok(empty.find("capture-empty") !== null);
});
