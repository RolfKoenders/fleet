import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, makeHome, makeSource, makeWorld, repoRoot, runBin, tempDir } from "./helpers.ts";
import { EXIT } from "../src/exit.ts";
import { readPin } from "../src/pin.ts";

const examples = join(repoRoot, "examples");

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}

/**
 * Runs `fleet diff` for `host` on a config repo that started as the examples. The examples name a skill source that
 * does not exist, so the copy's source is swapped for a local repo that holds the skills the catalog's bundles list, at the
 * placeholder commit's place. Everything else is read exactly as written.
 */
function diffOf(config: string, host: string) {
  const catalog = join(config, "catalog/skills.yaml");
  const text = readFileSync(catalog, "utf8");
  const skills = [...text.matchAll(/^ {2}\w+: \[(.*)\]$/gm)].flatMap((m) => m[1]!.split(",").map((s) => s.trim()));
  const source = makeSource(Object.fromEntries([...new Set(skills)].map((s) => [`skills/${s}/SKILL.md`, `---\nname: ${s}\n---\n`])));
  writeFileSync(catalog, text.replace("https://github.com/example/skills.git", source.remote).replace("1234567890abcdef1234567890abcdef12345678", source.first));
  const home = makeHome(host);
  // A host that has its managed fleet clone, which is where the fleet skill is linked from.
  cpSync(join(repoRoot, "skills"), join(home, ".local/share/fleet/fleet/skills"), { recursive: true });
  return runBin(join(repoRoot, "bin/fleet"), ["diff", "--json"], { home, env: { FLEET_CONFIG: config } });
}


test("the examples are a valid config for each of their hosts", () => {
  for (const host of ["laptop", "server"]) {
    const config = tempDir("fleet-examples-");
    cpSync(examples, config, { recursive: true });
    const r = diffOf(config, host);
    assert.equal(r.code, EXIT.ok, `${host}: ${r.stderr}`);
    const doc = JSON.parse(r.stdout);
    assert.deepEqual(doc.conflicts, []);
    const targets = doc.created.map((c: { target?: string; path?: string }) => c.target ?? c.path);
    assert.ok(targets.includes("~/.claude/skills/review"), `${host} gets the core bundle`);
    assert.ok(targets.includes("~/.claude/skills/fleet"), `${host} gets the fleet skill from the tool`);
    assert.ok(targets.includes("~/.claude/CLAUDE.md"), `${host} gets the shared instructions`);
    assert.equal(targets.includes("~/.claude/skills/notes"), host === "laptop", "only the laptop adds the extra bundle");
  }
});

test("the examples' pin is a valid pin, and fleet new is what fills it in", () => {
  const problems: string[] = [];
  assert.notEqual(readPin(examples, problems), null, problems.join("\n"));
});

test("the examples hold no email addresses, tailnet names or private addresses, and no em dash", () => {
  const banned = /[\w.+-]+@[\w-]+\.[a-z]{2,}|\.ts\.net\b|\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+/i;
  const dash = String.fromCharCode(0x2014);
  for (const file of filesUnder(examples)) {
    const text = readFileSync(join(examples, file), "utf8");
    assert.doesNotMatch(text, banned, file);
    assert.equal(text.includes(dash), false, file);
  }
});

test("every YAML file in the examples is mostly explanation: a third of its lines are comments", () => {
  const yaml = filesUnder(examples).filter((f) => f.endsWith(".yaml"));
  assert.ok(yaml.length >= 6, "the examples cover the pin, catalog, defaults and both hosts");
  for (const file of yaml) {
    const lines = readFileSync(join(examples, file), "utf8").split("\n").filter((l) => l.trim() !== "");
    const comments = lines.filter((l) => l.trimStart().startsWith("#")).length;
    assert.ok(comments / lines.length >= 1 / 3, `${file}: ${comments} of ${lines.length} lines are comments`);
  }
});

