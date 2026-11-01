import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, makeClone, makeHome, publish, runFleet, tempDir } from "./helpers.ts";
import { EXIT } from "../src/exit.ts";

function setup() {
  const { clone, remote } = makeClone();
  const home = makeHome("laptop");
  mkdirSync(join(clone, "hosts"));
  writeFileSync(join(clone, "hosts/laptop.yaml"), "{}\n");
  publish(clone, "host file");

  let elsewhere: string | null = null;
  const upstream = (files: Record<string, string>) => {
    if (elsewhere === null) {
      const base = tempDir("fleet-elsewhere-");
      git(base, "clone", "--quiet", remote, "w");
      elsewhere = join(base, "w");
    }
    git(elsewhere, "pull", "--quiet", "--ff-only");
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(elsewhere, path)), { recursive: true });
      writeFileSync(join(elsewhere, path), content);
    }
    git(elsewhere, "add", "-A");
    git(elsewhere, "commit", "-m", "upstream change");
    git(elsewhere, "push", "--quiet");
    return git(elsewhere, "rev-parse", "HEAD");
  };
  const run = (args: string[]) => runFleet(clone, args, { home });
  const json = (args: string[]) => {
    const r = run([...args, "--json"]);
    return { r, doc: JSON.parse(r.stdout) };
  };
  const nothingWritten = () => assert.equal(existsSync(join(home, ".local/state/fleet/applied.json")), false);
  return { clone, remote, home, upstream, run, json, nothingWritten };
}

test("apply fast-forwards a clean config repo to what GitHub has", () => {
  const s = setup();
  const head = s.upstream({ "notes.md": "from elsewhere" });
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(git(s.clone, "rev-parse", "HEAD"), head);
  assert.equal(readFileSync(join(s.clone, "notes.md"), "utf8"), "from elsewhere");
});

test("a config that arrives invalid is reported as exit 2 by the same run", () => {
  const s = setup();
  // The new commit breaks the host file, so the new code finds the config invalid.
  s.upstream({ "hosts/laptop.yaml": "nonsense: true\n" });
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.invalid, r.stderr);
  assert.match(r.stderr, /unknown key 'nonsense'/);
});

test("a config repo that did not move is not re-executed", () => {
  const s = setup();
  const main = readFileSync(join(s.clone, "src/main.ts"), "utf8");
  // Pushed from here, so the clone is already level with GitHub.
  writeFileSync(join(s.clone, "src/main.ts"), `process.stderr.write("running the new code\\n");\n${main}`);
  publish(s.clone, "new code");
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(r.stderr.match(/running the new code/g)?.length, 1, "one run, no re-exec");
});

test("uncommitted changes in the config repo are a repo conflict and nothing is written", () => {
  const s = setup();
  const before = git(s.clone, "rev-parse", "HEAD");
  s.upstream({ "notes.md": "from elsewhere" });
  writeFileSync(join(s.clone, "scratch.txt"), "half done");
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.conflict);
  assert.equal(doc.conflicts.length, 1);
  assert.equal(doc.conflicts[0].kind, "repo");
  assert.equal(doc.conflicts[0].path, s.clone);
  assert.match(doc.conflicts[0].detail, /uncommitted changes/);
  assert.ok(doc.conflicts[0].fix.length > 0);
  assert.equal(git(s.clone, "rev-parse", "HEAD"), before, "a dirty clone is not moved");
  s.nothingWritten();
});

test("local-only commits in the config repo are a repo conflict", () => {
  const s = setup();
  writeFileSync(join(s.clone, "local.txt"), "mine");
  git(s.clone, "add", "-A");
  git(s.clone, "commit", "-m", "local only");
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.conflict);
  assert.equal(doc.conflicts[0].kind, "repo");
  assert.equal(doc.conflicts[0].path, s.clone);
  assert.match(doc.conflicts[0].detail, /1 local commit/);
  s.nothingWritten();
});

test("a diverged config repo is a repo conflict", () => {
  const s = setup();
  s.upstream({ "theirs.txt": "1" });
  writeFileSync(join(s.clone, "mine.txt"), "1");
  git(s.clone, "add", "-A");
  git(s.clone, "commit", "-m", "mine");
  const before = git(s.clone, "rev-parse", "HEAD");
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.conflict);
  assert.equal(doc.conflicts[0].kind, "repo");
  assert.match(doc.conflicts[0].detail, /diverged.*1 ahead.*1 behind/);
  assert.equal(git(s.clone, "rev-parse", "HEAD"), before);
  s.nothingWritten();
});

test("a repo conflict is shown in human output too, with its fix", () => {
  const s = setup();
  writeFileSync(join(s.clone, "scratch.txt"), "half done");
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.conflict);
  assert.match(r.stdout, /conflict .*: .*uncommitted changes/);
  assert.match(r.stdout, /\n {2}fix: /);
  assert.match(r.stderr, /1 conflict; nothing was written/);
});

test("a fetch that fails exits 4 and writes nothing", () => {
  const s = setup();
  rmSync(s.remote, { recursive: true });
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.unreachable);
  assert.equal(doc.code, "unreachable");
  assert.match(r.stderr, /cannot fetch/);
  s.nothingWritten();
});

test("diff does no pull: the clone stays put and an unreachable GitHub is no problem", () => {
  const s = setup();
  const before = git(s.clone, "rev-parse", "HEAD");
  s.upstream({ "notes.md": "from elsewhere" });
  assert.equal(s.run(["diff"]).code, EXIT.ok);
  assert.equal(git(s.clone, "rev-parse", "HEAD"), before);
  rmSync(s.remote, { recursive: true });
  const r = s.run(["diff"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
});
