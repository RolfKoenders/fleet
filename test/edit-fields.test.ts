import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "../vendor/js-yaml.mjs";
import { applyOps, entryProblem, entryValue } from "../src/edit/index.ts";
import type { EditOp, Files } from "../src/edit/index.ts";

const MCP = `# Servers every host may pick.
servers:
  docs:
    command: [npx, -y, "@example/docs-mcp@1.0.0"]  # the docs server
    env:
      DOCS_TOKEN: secret:DOCS_TOKEN # keep it secret
      REGION: eu
    only: [claude]

  tracker:
    transport: http
    url: https://tracker.example.com/mcp # live
    headers:
      Authorization: secret:TRACKER_TOKEN
`;

const SKILLS = `# Where skills come from.
sources:
  mine:
    repo: https://example.com/mine.git
    commit: ${"a".repeat(40)} # pinned
    track: main
    path: skills # where they are
    review: true
  loose:
    repo: https://example.com/loose.git
    branch: main
    path: .

bundles:
  core:
    - review # first
    - debug
    # a note on the next one
    - notes
  extra: [alpha, beta] # flow
`;

const HOST = `# The laptop.
ssh: me@laptop.local # reach it here
age: ""
mcp:
  include: [docs]
`;

const files = (): Files => ({ "catalog/mcp.yaml": MCP, "catalog/skills.yaml": SKILLS, "hosts/laptop.yaml": HOST, "hosts/bare.yaml": "age: \"\"\n" });

/** Applies one op and says what it did: no drop is allowed. */
function run(op: EditOp, f: Files = files()): Files {
  const r = applyOps(f, [op]);
  assert.deepEqual(r.dropped, [], JSON.stringify(r.dropped));
  return r.files;
}

/** The lines that differ between two texts, once the shared head and tail are cut away. */
function diff(before: string, after: string): { removed: string[]; added: string[] } {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { removed: a.slice(head, a.length - tail), added: b.slice(head, b.length - tail) };
}

const dropped = (op: EditOp, f: Files = files()) => applyOps(f, [op]).dropped[0];

test("a server's command changes in place and keeps the comment at the end of its line", () => {
  const out = run({ op: "editServer", name: "docs", changes: [{ key: "command", from: ["npx", "-y", "@example/docs-mcp@1.0.0"], to: ["npx", "-y", "@example/docs-mcp@1.1.0"] }] });
  assert.deepEqual(diff(MCP, out["catalog/mcp.yaml"]!), {
    removed: ['    command: [npx, -y, "@example/docs-mcp@1.0.0"]  # the docs server'],
    added: ['    command: [npx, -y, "@example/docs-mcp@1.1.0"]  # the docs server'],
  });
  assert.equal(out["catalog/skills.yaml"], SKILLS, "no other file moves");
});

test("a plain value, a secret and a new variable change one line each; a cleared variable goes with its line and comment", () => {
  const out = run({
    op: "editServer",
    name: "docs",
    changes: [{ key: "env", from: { DOCS_TOKEN: "secret:DOCS_TOKEN", REGION: "eu" }, to: { DOCS_TOKEN: "REGION_PLAIN", REGION: "us", EXTRA: "secret:EXTRA" } }],
  })["catalog/mcp.yaml"]!;
  assert.deepEqual(diff(MCP, out), {
    removed: ["      DOCS_TOKEN: secret:DOCS_TOKEN # keep it secret", "      REGION: eu"],
    added: ["      DOCS_TOKEN: REGION_PLAIN # keep it secret", "      REGION: us", "      EXTRA: secret:EXTRA"],
  });
  const gone = run({ op: "editServer", name: "docs", changes: [{ key: "env", from: { DOCS_TOKEN: "secret:DOCS_TOKEN", REGION: "eu" }, to: { REGION: "eu" } }] })["catalog/mcp.yaml"]!;
  assert.deepEqual(diff(MCP, gone), { removed: ["      DOCS_TOKEN: secret:DOCS_TOKEN # keep it secret"], added: [] });
});

