import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkFleetSkill, makeClone, makeHome, publish, runFleet } from "./helpers.ts";
import { EXIT } from "../src/exit.ts";

const CLAUDE = "~/.claude/settings.json";
const OPENCODE = "~/.config/opencode/opencode.jsonc";

function setup(opts: { defaults?: string; host?: string } = {}) {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  linkFleetSkill(home, clone);
  const writeYaml = (name: string, yaml: string) => {
    mkdirSync(join(clone, "hosts"), { recursive: true });
    writeFileSync(join(clone, "hosts", name), yaml);
  };
  if (opts.defaults !== undefined) writeYaml("_defaults.yaml", opts.defaults);
  writeYaml("laptop.yaml", opts.host ?? "{}\n");
  const run = (args: string[]) => (publish(clone), runFleet(clone, args, { home }));
  const json = (args: string[]) => {
    const r = run([...args, "--json"]);
    return { r, doc: JSON.parse(r.stdout) };
  };
  const path = (target: string) => join(home, target.slice(2));
  const read = (target: string) => JSON.parse(readFileSync(path(target), "utf8"));
  const readText = (target: string) => readFileSync(path(target), "utf8");
  const write = (target: string, content: unknown) => {
    mkdirSync(dirname(path(target)), { recursive: true });
    writeFileSync(path(target), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  };
  return { clone, home, writeYaml, run, json, path, read, readText, write };
}

type Setup = ReturnType<typeof setup>;

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const statePath = (home: string) => join(home, ".local/state/fleet/applied.json");
const readState = (home: string) => JSON.parse(readFileSync(statePath(home), "utf8"));
const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
const mode = (path: string) => lstatSync(path).mode & 0o777;

const basic = () =>
  setup({
    host: "settings:\n  claude:\n    attribution:\n      commit: mine\n  opencode:\n    autoupdate: false\n",
  });

test("nested YAML becomes dotted owned paths, written into each tool's own file", () => {
  const s = setup({
    host: "settings:\n  claude:\n    attribution:\n      commit: ''\n      pr: ''\n    permissions:\n      defaultMode: plan\n  opencode:\n    autoupdate: false\n    model: m/x\n",
  });
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(s.read(CLAUDE), { attribution: { commit: "", pr: "" }, permissions: { defaultMode: "plan" } });
  assert.deepEqual(s.read(OPENCODE), { autoupdate: false, model: "m/x" });
  assert.deepEqual(
    doc.created.map((c: { file: string; path: string }) => `${c.file} ${c.path}`),
    [`${CLAUDE} attribution.commit`, `${CLAUDE} attribution.pr`, `${CLAUDE} permissions.defaultMode`, `${OPENCODE} autoupdate`, `${OPENCODE} model`],
  );
});

test("a host overrides the default per path, other default paths stay, and lists replace", () => {
  const s = setup({
    defaults:
      "settings:\n  claude:\n    attribution:\n      commit: a\n      pr: b\n    permissions:\n      allow: [x, y]\n  opencode:\n    instructions: [one, two]\n",
    host: "settings:\n  claude:\n    attribution:\n      pr: host\n    permissions:\n      allow: [z]\n",
  });
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.deepEqual(s.read(CLAUDE), { attribution: { commit: "a", pr: "host" }, permissions: { allow: ["z"] } });
  assert.deepEqual(s.read(OPENCODE), { instructions: ["one", "two"] });
});

test("an empty map is a leaf owned as {}", () => {
  const s = setup({ host: "settings:\n  claude:\n    env: {}\n" });
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.deepEqual(s.read(CLAUDE), { env: {} });
});

test("a nested path and a leaf at its parent are invalid, across defaults and host", () => {
  const s = setup({
    defaults: "settings:\n  claude:\n    attribution:\n      commit: a\n",
    host: "settings:\n  claude:\n    attribution: off\n",
  });
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /attribution.*attribution\.commit|attribution\.commit.*attribution/);
  assert.equal(exists(s.path(CLAUDE)), false);
});

