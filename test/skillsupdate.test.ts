import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, makeClone, makeHome, makeSource, publish, runFleet } from "./helpers.ts";
import { EXIT } from "../src/exit.ts";

const skill = (name: string) => ({ [`${name}/SKILL.md`]: `---\nname: ${name}\n---\n` });
const short = (sha: string) => sha.slice(0, 7);

function setup(catalog: string, pick: string[] = []) {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(clone, rel)), { recursive: true });
    writeFileSync(join(clone, rel), content);
  };
  write("catalog/skills.yaml", catalog);
  write("hosts/laptop.yaml", `bundles: [${pick.join(", ")}]\n`);
  publish(clone);
  const catalogPath = join(clone, "catalog/skills.yaml");
  const run = (...args: string[]) => runFleet(clone, ["skills", "update", ...args], { home });
  const json = (...args: string[]) => {
    const r = run(...args, "--json");
    return { r, doc: JSON.parse(r.stdout) };
  };
  return { clone, home, write, run, json, catalogPath, read: () => readFileSync(catalogPath, "utf8") };
}

test("with no argument every pinned source moves to the head of its track branch", () => {
  const a = makeSource({ ...skill("one"), "one/notes.md": "v1" });
  const b = makeSource({ ...skill("two"), "two/notes.md": "v1" });
  const a2 = a.commit({ "one/notes.md": "v2" });
  const b2 = b.commit({ "two/notes.md": "v2" });
  const s = setup(
    `sources:\n  aa:\n    repo: ${a.remote}\n    commit: ${a.first}\n    track: main\n    path: .\n  bb:\n    repo: ${b.remote}\n    commit: ${b.first}\n    track: main\n    path: .\nbundles:\n  core: [one, two]\n`,
  );
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(
    s.read(),
    `sources:\n  aa:\n    repo: ${a.remote}\n    commit: ${a2}\n    track: main\n    path: .\n  bb:\n    repo: ${b.remote}\n    commit: ${b2}\n    track: main\n    path: .\nbundles:\n  core: [one, two]\n`,
  );
});

test("a source named on the command line is the only one that moves", () => {
  const a = makeSource({ ...skill("one"), "one/notes.md": "v1" });
  const b = makeSource({ ...skill("two"), "two/notes.md": "v1" });
  a.commit({ "one/notes.md": "v2" });
  const b2 = b.commit({ "two/notes.md": "v2" });
  const s = setup(
    `sources:\n  aa:\n    repo: ${a.remote}\n    commit: ${a.first}\n    track: main\n    path: .\n  bb:\n    repo: ${b.remote}\n    commit: ${b.first}\n    track: main\n    path: .\nbundles:\n  core: [one, two]\n`,
  );
  const r = s.run("bb");
  assert.equal(r.code, EXIT.ok, r.stderr);
  const text = s.read();
  assert.match(text, new RegExp(`aa:\\n.*\\n    commit: ${a.first}\\n`));
  assert.match(text, new RegExp(`bb:\\n.*\\n    commit: ${b2}\\n`));
  assert.doesNotMatch(r.stdout, /^aa:/m);
});

test("a followed source is left alone when every pinned source is updated", () => {
  const a = makeSource({ ...skill("one"), "one/notes.md": "v1" });
  const f = makeSource(skill("mine"));
  const a2 = a.commit({ "one/notes.md": "v2" });
  f.commit({ "mine/notes.md": "later" });
  const s = setup(
    `sources:\n  aa:\n    repo: ${a.remote}\n    commit: ${a.first}\n    track: main\n    path: .\n  ff:\n    repo: ${f.remote}\n    branch: main\n    path: .\nbundles:\n  core: [one, mine]\n`,
  );
  assert.equal(s.run().code, EXIT.ok);
  assert.equal(s.read(), `sources:\n  aa:\n    repo: ${a.remote}\n    commit: ${a2}\n    track: main\n    path: .\n  ff:\n    repo: ${f.remote}\n    branch: main\n    path: .\nbundles:\n  core: [one, mine]\n`);
});

