import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, makeClone, makeHome, makeSource, publish, runFleet } from "./helpers.ts";
import { RESERVED_SKILLS } from "../src/catalog.ts";
import { EXIT } from "../src/exit.ts";

const skill = (name: string) => ({ [`${name}/SKILL.md`]: `---\nname: ${name}\n---\n` });

type SourceSpec = { repo: string; path?: string; commit?: string; branch?: string; track?: string };

function sourcesYaml(sources: Record<string, SourceSpec>, bundles: Record<string, string[]>): string {
  const lines = ["sources:"];
  for (const [name, s] of Object.entries(sources)) {
    lines.push(`  ${name}:`, `    repo: ${s.repo}`, `    path: ${s.path ?? "."}`);
    if (s.commit) lines.push(`    commit: ${s.commit}`, `    track: ${s.track ?? "main"}`);
    if (s.branch) lines.push(`    branch: ${s.branch}`);
  }
  lines.push("bundles:");
  for (const [name, skills] of Object.entries(bundles)) lines.push(`  ${name}: [${skills.join(", ")}]`);
  return `${lines.join("\n")}\n`;
}

function setup(opts: { sources: Record<string, SourceSpec>; bundles: Record<string, string[]>; pick?: string[]; defaults?: string }) {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(clone, rel)), { recursive: true });
    writeFileSync(join(clone, rel), content);
  };
  write("catalog/skills.yaml", sourcesYaml(opts.sources, opts.bundles));
  if (opts.defaults !== undefined) write("hosts/_defaults.yaml", opts.defaults);
  write("hosts/laptop.yaml", `bundles: [${(opts.pick ?? Object.keys(opts.bundles)).join(", ")}]\n`);
  const run = (args: string[]) => (publish(clone), runFleet(clone, args, { home }));
  const json = (args: string[]) => {
    const r = run([...args, "--json"]);
    return { r, doc: JSON.parse(r.stdout) };
  };
  const skillPath = (name: string) => join(home, ".claude/skills", name);
  const sourceClone = (name: string) => join(home, ".local/share/fleet/sources", name);
  return { clone, home, write, run, json, skillPath, sourceClone };
}

const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
const state = (home: string) => JSON.parse(readFileSync(join(home, ".local/state/fleet/applied.json"), "utf8"));

test("apply clones a followed source and links each bundle skill into ~/.claude/skills", () => {
  const src = makeSource({ ...skill("planning"), ...skill("tdd"), ...skill("unused") });
  const s = setup({ sources: { mine: { repo: src.remote, branch: "main" } }, bundles: { core: ["planning", "tdd"] } });
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(readlinkSync(s.skillPath("planning")), join(s.sourceClone("mine"), "planning"));
  assert.equal(readlinkSync(s.skillPath("tdd")), join(s.sourceClone("mine"), "tdd"));
  assert.equal(exists(s.skillPath("unused")), false);
  assert.match(readFileSync(join(s.skillPath("planning"), "SKILL.md"), "utf8"), /name: planning/);
});

test("a pinned source is checked out at its commit, whatever its branch has moved on to", () => {
  const src = makeSource({ ...skill("tdd"), "tdd/notes.md": "v1" });
  const pinned = src.first;
  src.commit({ "tdd/notes.md": "v2" });
  const s = setup({ sources: { mine: { repo: src.remote, commit: pinned } }, bundles: { eng: ["tdd"] } });
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.equal(readFileSync(join(s.skillPath("tdd"), "notes.md"), "utf8"), "v1");
  assert.equal(git(s.sourceClone("mine"), "rev-parse", "HEAD"), pinned);
});

test("a pinned source already at its commit is not fetched or touched again", () => {
  const src = makeSource(skill("tdd"));
  const s = setup({ sources: { mine: { repo: src.remote, commit: src.first } }, bundles: { eng: ["tdd"] } });
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  rmSync(dirname(src.remote), { recursive: true });
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
});

test("moving the pin moves the clone, and the link follows because it points into the clone", () => {
  const src = makeSource({ ...skill("tdd"), "tdd/notes.md": "v1" });
  const second = src.commit({ "tdd/notes.md": "v2" });
  const s = setup({ sources: { mine: { repo: src.remote, commit: src.first } }, bundles: { eng: ["tdd"] } });
  s.run(["apply"]);
  s.write("catalog/skills.yaml", sourcesYaml({ mine: { repo: src.remote, commit: second } }, { eng: ["tdd"] }));
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(readFileSync(join(s.skillPath("tdd"), "notes.md"), "utf8"), "v2");
});

