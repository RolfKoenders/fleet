import { test } from "node:test";
import assert from "node:assert/strict";
import { blankHost, confirmInit, heldProblem, hostDraft, idleInit, initEnd, initLine, startInit } from "../src/ui/static/hosts.js";

const form = (over: Record<string, string> = {}) => ({ ...blankHost(), name: "mini", ssh: "me@mini.local", ...over });

test("a form with a name and an ssh destination is a request; from the defaults it copies nothing", () => {
  assert.deepEqual(hostDraft(form(), ["laptop", "box"]).body, { name: "mini", ssh: "me@mini.local", from: null });
  assert.deepEqual(hostDraft(form({ from: "box", name: " mini " }), ["laptop", "box"]).body, { name: "mini", ssh: "me@mini.local", from: "box" });
});

test("ssh is required: a form without it is not a request, and says nothing until it is typed", () => {
  const d = hostDraft(form({ ssh: "" }), ["laptop"]);
  assert.equal(d.body, null);
  assert.equal(d.ssh, null);
  assert.equal(hostDraft(blankHost(), []).name, null);
});

test("a name that is not the loader's, or that exists, and an ssh destination ssh would read as an option or that has a space, are refused with a reason", () => {
  for (const name of ["-x", "a b", "../x", ".hidden", "x".repeat(65)]) assert.notEqual(hostDraft(form({ name }), []).name, null, name);
  assert.match(hostDraft(form({ name: "box" }), ["box"]).name!, /already a host/);
  for (const ssh of ["-oProxyCommand=x", "me@mini mini", "me@mini;id", "$(id)"]) {
    const d = hostDraft(form({ ssh }), []);
    assert.equal(d.body, null, ssh);
    assert.notEqual(d.ssh, null, ssh);
  }
  assert.match(hostDraft(form({ ssh: "-F/x" }), []).ssh!, /cannot start with '-'/);
  for (const ssh of ["mini", "me@mini.local", "me@10.0.0.4", "me@[fe80::1%eth0]", "me@host:22"]) assert.notEqual(hostDraft(form({ ssh }), []).body, null, ssh);
  assert.equal(hostDraft(form({ from: "gone" }), ["box"]).body, null, "a host to copy that is not there");
});

test("held edits and a new host do not mix: while any are held the page asks to push or discard them first", () => {
  assert.equal(heldProblem([]), null);
  assert.match(heldProblem([{}])!, /1 edit to push.*push or discard them first/);
  assert.match(heldProblem([{}, {}])!, /2 edits to push/);
});

test("the confirmation names the file, the machine, and what runs there", () => {
  const text = confirmInit({ name: "mini", ssh: "me@mini", from: "box" });
  assert.match(text, /hosts\/mini\.yaml as a copy of box/);
  assert.match(text, /fleet init mini/);
  assert.match(text, /me@mini over ssh/);
  assert.doesNotMatch(confirmInit({ name: "mini", ssh: "me@mini", from: null }), /copy/);
});

test("init output is folded line by line, kept to the last 300, and its end says whether the file was removed or kept", () => {
  let s = startInit("mini");
  s = initLine(s, { text: "$ fleet init mini" });
  s = initLine(s, { text: "1. prerequisites: unchanged" });
  assert.deepEqual(s.lines, ["$ fleet init mini", "1. prerequisites: unchanged"]);
  assert.equal(s.running, true);
  s = initEnd(s, { ok: false, code: "unreachable", messages: ["fleet: removed", 3], removed: true });
  assert.deepEqual(s.end, { ok: false, code: "unreachable", messages: ["removed"], removed: true, kept: false });
  assert.equal(s.running, false);
  // The next line is a new run.
  s = initLine(s, { text: "$ fleet init other" });
  assert.deepEqual(s.lines, ["$ fleet init other"]);
  assert.equal(s.end, null);
  let long = idleInit();
  for (let i = 0; i < 400; i++) long = initLine(long, { text: String(i) });
  assert.equal(long.lines.length, 300);
  assert.equal(long.lines[299], "399");
});
