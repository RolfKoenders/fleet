import { test } from "node:test";
import assert from "node:assert/strict";
import { fakePusher, ok, PREVIEW_SECRET, playToMiddle, pushBridge, tick } from "./pushfixture.ts";

test("P opens a review that shows the dirty files and the plan, and starts nothing", async () => {
  const f = fakePusher(PREVIEW_SECRET);
  const h = await pushBridge(f.pusher);
  h.press("P");
  await h.settle();
  h.advance(33);
  const frame = h.frame();
  assert.match(frame, /Review before you push/);
  assert.match(frame, /git add -A/);
  assert.match(frame, /catalog\/skills\.yaml/);
  assert.match(frame, /notes\.md/);
  assert.match(frame, /\.env\.local.*looks like a secret/);
  assert.match(frame, /create ~\/\.claude\/skills\/triage/);
  assert.match(frame, /Type push and press enter/);
  assert.match(frame, /reviewing a push/);
  assert.equal(f.runs, 0);
});

test("a single key, an empty answer or the wrong word never starts a push", async () => {
  const f = fakePusher();
  const h = await pushBridge(f.pusher);
  h.press("P");
  await h.settle();
  h.press("enter", "y", "enter", "p", "enter");
  h.type("ush").press("backspace", "enter");
  h.type("x").press("enter");
  await tick();
  assert.equal(f.runs, 0);
  assert.match(h.frame(), /that is not 'push'/);
  assert.equal(h.runtime.quitCode, null, "q-like keys typed into the box do not quit");
});

test("esc cancels the review and nothing runs", async () => {
  const f = fakePusher();
  const h = await pushBridge(f.pusher);
  h.press("P");
  await h.settle();
  h.type("push").press("escape");
  h.press("enter");
  await tick();
  assert.equal(f.runs, 0);
  assert.match(h.frame(), /No push yet/);
});

test("typing push and enter runs the real push once; lanes tick off as events arrive", async () => {
  const f = fakePusher();
  const h = await pushBridge(f.pusher);
  await playToMiddle(h, f);
  assert.equal(f.runs, 1);
  const mid = h.frame();
  assert.match(mid, /publish.*2\/2/);
  assert.match(mid, /✓ laptop\s+ok \(3 changes\)/);
  assert.match(mid, /✓ box\s+ok \(2 changes\)/);
  assert.match(mid, /edge\s+timer: not asked; it catches up on its own schedule/);
  assert.match(mid, /server\s+.*5\/12 link ~\/\.claude\/skills\/triage/);
  assert.match(mid, /Hosts run one after another, in name order\. A conflict on laptop stops the rest\./);
  assert.match(mid, /GitHub/);
  assert.match(mid, /pushing/);
  f.emit({ event: "host", host: "server", state: "done", result: "ok", changes: 4 });
  f.end(ok([["laptop", 3], ["box", 2], ["edge", 0], ["server", 4]]));
  await h.settle();
  h.advance(100);
  const end = h.frame();
  assert.match(end, /Push finished/);
  assert.match(end, /✓ server\s+ok \(4 changes\)/);
  assert.match(end, /read-only; P pushes/);
  assert.equal(f.previews, 1);
});

test("a local conflict shows the rest as not reached, with the fix", async () => {
  const f = fakePusher();
  const h = await pushBridge(f.pusher);
  h.press("P");
  await h.settle();
  h.type("push").press("enter");
  await tick();
  f.emit({ event: "hosts", hosts: [{ host: "laptop", via: "local" }, { host: "box", via: "ssh" }, { host: "edge", via: "timer" }, { host: "server", via: "ssh" }] });
  f.emit({ event: "host", host: "laptop", state: "start" });
  f.emit({ event: "host", host: "laptop", state: "done", result: "conflict", changes: 0 });
  for (const host of ["box", "edge", "server"]) f.emit({ event: "host", host, state: "skip" });
  f.end({ exit: 3, code: "conflict", messages: [], hosts: [{ host: "laptop", result: "conflict", changes: 0 }], conflicts: { laptop: [{ path: "~/.claude/x.md", detail: "is a real file", fix: "move it" }] } });
  await h.settle();
  h.advance(100);
  const frame = h.frame();
  assert.match(frame, /✕ laptop\s+conflict/);
  assert.match(frame, /– box\s+not reached: laptop has a conflict, so the rest wait/);
  assert.match(frame, /– server\s+not reached/);
  assert.match(frame, /Push ended: conflict.*exit 3/);
  assert.match(frame, /laptop: ~\/\.claude\/x\.md: is a real file/);
  assert.match(frame, /fix: move it/);
});

test("quitting during a push warns, names what is running, and only a second answer leaves", async () => {
  const f = fakePusher();
  const h = await pushBridge(f.pusher);
  await playToMiddle(h, f);
  h.press("q");
  assert.equal(h.runtime.quitCode, null);
  const warn = h.frame();
  assert.match(warn, /a push is still running/);
  assert.match(warn, /Right now: applying on server \(5 of 12 writes\)/);
  assert.match(warn, /Still to do: server/);
  assert.match(warn, /does not stop it/);
  h.press("escape");
  assert.equal(h.runtime.quitCode, null);
  assert.doesNotMatch(h.frame(), /a push is still running/);
  h.press("ctrl+c");
  assert.equal(h.runtime.quitCode, null, "ctrl-c asks too");
  h.press("q");
  assert.equal(h.runtime.quitCode, 0);
});