for (const [name, yaml, message] of [
  ["model", "claude:\n    model: opus", /settings\.claude\.model/],
  ["a path below a denied one", "claude:\n    tui:\n      fullscreen: true", /settings\.claude\.tui\.fullscreen/],
  ["theme", "claude:\n    theme: dark", /settings\.claude\.theme/],
  ["fastMode", "claude:\n    fastMode: true", /fastMode/],
  ["mcpServers", "claude:\n    mcpServers:\n      x: {}", /mcpServers/],
  ["opencode $schema", "opencode:\n    $schema: http://x", /settings\.opencode\.\$schema/],
  ["opencode mcp", "opencode:\n    mcp:\n      x: {}", /settings\.opencode\.mcp\.x/],
] as const) {
  for (const command of ["apply", "diff"]) {
    test(`a denied path (${name}) makes ${command} exit 2 before any write`, () => {
      const s = setup({ host: `settings:\n  ${yaml}\n  ${yaml.startsWith("claude") ? "opencode" : "claude"}:\n    ok: 1\n` });
      s.writeYaml("_defaults.yaml", "files: []\n");
      const r = s.run([command]);
      assert.equal(r.code, EXIT.invalid, r.stderr);
      assert.match(r.stderr, message);
      assert.equal(exists(s.path(CLAUDE)), false);
      assert.equal(exists(s.path(OPENCODE)), false);
      assert.equal(exists(statePath(s.home)), false);
    });
  }
}

test("a denied path in the defaults is invalid even when the host would not set it", () => {
  const s = setup({ defaults: "settings:\n  claude:\n    effortLevel: high\n" });
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /_defaults\.yaml.*settings\.claude\.effortLevel/);
});

test("keys fleet cannot write as JSON are invalid", () => {
  for (const [yaml, message] of [
    ["claude:\n    a.b: 1", /'a\.b'.*'\.'/],
    ["claude:\n    n: .nan", /settings\.claude\.n/],
    ["claude:\n    list: [1, .inf]", /settings\.claude\.list/],
    ["claude: [a]", /'settings\.claude' must be a map/],
    ["claude:\n    __proto__:\n      x: 1", /__proto__/],
  ] as const) {
    const s = setup({ host: `settings:\n  ${yaml}\n` });
    const r = s.run(["apply"]);
    assert.equal(r.code, EXIT.invalid, yaml);
    assert.match(r.stderr, message, yaml);
  }
});