test("only the commit line changes: comments, spacing, quotes and look-alike text survive byte for byte", () => {
  const a = makeSource({ ...skill("one"), "one/notes.md": "v1" });
  const b = makeSource({ ...skill("two"), "two/notes.md": "v1" });
  const a2 = a.commit({ "one/notes.md": "v2" });
  const b2 = b.commit({ "two/notes.md": "v2" });
  // The bundles come first and share the sources' names, and a comment repeats the old sha.
  const before = (aSha: string, bSha: string) =>
    [
      "# Fleet skills.  Hand-written; keep the comments.",
      "",
      "bundles:",
      "  aa: [one]   # not the source",
      "  bb: [two]",
      "",
      "sources:      # where the skills come from",
      "  # first source",
      "  aa:",
      `    repo:   ${a.remote}`,
      `    # was ${a.first} before the last update`,
      `    commit:    "${aSha}"   # pinned by hand`,
      "    track: main",
      "    path: .",
      "",
      "  bb:  ",
      `    commit: ${bSha}`,
      `    repo: ${b.remote}`,
      "    path: .",
      "    track: main",
      "# end",
      "",
    ].join("\n");
  const s = setup(before(a.first, b.first));
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  // Same text, with the two commit values replaced and nothing else; the repeated sha in the comment stays.
  assert.equal(s.read(), before(a2, b2).replace(`# was ${a2} before`, `# was ${a.first} before`));
  assert.equal(s.read().includes(`# was ${a.first} before the last update`), true);
});

test("a file with CRLF line endings keeps them", () => {
  const a = makeSource({ ...skill("one"), "one/notes.md": "v1" });
  const a2 = a.commit({ "one/notes.md": "v2" });
  const text = `sources:\r\n  aa:\r\n    repo: ${a.remote}\r\n    commit: ${a.first} # pin\r\n    track: main\r\n    path: .\r\nbundles:\r\n  core: [one]\r\n`;
  const s = setup(text);
  assert.equal(s.run().code, EXIT.ok);
  assert.equal(s.read(), text.replace(a.first, a2));
});

test("it prints the changed skills per source, and only the bundle skills that changed", () => {
  const a = makeSource({ ...skill("one"), ...skill("two"), ...skill("three"), ...skill("unlisted"), "one/notes.md": "v1", "three/notes.md": "v1" });
  const b = makeSource(skill("four"));
  const a2 = a.commit({ "one/notes.md": "v2", "three/notes.md": "v2", "unlisted/notes.md": "new" });
  const s = setup(
    `sources:\n  aa:\n    repo: ${a.remote}\n    commit: ${a.first}\n    track: main\n    path: .\n  bb:\n    repo: ${b.remote}\n    commit: ${b.first}\n    track: main\n    path: .\nbundles:\n  core: [one, two, four]\n  more: [three]\n`,
  );
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stdout, new RegExp(`^aa: ${short(a.first)} -> ${short(a2)}\\n  one\\n  three\\n`, "m"));
  assert.doesNotMatch(r.stdout, /^ {2}two$/m);
  assert.doesNotMatch(r.stdout, /unlisted/);
  assert.match(r.stdout, new RegExp(`^bb: up to date \\(${short(b.first)}\\)$`, "m"));
});

test("--json lists what moved, with the skills that changed", () => {
  const a = makeSource({ ...skill("one"), ...skill("two") });
  const b = makeSource(skill("four"));
  const a2 = a.commit({ "two/notes.md": "v2" });
  const s = setup(
    `sources:\n  aa:\n    repo: ${a.remote}\n    commit: ${a.first}\n    track: main\n    path: .\n  bb:\n    repo: ${b.remote}\n    commit: ${b.first}\n    track: main\n    path: .\nbundles:\n  core: [one, two, four]\n`,
  );
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(doc.ok, true);
  assert.deepEqual(doc.updated, [{ source: "aa", from: a.first, to: a2, skills: ["two"] }]);
  assert.deepEqual(doc.unchanged, ["bb"]);
});

test("a skill that moved to another directory in the source still resolves", () => {
  const a = makeSource({ ...skill("one"), "one/notes.md": "v1" });
  rmSync(join(a.work, "one"), { recursive: true });
  const a2 = a.commit({ "deeper/one/SKILL.md": "---\nname: one\n---\n" });
  const s = setup(`sources:\n  aa:\n    repo: ${a.remote}\n    commit: ${a.first}\n    track: main\n    path: .\nbundles:\n  core: [one]\n`);
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(s.read(), new RegExp(`commit: ${a2}`));
  assert.match(r.stdout, /^ {2}one$/m);
});

test("a source already at the head of its track is not touched", () => {
  const a = makeSource(skill("one"));
  const text = `sources:\n  aa:\n    repo: ${a.remote}\n    commit: ${a.first}\n    track: main\n    path: .\nbundles:\n  core: [one]\n`;
  const s = setup(text);
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(s.read(), text);
  assert.equal(git(s.clone, "status", "--porcelain"), "");
  assert.match(r.stdout, /aa: up to date/);
});