test("a pinned source with uncommitted changes is a repo conflict and nothing is written", () => {
  const src = makeSource({ ...skill("tdd"), ...skill("other") });
  const second = src.commit({ "tdd/notes.md": "v2" });
  const s = setup({ sources: { mine: { repo: src.remote, commit: src.first } }, bundles: { eng: ["tdd"] } });
  s.run(["apply"]);
  s.write("catalog/skills.yaml", sourcesYaml({ mine: { repo: src.remote, commit: second } }, { eng: ["tdd", "other"] }));
  writeFileSync(join(s.sourceClone("mine"), "tdd/SKILL.md"), "edited by hand");
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.conflict);
  assert.equal(doc.conflicts.length, 1);
  assert.equal(doc.conflicts[0].kind, "repo");
  assert.match(doc.conflicts[0].path, /sources\/mine$/);
  assert.match(doc.conflicts[0].fix, /fleet apply/);
  assert.equal(git(s.sourceClone("mine"), "rev-parse", "HEAD"), src.first);
  assert.equal(exists(s.skillPath("other")), false);
  assert.equal(exists(s.skillPath("tdd")), true, "no removals are planned from a source that could not be read");
});

test("a followed source sits on its branch: a clone on another branch is switched", () => {
  const src = makeSource(skill("tdd"));
  const s = setup({ sources: { mine: { repo: src.remote, branch: "main" } }, bundles: { eng: ["tdd"] } });
  s.run(["apply"]);
  git(s.sourceClone("mine"), "checkout", "-b", "elsewhere");
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.equal(git(s.sourceClone("mine"), "branch", "--show-current"), "main");
});

function followed() {
  const src = makeSource(skill("tdd"));
  const s = setup({ sources: { mine: { repo: src.remote, branch: "main" } }, bundles: { eng: ["tdd"] } });
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  const head = () => git(s.sourceClone("mine"), "rev-parse", "HEAD");
  const stateText = () => readFileSync(join(s.home, ".local/state/fleet/applied.json"), "utf8");
  return { src, s, head, stateText, before: head(), stateBefore: stateText() };
}

test("apply fast-forwards a followed source to what GitHub has", () => {
  const { src, s, head } = followed();
  const moved = src.commit({ "tdd/notes.md": "v2", ...skill("extra") });
  s.write("catalog/skills.yaml", sourcesYaml({ mine: { repo: src.remote, branch: "main" } }, { eng: ["tdd", "extra"] }));
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(head(), moved);
  assert.equal(readFileSync(join(s.skillPath("tdd"), "notes.md"), "utf8"), "v2");
  assert.equal(exists(s.skillPath("extra")), true);
});

test("a followed source with uncommitted changes is a repo conflict and nothing is written", () => {
  const { src, s, head, before, stateText, stateBefore } = followed();
  src.commit({ "tdd/notes.md": "v2" });
  writeFileSync(join(s.sourceClone("mine"), "tdd/SKILL.md"), "edited by hand");
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.conflict);
  assert.equal(doc.conflicts.length, 1);
  assert.equal(doc.conflicts[0].kind, "repo");
  assert.match(doc.conflicts[0].path, /sources\/mine$/);
  assert.match(doc.conflicts[0].detail, /uncommitted changes/);
  assert.equal(head(), before, "a dirty source is not moved");
  assert.equal(stateText(), stateBefore);
});

test("a followed source with local-only commits is a repo conflict", () => {
  const { s, before, head } = followed();
  writeFileSync(join(s.sourceClone("mine"), "local.md"), "mine");
  git(s.sourceClone("mine"), "add", "-A");
  git(s.sourceClone("mine"), "commit", "-m", "local only");
  const local = head();
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.conflict);
  assert.equal(doc.conflicts[0].kind, "repo");
  assert.match(doc.conflicts[0].path, /sources\/mine$/);
  assert.match(doc.conflicts[0].detail, /1 local commit/);
  assert.notEqual(local, before);
  assert.equal(head(), local);
});