test("the examples use the names laptop and server, and one host is the admin", () => {
  assert.deepEqual(readdirSync(join(examples, "hosts")).sort(), ["_defaults.yaml", "laptop.yaml", "server.yaml"]);
  assert.match(readFileSync(join(examples, "hosts/laptop.yaml"), "utf8"), /^admin: true$/m);
  assert.doesNotMatch(readFileSync(join(examples, "hosts/server.yaml"), "utf8"), /^admin:/m);
});

test("new copies the examples into a new directory, makes it a git repo and pins this tool's commit", () => {
  const w = makeWorld();
  const target = join(tempDir("fleet-new-"), "my-fleet");
  const r = runBin(join(w.dev, "bin/fleet"), ["new", target, "--json"], { home: makeHome() });
  assert.equal(r.code, EXIT.ok, r.stderr);
  const doc = JSON.parse(r.stdout);

  const expected = filesUnder(join(w.dev, "examples"));
  assert.deepEqual(filesUnder(target).filter((f) => !f.startsWith(".git/")), expected);
  for (const file of expected.filter((f) => f !== "fleet.yaml")) {
    assert.equal(readFileSync(join(target, file), "utf8"), readFileSync(join(w.dev, "examples", file), "utf8"), `${file} is copied as it is`);
  }
  assert.equal(git(target, "rev-parse", "--is-inside-work-tree"), "true");
  assert.equal(git(target, "branch", "--show-current"), "main");
  assert.equal(git(target, "remote"), "", "no remote: creating the GitHub repo is the person's step");
  assert.ok(git(target, "status", "--porcelain").split("\n").every((l) => l.startsWith("?? ")), "nothing is staged or committed for them");
  assert.equal(git(target, "rev-list", "--all", "--count"), "0");

  const problems: string[] = [];
  const pin = readPin(target, problems);
  assert.deepEqual(pin, { repo: w.toolRemote, commit: git(w.dev, "rev-parse", "HEAD"), track: "releases" }, problems.join());
  assert.deepEqual(doc.pin, pin);
  // Only the repo and the commit changed: `track: releases` is the example's own, and so are the comments in fleet.yaml are the example's.
  assert.equal(
    readFileSync(join(target, "fleet.yaml"), "utf8"),
    readFileSync(join(w.dev, "examples/fleet.yaml"), "utf8").replace("https://github.com/example/fleet.git", w.toolRemote).replace("a".repeat(40), pin!.commit),
  );
});

test("what new makes passes validation for its hosts", () => {
  const w = makeWorld();
  const target = join(tempDir("fleet-new-"), "my-fleet");
  assert.equal(runBin(join(w.dev, "bin/fleet"), ["new", target], { home: makeHome() }).code, EXIT.ok);
  for (const host of ["laptop", "server"]) {
    const r = diffOf(target, host);
    assert.equal(r.code, EXIT.ok, `${host}: ${r.stderr}`);
  }
});

test("new prints creating the GitHub repo as a checklist step and does not do it", () => {
  const w = makeWorld();
  const home = makeHome();
  // A `gh` that would create a repo if it were ever called. It is first on the path fleet would look in.
  const gh = join(home, "gh-called");
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  writeFileSync(join(home, ".local/bin/gh"), `#!/bin/sh\necho "$@" >> ${gh}\n`, { mode: 0o755 });
  const target = join(tempDir("fleet-new-"), "my-fleet");
  const r = runBin(join(w.dev, "bin/fleet"), ["new", target], { home, env: { PATH: `${home}/.local/bin:/usr/bin:/bin` } });
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stdout, /\[ \] Create the private GitHub repo and push \(fleet does not create it\): gh repo create my-fleet --private/);
  assert.match(r.stdout, /\[ \] Commit it/);
  assert.match(r.stdout, new RegExp(`cd ${target} && fleet init laptop`));
  assert.equal(existsSync(gh), false, "gh was never run");
  assert.equal(existsSync(join(home, ".config/fleet/config")), false, "and the machine's own settings are untouched");
});