test("the branch to read is the source's track, not main", () => {
  const a = makeSource(skill("one"), "stable");
  const a2 = a.commit({ "one/notes.md": "v2" });
  const s = setup(`sources:\n  aa:\n    repo: ${a.remote}\n    commit: ${a.first}\n    track: stable\n    path: .\nbundles:\n  core: [one]\n`);
  assert.equal(s.run().code, EXIT.ok);
  assert.match(s.read(), new RegExp(`commit: ${a2}`));
});

test("it does not commit, and does not apply: the repo is only dirty in the catalog and the host has nothing", () => {
  const a = makeSource({ ...skill("one"), "one/notes.md": "v1" });
  a.commit({ "one/notes.md": "v2" });
  const s = setup(`sources:\n  aa:\n    repo: ${a.remote}\n    commit: ${a.first}\n    track: main\n    path: .\nbundles:\n  core: [one]\n`, ["core"]);
  const head = git(s.clone, "rev-parse", "HEAD");
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(git(s.clone, "rev-parse", "HEAD"), head);
  assert.equal(git(s.clone, "status", "--porcelain"), "M catalog/skills.yaml");
  assert.equal(git(s.clone, "rev-parse", "origin/main"), head);
  for (const path of [".claude", ".local", ".config/opencode"]) assert.equal(existsSync(join(s.home, path)), false, path);
});

test("an applied host keeps its source clone and links where they were until apply runs", () => {
  const a = makeSource({ ...skill("one"), "one/notes.md": "v1" });
  const s = setup(`sources:\n  aa:\n    repo: ${a.remote}\n    commit: ${a.first}\n    track: main\n    path: .\nbundles:\n  core: [one]\n`, ["core"]);
  assert.equal(runFleet(s.clone, ["apply"], { home: s.home }).code, EXIT.ok);
  const clonePath = join(s.home, ".local/share/fleet/sources/aa");
  const a2 = a.commit({ "one/notes.md": "v2" });
  const stateBefore = readFileSync(join(s.home, ".local/state/fleet/applied.json"), "utf8");
  assert.equal(s.run().code, EXIT.ok);
  assert.equal(git(clonePath, "rev-parse", "HEAD"), a.first);
  assert.equal(readlinkSync(join(s.home, ".claude/skills/one")), join(clonePath, "one"));
  assert.equal(readFileSync(join(s.home, ".local/state/fleet/applied.json"), "utf8"), stateBefore);
  assert.match(s.read(), new RegExp(`commit: ${a2}`));
});

test("a bundle skill that no longer resolves exits 2 and names it, with nothing written", () => {
  const a = makeSource({ ...skill("one"), ...skill("two") });
  rmSync(join(a.work, "two"), { recursive: true });
  a.commit({ "one/notes.md": "v2" });
  const text = `sources:\n  aa:\n    repo: ${a.remote}\n    commit: ${a.first}\n    track: main\n    path: .\nbundles:\n  core: [one, two]\n`;
  const s = setup(text);
  const r = s.run();
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /skill 'two'.*source 'aa'/);
  assert.doesNotMatch(r.stderr, /skill 'one'/);
  assert.equal(r.stdout, "");
  assert.equal(s.read(), text);
});

test("with several sources nothing is written when any one fails, however many could move", () => {
  const ok1 = makeSource({ ...skill("one"), "one/notes.md": "v1" });
  const bad = makeSource({ ...skill("two"), ...skill("gone") });
  const ok2 = makeSource({ ...skill("three"), "three/notes.md": "v1" });
  ok1.commit({ "one/notes.md": "v2" });
  rmSync(join(bad.work, "gone"), { recursive: true });
  bad.commit({ "two/notes.md": "v2" });
  ok2.commit({ "three/notes.md": "v2" });
  const text = `# keep\nsources:\n  ok1:\n    repo: ${ok1.remote}\n    commit: ${ok1.first}\n    track: main\n    path: .\n  bad:\n    repo: ${bad.remote}\n    commit: ${bad.first}\n    track: main\n    path: .\n  ok2:\n    repo: ${ok2.remote}\n    commit: ${ok2.first}\n    track: main\n    path: .\nbundles:\n  core: [one, two, gone, three]\n`;
  const s = setup(text);
  const r = s.run();
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /skill 'gone'.*source 'bad'/);
  assert.equal(s.read(), text);
  assert.equal(git(s.clone, "status", "--porcelain"), "");
});

