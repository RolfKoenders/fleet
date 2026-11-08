import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, makeWorld, pinText } from "./helpers.ts";
import { EXIT } from "../src/exit.ts";
import { newestRelease } from "../src/release.ts";

type World = ReturnType<typeof makeWorld>;

const pinFile = (w: World) => readFileSync(join(w.config, "fleet.yaml"), "utf8");
const pinAt = (w: World, commit: string, track = "releases") => writeFileSync(join(w.config, "fleet.yaml"), pinText(w.toolRemote, commit, track));
const changelog = (...versions: string[]) => `# Changelog\n\n## Unreleased\n\n${versions.map((v) => `## ${v} - 2026-11-01\n\n- Entry for ${v}.\n`).join("\n")}`;

/** A commit on the tool's main branch with a changelog that lists `versions`, tagged `tag` (annotated or not) and pushed. */
function release(w: World, tag: string, versions: string[], opts: { annotated?: boolean; date?: string } = {}): string {
  const sha = w.toolCommit({ "CHANGELOG.md": changelog(...versions) }, `Release ${tag}`);
  tagAt(w, tag, sha, opts);
  return sha;
}

function tagAt(w: World, tag: string, sha: string, opts: { annotated?: boolean; date?: string } = {}): void {
  // `git` in the helpers inherits the environment, so the tagger date is set around the call.
  if (opts.date !== undefined) process.env.GIT_COMMITTER_DATE = opts.date;
  try {
    git(w.tool, ...(opts.annotated ? ["tag", "-a", "-m", tag, tag, sha] : ["tag", tag, sha]));
  } finally {
    delete process.env.GIT_COMMITTER_DATE;
  }
  git(w.tool, "push", "--quiet", "origin", tag);
}

/** A commit on whatever the tool's checkout has out, not pushed: only a tag or branch made on it publishes it. */
function commitHere(w: World, file: string, message: string): string {
  writeFileSync(join(w.tool, file), message);
  git(w.tool, "add", "-A");
  git(w.tool, "commit", "-m", message);
  return git(w.tool, "rev-parse", "HEAD");
}

/** The world of the story: v1.0.0, v2.0.0 (annotated), v2.1.0 and a v3.0.0-rc.1 that must be ignored. */
function released() {
  const w = makeWorld();
  const v1 = release(w, "v1.0.0", ["1.0.0"]);
  const v2 = release(w, "v2.0.0", ["2.0.0", "1.0.0"], { annotated: true });
  const v21 = release(w, "v2.1.0", ["2.1.0", "2.0.0", "1.0.0"]);
  const rc = release(w, "v3.0.0-rc.1", ["3.0.0", "2.1.0", "2.0.0", "1.0.0"]);
  return { w, v1, v2, v21, rc };
}

test("track: releases is a valid pin, and a bad track says it is a branch or releases", () => {
  const w = makeWorld();
  release(w, "v1.0.0", ["1.0.0"]);
  pinAt(w, w.first);
  assert.equal(w.run(["update"]).code, EXIT.ok);
  writeFileSync(join(w.config, "fleet.yaml"), `tool:\n  repo: ${w.toolRemote}\n  commit: ${w.first}\n  track: 7\n`);
  const bad = w.run(["update"]);
  assert.equal(bad.code, EXIT.invalid);
  assert.match(bad.stderr, /'tool\.track' must be the branch 'fleet update' reads, or 'releases'/);
});