test("unowned content and its key order survive, and new keys go at the end", () => {
  const s = setup({
    host: "settings:\n  claude:\n    permissions:\n      deny: [rm]\n    attribution:\n      commit: ''\n",
  });
  s.write(CLAUDE, '{\n  "zeta": 1,\n  "permissions": {\n    "allow": ["Bash"],\n    "ask": []\n  },\n  "alpha": {"deep": [1, 2]}\n}\n');
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.deepEqual(Object.keys(s.read(CLAUDE)), ["zeta", "permissions", "alpha", "attribution"]);
  assert.deepEqual(s.read(CLAUDE).permissions, { allow: ["Bash"], ask: [], deny: ["rm"] });
  assert.deepEqual(s.read(CLAUDE).alpha, { deep: [1, 2] });
  assert.match(s.readText(CLAUDE), /^\{\n  "zeta": 1,\n/, "2-space JSON");
  assert.ok(s.readText(CLAUDE).endsWith("}\n"));
});

test("the file is written with mode 600 and no temp file is left beside it", () => {
  const s = basic();
  s.write(CLAUDE, "{}\n");
  writeFileSync(s.path(CLAUDE), "{}\n", { mode: 0o644 });
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.equal(mode(s.path(CLAUDE)), 0o600);
  assert.equal(mode(s.path(OPENCODE)), 0o600);
  assert.deepEqual(readdirSync(dirname(s.path(CLAUDE))).filter((f) => f !== "skills"), ["settings.json"]);
  assert.deepEqual(readdirSync(dirname(s.path(OPENCODE))), ["opencode.jsonc"]);
});

test("a settings file that is a symlink is written through, not replaced", () => {
  const s = basic();
  mkdirSync(dirname(s.path(CLAUDE)), { recursive: true });
  writeFileSync(join(s.home, "elsewhere.json"), "{}\n");
  symlinkSync(join(s.home, "elsewhere.json"), s.path(CLAUDE));
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.equal(lstatSync(s.path(CLAUDE)).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(readFileSync(join(s.home, "elsewhere.json"), "utf8")), { attribution: { commit: "mine" } });
});


test("applied state records desired and actual hashes and no values", () => {
  const s = setup({ host: "settings:\n  claude:\n    attribution:\n      commit: very-secret-string\n" });
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.deepEqual(readState(s.home).keys, [
    { file: CLAUDE, path: "attribution.commit", desired: sha("very-secret-string"), actual: sha("very-secret-string") },
  ]);
  assert.doesNotMatch(readFileSync(statePath(s.home), "utf8"), /very-secret-string/);
});

test("hashes are of JSON with sorted keys", () => {
  const s = setup({ host: "settings:\n  claude:\n    thing:\n      z: 1\n      a: [{ y: 1, b: 2 }]\n    e: {}\n" });
  // thing.z and thing.a are separate leaves; the object-valued leaves here are the list's maps
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  const keys = readState(s.home).keys;
  const byPath = Object.fromEntries(keys.map((k: { path: string; desired: string }) => [k.path, k.desired]));
  assert.equal(byPath["thing.a"], sha([{ b: 2, y: 1 }]));
  assert.equal(byPath["thing.z"], sha(1));
  assert.equal(byPath.e, sha({}));
});

function applied(): Setup {
  const s = basic();
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  return s;
}

test("a second apply changes nothing and leaves the state file and settings as they were", () => {
  const s = applied();
  const state = readFileSync(statePath(s.home), "utf8");
  const file = s.readText(CLAUDE);
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.ok);
  assert.deepEqual([doc.created, doc.updated, doc.removed], [[], [], []]);
  assert.equal(readFileSync(statePath(s.home), "utf8"), state);
  assert.equal(s.readText(CLAUDE), file);
});

test("current equals desired is a no-op that records the key", () => {
  const s = basic();
  s.write(CLAUDE, { other: 1, attribution: { commit: "mine" } });
  const before = s.readText(CLAUDE);
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(doc.created, [{ file: OPENCODE, path: "autoupdate" }]);
  assert.equal(s.readText(CLAUDE), before, "not rewritten");
  assert.deepEqual(readState(s.home).keys[0], { file: CLAUDE, path: "attribution.commit", desired: sha("mine"), actual: sha("mine") });
});

test("it clears a conflict once the value matches again", () => {
  const s = applied();
  s.write(CLAUDE, { attribution: { commit: "edited" } });
  assert.equal(s.run(["apply"]).code, EXIT.conflict);
  s.write(CLAUDE, { attribution: { commit: "mine" } });
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
});

test("a missing path is created, with no state record", () => {
  const s = basic();
  s.write(CLAUDE, { other: 1 });
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.deepEqual(s.read(CLAUDE), { other: 1, attribution: { commit: "mine" } });
});

test("a missing path is recreated when the state has a record", () => {
  const s = applied();
  s.write(CLAUDE, { other: 1 });
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(doc.created, [{ file: CLAUDE, path: "attribution.commit" }]);
  assert.deepEqual(s.read(CLAUDE), { other: 1, attribution: { commit: "mine" } });
});

test("a missing file is created along with its directory", () => {
  const s = basic();
  assert.equal(exists(dirname(s.path(OPENCODE))), false);
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.deepEqual(s.read(OPENCODE), { autoupdate: false });
});

test("no state record and another value is a collision conflict, and nothing is written", () => {
  const s = basic();
  s.write(CLAUDE, { attribution: { commit: "theirs" } });
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.conflict);
  assert.equal(doc.conflicts.length, 1);
  const [c] = doc.conflicts;
  assert.deepEqual(Object.keys(c).sort(), ["detail", "fix", "kind", "path"]);
  assert.equal(c.kind, "key");
  assert.equal(c.path, `${CLAUDE} attribution.commit`);
  assert.match(c.fix, /fleet apply/);
  assert.doesNotMatch(JSON.stringify(doc), /theirs|"mine"/, "values are never printed");
  assert.deepEqual(s.read(CLAUDE), { attribution: { commit: "theirs" } });
  assert.equal(exists(s.path(OPENCODE)), false, "the other file is not written either");
  assert.equal(exists(statePath(s.home)), false);
});