test("a diverged followed source is a repo conflict", () => {
  const { src, s, head } = followed();
  src.commit({ "theirs.md": "1" });
  writeFileSync(join(s.sourceClone("mine"), "mine.md"), "1");
  git(s.sourceClone("mine"), "add", "-A");
  git(s.sourceClone("mine"), "commit", "-m", "mine");
  const local = head();
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.conflict);
  assert.match(doc.conflicts[0].detail, /diverged.*1 ahead.*1 behind/);
  assert.equal(head(), local);
});

test("a fleet clone conflict and a source conflict are reported together", () => {
  const { s } = followed();
  writeFileSync(join(s.sourceClone("mine"), "scratch.md"), "x");
  writeFileSync(join(s.clone, "scratch.txt"), "x");
  const r = runFleet(s.clone, ["apply", "--json"], { home: s.home }); // not through `run`, which would publish the scratch file
  const doc = JSON.parse(r.stdout);
  assert.equal(r.code, EXIT.conflict);
  assert.deepEqual(doc.conflicts.map((c: { kind: string }) => c.kind), ["repo", "repo"]);
  assert.deepEqual(doc.conflicts.map((c: { path: string }) => c.path.endsWith("sources/mine")).sort(), [false, true]);
});

test("a followed source whose fetch fails exits 4 and writes nothing", () => {
  const { src, s, stateText, stateBefore } = followed();
  rmSync(dirname(src.remote), { recursive: true });
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.unreachable);
  assert.match(r.stderr, /cannot fetch .* for source 'mine'/);
  assert.equal(stateText(), stateBefore);
});

test("diff does not pull a followed source, and does not need GitHub", () => {
  const { src, s, head, before } = followed();
  src.commit({ "tdd/notes.md": "v2" });
  assert.equal(s.run(["diff"]).code, EXIT.ok);
  assert.equal(head(), before);
  rmSync(dirname(src.remote), { recursive: true });
  const r = s.run(["diff"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
});

test("diff reports a followed source with uncommitted changes as a repo conflict", () => {
  const { s } = followed();
  writeFileSync(join(s.sourceClone("mine"), "scratch.md"), "x");
  const { r, doc } = s.json(["diff"]);
  assert.equal(r.code, EXIT.conflict);
  assert.equal(doc.conflicts[0].kind, "repo");
});

test("a source that cannot be cloned exits 4 and writes nothing", () => {
  const s = setup({ sources: { mine: { repo: "/nonexistent/repo.git", branch: "main" } }, bundles: { eng: ["tdd"] } });
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.unreachable);
  assert.match(r.stderr, /cannot clone \/nonexistent\/repo\.git/);
  assert.equal(exists(join(s.home, ".local/state/fleet/applied.json")), false);
});

test("a pinned commit that is not in the repo is invalid", () => {
  const src = makeSource(skill("tdd"));
  const s = setup({ sources: { mine: { repo: src.remote, commit: `${"0".repeat(39)}a` } }, bundles: { eng: ["tdd"] } });
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /pinned commit 0{39}a is not in/);
});

test("a skill resolves at any depth under the source path, and dot directories are skipped", () => {
  const src = makeSource({
    "skills/deep/er/tdd/SKILL.md": "real",
    "skills/.hidden/tdd/SKILL.md": "decoy in a dot directory",
    ".agents/skills/tdd/SKILL.md": "decoy outside the path",
    "elsewhere/tdd/SKILL.md": "outside the path",
  });
  const s = setup({ sources: { mine: { repo: src.remote, branch: "main", path: "skills" } }, bundles: { eng: ["tdd"] } });
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(readFileSync(join(s.skillPath("tdd"), "SKILL.md"), "utf8"), "real");
});

test("a source path that is itself a skill offers only that skill", () => {
  const shared = makeSource({ "pack/skills/polish/SKILL.md": "theirs", "pack/skills/tdd/SKILL.md": "theirs" });
  const mine = makeSource(skill("tdd"));
  const s = setup({
    sources: { pack: { repo: shared.remote, branch: "main", path: "pack/skills/polish" }, mine: { repo: mine.remote, branch: "main" } },
    bundles: { eng: ["tdd", "polish"] },
  });
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(readFileSync(join(s.skillPath("polish"), "SKILL.md"), "utf8"), "theirs");
  assert.match(readFileSync(join(s.skillPath("tdd"), "SKILL.md"), "utf8"), /name: tdd/);
});

