import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseNotes } from "../scripts/release-notes.ts";
import { repoRoot, tempDir, writeExecutable } from "./helpers.ts";

const changelog = `# Changelog

Intro.

## Unreleased

- Not released yet.

## 2.0.0 - 2026-11-03

### Added

- Two.

## 1.0.0 - 2026-11-01

- One.
- Another.

## 0.9.0 - 2026-10-01
`;

test("the notes are the section of the version, without its heading", () => {
  assert.equal(releaseNotes(changelog, "2.0.0"), "### Added\n\n- Two.");
  assert.equal(releaseNotes(changelog, "1.0.0"), "- One.\n- Another.");
});

test("a version with no section, an empty section or a bad name is an error", () => {
  assert.throws(() => releaseNotes(changelog, "3.0.0"), /no section for 3\.0\.0/);
  assert.throws(() => releaseNotes(changelog, "0.9.0"), /empty/);
  assert.throws(() => releaseNotes(changelog, "Unreleased"), /not a version/);
  assert.throws(() => releaseNotes(changelog, "2.0"), /not a version/);
  // A prefix of a heading is not that heading.
  assert.throws(() => releaseNotes("## 2.0.0 - x\n\n- a\n", "2.0"), /not a version/);
  assert.throws(() => releaseNotes("## 2.0.10 - x\n\n- a\n", "2.0.1"), /no section/);
});

const script = join(repoRoot, "scripts/release-notes.ts");

function cli(args: string[]) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("the script prints the section, takes a leading v, and exits non-zero for a missing one", () => {
  const dir = tempDir();
  const file = join(dir, "CHANGELOG.md");
  writeFileSync(file, changelog);
  assert.deepEqual(cli(["2.0.0", file]), { code: 0, stdout: "### Added\n\n- Two.\n", stderr: "" });
  assert.equal(cli(["v1.0.0", file]).stdout, "- One.\n- Another.\n");
  const missing = cli(["3.0.0", file]);
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /no section for 3\.0\.0/);
  assert.equal(cli([]).code, 2);
});

test("the repo's changelog has a section for each release, and Unreleased on top", () => {
  const text = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
  const headings = text.split("\n").filter((line) => line.startsWith("## "));
  assert.equal(headings[0], "## Unreleased");
  assert.deepEqual(headings.slice(1), ["## 2.0.0 - 2026-11-03", "## 1.0.0 - 2026-11-01"]);
  for (const version of ["2.0.0", "1.0.0"]) assert.notEqual(releaseNotes(text, version), "");
});

/** The release step of the workflow, run for a tag with a fake `gh` that records what it is given. */
function release(tag: string) {
  const workflow = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");
  const run = /^ {8}run: \|\n((?: {10}.*\n?)+)/m.exec(workflow)?.[1];
  assert.ok(run, "the workflow has a run step");
  const dir = tempDir();
  const bin = join(dir, "bin");
  const gh = `#!/bin/sh
printf '%s\\n' "$*" > "${dir}/gh-args"
while [ $# -gt 0 ]; do
  [ "$1" = --notes-file ] && cat "$2" > "${dir}/gh-notes"
  shift
done
`;
  writeExecutable(join(bin, "gh"), gh);
  const r = spawnSync("sh", ["-c", run.replace(/^ {10}/gm, "")], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, RUNNER_TEMP: dir, GITHUB_REF_NAME: tag },
  });
  return { code: r.status, stderr: r.stderr, args: existsSync(join(dir, "gh-args")) ? readFileSync(join(dir, "gh-args"), "utf8") : null, notes: existsSync(join(dir, "gh-notes")) ? readFileSync(join(dir, "gh-notes"), "utf8") : null };
}

test("a tag with a changelog section creates its release with exactly that section as notes", () => {
  const r = release("v2.0.0");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.args ?? "", /^release create v2\.0\.0 --verify-tag --title v2\.0\.0 --notes-file /);
  const section = releaseNotes(readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8"), "2.0.0");
  assert.equal(r.notes, `${section}\n`);
});

test("a tag with no changelog section fails before gh release create runs", () => {
  const r = release("v9.9.9");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no section for 9\.9\.9/);
  assert.equal(r.args, null);
});