test("current equals state actual and desired changed is an update", () => {
  const s = applied();
  s.writeYaml("laptop.yaml", "settings:\n  claude:\n    attribution:\n      commit: changed\n  opencode:\n    autoupdate: false\n");
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(doc.updated, [{ file: CLAUDE, path: "attribution.commit" }]);
  assert.deepEqual(s.read(CLAUDE), { attribution: { commit: "changed" } });
  assert.deepEqual(readState(s.home).keys[0], { file: CLAUDE, path: "attribution.commit", desired: sha("changed"), actual: sha("changed") });
});

test("current differs from state actual is a conflict, even when desired is unchanged", () => {
  const s = applied();
  s.write(CLAUDE, { attribution: { commit: "edited" } });
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.conflict);
  assert.equal(doc.conflicts[0].kind, "key");
  assert.equal(doc.conflicts[0].path, `${CLAUDE} attribution.commit`);
  assert.deepEqual(s.read(CLAUDE), { attribution: { commit: "edited" } });
});

test("a changed config does not override an outside edit", () => {
  const s = applied();
  s.write(CLAUDE, { attribution: { commit: "edited" } });
  s.writeYaml("laptop.yaml", "settings:\n  claude:\n    attribution:\n      commit: changed\n  opencode:\n    autoupdate: false\n");
  assert.equal(s.run(["apply"]).code, EXIT.conflict);
  assert.deepEqual(s.read(CLAUDE), { attribution: { commit: "edited" } });
});

test("a key a tool normalised after fleet wrote it stays a no-op", () => {
  const s = applied();
  // The tool rewrote the value; state.actual holds what fleet read back.
  s.write(CLAUDE, { attribution: { commit: "normalised" } });
  const state = readState(s.home);
  state.keys.find((k: { path: string }) => k.path === "attribution.commit").actual = sha("normalised");
  writeFileSync(statePath(s.home), JSON.stringify(state));
  const before = readFileSync(statePath(s.home), "utf8");
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual([doc.created, doc.updated], [[], []]);
  assert.equal(readFileSync(statePath(s.home), "utf8"), before);
  assert.deepEqual(s.read(CLAUDE), { attribution: { commit: "normalised" } });
});

test("a value sitting where a parent map should be is a conflict", () => {
  const s = basic();
  s.write(CLAUDE, { attribution: "a string" });
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.conflict);
  assert.equal(doc.conflicts[0].path, `${CLAUDE} attribution.commit`);
});

test("removing a declared key removes it when unchanged, leaving unowned siblings", () => {
  const s = applied();
  s.write(CLAUDE, { sibling: 1, attribution: { commit: "mine", extra: true } });
  s.writeYaml("laptop.yaml", "settings:\n  opencode:\n    autoupdate: false\n");
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(doc.removed, [{ file: CLAUDE, path: "attribution.commit" }]);
  assert.deepEqual(s.read(CLAUDE), { sibling: 1, attribution: { extra: true } });
  assert.deepEqual(readState(s.home).keys.map((k: { path: string }) => k.path), ["autoupdate"]);
});

test("removing a key leaves the maps around it, and the order of everything unowned", () => {
  const s = applied();
  s.write(CLAUDE, { first: 1, attribution: { commit: "mine" }, last: 2 });
  s.writeYaml("laptop.yaml", "settings:\n  opencode:\n    autoupdate: false\n");
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.equal(s.readText(CLAUDE), JSON.stringify({ first: 1, attribution: {}, last: 2 }, null, 2) + "\n");
});