test("a SKILL.md at the root of a source with path . is not a skill named after the clone", () => {
  const src = makeSource({ "SKILL.md": "root" });
  const s = setup({ sources: { mine: { repo: src.remote, branch: "main" } }, bundles: { eng: ["mine"] } });
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /skill 'mine' is in no source/);
});

test("a directory without a SKILL.md is not a skill", () => {
  const src = makeSource({ "tdd/README.md": "not a skill" });
  const s = setup({ sources: { mine: { repo: src.remote, branch: "main" } }, bundles: { eng: ["tdd"] } });
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /skill 'tdd' is in no source/);
});

function invalid(s: ReturnType<typeof setup>, message: RegExp) {
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.invalid, r.stderr);
  assert.match(r.stderr, message);
  assert.equal(exists(join(s.home, ".claude")), false, "nothing is linked");
  assert.equal(exists(join(s.home, ".local/state/fleet/applied.json")), false);
}

test("a name that resolves to several directories is invalid", () => {
  const src = makeSource({ "a/tdd/SKILL.md": "1", "b/tdd/SKILL.md": "2" });
  invalid(setup({ sources: { mine: { repo: src.remote, branch: "main" } }, bundles: { eng: ["tdd"] } }), /more than one directory in source 'mine'/);
});

test("a name in two sources is invalid", () => {
  const one = makeSource(skill("tdd"));
  const two = makeSource(skill("tdd"));
  const s = setup({ sources: { one: { repo: one.remote, branch: "main" }, two: { repo: two.remote, branch: "main" } }, bundles: { eng: ["tdd"] } });
  invalid(s, /skill 'tdd' is in more than one source \(one, two\)/);
});

test("a skill in two bundles is invalid", () => {
  const src = makeSource(skill("tdd"));
  const s = setup({ sources: { mine: { repo: src.remote, branch: "main" } }, bundles: { a: ["tdd"], b: ["tdd"] }, pick: ["a"] });
  invalid(s, /skill 'tdd' is in both bundle 'a' and bundle 'b'/);
});

for (const name of RESERVED_SKILLS) {
  test(`the reserved name '${name}' in a bundle is invalid`, () => {
    const src = makeSource(skill("tdd"));
    const s = setup({ sources: { mine: { repo: src.remote, branch: "main" } }, bundles: { eng: ["tdd", name] } });
    invalid(s, new RegExp(`'${name.replace(".", "\\.")}' is a reserved name`));
  });
}

test("a skill that resolves to nothing is invalid, and every unresolved name is listed", () => {
  const src = makeSource(skill("tdd"));
  const s = setup({ sources: { mine: { repo: src.remote, branch: "main" } }, bundles: { eng: ["tdd", "ghost", "spectre"] } });
  invalid(s, /skill 'ghost' is in no source[^]*skill 'spectre' is in no source/);
});

test("a bundle the host names but the catalog lacks is invalid", () => {
  const src = makeSource(skill("tdd"));
  const s = setup({ sources: { mine: { repo: src.remote, branch: "main" } }, bundles: { eng: ["tdd"] }, pick: ["eng", "nope"] });
  invalid(s, /names bundle 'nope', which is not in catalog\/skills\.yaml/);
});

test("a skill and a files record on the same target is invalid", () => {
  const src = makeSource(skill("tdd"));
  const s = setup({ sources: { mine: { repo: src.remote, branch: "main" } }, bundles: { eng: ["tdd"] } });
  s.write("config/x.md", "x");
  s.write("hosts/laptop.yaml", "bundles: [eng]\nfiles:\n  - { source: config/x.md, target: ~/.claude/skills/tdd }\n");
  invalid(s, /skill 'tdd' and a files record both target/);
});