test("update from v1.0.0 moves to v2.1.0, ignoring the rc, with the sections between and release in --json", () => {
  const { w, v1, v21 } = released();
  pinAt(w, v1);
  const r = w.run(["update", "--json"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.deepEqual([doc.from, doc.to, doc.release, doc.updated, doc.track], [v1, v21, "v2.1.0", true, "releases"]);
  assert.deepEqual(doc.changes.sections.map((s: { heading: string }) => s.heading), ["2.1.0 - 2026-11-01", "2.0.0 - 2026-11-01"]);
  assert.equal(pinFile(w), pinText(w.toolRemote, v21, "releases"));
});

test("update in text prints the pin line, then the changelog sections", () => {
  const { w, v2, v21 } = released();
  pinAt(w, v2);
  const r = w.run(["update"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(r.stdout, `tool: ${v2.slice(0, 7)} -> v2.1.0 (${v21.slice(0, 7)})\n\n## 2.1.0 - 2026-11-01\n- Entry for 2.1.0.\n`);
  assert.match(r.stderr, /Nothing was committed or applied/);
  assert.equal(git(w.config, "status", "--porcelain"), "M fleet.yaml");
});

test("the newest release is the highest version, not the latest tag date: v2.0.10 beats v2.0.9 tagged later", () => {
  const w = makeWorld();
  const base = release(w, "v2.0.0", ["2.0.0"]);
  const ten = w.toolCommit({ "a.md": "a" }, "ten");
  tagAt(w, "v2.0.10", ten, { date: "2026-01-01T00:00:00Z" });
  const nine = w.toolCommit({ "b.md": "b" }, "nine");
  tagAt(w, "v2.0.9", nine, { date: "2026-12-01T00:00:00Z" });
  pinAt(w, base);
  const doc = JSON.parse(w.run(["update", "--json"]).stdout);
  assert.deepEqual([doc.release, doc.to], ["v2.0.10", ten]);
});

test("newestRelease takes only vX.Y.Z tags and the peeled commit of an annotated tag", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const c = "c".repeat(40);
  const d = "d".repeat(40);
  const out = [`${a}\trefs/tags/v1.0.0`, `${b}\trefs/tags/v1.1.0`, `${c}\trefs/tags/v1.1.0^{}`, `${d}\trefs/tags/v1.2.0-rc.1`, `${d}\trefs/tags/1.9.0`, `${d}\trefs/tags/v1.10`, `${d}\trefs/tags/release-v9.0.0`, `${d}\trefs/tags/v01.0.0`].join("\n");
  assert.deepEqual(newestRelease(out), { tag: "v1.1.0", version: [1, 1, 0], commit: c });
  assert.equal(newestRelease(`${d}\trefs/tags/v1.0.0-rc.1\n${d}\trefs/tags/latest`), null);
  assert.equal(newestRelease(""), null);
});

test("annotated and lightweight tags both resolve to the commit the tag points at", () => {
  const w = makeWorld();
  const light = release(w, "v1.0.0", ["1.0.0"]);
  const annotated = release(w, "v1.1.0", ["1.1.0", "1.0.0"], { annotated: true });
  assert.notEqual(git(w.tool, "rev-parse", "v1.1.0"), annotated, "the annotated tag object is not the commit");
  pinAt(w, w.first);
  assert.equal(JSON.parse(w.run(["update", "--json"]).stdout).to, annotated);
  pinAt(w, w.first);
  git(w.tool, "tag", "-d", "v1.1.0");
  git(w.tool, "push", "--quiet", "origin", ":refs/tags/v1.1.0");
  assert.equal(JSON.parse(w.run(["update", "--json"]).stdout).to, light);
});

test("on the newest release update says up to date and writes nothing", () => {
  const { w, v21 } = released();
  pinAt(w, v21);
  publishConfig(w);
  const r = w.run(["update"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(r.stdout, "tool: up to date (v2.1.0)\n");
  const doc = JSON.parse(w.run(["update", "--json"]).stdout);
  assert.deepEqual([doc.updated, doc.release], [false, "v2.1.0"]);
  assert.equal(git(w.config, "status", "--porcelain"), "");
});

const publishConfig = (w: World) => {
  git(w.config, "add", "-A");
  git(w.config, "commit", "-m", "pin");
};

test("a pin past the newest release on its line does not move, and says so", () => {
  const { w } = released();
  const past = w.toolCommit({ "x.md": "x" }, "work after the release");
  pinAt(w, past);
  publishConfig(w);
  const r = w.run(["update"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(r.stdout.trim(), `tool: ${past.slice(0, 7)} is past v2.1.0; up to date until the next release`);
  assert.equal(git(w.config, "status", "--porcelain"), "");
  assert.equal(JSON.parse(w.run(["update", "--json"]).stdout).updated, false);
});

test("a pin on a side line that never met the release moves to it", () => {
  const { w, v21 } = released();
  git(w.tool, "checkout", "--quiet", "--orphan", "side");
  const side = commitHere(w, "side.md", "a line of its own");
  git(w.tool, "push", "--quiet", "origin", "side");
  git(w.tool, "checkout", "--quiet", "-f", "main");
  pinAt(w, side);
  const doc = JSON.parse(w.run(["update", "--json"]).stdout);
  assert.deepEqual([doc.updated, doc.to], [true, v21]);
  assert.equal(pinFile(w), pinText(w.toolRemote, v21, "releases"));
});

test("a pin that branched off before the release and has its own commits moves to it", () => {
  const w = makeWorld();
  const v1 = release(w, "v1.0.0", ["1.0.0"]);
  git(w.tool, "checkout", "--quiet", "-b", "fix", v1);
  const fix = commitHere(w, "fix.md", "fix on a branch");
  git(w.tool, "push", "--quiet", "origin", "fix");
  git(w.tool, "checkout", "--quiet", "main");
  const v11 = release(w, "v1.1.0", ["1.1.0", "1.0.0"]);
  pinAt(w, fix);
  const doc = JSON.parse(w.run(["update", "--json"]).stdout);
  assert.deepEqual([doc.updated, doc.to], [true, v11]);
});

test("a move to a new major version says to read You need to do; a minor one does not", () => {
  const { w, v1, v2, v21 } = released();
  pinAt(w, v1);
  const major = w.run(["update"]);
  assert.equal(major.code, EXIT.ok, major.stderr);
  assert.match(major.stdout, /\nthis is a new major version: read "You need to do" before you push\n/);
  assert.ok(major.stdout.indexOf("this is a new major") < major.stdout.indexOf("## 2.1.0"), "above the changes, where a long list cannot push it off");

  pinAt(w, v2);
  const minor = w.run(["update"]);
  assert.doesNotMatch(minor.stdout, /new major version/);
  assert.match(minor.stdout, new RegExp(`-> v2\\.1\\.0 \\(${v21.slice(0, 7)}\\)`));
});

test("the major of a pin is that of the newest release behind it, so a pin on the 1.x line is a new major for v2", () => {
  const { w, v1 } = released();
  git(w.tool, "checkout", "--quiet", "-b", "v1line", v1);
  const onV1 = commitHere(w, "n.md", "on the 1.x line");
  git(w.tool, "push", "--quiet", "origin", "v1line");
  git(w.tool, "checkout", "--quiet", "main");
  pinAt(w, onV1);
  assert.match(w.run(["update"]).stdout, /new major version/);
});

test("a repo with no vX.Y.Z tag exits 2 with the message and writes nothing", () => {
  const w = makeWorld();
  git(w.tool, "tag", "v1.0.0-rc.1");
  git(w.tool, "tag", "latest");
  git(w.tool, "push", "--quiet", "origin", "--tags");
  pinAt(w, w.first);
  publishConfig(w);
  const r = w.run(["update", "--json"]);
  assert.equal(r.code, EXIT.invalid, r.stderr);
  assert.match(r.stderr, new RegExp(`no release tags \\(vX\\.Y\\.Z\\) in ${w.toolRemote.replaceAll(".", "\\.")}`));
  assert.equal(git(w.config, "status", "--porcelain"), "");
});

test("an unreachable repo exits 4 under track: releases, writing nothing", () => {
  const w = makeWorld();
  pinAt(w, w.first);
  publishConfig(w);
  writeFileSync(join(w.config, "fleet.yaml"), pinText(join(w.base, "nowhere.git"), w.first, "releases"));
  publishConfig(w);
  assert.equal(w.run(["update"]).code, EXIT.unreachable);
  assert.equal(git(w.config, "status", "--porcelain"), "");
});

test("a pin that is gone from the repo still moves to the release, with no history", () => {
  const { w, v21 } = released();
  pinAt(w, "a".repeat(40));
  const doc = JSON.parse(w.run(["update", "--json"]).stdout);
  assert.deepEqual([doc.updated, doc.to, doc.changes], [true, v21, { source: "none" }]);
});

test("update with track: releases changes only the commit line, byte for byte", () => {
  const { w, v1, v21 } = released();
  const text = `# pin\r\ntool:   # the tool\r\n  repo:    ${w.toolRemote}   # where from\r\n  commit:  "${v1}"   # moved by fleet update\r\n  track: releases\r\n`;
  writeFileSync(join(w.config, "fleet.yaml"), text);
  assert.equal(w.run(["update"]).code, EXIT.ok);
  assert.equal(pinFile(w), text.replace(`"${v1}"`, `"${v21}"`));
});

test("a tag on a commit no branch holds still resolves", () => {
  const { w, v1 } = released();
  git(w.tool, "checkout", "--quiet", "--detach", v1);
  const loose = commitHere(w, "loose.md", "on no branch");
  tagAt(w, "v9.0.0", loose);
  git(w.tool, "checkout", "--quiet", "main");
  pinAt(w, v1);
  const doc = JSON.parse(w.run(["update", "--json"]).stdout);
  assert.deepEqual([doc.release, doc.to], ["v9.0.0", loose]);
  assert.equal(doc.changes.source, "commits");
});

test("track: main still follows the branch head and does not look at tags", () => {
  const { w, v1 } = released();
  const head = w.toolCommit({ "h.md": "h" }, "after the rc");
  pinAt(w, v1, "main");
  const doc = JSON.parse(w.run(["update", "--json"]).stdout);
  assert.deepEqual([doc.to, doc.updated, "release" in doc], [head, true, false]);
});