test("every failing source is reported, not just the first", () => {
  const a = makeSource({ ...skill("one"), ...skill("lost1") });
  const b = makeSource({ ...skill("two"), ...skill("lost2") });
  rmSync(join(a.work, "lost1"), { recursive: true });
  a.commit({ "one/notes.md": "v2" });
  rmSync(join(b.work, "lost2"), { recursive: true });
  b.commit({ "two/notes.md": "v2" });
  const s = setup(
    `sources:\n  aa:\n    repo: ${a.remote}\n    commit: ${a.first}\n    track: main\n    path: .\n  bb:\n    repo: ${b.remote}\n    commit: ${b.first}\n    track: main\n    path: .\nbundles:\n  core: [one, two, lost1, lost2]\n`,
  );
  const r = s.run();
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /skill 'lost1'/);
  assert.match(r.stderr, /skill 'lost2'/);
});

test("a skill that is a SKILL.md-less directory after the update no longer resolves", () => {
  const a = makeSource({ ...skill("one"), "one/notes.md": "v1" });
  rmSync(join(a.work, "one/SKILL.md"));
  a.commit({ "one/README.md": "no skill file now" });
  const text = `sources:\n  aa:\n    repo: ${a.remote}\n    commit: ${a.first}\n    track: main\n    path: .\nbundles:\n  core: [one]\n`;
  const s = setup(text);
  assert.equal(s.run().code, EXIT.invalid);
  assert.equal(s.read(), text);
});

test("a skill that becomes two directories in the source exits 2", () => {
  const a = makeSource(skill("one"));
  a.commit(skill("other/one"));
  const text = `sources:\n  aa:\n    repo: ${a.remote}\n    commit: ${a.first}\n    track: main\n    path: .\nbundles:\n  core: [one]\n`;
  const s = setup(text);
  const r = s.run();
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /skill 'one'.*more than one directory/);
  assert.equal(s.read(), text);
});

test("a skill another source provides is not blamed on a source that does not have it", () => {
  const a = makeSource({ ...skill("one"), "one/notes.md": "v1" });
  const b = makeSource(skill("two"));
  const a2 = a.commit({ "one/notes.md": "v2" });
  const s = setup(
    `sources:\n  aa:\n    repo: ${a.remote}\n    commit: ${a.first}\n    track: main\n    path: .\n  bb:\n    repo: ${b.remote}\n    commit: ${b.first}\n    track: main\n    path: .\nbundles:\n  core: [one, two]\n`,
  );
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(s.read(), new RegExp(`commit: ${a2}`));
});

test("a skill in a bundle no host picks still has to resolve", () => {
  const a = makeSource({ ...skill("one"), ...skill("shelved") });
  rmSync(join(a.work, "shelved"), { recursive: true });
  a.commit({ "one/notes.md": "v2" });
  const text = `sources:\n  aa:\n    repo: ${a.remote}\n    commit: ${a.first}\n    track: main\n    path: .\nbundles:\n  core: [one]\n  spare: [shelved]\n`;
  const s = setup(text, ["core"]);
  const r = s.run();
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /skill 'shelved'/);
  assert.equal(s.read(), text);
});

test("a source path that is gone at the new commit exits 2", () => {
  const a = makeSource({ "skills/one/SKILL.md": "x" });
  rmSync(join(a.work, "skills"), { recursive: true });
  a.commit({ "elsewhere/one/SKILL.md": "x" });
  const text = `sources:\n  aa:\n    repo: ${a.remote}\n    commit: ${a.first}\n    track: main\n    path: skills\nbundles:\n  core: [one]\n`;
  const s = setup(text);
  const r = s.run();
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /path 'skills' is not a directory/);
  assert.equal(s.read(), text);
});

test("a track branch the repo does not have exits 2", () => {
  const a = makeSource(skill("one"));
  const text = `sources:\n  aa:\n    repo: ${a.remote}\n    commit: ${a.first}\n    track: nope\n    path: .\nbundles:\n  core: [one]\n`;
  const s = setup(text);
  const r = s.run();
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /branch nope is not in/);
  assert.equal(s.read(), text);
});

test("a pinned commit the repo does not have exits 2 with nothing written", () => {
  const a = makeSource(skill("one"));
  a.commit({ "one/notes.md": "v2" });
  const missing = `a${"0".repeat(39)}`;
  const text = `sources:\n  aa:\n    repo: ${a.remote}\n    commit: ${missing}\n    track: main\n    path: .\nbundles:\n  core: [one]\n`;
  const s = setup(text);
  const r = s.run();
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, new RegExp(`pinned commit ${missing} is not in`));
  assert.equal(s.read(), text);
});