for (const [name, key, bad, message] of [
  ["a source with neither commit nor branch", "x", "    repo: r\n    path: .\n", /exactly one of 'commit'/],
  ["a source with both commit and branch", "x", `    repo: r\n    path: .\n    commit: ${"a".repeat(40)}\n    track: main\n    branch: main\n`, /exactly one of 'commit'/],
  ["a pinned source without track", "x", `    repo: r\n    path: .\n    commit: ${"a".repeat(40)}\n`, /needs 'track'/],
  ["a short commit", "x", "    repo: r\n    path: .\n    commit: abc123\n    track: main\n", /40-character/],
  ["an unknown source key", "x", "    repo: r\n    path: .\n    branch: main\n    depth: 1\n", /unknown key 'depth'/],
  ["a path that climbs out of the repo", "x", "    repo: r\n    path: ../x\n    branch: main\n", /without '\.\.'/],
] as const) {
  test(`${name} makes the catalog invalid`, () => {
    const s = setup({ sources: {}, bundles: {} });
    s.write("catalog/skills.yaml", `sources:\n  ${key}:\n${bad}`);
    const r = s.run(["apply"]);
    assert.equal(r.code, EXIT.invalid, r.stderr);
    assert.match(r.stderr, message);
  });
}

test("bundles add across the defaults and the host file, and exclude removes after every list", () => {
  const src = makeSource({ ...skill("a"), ...skill("b"), ...skill("c"), ...skill("d") });
  const s = setup({
    sources: { mine: { repo: src.remote, branch: "main" } },
    bundles: { one: ["a"], two: ["b"], three: ["c"], four: ["d"] },
    defaults: "bundles: [one, two]\nexclude: [four]\n",
  });
  // The host adds `three` and `four`, and excludes `two`. The defaults' exclude of `four` still applies.
  s.write("hosts/laptop.yaml", "bundles: [three, four]\nexclude: [two]\n");
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(["a", "b", "c", "d"].filter((n) => exists(s.skillPath(n))), ["a", "c"]);
});

test("a bundle in both bundles and exclude of one file is excluded", () => {
  const src = makeSource({ ...skill("a"), ...skill("b") });
  const s = setup({ sources: { mine: { repo: src.remote, branch: "main" } }, bundles: { one: ["a"], two: ["b"] } });
  s.write("hosts/laptop.yaml", "bundles: [one, two]\nexclude: [two]\n");
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.deepEqual(["a", "b"].filter((n) => exists(s.skillPath(n))), ["a"]);
});

test("removing a bundle removes its links on the next apply, and only those", () => {
  const src = makeSource({ ...skill("a"), ...skill("b") });
  const s = setup({ sources: { mine: { repo: src.remote, branch: "main" } }, bundles: { one: ["a"], two: ["b"] } });
  s.run(["apply"]);
  assert.equal(exists(s.skillPath("b")), true);
  s.write("hosts/laptop.yaml", "bundles: [one]\n");
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(doc.removed.map((x: { target: string }) => x.target), ["~/.claude/skills/b"]);
  assert.equal(exists(s.skillPath("b")), false);
  assert.equal(exists(s.skillPath("a")), true);
  assert.deepEqual(state(s.home).links.map((l: { target: string }) => l.target).filter((t: string) => t !== "~/.claude/skills/fleet"), ["~/.claude/skills/a"]);
});

test("synced, .trash and hand-placed skills in ~/.claude/skills are left alone, across applies and removals", () => {
  const src = makeSource({ ...skill("a"), ...skill("b") });
  const s = setup({ sources: { mine: { repo: src.remote, branch: "main" } }, bundles: { one: ["a"], two: ["b"] } });
  const skills = join(s.home, ".claude/skills");
  mkdirSync(join(skills, "synced/x"), { recursive: true });
  mkdirSync(join(skills, ".trash"), { recursive: true });
  mkdirSync(join(skills, "personal"), { recursive: true });
  writeFileSync(join(skills, "personal/SKILL.md"), "mine");
  symlinkSync("/etc/hostname", join(skills, "handmade"));
  const before = () => ["synced", ".trash", "personal", "handmade"].filter((n) => exists(join(skills, n)));
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  s.write("hosts/laptop.yaml", "bundles: [one]\n");
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  s.write("hosts/laptop.yaml", "{}\n");
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.deepEqual(before(), ["synced", ".trash", "personal", "handmade"]);
  assert.equal(readFileSync(join(skills, "personal/SKILL.md"), "utf8"), "mine");
  assert.equal(readlinkSync(join(skills, "handmade")), "/etc/hostname");
  assert.equal(exists(s.skillPath("a")), false);
});

