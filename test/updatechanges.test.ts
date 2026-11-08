import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, makeWorld, pinText } from "./helpers.ts";
import { EXIT } from "../src/exit.ts";
import { addedSections, sections } from "../src/changelog.ts";

type World = ReturnType<typeof makeWorld>;

const pinAt = (w: World, commit: string) => writeFileSync(join(w.config, "fleet.yaml"), pinText(w.toolRemote, commit));
const pinFile = (w: World) => readFileSync(join(w.config, "fleet.yaml"), "utf8");

const OLD = `# Changelog

## Unreleased

- Waiting.

## 1.0.0 - 2026-11-01

- One.
`;

test("update prints the sections the new commit has and the old one lacks, matched by heading", () => {
  const w = makeWorld();
  const old = w.toolCommit({ "CHANGELOG.md": OLD });
  w.toolCommit({
    "CHANGELOG.md": `# Changelog\n\n## Unreleased\n\n- Still waiting, now with more.\n\n## 1.1.0 - 2026-11-10\n\n- Shiny.\n\n## 1.0.0 - 2026-11-01\n\n- One, reworded.\n`,
  });
  pinAt(w, old);
  const r = w.run(["update"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  const lines = r.stdout.split("\n");
  assert.match(lines[0] ?? "", /^tool: [0-9a-f]{7} -> [0-9a-f]{7} \(main\)$/);
  assert.equal(lines.slice(1).join("\n"), "\n## Unreleased\n- Still waiting, now with more.\n\n## 1.1.0 - 2026-11-10\n- Shiny.\n");
  assert.doesNotMatch(r.stdout, /1\.0\.0|reworded/, "a section at both commits is not printed, even with other text");
});

test("update leaves Unreleased out when it did not change or is now empty, and falls back to the subjects", () => {
  const w = makeWorld();
  const old = w.toolCommit({ "CHANGELOG.md": OLD });
  w.toolCommit({ "other.md": "x" }, "Add something that is not in the changelog");
  pinAt(w, old);
  const same = w.run(["update", "--json"]);
  assert.equal(same.code, EXIT.ok, same.stderr);
  assert.deepEqual(JSON.parse(same.stdout).changes, { source: "commits", subjects: ["Add something that is not in the changelog"], omitted: 0 });
  assert.match(same.stdout, /Add something/);

  const w2 = makeWorld();
  const old2 = w2.toolCommit({ "CHANGELOG.md": OLD });
  w2.toolCommit({ "CHANGELOG.md": OLD.replace("- Waiting.\n", "") }, "Empty the unreleased section");
  pinAt(w2, old2);
  const emptied = JSON.parse(w2.run(["update", "--json"]).stdout);
  assert.deepEqual(emptied.changes, { source: "commits", subjects: ["Empty the unreleased section"], omitted: 0 });
});

test("update with no changelog at either commit prints the commit subjects, newest first", () => {
  const w = makeWorld();
  w.toolCommit({ "a.md": "a" }, "First change");
  w.toolCommit({ "b.md": "b" }, "Second change");
  const r = w.run(["update"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(r.stdout.split("\n").slice(1).join("\n"), "\n- Second change\n- First change\n");
});

test("update against a pin with no changelog reads the whole new one", () => {
  const w = makeWorld();
  w.toolCommit({ "CHANGELOG.md": OLD });
  const r = JSON.parse(w.run(["update", "--json"]).stdout);
  assert.deepEqual(r.changes.sections.map((s: { heading: string }) => s.heading), ["Unreleased", "1.0.0 - 2026-11-01"]);
  assert.deepEqual(r.changes.sections[1], { heading: "1.0.0 - 2026-11-01", body: "- One." });
});

test("update still moves the pin when the old commit is gone from the tool repo, and says there is no history", () => {
  const w = makeWorld();
  const next = w.toolCommit({ "a.md": "a" });
  pinAt(w, "a".repeat(40));
  const r = w.run(["update", "--json"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.deepEqual(doc.changes, { source: "none" });
  assert.equal(doc.updated, true);
  assert.equal(pinFile(w), pinText(w.toolRemote, next));
  assert.match(w.run(["update"]).stdout, /up to date/);

  pinAt(w, "a".repeat(40));
  assert.match(w.run(["update"]).stdout, /\n\nno history available\n$/);
});

test("update with --json adds only changes, and the pin line stays byte for byte", () => {
  const w = makeWorld();
  const next = w.toolCommit({ "a.md": "a" }, "A change");
  const text = `tool:\r\n  repo: ${w.toolRemote}\r\n  commit:  "${w.first}"   # pinned\r\n  track: main\r\n`;
  writeFileSync(join(w.config, "fleet.yaml"), text);
  const doc = JSON.parse(w.run(["update", "--json"]).stdout);
  assert.deepEqual(Object.keys(doc), ["ok", "code", "host", "messages", "repo", "track", "from", "to", "updated", "changes"]);
  assert.equal(pinFile(w), text.replace(`"${w.first}"`, `"${next}"`));
});

test("what update prints is printable characters only and limited in length", () => {
  const w = makeWorld();
  const old = w.toolCommit({ "CHANGELOG.md": OLD });
  const hostile = [
    "## 9.9.9 - \u001b[2Jx",
    "",
    `- red \u001b[31mtext\u001b[0m and \u202Ereversed\u202C and a bell \u0007 and a return \r over`,
    `- ${"long ".repeat(100)}`,
    ...Array.from({ length: 80 }, (_, i) => `- item ${i}`),
  ].join("\n");
  w.toolCommit({ "CHANGELOG.md": `# Changelog\n\n${hostile}\n\n## 1.0.0 - 2026-11-01\n\n- One.\n` });
  pinAt(w, old);
  const shown = w.run(["update"]).stdout;
  assert.doesNotMatch(shown, /[\u0000-\u0008\u000b-\u001f\u007f\u202e]/, "no control or bidi characters");
  assert.ok(shown.split("\n").every((line) => [...line].length <= 170), "every line is cut");
  assert.ok(shown.split("\n").length < 60, "the whole is cut");
  assert.match(shown, /\.\.\. and \d+ more/);
  assert.match(shown, /## 9\.9\.9 - \[2Jx/);

  const subjectWorld = makeWorld();
  subjectWorld.toolCommit({ "a.md": "a" }, "Subject with \u001b]0;title\u0007 escape");
  const subjects = JSON.parse(subjectWorld.run(["update", "--json"]).stdout).changes.subjects;
  assert.deepEqual(subjects, ["Subject with ]0;title escape"]);
});

test("a long run of commits is cut to a number of subjects", () => {
  const w = makeWorld();
  for (let i = 0; i < 35; i++) w.toolCommit({ [`f${i}.md`]: "x" }, `Change ${i}`);
  const changes = JSON.parse(w.run(["update", "--json"]).stdout).changes;
  assert.equal(changes.subjects.length, 30);
  assert.equal(changes.omitted, 5);
});

test("update leaves no throwaway clone behind", () => {
  const w = makeWorld();
  w.toolCommit({ "a.md": "a" });
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith("fleet-update-")).length;
  w.run(["update"]);
  assert.equal(readdirSync(tmpdir()).filter((n) => n.startsWith("fleet-update-")).length, before);
});

test("the changelog parser matches sections by heading", () => {
  assert.deepEqual(sections("intro\n\n## A\n\nx\n\n### sub\n\ny\n\n## B\n"), [
    { heading: "A", body: "x\n\n### sub\n\ny" },
    { heading: "B", body: "" },
  ]);
  assert.deepEqual(addedSections("## A\n\none\n", "## B\n\ntwo\n\n## A\n\nchanged\n").map((s) => s.heading), ["B"]);
  assert.deepEqual(addedSections("## Unreleased\n\nx\n", "## Unreleased\n\nx\n"), []);
});