test("new refuses a directory that is not empty and changes nothing in it", () => {
  const w = makeWorld();
  const target = tempDir("fleet-new-");
  writeFileSync(join(target, "mine.txt"), "keep");
  const r = runBin(join(w.dev, "bin/fleet"), ["new", target, "--json"], { home: makeHome() });
  assert.equal(r.code, EXIT.invalid, r.stderr);
  assert.match(r.stderr, /is not empty/);
  assert.deepEqual(readdirSync(target), ["mine.txt"]);

  const file = join(tempDir("fleet-new-"), "a-file");
  writeFileSync(file, "x");
  assert.equal(runBin(join(w.dev, "bin/fleet"), ["new", file], { home: makeHome() }).code, EXIT.invalid);
});

test("new accepts an empty directory", () => {
  const w = makeWorld();
  const target = tempDir("fleet-new-");
  assert.equal(runBin(join(w.dev, "bin/fleet"), ["new", target], { home: makeHome() }).code, EXIT.ok);
  assert.ok(existsSync(join(target, "hosts/laptop.yaml")));
});

test("new needs a directory argument, and a tool with an origin to pin", () => {
  const w = makeWorld();
  assert.equal(runBin(join(w.dev, "bin/fleet"), ["new"], { home: makeHome() }).code, EXIT.invalid);
  git(w.dev, "remote", "remove", "origin");
  const target = join(tempDir("fleet-new-"), "my-fleet");
  const r = runBin(join(w.dev, "bin/fleet"), ["new", target], { home: makeHome() });
  assert.equal(r.code, EXIT.invalid, r.stderr);
  assert.match(r.stderr, /no 'origin' remote/);
  assert.equal(existsSync(target), false, "nothing was made");
});

test("new needs no config repo and no host name on the machine", () => {
  const w = makeWorld();
  const target = join(tempDir("fleet-new-"), "my-fleet");
  const r = runBin(join(w.dev, "bin/fleet"), ["new", target], { home: makeHome(), env: { FLEET_CONFIG: "" } });
  assert.equal(r.code, EXIT.ok, r.stderr);
});

test("new refuses, with nothing written, when the tool's commit is on no remote branch, and says why", () => {
  const w = makeWorld();
  writeFileSync(join(w.dev, "local.txt"), "mine");
  git(w.dev, "add", "-A");
  git(w.dev, "commit", "-m", "local only");
  const target = join(tempDir("fleet-new-"), "my-fleet");
  const r = runBin(join(w.dev, "bin/fleet"), ["new", target, "--json"], { home: makeHome() });
  assert.equal(r.code, EXIT.invalid, r.stderr);
  assert.match(r.stderr, /not on any remote branch.*hosts could not fetch/);
  assert.equal(existsSync(target), false);
  git(w.dev, "push", "origin", "main");
  assert.equal(runBin(join(w.dev, "bin/fleet"), ["new", target], { home: makeHome() }).code, EXIT.ok, "pushed, it works");
});

test("a failure while making the directory leaves no target, and a rerun works", () => {
  const w = makeWorld();
  const home = makeHome();
  const parent = tempDir("fleet-new-");
  const target = join(parent, "my-fleet");
  // A git that fails on `init` and is otherwise the real one, first on the probe path.
  writeFileSync(join(home, "real-git"), "");
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  writeFileSync(join(home, ".local/bin/git"), `#!/bin/sh\n[ "$1" = init ] && { echo 'boom' >&2; exit 1; }\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
  const failed = runBin(join(w.dev, "bin/fleet"), ["new", target], { home });
  assert.notEqual(failed.code, EXIT.ok);
  assert.equal(existsSync(target), false, "no half-made target");
  assert.deepEqual(readdirSync(parent), [], "and no temporary directory beside it");
  mkdirSync(target);
  assert.notEqual(runBin(join(w.dev, "bin/fleet"), ["new", target], { home }).code, EXIT.ok);
  assert.deepEqual(readdirSync(target), []);
  rmSync(join(home, ".local/bin/git"));
  assert.equal(runBin(join(w.dev, "bin/fleet"), ["new", target], { home }).code, EXIT.ok, "the rerun works");
  assert.ok(existsSync(join(target, "hosts/laptop.yaml")));
});