test("a hand-placed skill with the name of a bundle skill is a link conflict, not overwritten", () => {
  const src = makeSource(skill("a"));
  const s = setup({ sources: { mine: { repo: src.remote, branch: "main" } }, bundles: { one: ["a"] } });
  mkdirSync(s.skillPath("a"), { recursive: true });
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.conflict);
  assert.equal(doc.conflicts[0].kind, "link");
  assert.equal(doc.conflicts[0].path, "~/.claude/skills/a");
});

test("no bundles picked means no source is cloned", () => {
  const src = makeSource(skill("a"));
  const s = setup({ sources: { mine: { repo: src.remote, branch: "main" } }, bundles: { one: ["a"] }, pick: [] });
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.equal(exists(join(s.home, ".local/share")), false);
});

test("a second apply changes nothing", () => {
  const src = makeSource(skill("a"));
  const s = setup({ sources: { mine: { repo: src.remote, branch: "main" } }, bundles: { one: ["a"] } });
  s.run(["apply"]);
  const before = readFileSync(join(s.home, ".local/state/fleet/applied.json"), "utf8");
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.ok);
  assert.deepEqual(doc.created, []);
  assert.equal(readFileSync(join(s.home, ".local/state/fleet/applied.json"), "utf8"), before);
});

test("diff on a fresh host clones the missing sources, shows the skill links, and links nothing", () => {
  const src = makeSource({ ...skill("a"), ...skill("b") });
  const pinned = src.first;
  src.commit({ "a/notes.md": "later" });
  const s = setup({ sources: { mine: { repo: src.remote, commit: pinned } }, bundles: { one: ["a", "b"] } });
  const r = s.run(["diff"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stdout, /create ~\/\.claude\/skills\/a -> .*sources\/mine\/a/);
  assert.match(r.stdout, /create ~\/\.claude\/skills\/b -> /);
  assert.equal(exists(join(s.home, ".claude")), false);
  assert.equal(exists(join(s.home, ".local/state")), false);
  assert.equal(git(s.sourceClone("mine"), "rev-parse", "HEAD"), pinned);
});

test("diff never moves an existing clone: a clone off its pin is reported, and apply fixes it", () => {
  const src = makeSource({ ...skill("a"), "a/notes.md": "v1" });
  const second = src.commit({ "a/notes.md": "v2" });
  const s = setup({ sources: { mine: { repo: src.remote, commit: src.first } }, bundles: { one: ["a"] } });
  s.run(["apply"]);
  s.write("catalog/skills.yaml", sourcesYaml({ mine: { repo: src.remote, commit: second } }, { one: ["a"] }));
  const r = s.run(["diff"]);
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /is at [0-9a-f]{7}, not its pinned [0-9a-f]{7}; run 'fleet apply'/);
  assert.equal(git(s.sourceClone("mine"), "rev-parse", "HEAD"), src.first);
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.equal(git(s.sourceClone("mine"), "rev-parse", "HEAD"), second);
});

test("the skill links are real symlinks into the source clone", () => {
  const src = makeSource(skill("a"));
  const s = setup({ sources: { mine: { repo: src.remote, branch: "main" } }, bundles: { one: ["a"] } });
  s.run(["apply"]);
  assert.equal(lstatSync(s.skillPath("a")).isSymbolicLink(), true);
  assert.equal(realpathSync(s.skillPath("a")), realpathSync(join(s.sourceClone("mine"), "a")));
});

test("a followed branch the repo does not have is invalid, not unreachable", () => {
  const src = makeSource(skill("tdd"));
  const s = setup({ sources: { mine: { repo: src.remote, branch: "nope" } }, bundles: { eng: ["tdd"] } });
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.invalid, r.stderr);
  assert.match(r.stderr, /branch nope is not in/);
});

test("a source directory that is not a git clone is an error that names it", () => {
  const src = makeSource(skill("tdd"));
  const s = setup({ sources: { mine: { repo: src.remote, branch: "main" } }, bundles: { eng: ["tdd"] } });
  mkdirSync(s.sourceClone("mine"), { recursive: true });
  writeFileSync(join(s.sourceClone("mine"), "stray"), "x");
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.error);
  assert.match(r.stderr, /sources\/mine exists but is not a git clone/);
});