test("a leaf owned as {} can become its members: the old key goes first, the new ones are set", () => {
  const s = setup({ host: "settings:\n  claude:\n    env: {}\n" });
  s.write(CLAUDE, { before: 1 });
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  s.writeYaml("laptop.yaml", "settings:\n  claude:\n    env:\n      FOO: bar\n");
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(s.read(CLAUDE), { before: 1, env: { FOO: "bar" } });
  assert.deepEqual(doc.removed, [{ file: CLAUDE, path: "env" }]);
  assert.deepEqual(doc.created, [{ file: CLAUDE, path: "env.FOO" }]);
  assert.deepEqual(readState(s.home).keys.map((k: { path: string }) => k.path), ["env.FOO"]);
});

test("removing a declared key whose value changed is a removal conflict", () => {
  const s = applied();
  s.write(CLAUDE, { attribution: { commit: "edited" } });
  s.writeYaml("laptop.yaml", "settings:\n  opencode:\n    autoupdate: false\n");
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.conflict);
  assert.equal(doc.conflicts[0].kind, "removal");
  assert.equal(doc.conflicts[0].path, `${CLAUDE} attribution.commit`);
  assert.deepEqual(s.read(CLAUDE), { attribution: { commit: "edited" } });
  assert.equal(readState(s.home).keys.length, 2);
});

test("removing a declared key that is already missing leaves the state", () => {
  const s = applied();
  s.write(CLAUDE, { other: 1 });
  s.writeYaml("laptop.yaml", "settings:\n  opencode:\n    autoupdate: false\n");
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(doc.forgotten, [`${CLAUDE} attribution.commit`]);
  assert.deepEqual(s.read(CLAUDE), { other: 1 });
  assert.deepEqual(readState(s.home).keys.map((k: { path: string }) => k.path), ["autoupdate"]);
});

test("a file fleet owned keys in is still checked when the host declares nothing there any more", () => {
  const s = applied();
  s.writeYaml("laptop.yaml", "{}\n");
  s.write(OPENCODE, '// mine now\n{"autoupdate": false}\n');
  // Removing the recorded key needs a write into a file with comments.
  assert.equal(s.run(["apply"]).code, EXIT.conflict);
});

test("a conflict on one key stops the removal and creation of every other", () => {
  const s = applied();
  s.write(CLAUDE, { attribution: { commit: "edited" } });
  s.writeYaml("laptop.yaml", "settings:\n  claude:\n    attribution:\n      commit: mine\n  opencode:\n    autoupdate: true\n");
  assert.equal(s.run(["apply"]).code, EXIT.conflict);
  assert.deepEqual(s.read(OPENCODE), { autoupdate: false });
});

test("settings are applied before links, and links still work beside them", () => {
  const s = basic();
  writeFileSync(join(s.clone, "a.md"), "a\n");
  s.writeYaml("laptop.yaml", `files:\n  - { source: a.md, target: ~/linked }\n${readFileSync(join(s.clone, "hosts/laptop.yaml"), "utf8")}`);
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(doc.created.length, 3);
  const state = readState(s.home);
  assert.equal(state.links.length, 1);
  assert.equal(state.keys.length, 2);
});

test("a link conflict stops settings from being written", () => {
  const s = basic();
  writeFileSync(join(s.clone, "a.md"), "a\n");
  s.writeYaml("laptop.yaml", `files:\n  - { source: a.md, target: ~/linked }\n${readFileSync(join(s.clone, "hosts/laptop.yaml"), "utf8")}`);
  writeFileSync(join(s.home, "linked"), "mine");
  assert.equal(s.run(["apply"]).code, EXIT.conflict);
  assert.equal(exists(s.path(CLAUDE)), false);
});

test("opencode.jsonc with comments is a conflict when a write is needed", () => {
  const s = basic();
  s.write(OPENCODE, '// my notes\n{\n  "theme": "x" /* inline */\n}\n');
  const before = s.readText(OPENCODE);
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.conflict);
  assert.equal(doc.conflicts.length, 1);
  assert.equal(doc.conflicts[0].kind, "key");
  assert.equal(doc.conflicts[0].path, OPENCODE);
  assert.match(doc.conflicts[0].detail, /comments or trailing commas/);
  assert.equal(s.readText(OPENCODE), before);
  assert.equal(exists(s.path(CLAUDE)), false);
});