test("quitting with no push running is immediate, and the palette's Quit asks like q does", async () => {
  const f = fakePusher();
  const h = await pushBridge(f.pusher);
  h.press("q");
  assert.equal(h.runtime.quitCode, 0);
  const g = await pushBridge(f.pusher);
  await playToMiddle(g, f);
  g.press("ctrl+k");
  g.type("quit").press("enter");
  assert.equal(g.runtime.quitCode, null);
  assert.match(g.frame(), /a push is still running/);
});

test("a preview that failed blocks the push: the word does nothing", async () => {
  const f = fakePusher({ ok: false, detail: "the config repo is not a git repo" });
  const h = await pushBridge(f.pusher);
  h.press("P");
  await h.settle();
  h.type("push").press("enter");
  await tick();
  assert.equal(f.runs, 0);
  assert.match(h.frame(), /nothing can be pushed from here/);
});

test("where no pusher is offered, P cannot push", async () => {
  const h = await pushBridge(undefined);
  h.press("P");
  await h.settle();
  h.type("push").press("enter");
  await tick();
  assert.match(h.frame(), /nothing can be pushed from here/);
  assert.match(h.frame(), /pushing is not offered/);
});

test("the header says read-only until a push is confirmed, and pushing while one runs", async () => {
  const f = fakePusher();
  const h = await pushBridge(f.pusher);
  assert.match(h.frame(), /read-only; P pushes/);
  await playToMiddle(h, f);
  assert.match(h.frame().split("\n")[0]!, /pushing/);
  assert.doesNotMatch(h.frame().split("\n")[0]!, /read-only/);
});

test("a second P while a push runs only goes to its screen", async () => {
  const f = fakePusher();
  const h = await pushBridge(f.pusher);
  await playToMiddle(h, f);
  h.press("1", "P");
  await tick();
  assert.equal(f.runs, 1);
  assert.equal(f.previews, 1);
  assert.match(h.frame(), /Hosts run one after another/);
});

test("narrow windows drop the diagram and keep the lanes", async () => {
  const f = fakePusher();
  const h = await pushBridge(f.pusher, { cols: 60, rows: 20 });
  await playToMiddle(h, f);
  const frame = h.frame();
  assert.doesNotMatch(frame, /GitHub/);
  assert.match(frame, /✓ laptop/);
  assert.match(frame, /server/);
});

test("a typed commit message is passed to the push, trimmed, and none passes nothing", async () => {
  const f = fakePusher();
  const h = await pushBridge(f.pusher);
  h.press("P");
  await h.settle();
  h.press("tab");
  h.type("  Add the triage skill ");
  assert.match(h.frame(), /Commit message: +Add the triage skill/);
  h.press("enter");
  assert.equal(f.runs, 0, "enter in the message box only moves on to the word");
  h.type("push").press("enter");
  await tick();
  assert.deepEqual(f.messages, ["Add the triage skill"]);

  const g = fakePusher();
  const k = await pushBridge(g.pusher);
  k.press("P");
  await k.settle();
  k.type("push").press("enter");
  await tick();
  assert.deepEqual(g.messages, [undefined]);
});

test("a message never starts a push, and the word typed into the message box is caught", async () => {
  const f = fakePusher();
  const h = await pushBridge(f.pusher);
  h.press("P");
  await h.settle();
  h.press("tab");
  h.type("Fix the link").press("enter", "enter", "enter");
  await tick();
  assert.equal(f.runs, 0, "a message and enters do not push");
  // Someone types the word while the message box has the focus.
  h.press("tab");
  h.press("ctrl+u");
  h.type("push");
  assert.match(h.frame(), /Commit message: push/);
  h.press("enter");
  h.type("push").press("enter");
  await tick();
  assert.equal(f.runs, 0, "a message that is only the word does not go");
  assert.match(h.frame(), /Blocked: the commit message is only 'push'/);
  // Fixing the message lets it through.
  h.press("tab");
  h.press("ctrl+u");
  h.type("push the triage skill").press("enter", "enter");
  await tick();
  assert.equal(f.runs, 1);
  assert.deepEqual(f.messages, ["push the triage skill"]);
});

test("a file that looks like a plaintext secret blocks the push and says why, until it is gone", async () => {
  const f = fakePusher(PREVIEW_SECRET);
  const h = await pushBridge(f.pusher);
  h.press("P");
  await h.settle();
  h.advance(33);
  h.type("push").press("enter");
  await tick();
  assert.equal(f.runs, 0);
  const frame = h.frame();
  assert.match(frame, /Blocked: 1 file looks like a plaintext secret\. \.env\.local\. Remove or gitignore it/);
  assert.match(frame, /\.env\.local.*looks like a secret/);
  // It was removed: read again.
  const clean = fakePusher();
  (f.pusher as { preview: unknown }).preview = clean.pusher.preview;
  h.press("ctrl+r");
  await h.settle();
  h.advance(33);
  assert.doesNotMatch(h.frame(), /Blocked/);
  h.press("enter");
  await tick();
  assert.equal(f.runs, 1);
});
