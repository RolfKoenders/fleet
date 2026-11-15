import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "../vendor/js-yaml.mjs";
import { applyOps } from "../src/edit/index.ts";
import type { EditOp, Files } from "../src/edit/index.ts";

const MCP = `# Servers every host may pick.
servers:
  docs:
    # why docs needs a token
    command: [npx, -y, "@example/docs-mcp@1.0.0"]  # the docs server
    env:
      DOCS_TOKEN: secret:DOCS_TOKEN # keep it secret
      REGION: eu
    only: [claude]

  # the tracker
  tracker:
    transport: http
    url: https://tracker.example.com/mcp # live
    headers:
      Authorization: secret:TRACKER_TOKEN

  search:
    command: [search-mcp]
`;

const SKILLS = `# Where skills come from.
sources:
  mine:
    # a pinned source
    repo: https://example.com/mine.git
    commit: ${"a".repeat(40)} # pinned
    track: main
    path: skills # where they are
    review: true

  loose:
    repo: https://example.com/loose.git
    branch: main

bundles:
  core:
    - review # first
    - debug
    # a note on the next one
    - lint
  extra: [format, review2]
  other:
    - solo
`;

const DEFAULTS = `# Everything gets these.
bundles: [core]
mcp:
  include: [docs, tracker]  # the basics
  exclude: [search]
`;

const BOX = `ssh: me@box
bundles:
  - extra
  - other
exclude: [core]
mcp:
  include: [search, tracker]
vars:
  A: b
`;

const files = (): Files => ({ "catalog/mcp.yaml": MCP, "catalog/skills.yaml": SKILLS, "hosts/_defaults.yaml": DEFAULTS, "hosts/box.yaml": BOX, "hosts/mini.yaml": "ssh: me@mini\n" });

const run = (ops: EditOp[], input: Files = files()) => applyOps(input, ops);
const must = (ops: EditOp[], input?: Files) => {
  const r = run(ops, input);
  assert.deepEqual(r.dropped, [], JSON.stringify(r.dropped));
  return r;
};

test("removing a server takes its entry, comments inside it included, and every mention of it in the defaults and the hosts", () => {
  const r = must([{ op: "removeServer", name: "tracker" }]);
  assert.deepEqual(r.changed.sort(), ["catalog/mcp.yaml", "hosts/_defaults.yaml", "hosts/box.yaml"]);
  // The comment right above the entry describes it and goes with it (the YAML view shows it as part of the item), and so does the blank line that set it apart.
  assert.equal(r.files["catalog/mcp.yaml"], MCP.replace("  # the tracker\n  tracker:\n    transport: http\n    url: https://tracker.example.com/mcp # live\n    headers:\n      Authorization: secret:TRACKER_TOKEN\n\n", ""));
  assert.doesNotMatch(r.files["catalog/mcp.yaml"]!, /tracker\.example|TRACKER_TOKEN/);
  assert.equal(r.files["hosts/_defaults.yaml"], DEFAULTS.replace("[docs, tracker]", "[docs]"));
  assert.equal(r.files["hosts/box.yaml"], BOX.replace("[search, tracker]", "[search]"));
  assert.equal(r.files["hosts/mini.yaml"], "ssh: me@mini\n");
});

test("removing a server that is excluded takes the exclude out too, and a list left empty is []", () => {
  const r = must([{ op: "removeServer", name: "search" }]);
  assert.match(r.files["hosts/_defaults.yaml"]!, /exclude: \[\]/);
  assert.match(r.files["hosts/box.yaml"]!, /include: \[tracker\]/);
  assert.doesNotMatch(r.files["catalog/mcp.yaml"]!, /search/);
  assert.equal((load(r.files["catalog/mcp.yaml"]!) as any).servers.search, undefined);
});

test("the first entry of a section goes with its comments inside it and the blank line after it", () => {
  const r = must([{ op: "removeServer", name: "docs" }]);
  assert.equal(r.files["catalog/mcp.yaml"], "# Servers every host may pick.\nservers:\n  # the tracker\n  tracker:\n    transport: http\n    url: https://tracker.example.com/mcp # live\n    headers:\n      Authorization: secret:TRACKER_TOKEN\n\n  search:\n    command: [search-mcp]\n");
});

test("the last entry goes without leaving a blank line at the end", () => {
  const r = must([{ op: "removeServer", name: "search" }]);
  assert.ok(r.files["catalog/mcp.yaml"]!.endsWith("Authorization: secret:TRACKER_TOKEN\n"), JSON.stringify(r.files["catalog/mcp.yaml"]!.slice(-60)));
});