test("opencode.jsonc with trailing commas is a conflict when a write is needed", () => {
  const s = basic();
  s.write(OPENCODE, '{\n  "theme": "x",\n}\n');
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.conflict);
  assert.match(doc.conflicts[0].detail, /trailing commas/);
});

test("comments and trailing commas inside strings are not comments", () => {
  const s = basic();
  s.write(OPENCODE, '{"url": "http://x/*not*/,", "list": ["a,]"]}\n');
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.deepEqual(s.read(OPENCODE), { url: "http://x/*not*/,", list: ["a,]"], autoupdate: false });
});

test("opencode.jsonc with comments is fine when nothing needs writing", () => {
  const s = basic();
  s.write(OPENCODE, '// my notes\n{\n  "autoupdate": false, // keep\n}\n');
  const before = s.readText(OPENCODE);
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(s.readText(OPENCODE), before);
  assert.equal(readState(s.home).keys.length, 2);
});

test("a settings file that is not JSON at all is a conflict", () => {
  const s = basic();
  s.write(CLAUDE, "{ nope");
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.conflict);
  assert.equal(doc.conflicts[0].path, CLAUDE);
  assert.equal(s.readText(CLAUDE), "{ nope");
});

test("a settings file whose top level is not a map is a conflict", () => {
  const s = basic();
  s.write(CLAUDE, "[1]\n");
  assert.equal(s.run(["apply"]).code, EXIT.conflict);
});

test("an existing opencode.json is a conflict", () => {
  const s = basic();
  s.write("~/.config/opencode/opencode.json", { old: true });
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.conflict);
  assert.equal(doc.conflicts[0].kind, "key");
  assert.equal(doc.conflicts[0].path, "~/.config/opencode/opencode.json");
  assert.match(doc.conflicts[0].detail, /loads both/);
  assert.equal(exists(s.path(CLAUDE)), false);
});

test("an existing opencode.json is a conflict even for a host that owns nothing in opencode", () => {
  const s = setup({ host: "settings:\n  claude:\n    attribution:\n      commit: mine\n" });
  s.write("~/.config/opencode/opencode.json", { old: true });
  assert.equal(s.run(["apply"]).code, EXIT.conflict);
  assert.equal(exists(s.path(CLAUDE)), false);
});

test("settings.local.json is never touched", () => {
  const s = basic();
  s.write("~/.claude/settings.local.json", '{"keep":  "as is"}');
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  s.writeYaml("laptop.yaml", "{}\n");
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.equal(s.readText("~/.claude/settings.local.json"), '{"keep":  "as is"}');
});

test("a host that declares no settings creates no settings file", () => {
  const s = setup();
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.equal(exists(s.path(CLAUDE)), false);
  assert.equal(exists(s.path(OPENCODE)), false);
});

test("diff prints the key changes without values and writes nothing", () => {
  const s = basic();
  const r = s.run(["diff"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stdout, new RegExp(`create ${CLAUDE.replace(/[~.]/g, "\\$&")} attribution\\.commit`));
  assert.doesNotMatch(r.stdout, /mine/);
  assert.equal(exists(s.path(CLAUDE)), false);
  assert.equal(exists(statePath(s.home)), false);
});

test("diff on an applied host says there is nothing to do, and shows an update", () => {
  const s = applied();
  assert.match(s.run(["diff"]).stdout, /nothing to do/);
  s.writeYaml("laptop.yaml", "settings:\n  claude:\n    attribution:\n      commit: changed\n  opencode:\n    autoupdate: false\n");
  const { r, doc } = s.json(["diff"]);
  assert.equal(r.code, EXIT.ok);
  assert.deepEqual(doc.updated, [{ file: CLAUDE, path: "attribution.commit" }]);
  assert.deepEqual(s.read(CLAUDE), { attribution: { commit: "mine" } });
});

test("diff exits 3 on a key conflict", () => {
  const s = applied();
  s.write(CLAUDE, { attribution: { commit: "edited" } });
  const r = s.run(["diff"]);
  assert.equal(r.code, EXIT.conflict);
  assert.match(r.stdout, /conflict .*attribution\.commit: /);
});
