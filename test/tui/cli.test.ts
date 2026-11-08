import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, installStatusTools, makeClone, makeHome, publish, runFleet, tempDir } from "../helpers.ts";
import { EXIT } from "../../src/exit.ts";

/** A config whose defaults link a file onto one that is already there by hand: one conflict. */
function conflicted() {
  const { clone, remote } = makeClone();
  const home = makeHome("laptop");
  installStatusTools(home);
  mkdirSync(join(clone, "hosts"), { recursive: true });
  writeFileSync(join(clone, "hosts/laptop.yaml"), "{}\n");
  writeFileSync(join(clone, "hosts/_defaults.yaml"), "files:\n  - { source: fleet.yaml, target: ~/.claude/CLAUDE.md }\n");
  publish(clone, "defaults");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/CLAUDE.md"), "mine\n");
  return { clone, remote, home };
}

test("fleet status --conflicts lists this host's conflicts in full, and does not fetch", () => {
  const w = conflicted();
  // The remote moves on; a command that fetched would see it.
  const other = join(tempDir(), "other");
  git(tempDir(), "clone", w.remote, other);
  writeFileSync(join(other, "later.md"), "later\n");
  git(other, "add", "-A");
  git(other, "commit", "-m", "later");
  git(other, "push", "--quiet", "origin", "main");
  const before = git(w.clone, "rev-parse", "origin/main");

  const r = runFleet(w.clone, ["status", "--conflicts", "--json"], { home: w.home });
  assert.equal(r.code, EXIT.ok, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.conflicts.length, 1);
  assert.deepEqual(Object.keys(doc.conflicts[0]).sort(), ["detail", "fix", "kind", "path"]);
  assert.match(doc.conflicts[0].detail, /~\/\.claude\/CLAUDE\.md is a file/);
  assert.equal(git(w.clone, "rev-parse", "origin/main"), before, "no fetch");
  assert.equal(git(w.clone, "status", "--porcelain"), "", "nothing written in the config repo");

  const text = runFleet(w.clone, ["status", "--conflicts"], { home: w.home });
  assert.match(text.stdout, /CLAUDE\.md/);
  assert.match(text.stdout, /fix: /);
});

test("--conflicts is only for status, and not with --all", () => {
  const w = conflicted();
  assert.equal(runFleet(w.clone, ["diff", "--conflicts"], { home: w.home }).code, EXIT.invalid);
  const both = runFleet(w.clone, ["status", "--conflicts", "--all"], { home: w.home });
  assert.equal(both.code, EXIT.invalid);
  assert.match(both.stderr, /cannot be used together/);
});

test("bare fleet prints help with one line pointing to fleet bridge", () => {
  const w = conflicted();
  const r = runFleet(w.clone, [], { home: w.home });
  assert.equal(r.code, EXIT.ok);
  assert.equal(r.stdout.split("\n").filter((l) => /^Run 'fleet bridge'/.test(l)).length, 1);
  assert.match(r.stdout, /^ {2}status +Report this host.*--conflicts/m);
});

test("fleet bridge --view and --host are only for bridge", () => {
  const w = conflicted();
  for (const flag of [["--view", "matrix"], ["--host", "laptop"]]) {
    const r = runFleet(w.clone, ["status", ...flag], { home: w.home });
    assert.equal(r.code, EXIT.invalid);
    assert.match(r.stderr, new RegExp(`${flag[0]} is only for 'bridge'`));
  }
});

test("fleet bridge with an unknown view is exit 2, before any screen, and lists the views", () => {
  const w = conflicted();
  const r = runFleet(w.clone, ["bridge", "--view", "inbox"], { home: w.home });
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /unknown view 'inbox'\. The views are: home, matrix, conflicts, timeline, secrets, catalog, push, context/);
  assert.equal(r.stdout, "");
  assert.doesNotMatch(r.stderr, /needs a terminal/);
  assert.doesNotMatch(r.stderr + r.stdout, /\u001b/);
});

test("fleet bridge with an unknown host is exit 2, before any screen, and lists the hosts", () => {
  const w = conflicted();
  const r = runFleet(w.clone, ["bridge", "--host", "mainframe"], { home: w.home });
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /unknown host 'mainframe'\. The hosts are: laptop$/m);
  assert.equal(r.stdout, "");
  assert.doesNotMatch(r.stderr + r.stdout, /\u001b/);
  const both = runFleet(w.clone, ["bridge", "--view", "matrix", "--host", "mainframe"], { home: w.home });
  assert.equal(both.code, EXIT.invalid);
  assert.match(both.stderr, /unknown host 'mainframe'/);
});

test("fleet bridge with a valid view and host still needs a terminal, and says so", () => {
  const w = conflicted();
  const r = runFleet(w.clone, ["bridge", "--view", "matrix", "--host", "laptop"], { home: w.home });
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /needs a terminal/);
});

test("fleet help shows the bridge's --view and --host with the valid views", () => {
  const w = conflicted();
  const r = runFleet(w.clone, ["help"], { home: w.home });
  assert.match(r.stdout, /--view <name> +With 'bridge': open on this screen \(home, matrix, conflicts, timeline, secrets, catalog, push, context\)/);
  assert.match(r.stdout, /--host <name> +With 'bridge': select this host/);
  assert.match(r.stdout, /^ {2}bridge +Open the full-screen view.*--view.*--host/m);
  const agent = runFleet(w.clone, ["agent"], { home: w.home });
  assert.match(agent.stdout, /`fleet bridge \[--view <screen>\] \[--host <name>\]`/);
});
