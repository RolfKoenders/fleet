import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { repoRoot, tempDir } from "./helpers.ts";
import { load } from "../vendor/js-yaml.mjs";
import { loadConfig } from "../src/config.ts";
import { applyOps, validate } from "../src/edit/index.ts";
import type { EditOp, Files } from "../src/edit/index.ts";

const examples = join(repoRoot, "examples");

/** Every file of the examples that an edit may touch, by repo-relative path. */
function exampleFiles(): Files {
  const files: Files = {};
  const dir = tempDir("fleet-edit-");
  cpSync(examples, dir, { recursive: true });
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const path = relative(dir, join(e.parentPath, e.name));
    if (e.isFile() && path.endsWith(".yaml")) files[path] = readFileSync(join(dir, path), "utf8");
  }
  return files;
}

/** The lines that differ between two texts: what left and what came in, once the shared head and tail are cut away. */
function diff(before: string, after: string): { removed: string[]; added: string[] } {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { removed: a.slice(head, a.length - tail), added: b.slice(head, b.length - tail) };
}

/** A config directory on disk holding the examples and then `files`, so a host that is only in `files` is a host. */
function tempDirWith(files: Files): string {
  const dir = tempDir("fleet-edit-cfg-");
  cpSync(examples, dir, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const one = (files: Files, op: EditOp) => {
  const r = applyOps(files, [op]);
  assert.deepEqual(r.dropped, [], JSON.stringify(r.dropped));
  return r;
};

test("no ops return every file as it came, byte for byte", () => {
  const files = exampleFiles();
  const r = applyOps(files, []);
  assert.deepEqual(r.files, files);
  assert.deepEqual(r.changed, []);
});

const HOST = (extra = "") => `# The host.\n\nadmin: true # me\n\n# Bundles.\nbundles: [core] # picked\n\n# Files.\nfiles:\n  - { source: a, target: ~/a }\n${extra}`;

test("adding to a flow list changes only that line and keeps its comment", () => {
  const files = { "hosts/box.yaml": HOST(), "hosts/_defaults.yaml": "bundles: []\n" };
  const r = one(files, { op: "add", host: "box", kind: "bundles", name: "extra" });
  assert.deepEqual(diff(files["hosts/box.yaml"], r.files["hosts/box.yaml"]!), {
    removed: ["bundles: [core] # picked"],
    added: ["bundles: [core, extra] # picked"],
  });
  assert.deepEqual(r.changed, ["hosts/box.yaml"]);
});

test("adding to a block list adds one line in the list's own indentation, between its comments", () => {
  const text = "bundles:\n    - core # first\n    # between\n    - other # last\n\n# tail\nadmin: true\n";
  const r = one({ "hosts/box.yaml": text, "hosts/_defaults.yaml": "" }, { op: "add", host: "box", kind: "bundles", name: "extra" });
  assert.deepEqual(diff(text, r.files["hosts/box.yaml"]!), { removed: [], added: ["    - extra"] });
  assert.equal(r.files["hosts/box.yaml"]!.indexOf("    - extra"), text.indexOf("\n\n# tail") + 1);
});

test("a flow list grows by one item wherever the item goes and shrinks by only that item", () => {
  const defaults = "";
  for (const [list, name, after] of [
    ["[a, b, c]", "a", "[b, c]"],
    ["[a, b, c]", "b", "[a, c]"],
    ["[a, b, c]", "c", "[a, b]"],
    ["[a]", "a", "[]"],
    ["[ a , b ]", "b", "[ a ]"],
    ["['a', 'b']", "b", "['a']"],
  ] as const) {
    const text = `x: 1\nbundles: ${list} # note\ny: 2\n`;
    const r = one({ "hosts/box.yaml": text, "hosts/_defaults.yaml": defaults }, { op: "remove", host: "box", kind: "bundles", name });
    assert.equal(r.files["hosts/box.yaml"], `x: 1\nbundles: ${after} # note\ny: 2\n`, list);
  }
  const quoted = one({ "hosts/box.yaml": "bundles: ['a']\n", "hosts/_defaults.yaml": "" }, { op: "add", host: "box", kind: "bundles", name: "b" });
  assert.equal(quoted.files["hosts/box.yaml"], "bundles: ['a', 'b']\n");
});

test("an empty flow list or a bare key takes the first item", () => {
  for (const [before, after] of [["bundles: []\n", "bundles: [x]\n"], ["bundles: # c\nz: 1\n", "bundles: [x] # c\nz: 1\n"]] as const) {
    const r = one({ "hosts/box.yaml": before, "hosts/_defaults.yaml": "" }, { op: "add", host: "box", kind: "bundles", name: "x" });
    assert.equal(r.files["hosts/box.yaml"], after);
  }
});

test("removing from a block list deletes that item's line, and the last item leaves an empty list", () => {
  const text = "bundles:\n  - a\n  # c\n  - b # why\nz: 1\n";
  const files = { "hosts/box.yaml": text, "hosts/_defaults.yaml": "" };
  const r = one(files, { op: "remove", host: "box", kind: "bundles", name: "b" });
  assert.deepEqual(diff(text, r.files["hosts/box.yaml"]!), { removed: ["  - b # why"], added: [] });
  const last = one({ ...files, "hosts/box.yaml": "bundles:\n  - a\nz: 1\n" }, { op: "remove", host: "box", kind: "bundles", name: "a" });
  assert.equal(last.files["hosts/box.yaml"], "bundles: []\nz: 1\n");
});

test("a host file with no bundles key gets one after its last top-level key, in the file's style", () => {
  const spaced = "# top\nadmin: true\n\nfiles:\n  - { source: a, target: ~/a }\n\n# trailing note\n";
  const r = one({ "hosts/box.yaml": spaced, "hosts/_defaults.yaml": "" }, { op: "add", host: "box", kind: "bundles", name: "x" });
  assert.equal(r.files["hosts/box.yaml"], "# top\nadmin: true\n\nfiles:\n  - { source: a, target: ~/a }\n\nbundles: [x]\n\n# trailing note\n".replace("\n\nbundles: [x]\n\n# trailing", "\n\nbundles: [x]\n\n# trailing"));
  const tight = "admin: true\nage: \"\"\n";
  const t = one({ "hosts/box.yaml": tight, "hosts/_defaults.yaml": "" }, { op: "add", host: "box", kind: "bundles", name: "x" });
  assert.equal(t.files["hosts/box.yaml"], "admin: true\nage: \"\"\nbundles: [x]\n");
  const block = "admin: true\nexclude:\n  - q\n";
  const b = one({ "hosts/box.yaml": block, "hosts/_defaults.yaml": "" }, { op: "add", host: "box", kind: "bundles", name: "x" });
  assert.equal(b.files["hosts/box.yaml"], "admin: true\nexclude:\n  - q\nbundles:\n  - x\n");
  const empty = one({ "hosts/box.yaml": "# nothing yet\n", "hosts/_defaults.yaml": "" }, { op: "add", host: "box", kind: "bundles", name: "x" });
  assert.equal(empty.files["hosts/box.yaml"], "# nothing yet\n\nbundles: [x]\n");
  const noNewline = one({ "hosts/box.yaml": "admin: true", "hosts/_defaults.yaml": "" }, { op: "add", host: "box", kind: "bundles", name: "x" });
  assert.equal(noNewline.files["hosts/box.yaml"], "admin: true\nbundles: [x]");
});

test("a host file without mcp gets an mcp map, and one with mcp but no include gets only the include line", () => {
  const none = one({ "hosts/box.yaml": "admin: true\n\nvars:\n  A: b\n", "hosts/_defaults.yaml": "" }, { op: "add", host: "box", kind: "mcp", name: "docs" });
  assert.equal(none.files["hosts/box.yaml"], "admin: true\n\nvars:\n  A: b\n\nmcp:\n  include: [docs]\n");
  const text = "mcp:\n    exclude: [x] # no\n\nadmin: true\n";
  const some = one({ "hosts/box.yaml": text, "hosts/_defaults.yaml": "" }, { op: "add", host: "box", kind: "mcp", name: "docs" });
  assert.deepEqual(diff(text, some.files["hosts/box.yaml"]!), { removed: [], added: ["    include: [docs]"] });
});

test("taking a defaults item away from a host is an exclude in the host's file, and the defaults stay as they were", () => {
  const defaults = "# defaults\nbundles: [core]\nmcp:\n  include: [docs]\n";
  const files = exampleFiles();
  files["hosts/_defaults.yaml"] = defaults;
  const r = applyOps(files, [
    { op: "remove", host: "server", kind: "bundles", name: "core" },
    { op: "remove", host: "server", kind: "mcp", name: "docs" },
  ]);
  assert.deepEqual(r.dropped, []);
  assert.equal(r.files["hosts/_defaults.yaml"], defaults);
  assert.deepEqual(r.changed, ["hosts/server.yaml"]);
  const server = r.files["hosts/server.yaml"]!;
  assert.match(server, /^exclude: \[core\]$/m);
  assert.match(server, /^mcp:\n {2}exclude: \[docs\]$/m);
  // The commented hint in the example is untouched.
  assert.ok(server.includes("# exclude: [core]\n# mcp:\n#   exclude: [docs]\n"));
});

test("an item a host picks itself is taken out of its own list, and a host that excludes it gets it back by dropping the exclude", () => {
  const files = { "hosts/box.yaml": "bundles: [a, b]\nexclude: [c]\n", "hosts/_defaults.yaml": "bundles: [c]\n" };
  const r = applyOps(files, [
    { op: "remove", host: "box", kind: "bundles", name: "a" },
    { op: "add", host: "box", kind: "bundles", name: "c" },
  ]);
  assert.deepEqual(r.dropped, []);
  assert.equal(r.files["hosts/box.yaml"], "bundles: [b]\nexclude: []\n");
});

test("_defaults.yaml is edited only by the explicit for-every-host operations", () => {
  const files = exampleFiles();
  const r = applyOps(files, [
    { op: "addEverywhere", kind: "bundles", name: "extra" },
    { op: "addEverywhere", kind: "mcp", name: "tracker" },
    { op: "removeEverywhere", kind: "mcp", name: "docs" },
  ]);
  assert.deepEqual(r.dropped, []);
  assert.deepEqual(r.changed, ["hosts/_defaults.yaml"]);
  const defaults = r.files["hosts/_defaults.yaml"]!;
  assert.match(defaults, /^bundles: \[core, extra\]$/m);
  assert.match(defaults, /^mcp:\n {2}include: \[tracker\]$/m);
});

test("catalog entries go at the end of their map, in the style of the one before", () => {
  const files = exampleFiles();
  const mcp = files["catalog/mcp.yaml"]!;
  const r = one(files, { op: "addServer", name: "fresh", entry: { only: ["claude"], env: { KEY: "secret:KEY" }, command: ["npx", "-y", "@x/y@1.0.0"] } });
  const after = r.files["catalog/mcp.yaml"]!;
  assert.equal(after, `${mcp}\n  fresh:\n    command: [npx, -y, "@x/y@1.0.0"]\n    env:\n      KEY: secret:KEY\n    only: [claude]\n`);
  assert.ok(after.startsWith(mcp.slice(0, mcp.length - 1)));

  const skills = files["catalog/skills.yaml"]!;
  const bundle = one(files, { op: "addBundle", name: "more", skills: ["x", "w"] });
  assert.deepEqual(diff(skills, bundle.files["catalog/skills.yaml"]!), { removed: [], added: ["  more: [x, w]"] });
  const source = one(files, { op: "addSource", name: "mine", entry: { repo: "https://github.com/me/s.git", branch: "main", path: "." } });
  assert.deepEqual(diff(skills, source.files["catalog/skills.yaml"]!), {
    removed: [],
    added: ["  mine:", "    repo: https://github.com/me/s.git", "    path: .", "    branch: main"],
  });
});

test("a new entry copies its neighbour's quoting, key order, block lists and indentation", () => {
  const text = 'servers:\n    one:\n        url: "https://one.example/mcp"\n        transport: "http"\n        only:\n            - "claude"\n';
  const r = one({ "catalog/mcp.yaml": text }, { op: "addServer", name: "two", entry: { transport: "sse", url: "https://two.example/mcp", only: ["claude", "opencode"] } });
  assert.deepEqual(diff(text, r.files["catalog/mcp.yaml"]!).added, [
    "    two:",
    '        url: "https://two.example/mcp"',
    '        transport: "sse"',
    "        only:",
    '            - "claude"',
    '            - "opencode"',
  ]);
});

test("a missing catalog file or section is made", () => {
  const r = one({}, { op: "addServer", name: "a", entry: { transport: "http", url: "https://a.example" } });
  assert.equal(r.files["catalog/mcp.yaml"], "servers:\n  a:\n    transport: http\n    url: https://a.example\n");
  const s = one({ "catalog/skills.yaml": "# sources\nsources:\n" }, { op: "addBundle", name: "b", skills: ["x"] });
  assert.equal(s.files["catalog/skills.yaml"], "# sources\nsources:\nbundles:\n  b: [x]\n");
  const bare = one({ "catalog/skills.yaml": "sources:\nbundles: # none yet\n" }, { op: "addBundle", name: "b", skills: ["x"] });
  assert.equal(bare.files["catalog/skills.yaml"], "sources:\nbundles: # none yet\n  b: [x]\n");
});

test("every op's result loads for every host through the overlay, and the files on disk are not read for it", () => {
  const config = tempDir("fleet-edit-cfg-");
  cpSync(examples, config, { recursive: true });
  const files = exampleFiles();
  const r = applyOps(files, [
    { op: "add", host: "server", kind: "bundles", name: "extra" },
    { op: "remove", host: "laptop", kind: "mcp", name: "tracker" },
    { op: "addServer", name: "fresh", entry: { transport: "http", url: "https://fresh.example/mcp" } },
    { op: "add", host: "server", kind: "mcp", name: "fresh" },
    { op: "addBundle", name: "more", skills: ["review2"] },
  ]);
  assert.deepEqual(r.dropped, []);
  const overlay = Object.fromEntries(r.changed.map((p) => [p, r.files[p]!]));
  // The skill review2 is in no source, so the new bundle is fine until a host picks it.
  assert.deepEqual(validate(config, overlay), []);
  const before = readFileSync(join(config, "hosts/server.yaml"), "utf8");
  assert.equal(before, files["hosts/server.yaml"]);
  const loaded = loadConfig(config, "server", { home: tempDir(), sources: "none", overlay });
  assert.ok(loaded.keys.some((k) => JSON.stringify(k).includes("fresh")));
  // A held edit that breaks a host is reported against it.
  const bad = applyOps(r.files, [{ op: "add", host: "server", kind: "bundles", name: "nope" }]);
  assert.deepEqual(bad.dropped, []);
  const failed = validate(config, { ...overlay, "hosts/server.yaml": bad.files["hosts/server.yaml"]! });
  assert.deepEqual(failed.map((f) => f.host), ["server"]);
  assert.match(failed[0]!.problems.join("\n"), /nope/);
});

test("loadConfig and parseFile are unchanged without an overlay", () => {
  const config = tempDir("fleet-edit-cfg-");
  cpSync(examples, config, { recursive: true });
  const a = loadConfig(config, "laptop", { home: tempDir(), sources: "none" });
  const b = loadConfig(config, "laptop", { home: a.files.length ? tempDir() : tempDir(), sources: "none", overlay: {} });
  assert.deepEqual(a.keys, b.keys);
});

test("replaying on a changed file keeps what still applies and reports what no longer does", () => {
  const ops: EditOp[] = [
    { op: "add", host: "box", kind: "bundles", name: "x" },
    { op: "add", host: "box", kind: "bundles", name: "w" },
    { op: "remove", host: "box", kind: "bundles", name: "z" },
  ];
  const first = applyOps({ "hosts/box.yaml": "bundles: [z]\n", "hosts/_defaults.yaml": "" }, ops);
  assert.deepEqual(first.dropped, []);
  assert.equal(first.files["hosts/box.yaml"], "bundles: [x, w]\n");
  // Someone adds x on disk and drops z by hand: the first and last ops have nothing left to do.
  const second = applyOps({ "hosts/box.yaml": "# edited\nbundles: [x]\n", "hosts/_defaults.yaml": "" }, ops);
  assert.deepEqual(second.applied, [ops[1]]);
  assert.deepEqual(second.dropped.map((d) => [d.op, d.why]), [[ops[0], "stale"], [ops[2], "stale"]]);
  assert.equal(second.files["hosts/box.yaml"], "# edited\nbundles: [x, w]\n");
  // The host file went away.
  const gone = applyOps({ "hosts/_defaults.yaml": "" }, [ops[0]!]);
  assert.match(gone.dropped[0]!.reason, /does not exist/);
  // A server another editor added under the same name.
  const dup = applyOps({ "catalog/mcp.yaml": "servers:\n  a:\n    url: u\n" }, [{ op: "addServer", name: "a", entry: { url: "v" } }]);
  assert.equal(dup.dropped[0]!.why, "stale");
  assert.equal(dup.files["catalog/mcp.yaml"], "servers:\n  a:\n    url: u\n");
});

test("shapes that cannot be spliced safely are refused and the file is left as it was", () => {
  const defaults = "";
  const op: EditOp = { op: "add", host: "box", kind: "bundles", name: "x" };
  for (const [text, why] of [
    ["base: &a [x]\nbundles: *a\n", /alias|anchor/],
    ["bundles: [a,\n  b]\n", /several lines/],
    ["bundles:\n  - { a: 1 }\n", /names/],
    ["bundles: core\n", /not a list/],
    ["bundles: [a\n", /not valid YAML/],
    ["bundles: [a]\r\nx: 1\r\n", /Windows/],
    ["{ bundles: [a] }\n", /block map/],
  ] as const) {
    const r = applyOps({ "hosts/box.yaml": text, "hosts/_defaults.yaml": defaults }, [op]);
    assert.equal(r.dropped.length, 1, text);
    assert.equal(r.dropped[0]!.why, "cannot-edit", text);
    assert.match(r.dropped[0]!.reason, why, text);
    assert.equal(r.files["hosts/box.yaml"], text);
  }
  const flowMcp = applyOps({ "hosts/box.yaml": "mcp: { exclude: [a] }\n", "hosts/_defaults.yaml": defaults }, [{ ...op, kind: "mcp" }]);
  assert.equal(flowMcp.dropped[0]!.why, "cannot-edit");
  const flowCatalog = applyOps({ "catalog/mcp.yaml": "servers: {}\n" }, [{ op: "addServer", name: "a", entry: { url: "u" } }]);
  assert.equal(flowCatalog.dropped[0]!.why, "cannot-edit");
});

test("names that need quoting are written quoted and read back as the same name", () => {
  for (const name of ["true", "123", "a: b", "#x", "-", "y"]) {
    const r = one({ "hosts/box.yaml": "bundles: [a]\n", "hosts/_defaults.yaml": "" }, { op: "add", host: "box", kind: "bundles", name });
    const text = r.files["hosts/box.yaml"]!;
    assert.equal(text, `bundles: [a, ${JSON.stringify(name)}]\n`);
    assert.deepEqual(load(text), { bundles: ["a", name] });
  }
});

test("on every example file, an op that changes it changes only its own lines", () => {
  const files = exampleFiles();
  const ops: EditOp[] = [
    { op: "add", host: "server", kind: "bundles", name: "extra" },
    { op: "add", host: "laptop", kind: "mcp", name: "tracker-local" },
    { op: "remove", host: "laptop", kind: "bundles", name: "extra" },
    { op: "addEverywhere", kind: "bundles", name: "extra" },
    { op: "addServer", name: "zz", entry: { url: "https://zz.example" } },
    { op: "addBundle", name: "zz", skills: ["q"] },
  ];
  for (const op of ops) {
    const r = applyOps(files, [op]);
    for (const path of r.changed) {
      const { removed, added } = diff(files[path]!, r.files[path]!);
      assert.ok(removed.length + added.length <= 3, `${JSON.stringify(op)} on ${path}: ${JSON.stringify({ removed, added })}`);
    }
    for (const path of Object.keys(files)) if (!r.changed.includes(path)) assert.equal(r.files[path], files[path]);
  }
});

test("adding an item and taking it out again gives back the text, for flow and block lists", () => {
  for (const text of ["# c\nbundles: [a, b] # x\nz: 1\n", "bundles:\n  - a\n  # k\n  - b # x\nz: 1\n", "z: 1\n", "mcp:\n  include: [a]\n"]) {
    const kind = text.startsWith("mcp") ? "mcp" : "bundles";
    const added = one({ "hosts/box.yaml": text, "hosts/_defaults.yaml": "" }, { op: "add", host: "box", kind, name: "new" });
    const back = one(added.files, { op: "remove", host: "box", kind, name: "new" });
    // A list made by the add is left as an empty list; every other text comes back exactly.
    if (text !== "z: 1\n") assert.equal(back.files["hosts/box.yaml"], text);
    else assert.equal(back.files["hosts/box.yaml"], "z: 1\nbundles: []\n");
  }
});

test("addHost writes a host from the defaults: how to reach it and an empty age, nothing else", () => {
  const files = exampleFiles();
  const r = applyOps(files, [{ op: "addHost", host: "mini", ssh: "me@mini.local", from: null }]);
  assert.deepEqual(r.dropped, []);
  assert.deepEqual(r.changed, ["hosts/mini.yaml"]);
  assert.equal(r.files["hosts/mini.yaml"], 'ssh: me@mini.local\nage: ""\n');
  assert.deepEqual(validate(tempDirWith(r.files), {}), []);
});

test("addHost copies bundles, exclude, mcp, settings and vars from another host, comments in them kept, and not ssh, age, admin or files", () => {
  const files: Files = {
    ...exampleFiles(),
    "hosts/box.yaml": "# The build box.\nadmin: false\nssh: me@box\nage: age1abc\n\n# Skills.\nbundles: [extra, more]\nexclude: [core]\nmcp:\n  include: [tracker]  # for builds\n  exclude: [docs]\nsettings:\n  claude:\n    model: opus\nvars:\n  DOCS_URL: 'https://box.example.com'\nfiles:\n  - { source: config/rules/host/server.md, target: ~/.claude/rules/host.md }\n",
  };
  const r = applyOps(files, [{ op: "addHost", host: "mini", ssh: "me@mini", from: "box" }]);
  assert.deepEqual(r.dropped, []);
  const text = r.files["hosts/mini.yaml"]!;
  assert.equal(
    text,
    'ssh: me@mini\nage: ""\n\nbundles: [extra, more]\n\nexclude: [core]\n\nmcp:\n  include: [tracker]  # for builds\n  exclude: [docs]\n\nsettings:\n  claude:\n    model: opus\n\nvars:\n  DOCS_URL: \'https://box.example.com\'\n',
  );
  assert.equal(r.files["hosts/box.yaml"], files["hosts/box.yaml"], "the source is not touched");
  const doc = load(text) as Record<string, unknown>;
  assert.equal(doc.admin, undefined);
  assert.equal(doc.files, undefined);
  assert.deepEqual(doc.mcp, { include: ["tracker"], exclude: ["docs"] });
});

test("addHost copies from a host with only comments, and refuses a host that exists, a name that is not one and a source that is not there", () => {
  const files: Files = { ...exampleFiles(), "hosts/quiet.yaml": "# nothing yet\n" };
  const ok = applyOps(files, [{ op: "addHost", host: "mini", ssh: "mini", from: "quiet" }]);
  assert.equal(ok.files["hosts/mini.yaml"], 'ssh: mini\nage: ""\n');
  for (const op of [
    { op: "addHost", host: "laptop", ssh: "x", from: null },
    { op: "addHost", host: "../x", ssh: "x", from: null },
    { op: "addHost", host: "mini", ssh: "x", from: "nowhere" },
  ] as EditOp[]) {
    const r = applyOps(files, [op]);
    assert.equal(r.dropped.length, 1, JSON.stringify(op));
    assert.deepEqual(r.changed, []);
  }
});

test("a host file with only comments is an empty host, not a file that fails to load", () => {
  const files: Files = { ...exampleFiles(), "hosts/quiet.yaml": "# nothing yet\n\n" };
  assert.deepEqual(validate(tempDirWith(files), {}), []);
});