test("a repo that cannot be reached exits 4 with nothing written, even if another source could move", () => {
  const a = makeSource({ ...skill("one"), "one/notes.md": "v1" });
  const b = makeSource(skill("two"));
  a.commit({ "one/notes.md": "v2" });
  const text = `sources:\n  aa:\n    repo: ${a.remote}\n    commit: ${a.first}\n    track: main\n    path: .\n  bb:\n    repo: ${b.remote}\n    commit: ${b.first}\n    track: main\n    path: .\nbundles:\n  core: [one, two]\n`;
  const s = setup(text);
  rmSync(dirname(b.remote), { recursive: true });
  const r = s.run();
  assert.equal(r.code, EXIT.unreachable);
  assert.match(r.stderr, /cannot clone/);
  assert.equal(s.read(), text);
});

test("it leaves no temporary clone behind", () => {
  const a = makeSource({ ...skill("one"), "one/notes.md": "v1" });
  a.commit({ "one/notes.md": "v2" });
  const s = setup(`sources:\n  aa:\n    repo: ${a.remote}\n    commit: ${a.first}\n    track: main\n    path: .\nbundles:\n  core: [one]\n`);
  const tmp = join(s.home, "tmp");
  mkdirSync(tmp);
  const r = runFleet(s.clone, ["skills", "update"], { home: s.home, env: { TMPDIR: tmp } });
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(readdirSync(tmp), []);
});

test("an unknown source, or a followed one, exits 2", () => {
  const a = makeSource(skill("one"));
  const f = makeSource(skill("mine"));
  const text = `sources:\n  aa:\n    repo: ${a.remote}\n    commit: ${a.first}\n    track: main\n    path: .\n  ff:\n    repo: ${f.remote}\n    branch: main\n    path: .\nbundles:\n  core: [one, mine]\n`;
  const s = setup(text);
  const unknown = s.run("nope");
  assert.equal(unknown.code, EXIT.invalid);
  assert.match(unknown.stderr, /no source 'nope'/);
  const followed = s.run("ff");
  assert.equal(followed.code, EXIT.invalid);
  assert.match(followed.stderr, /'ff' is followed.*only a pinned source/);
  assert.equal(s.read(), text);
});

test("a missing or unknown subcommand, or a second source name, exits 2", () => {
  const s = setup("sources: {}\n");
  for (const args of [["skills"], ["skills", "upgrade"]]) {
    const r = runFleet(s.clone, args, { home: s.home });
    assert.equal(r.code, EXIT.invalid, args.join(" "));
    assert.match(r.stderr, /usage: fleet skills update \[--review\] \[--yes\] \[<source>\]/);
  }
  assert.equal(runFleet(s.clone, ["skills", "update", "a", "b"], { home: s.home }).code, EXIT.invalid);
});

test("a catalog that does not validate exits 2 and is left alone", () => {
  const a = makeSource(skill("one"));
  a.commit({ "one/notes.md": "v2" });
  const text = `sources:\n  aa:\n    repo: ${a.remote}\n    commit: ${a.first}\n    track: main\n    path: .\n    colour: red\nbundles:\n  core: [one]\n`;
  const s = setup(text);
  const r = s.run();
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /unknown key 'colour'/);
  assert.equal(s.read(), text);
});

test("a source written in flow style, where the commit line cannot be found, exits 2 and is left alone", () => {
  const a = makeSource(skill("one"));
  a.commit({ "one/notes.md": "v2" });
  const text = `sources:\n  aa: {repo: ${a.remote}, commit: ${a.first}, track: main, path: .}\nbundles:\n  core: [one]\n`;
  const s = setup(text);
  const r = s.run();
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /source 'aa'.*'commit:' line/);
  assert.equal(s.read(), text);
});

test("no pinned sources is nothing to do, not an error", () => {
  const f = makeSource(skill("mine"));
  const text = `sources:\n  ff:\n    repo: ${f.remote}\n    branch: main\n    path: .\nbundles:\n  core: [mine]\n`;
  const s = setup(text);
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stdout, /no pinned sources/);
  assert.equal(s.read(), text);
});

test("it needs no host name and takes no apply lock", () => {
  const a = makeSource({ ...skill("one"), "one/notes.md": "v1" });
  const a2 = a.commit({ "one/notes.md": "v2" });
  const s = setup(`sources:\n  aa:\n    repo: ${a.remote}\n    commit: ${a.first}\n    track: main\n    path: .\nbundles:\n  core: [one]\n`);
  rmSync(join(s.home, ".config/fleet/host"));
  mkdirSync(join(s.home, ".local/state/fleet/lock"), { recursive: true });
  writeFileSync(join(s.home, ".local/state/fleet/lock/pid"), `${process.pid}\n`);
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(s.read(), new RegExp(`commit: ${a2}`));
});