test("removing every server leaves an empty section the loader reads, and a server can be added to it again", () => {
  const r = must([{ op: "removeServer", name: "docs" }, { op: "removeServer", name: "tracker" }, { op: "removeServer", name: "search" }]);
  assert.equal(r.files["catalog/mcp.yaml"], "# Servers every host may pick.\nservers: {}\n");
  assert.deepEqual(load(r.files["catalog/mcp.yaml"]!), { servers: {} });
  const again = must([{ op: "removeServer", name: "docs" }, { op: "removeServer", name: "tracker" }, { op: "removeServer", name: "search" }, { op: "addServer", name: "docs", entry: { command: ["x"] } }]);
  assert.deepEqual((load(again.files["catalog/mcp.yaml"]!) as any).servers, { docs: { command: ["x"] } });
  assert.match(again.files["catalog/mcp.yaml"]!, /^# Servers every host may pick\.\nservers:\n  docs:/);
});

test("removing a bundle takes its entry and its name from bundles and exclude of the defaults and the hosts", () => {
  const r = must([{ op: "removeBundle", name: "core" }]);
  assert.deepEqual(r.changed.sort(), ["catalog/skills.yaml", "hosts/_defaults.yaml", "hosts/box.yaml"]);
  assert.equal(r.files["hosts/_defaults.yaml"], DEFAULTS.replace("bundles: [core]", "bundles: []"));
  assert.equal(r.files["hosts/box.yaml"], BOX.replace("exclude: [core]", "exclude: []"));
  const doc = load(r.files["catalog/skills.yaml"]!) as any;
  assert.deepEqual(Object.keys(doc.bundles), ["extra", "other"]);
  assert.doesNotMatch(r.files["catalog/skills.yaml"]!, /a note on the next one|lint/);
  assert.match(r.files["catalog/skills.yaml"]!, /^  extra: \[format, review2\]$/m);
});

test("a flow bundle and a list item with a comment are taken out whole", () => {
  const r = must([{ op: "removeBundle", name: "extra" }, { op: "removeBundle", name: "other" }]);
  assert.equal(r.files["hosts/box.yaml"], BOX.replace("bundles:\n  - extra\n  - other\n", "bundles: []\n"));
  assert.deepEqual((load(r.files["catalog/skills.yaml"]!) as any).bundles, { core: ["review", "debug", "lint"] });
});

test("removing a skill source takes its entry, and its skills out of every bundle that lists them", () => {
  const r = must([{ op: "removeSource", name: "mine", skills: ["review", "debug", "lint", "format"] }]);
  assert.deepEqual(r.changed, ["catalog/skills.yaml"]);
  const doc = load(r.files["catalog/skills.yaml"]!) as any;
  assert.deepEqual(Object.keys(doc.sources), ["loose"]);
  // Every skill of core is the source's: the bundle stays, empty. A bundle with others keeps them, with their lines.
  assert.deepEqual(doc.bundles, { core: [], extra: ["review2"], other: ["solo"] });
  assert.doesNotMatch(r.files["catalog/skills.yaml"]!, /a pinned source|pinned|where they are/);
  assert.match(r.files["catalog/skills.yaml"]!, /^# Where skills come from\.\nsources:\n  loose:/);
});

test("a source's skills that no bundle lists change nothing, and a bundle without them is untouched byte for byte", () => {
  const r = must([{ op: "removeSource", name: "loose", skills: ["nothing-listed"] }]);
  assert.equal(r.files["catalog/skills.yaml"], SKILLS.replace("\n  loose:\n    repo: https://example.com/loose.git\n    branch: main\n", ""));
});

test("a removal of what is gone is dropped as stale and changes nothing", () => {
  for (const op of [{ op: "removeServer", name: "nope" }, { op: "removeBundle", name: "nope" }, { op: "removeSource", name: "nope", skills: [] }] as EditOp[]) {
    const r = run([op]);
    assert.equal(r.dropped.length, 1);
    assert.equal(r.dropped[0]!.why, "stale");
    assert.match(r.dropped[0]!.reason, /'nope' is not in catalog\//);
    assert.deepEqual(r.changed, []);
  }
  const twice = run([{ op: "removeServer", name: "docs" }, { op: "removeServer", name: "docs" }]);
  assert.equal(twice.applied.length, 1);
  assert.equal(twice.dropped.length, 1);
});

test("a file with a shape the engine refuses drops the whole removal as cannot-edit, writing none of it", () => {
  const input = files();
  input["hosts/box.yaml"] = "ssh: me@box\nbundles: &b [extra]\n";
  const r = run([{ op: "removeBundle", name: "extra" }], input);
  assert.equal(r.dropped[0]?.why, "cannot-edit");
  assert.deepEqual(r.changed, []);
  const anchored = files();
  anchored["catalog/mcp.yaml"] = "servers:\n  a: &x\n    command: [a]\n  b: *x\n";
  assert.equal(run([{ op: "removeServer", name: "a" }], anchored).dropped[0]?.why, "cannot-edit");
});

test("a host whose list is in the way of the removal is left as it is when the item is not in it", () => {
  const input = files();
  input["hosts/mini.yaml"] = "ssh: me@mini\nmcp:\n  include: [search]\n";
  const r = must([{ op: "removeServer", name: "docs" }], input);
  assert.equal(r.files["hosts/mini.yaml"], input["hosts/mini.yaml"]);
});

test("a removal replays after earlier edits: a held pick of the item is taken out too", () => {
  const r = must([{ op: "add", host: "mini", kind: "bundles", name: "extra" }, { op: "removeBundle", name: "extra" }]);
  assert.equal(r.files["hosts/mini.yaml"], "ssh: me@mini\nbundles: []\n");
});

test("only the comment lines right above the entry go: not one after a blank line, one at another indent, or one below the entry", () => {
  const text = "# top\nservers:\n  # about a\n\n  # about b, after a blank line\n  b:\n    command: [b]\n  # about c\n  c:\n    command: [c]\n    # inside c\n  # below c, for d\n  d:\n    command: [d]\n";
  const r = must([{ op: "removeServer", name: "b" }, { op: "removeServer", name: "c" }], { ...files(), "catalog/mcp.yaml": text });
  // "about a" is not above b (a blank line is between), b's own comment is, c's and its inner one are, the comment below c is d's.
  assert.equal(r.files["catalog/mcp.yaml"], "# top\nservers:\n  # about a\n\n  # below c, for d\n  d:\n    command: [d]\n");
});