test("only a changed secret line moves: the comment after an untouched value stays", () => {
  const out = run({ op: "editServer", name: "docs", changes: [{ key: "env", from: { DOCS_TOKEN: "secret:DOCS_TOKEN", REGION: "eu" }, to: { DOCS_TOKEN: "secret:DOCS_TOKEN", REGION: "us" } }] })["catalog/mcp.yaml"]!;
  assert.deepEqual(diff(MCP, out), { removed: ["      REGION: eu"], added: ["      REGION: us"] });
  assert.match(out, /DOCS_TOKEN: secret:DOCS_TOKEN # keep it secret/);
});

test("emptying every variable leaves {} and drops the lines under it", () => {
  const out = run({ op: "editServer", name: "docs", changes: [{ key: "env", from: { DOCS_TOKEN: "secret:DOCS_TOKEN", REGION: "eu" }, to: {} }] })["catalog/mcp.yaml"]!;
  assert.deepEqual(load(out), { servers: { ...(load(MCP) as any).servers, docs: { command: ["npx", "-y", "@example/docs-mcp@1.0.0"], env: {}, only: ["claude"] } } });
  assert.match(out, /env: \{\}\n    only: \[claude\]/);
});

test("a cleared field is removed with its line, and a new one is placed where the entry writes it", () => {
  const out = run({ op: "editServer", name: "docs", changes: [{ key: "only", from: ["claude"], to: null }] })["catalog/mcp.yaml"]!;
  assert.deepEqual(diff(MCP, out), { removed: ["    only: [claude]"], added: [] });
  const back = run({ op: "editServer", name: "docs", changes: [{ key: "only", from: null, to: ["claude", "opencode"] }] }, { ...files(), "catalog/mcp.yaml": out })["catalog/mcp.yaml"]!;
  assert.deepEqual(diff(out, back), { removed: [], added: ["    only: [claude, opencode]"] });
});

test("switching a server from a command to a URL writes each key where the catalog puts it", () => {
  const out = run({
    op: "editServer",
    name: "docs",
    changes: [
      { key: "command", from: ["npx", "-y", "@example/docs-mcp@1.0.0"], to: null },
      { key: "env", from: { DOCS_TOKEN: "secret:DOCS_TOKEN", REGION: "eu" }, to: null },
      { key: "transport", from: null, to: "sse" },
      { key: "url", from: null, to: "https://docs.example.com/sse" },
      { key: "headers", from: null, to: { Authorization: "secret:DOCS_TOKEN" } },
    ],
  })["catalog/mcp.yaml"]!;
  const docs = (load(out) as any).servers.docs;
  assert.deepEqual(docs, { transport: "sse", url: "https://docs.example.com/sse", headers: { Authorization: "secret:DOCS_TOKEN" }, only: ["claude"] });
  assert.match(out, /docs:\n    transport: sse\n    url: https:\/\/docs\.example\.com\/sse\n    headers:\n      Authorization: secret:DOCS_TOKEN\n    only: \[claude\]\n/);
  assert.match(out, /# Servers every host may pick\./);
});

test("a changed URL keeps its comment, and another server is not touched", () => {
  const out = run({ op: "editServer", name: "tracker", changes: [{ key: "url", from: "https://tracker.example.com/mcp", to: "https://tracker.example.com/v2/mcp" }] })["catalog/mcp.yaml"]!;
  assert.deepEqual(diff(MCP, out), { removed: ["    url: https://tracker.example.com/mcp # live"], added: ["    url: https://tracker.example.com/v2/mcp # live"] });
});

test("an edit made from a value the file no longer holds is stale and writes nothing", () => {
  const d = dropped({ op: "editServer", name: "docs", changes: [{ key: "command", from: ["npx", "-y", "@example/docs-mcp@0.9.0"], to: ["npx", "-y", "x@1.0.0"] }] });
  assert.equal(d?.why, "stale");
  assert.match(d!.reason, /servers\.docs\.command.*changed in the file/);
  assert.equal(dropped({ op: "editServer", name: "docs", changes: [{ key: "only", from: null, to: ["opencode"] }] })?.why, "stale", "a field someone else added");
  assert.equal(dropped({ op: "editServer", name: "gone", changes: [{ key: "only", from: null, to: ["opencode"] }] })?.why, "stale", "an entry that is not there");
  const second = applyOps(files(), [
    { op: "editServer", name: "docs", changes: [{ key: "only", from: ["claude"], to: ["opencode"] }] },
    { op: "editServer", name: "docs", changes: [{ key: "only", from: ["claude"], to: null }] },
  ]);
  assert.equal(second.applied.length, 1);
  assert.equal(second.dropped[0]?.why, "stale", "two edits made from the same value: the second finds the first");
});

test("a source moves its pin and tracked branch, keeping the comments on the lines it keeps", () => {
  const sha = "b".repeat(40);
  const out = run({
    op: "editSource",
    name: "mine",
    changes: [
      { key: "commit", from: "a".repeat(40), to: sha },
      { key: "track", from: "main", to: "dev" },
      { key: "path", from: "skills", to: "tools" },
      { key: "review", from: true, to: null },
    ],
  })["catalog/skills.yaml"]!;
  assert.deepEqual(diff(SKILLS, out), {
    removed: [`    commit: ${"a".repeat(40)} # pinned`, "    track: main", "    path: skills # where they are", "    review: true"],
    added: [`    commit: ${sha} # pinned`, "    track: dev", "    path: tools # where they are"],
  });
});

test("a source goes from pinned to followed and back", () => {
  const sha = "c".repeat(40);
  const followed = run({
    op: "editSource",
    name: "mine",
    changes: [
      { key: "commit", from: "a".repeat(40), to: null },
      { key: "track", from: "main", to: null },
      { key: "review", from: true, to: null },
      { key: "branch", from: null, to: "main" },
    ],
  })["catalog/skills.yaml"]!;
  assert.deepEqual((load(followed) as any).sources.mine, { repo: "https://example.com/mine.git", branch: "main", path: "skills" });
  assert.match(followed, /  mine:\n    repo: https:\/\/example\.com\/mine\.git\n    branch: main\n    path: skills # where they are\n  loose:/);
  const pinned = run(
    { op: "editSource", name: "loose", changes: [{ key: "branch", from: "main", to: null }, { key: "commit", from: null, to: sha }, { key: "track", from: null, to: "main" }, { key: "review", from: null, to: true }] },
  )["catalog/skills.yaml"]!;
  assert.deepEqual((load(pinned) as any).sources.loose, { repo: "https://example.com/loose.git", commit: sha, track: "main", path: ".", review: true });
  assert.match(pinned, /  loose:\n    repo: https:\/\/example\.com\/loose\.git\n    commit: c+\n    track: main\n    path: \.\n    review: true\n\nbundles:/);
});

test("a bundle's skills change by line: a skill that goes loses its line, a new one follows the one before it, the rest keep their comments", () => {
  const out = run({ op: "editBundle", name: "core", from: ["review", "debug", "notes"], to: ["review", "plan", "notes", "ship"] })["catalog/skills.yaml"]!;
  assert.match(out, /    - review # first\n    - plan\n    # a note on the next one\n    - notes\n    - ship\n  extra:/);
  assert.deepEqual((load(out) as any).bundles.core, ["review", "plan", "notes", "ship"]);
});

test("a bundle that gets a new first skill and loses its last", () => {
  const out = run({ op: "editBundle", name: "core", from: ["review", "debug", "notes"], to: ["lint", "review", "debug"] })["catalog/skills.yaml"]!;
  assert.deepEqual((load(out) as any).bundles.core, ["lint", "review", "debug"]);
  assert.match(out, /core:\n    - lint\n    - review # first\n    - debug\n    # a note on the next one\n  extra:/);
});

test("a bundle written as a flow list is rewritten on its line, with its comment", () => {
  const out = run({ op: "editBundle", name: "extra", from: ["alpha", "beta"], to: ["beta", "gamma"] })["catalog/skills.yaml"]!;
  assert.deepEqual(diff(SKILLS, out), { removed: ["  extra: [alpha, beta] # flow"], added: ["  extra: [beta, gamma] # flow"] });
  assert.equal(dropped({ op: "editBundle", name: "extra", from: ["alpha"], to: ["x"] })?.why, "stale");
});

test("a bundle at the end of a file with no final newline stays without one", () => {
  const text = "bundles:\n  core:\n    - a\n    - b";
  const f = { ...files(), "catalog/skills.yaml": text };
  assert.equal(run({ op: "editBundle", name: "core", from: ["a", "b"], to: ["a", "c"] }, f)["catalog/skills.yaml"], "bundles:\n  core:\n    - a\n    - c");
  assert.equal(run({ op: "editBundle", name: "core", from: ["a", "b"], to: ["b"] }, f)["catalog/skills.yaml"], "bundles:\n  core:\n    - b");
  assert.equal(run({ op: "editBundle", name: "core", from: ["a", "b"], to: ["a", "b", "c", "d"] }, f)["catalog/skills.yaml"], "bundles:\n  core:\n    - a\n    - b\n    - c\n    - d");
});

test("a host's ssh changes on its line with the comment; a host with none gets one; the rest of the file is untouched", () => {
  const out = run({ op: "editHost", host: "laptop", from: "me@laptop.local", to: "me@laptop.lan" })["hosts/laptop.yaml"]!;
  assert.deepEqual(diff(HOST, out), { removed: ["ssh: me@laptop.local # reach it here"], added: ["ssh: me@laptop.lan # reach it here"] });
  const bare = run({ op: "editHost", host: "bare", from: null, to: "me@bare" })["hosts/bare.yaml"]!;
  assert.equal(bare, 'ssh: me@bare\nage: ""\n');
  assert.equal(dropped({ op: "editHost", host: "laptop", from: "someone@else", to: "x@y" })?.why, "stale");
  assert.equal(dropped({ op: "editHost", host: "nobody", from: null, to: "x@y" })?.why, "stale");
});

test("shapes the engine cannot splice are refused, not guessed at", () => {
  const edit = (text: string): EditOp => ({ op: "editServer", name: "docs", changes: [{ key: "command", from: ["a"], to: ["b"] }] });
  const refusal = (mcp: string, op: EditOp = edit(mcp)) => applyOps({ ...files(), "catalog/mcp.yaml": mcp }, [op]).dropped[0];
  assert.equal(refusal("base: &b\n  x: 1\nservers:\n  docs:\n    command: [a]\n")?.why, "cannot-edit", "an anchor anywhere in the file");
  assert.equal(refusal("servers:\n  docs:\n    command:\n      [a\n       ]\n")?.why, "cannot-edit", "a flow list over several lines");
  assert.equal(refusal("servers:\n  docs: { command: [a] }\n")?.why, "cannot-edit", "an entry written as a flow map");
  assert.equal(refusal("servers:\n  docs:\n    url: |\n      a\n", { op: "editServer", name: "docs", changes: [{ key: "url", from: "a\n", to: "b" }] })?.why, "cannot-edit", "a block scalar");
  assert.equal(refusal("servers:\n  docs:\n    command: [a]\n    env: *e\n")?.why, "cannot-edit", "an alias");
  assert.equal(refusal("servers:\r\n  docs:\r\n    command: [a]\r\n")?.why, "cannot-edit", "windows line endings");
  assert.match(refusal("servers:\n  docs: { command: [a] }\n")!.reason, /cannot edit this shape/);
  assert.equal(refusal("servers:\n  docs:\n    command: [a]\n", { op: "editServer", name: "docs", changes: [{ key: "command", from: ["a"], to: "b" }] })?.why, "cannot-edit", "a list that would become a single value");
});

test("entryValue reads an item as written, and entryProblem says why one cannot be edited", () => {
  const f = files();
  assert.deepEqual(entryValue(f, "server", "tracker"), { transport: "http", url: "https://tracker.example.com/mcp", headers: { Authorization: "secret:TRACKER_TOKEN" } });
  assert.deepEqual(entryValue(f, "bundle", "extra"), ["alpha", "beta"]);
  assert.deepEqual(entryValue(f, "host", "laptop"), { ssh: "me@laptop.local" });
  assert.deepEqual(entryValue(f, "host", "bare"), {});
  assert.equal(entryValue(f, "server", "nope"), null);
  assert.equal(entryProblem(f, "server", "docs"), null);
  assert.equal(entryProblem(f, "source", "mine"), null);
  assert.equal(entryProblem(f, "bundle", "core"), null);
  assert.equal(entryProblem(f, "host", "laptop"), null);
  const odd = { ...f, "catalog/mcp.yaml": "servers:\n  docs: { command: [a] }\n  tracker:\n    transport: http\n    url: x\n", "catalog/skills.yaml": "bundles:\n  core: &c [a]\n" };
  assert.match(entryProblem(odd, "server", "docs")!, /not a map or a list written in block style/);
  assert.match(entryProblem(odd, "bundle", "core")!, /anchor/);
  assert.equal(entryProblem({ ...f, "hosts/laptop.yaml": "ssh: [a,\n b]\n" }, "host", "laptop")?.includes("several lines"), true);
  assert.equal(entryProblem({ ...f, "hosts/laptop.yaml": "x: &a 1\nssh: a\n" }, "host", "laptop")?.includes("anchor"), true);
});

test("an edit that changes nothing leaves the file as it was", () => {
  const r = applyOps(files(), [{ op: "editServer", name: "docs", changes: [{ key: "only", from: ["claude"], to: ["claude"] }] }]);
  assert.deepEqual(r.changed, []);
});

test("edits to an item added in the same replay: the edit finds the entry the add wrote", () => {
  const r = applyOps(files(), [
    { op: "addServer", name: "fresh", entry: { command: ["node", "x.js"], only: ["claude"] } },
    { op: "editServer", name: "fresh", changes: [{ key: "command", from: ["node", "x.js"], to: ["node", "y.js"] }] },
  ]);
  assert.deepEqual(r.dropped, []);
  assert.deepEqual((load(r.files["catalog/mcp.yaml"]!) as any).servers.fresh.command, ["node", "y.js"]);
});

test("files written another way: four-space indents, indentless lists, quoted values (a new item is quoted like its neighbours)", () => {
  const text = `servers:\n    docs:\n        command:\n        - "npx"\n        - '-y'\n        - pkg@1.0.0 # pin\n        env:\n            A: 'one'\n            B: "two"\n`;
  const f = { ...files(), "catalog/mcp.yaml": text };
  const out = run({ op: "editServer", name: "docs", changes: [{ key: "command", from: ["npx", "-y", "pkg@1.0.0"], to: ["npx", "-y", "pkg@2.0.0", "--x"] }, { key: "env", from: { A: "one", B: "two" }, to: { A: "uno", B: "two", C: "three" } }] }, f)["catalog/mcp.yaml"]!;
  assert.equal(out, `servers:\n    docs:\n        command:\n        - "npx"\n        - '-y'\n        - "pkg@2.0.0"\n        - "--x"\n        env:\n            A: 'uno'\n            B: "two"\n            C: "three"\n`);
});
