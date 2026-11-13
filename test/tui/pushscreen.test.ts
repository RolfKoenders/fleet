import { test } from "node:test";
import assert from "node:assert/strict";
import { fakePusher, ok, playToMiddle, pushBridge, tick } from "./pushfixture.ts";
import { finish, readEnd, reduce, startRun, STEPS_KEPT } from "../../src/pushrun.ts";
import type { FleetEvent } from "../../src/events.ts";

const HOSTS: FleetEvent = { event: "hosts", hosts: [{ host: "laptop", via: "local" }, { host: "box", via: "ssh" }, { host: "edge", via: "timer" }, { host: "server", via: "ssh" }] };
const names = [{ host: "laptop", name: "laptop", ssh: null, self: true }];

/** Starts a push and plays it until server has been started and nothing more: it is still connecting. */
async function connecting(size?: { cols: number; rows: number }) {
  const f = fakePusher();
  const h = await pushBridge(f.pusher, size);
  h.press("P");
  await h.settle();
  h.advance(33);
  h.type("push").press("enter");
  await tick();
  f.emit(HOSTS);
  f.emit({ event: "stage", host: null, stage: "apply", of: 4 });
  f.emit({ event: "host", host: "laptop", state: "start" });
  f.emit({ event: "host", host: "laptop", state: "done", result: "ok", changes: 3 });
  f.emit({ event: "host", host: "box", state: "start" });
  return { f, h };
}

test("the pipeline row has the total elapsed time, and each lane its own, running until the host is done", async () => {
  const { f, h } = await connecting();
  h.advance(2000);
  const mid = h.frame().split("\n");
  assert.match(mid[2]!, /apply.*\b2\.\ds$/, "total elapsed ends the pipeline row");
  assert.match(mid.find((l) => /box/.test(l) && /connecting/.test(l))!, /\b2\.0s$/);
  assert.match(mid.find((l) => /laptop/.test(l))!, /\b0\.0s$/, "a host that is done keeps the time it took");
  h.advance(1000);
  assert.match(h.frame().split("\n").find((l) => /box/.test(l))!, /\b3\.0s$/);
  f.emit({ event: "host", host: "box", state: "done", result: "ok", changes: 1 });
  h.advance(500);
  const after = h.frame().split("\n").find((l) => /box\s+ok/.test(l))!;
  assert.match(after, /\b3\.0s$/);
  h.advance(2000);
  assert.match(h.frame().split("\n").find((l) => /box\s+ok/.test(l))!, /\b3\.0s$/, "a finished lane's time stops");
  // The total stops when the push ends.
  f.end(ok([["laptop", 3], ["box", 1]]));
  await h.settle();
  const total = h.frame().split("\n")[2]!.match(/(\d+\.\ds)$/)![1];
  h.advance(3000);
  assert.equal(h.frame().split("\n")[2]!.match(/(\d+\.\ds)$/)![1], total);
});

test("before its first step a ssh lane says it is connecting, with its time running; a timer host shows no time", async () => {
  const { f, h } = await connecting();
  h.advance(1500);
  assert.match(h.frame(), /box\s+connecting over ssh\s+1\.\ds/);
  f.emit({ event: "host", host: "edge", state: "start" });
  f.emit({ event: "host", host: "edge", state: "done", result: "timer", changes: 0 });
  h.advance(100);
  assert.match(h.frame().split("\n").find((l) => /edge/.test(l) && /timer/.test(l))!, /schedule\s*$/);
  // Once it reports a stage, the lane says that instead.
  f.emit({ event: "stage", host: "box", stage: "plan" });
  h.advance(100);
  assert.match(h.frame(), /box\s+planning\s+1\.\ds/);
});

test("the feed lists every event as it arrives, with its time and host", async () => {
  const f = fakePusher();
  const h = await pushBridge(f.pusher);
  await playToMiddle(h, f);
  f.emit({ event: "message", host: "server", text: "fleet: server: syncing the fleet clone" });
  h.advance(1000);
  const frame = h.frame();
  assert.match(frame, /ACTIVITY/);
  for (const line of [/push\s+validate/, /push\s+publish 2 repos/, /push\s+apply on 4 hosts/, /laptop\s+started/, /laptop\s+ok \(3 changes\)/, /edge\s+timer/, /server\s+write 12 steps/, /server\s+link ~\/\.claude\/skills\/triage \(5\/12\)/, /server\s+syncing the fleet clone/]) assert.match(frame, line);
  assert.match(frame, /\d\.\ds\s+server\s+syncing/, "each line has its time");
  const order = ["validate", "laptop    started", "box      started", "server   write"].map((t) => frame.indexOf(t.replace(/ +/, " ").split(" ")[0]!));
  assert.ok(order[0]! < order[1]! && order[1]! < order[2]!, "oldest first");
});

test("the host pane follows the host being applied, ↑↓ picks another, and it says how many steps remain", async () => {
  const f = fakePusher();
  const h = await pushBridge(f.pusher);
  await playToMiddle(h, f);
  let frame = h.frame();
  assert.match(frame, /│ SERVER/);
  assert.match(frame, /5 of 12 writes done, 7 to go/);
  assert.match(frame, /\+ link ~\/\.claude\/skills\/triage/);
  h.press("up");
  frame = h.frame();
  assert.match(frame, /│ EDGE/);
  assert.match(frame, /not asked; it catches up on its own schedule/);
  assert.match(frame, /^›.*edge/m, "the picked lane is marked");
  h.press("up", "up");
  assert.match(h.frame(), /│ LAPTOP/);
  h.press("down", "down", "down", "down");
  assert.match(h.frame(), /│ SERVER/, "the cursor stops at the last lane");
  // A step arriving later is added to a picked host's list too.
  f.emit({ event: "step", host: "server", step: "write-link", target: "~/.claude/skills/other", n: 6, of: 12 });
  h.advance(100);
  assert.match(h.frame(), /6 of 12 writes done, 6 to go/);
  assert.match(h.frame(), /\+ link ~\/\.claude\/skills\/other/);
});

test("a host that has not reported its writes says the count is not known yet", async () => {
  const { h } = await connecting();
  assert.match(h.frame(), /│ BOX[^]*steps to come: not known yet/, "the pane follows the host being applied");
  assert.match(h.frame(), /│ {1}.*connecting over ssh/);
});

test("after the push the pane shows what each host got, from the receipts in the end document", async () => {
  const f = fakePusher();
  const h = await pushBridge(f.pusher);
  await playToMiddle(h, f);
  f.emit({ event: "host", host: "server", state: "done", result: "ok", changes: 3 });
  f.emit({ event: "host", host: "box", state: "done", result: "ok", changes: 0 });
  const end = readEnd(0, JSON.stringify({
    code: "ok",
    messages: [],
    hosts: [
      { host: "laptop", result: "ok", changes: 0, created: [], updated: [], removed: [], conflicts: [] },
      { host: "box", result: "ok", changes: 0, created: [], updated: [], removed: [], conflicts: [] },
      { host: "edge", result: "timer", changes: 0, created: [], updated: [], removed: [], conflicts: [] },
      {
        host: "server",
        result: "ok",
        changes: 3,
        created: [{ file: "~/.claude/settings.json", path: "env.TOKEN" }, { target: "~/.claude/skills/triage", source: "/cfg/skills/triage" }],
        updated: [{ file: "~/.claude/settings.json", path: "model" }],
        removed: [{ target: "~/.claude/old.md" }],
        conflicts: [],
      },
    ],
  }));
  f.end(end);
  await h.settle();
  h.advance(100);
  let frame = h.frame();
  assert.match(frame, /│ SERVER/);
  assert.match(frame, /2 created, 1 updated, 1 removed/);
  assert.match(frame, /\+ env\.TOKEN \(~\/\.claude\/settings\.json\)/);
  assert.match(frame, /\+ ~\/\.claude\/skills\/triage/);
  assert.match(frame, /~ model \(~\/\.claude\/settings\.json\)/);
  assert.match(frame, /- ~\/\.claude\/old\.md/);
  assert.doesNotMatch(frame, /\/cfg\/skills/, "only what was written, never more");
  h.press("up", "up");
  frame = h.frame();
  assert.match(frame, /│ BOX/);
  assert.match(frame, /already matched: nothing written/);
  assert.doesNotMatch(frame, /faster than the last push/);
});

test("the receipts say nothing about a host that was not applied", async () => {
  const f = fakePusher();
  const h = await pushBridge(f.pusher);
  await playToMiddle(h, f);
  f.end(ok([["laptop", 3], ["box", 2], ["edge", 0], ["server", 4]]));
  await h.settle();
  h.press("up");
  assert.match(h.frame(), /│ EDGE[^]*not asked/);
});

test("by width: 100 columns shows the feed and the host pane, 80 to 99 drops the pane, below 80 the feed goes too", async () => {
  const shown = async (cols: number, rows = 30) => {
    const f = fakePusher();
    const h = await pushBridge(f.pusher, { cols, rows });
    await playToMiddle(h, f);
    return h.frame();
  };
  const wide = await shown(100);
  assert.match(wide, /ACTIVITY/);
  assert.match(wide, /│ SERVER/);
  for (const cols of [99, 80]) {
    const frame = await shown(cols);
    assert.match(frame, /ACTIVITY/, `${cols} columns have the feed`);
    assert.doesNotMatch(frame, /│ SERVER|writes done/, `${cols} columns have no host pane`);
    assert.match(frame, /✓ laptop/);
  }
  const narrow = await shown(79);
  assert.doesNotMatch(narrow, /ACTIVITY/);
  assert.doesNotMatch(narrow, /writes done/);
  assert.match(narrow, /✓ laptop/);
  assert.match(narrow, /server/);
  assert.match(narrow.split("\n")[2]!, /\d\.\ds$/, "the clock stays");
  assert.match(narrow, /server\s+.*\d\.\ds/, "and the lane times");
});

test("the smallest window, 30 x 8, still draws the push", async () => {
  const f = fakePusher();
  const h = await pushBridge(f.pusher, { cols: 30, rows: 8 });
  await playToMiddle(h, f);
  const frame = h.frame();
  assert.doesNotMatch(frame, /needs a window/);
  assert.match(frame, /validate/);
  assert.match(frame, /\d\.\ds/);
});

test("r on a lane after the push runs a push for that host alone, and the screen shows that run", async () => {
  const f = fakePusher();
  const h = await pushBridge(f.pusher);
  await playToMiddle(h, f);
  f.emit({ event: "host", host: "server", state: "done", result: "ok", changes: 4 });
  f.end(ok([["laptop", 3], ["box", 2], ["edge", 0], ["server", 4]]));
  await h.settle();
  h.advance(100);
  h.press("up", "up");
  h.press("r");
  await tick();
  assert.equal(f.runs, 2);
  assert.deepEqual(f.hosts, [undefined, "box"]);
  assert.deepEqual(f.messages, [undefined, undefined], "no commit message is carried over");
  assert.deepEqual(h.state.push.phase === "running" ? h.state.push.run.lanes.map((l) => l.host) : null, ["box"]);
  f.emit({ event: "hosts", hosts: [{ host: "box", via: "ssh" }] });
  f.emit({ event: "host", host: "box", state: "start" });
  h.advance(100);
  const frame = h.frame();
  assert.match(frame, /box\s+connecting over ssh/);
  assert.doesNotMatch(frame, /laptop/);
  assert.doesNotMatch(frame, /Hosts run one after another/, "one lane has no order to explain");
  assert.match(frame.split("\n")[0]!, /pushing/);
});

test("r does nothing while a push runs, and a timer host is refused with the reason", async () => {
  const f = fakePusher();
  const h = await pushBridge(f.pusher);
  await playToMiddle(h, f);
  h.press("r");
  await tick();
  assert.equal(f.runs, 1);
  assert.match(h.frame(), /a push is running; r runs one host once it is over/);
  f.emit({ event: "host", host: "server", state: "done", result: "ok", changes: 4 });
  f.end(ok([["laptop", 3], ["box", 2], ["edge", 0], ["server", 4]]));
  await h.settle();
  h.press("up");
  assert.match(h.frame(), /│ EDGE/);
  h.press("r");
  await tick();
  assert.equal(f.runs, 1, "nothing was started");
  assert.match(h.frame(), /edge has no ssh destination; it applies on its own timer/);
  h.press("down");
  assert.doesNotMatch(h.frame(), /edge has no ssh destination; it applies on its own timer/, "a key that moves on clears the notice");
  assert.match(h.frame(), /│ SERVER/);
  // This host is allowed: it is the same as publishing and applying here.
  h.press("up", "up", "up");
  h.press("r");
  await tick();
  assert.deepEqual(f.hosts, [undefined, "laptop"]);
});

test("f on a conflict lane opens Conflicts with that host first; on another lane it does not", async () => {
  const f = fakePusher();
  const h = await pushBridge(f.pusher);
  h.press("P");
  await h.settle();
  h.type("push").press("enter");
  await tick();
  f.emit(HOSTS);
  f.emit({ event: "host", host: "laptop", state: "start" });
  f.emit({ event: "host", host: "laptop", state: "done", result: "ok", changes: 0 });
  f.emit({ event: "host", host: "box", state: "start" });
  f.emit({ event: "host", host: "box", state: "done", result: "conflict", changes: 0 });
  f.emit({ event: "host", host: "edge", state: "skip" });
  f.emit({ event: "host", host: "server", state: "skip" });
  f.end({ exit: 3, code: "conflict", messages: [], hosts: [{ host: "laptop", result: "ok", changes: 0 }, { host: "box", result: "conflict", changes: 0 }], conflicts: { box: [{ path: "~/.claude/x.md", detail: "is a real file", fix: "move it" }] } });
  await h.settle();
  h.advance(100);
  assert.match(h.frame(), /│ BOX/, "the last host that finished is shown");
  h.press("up");
  h.press("f");
  assert.equal(h.state.screen, "push", "laptop has no conflict to open");
  assert.match(h.frame(), /laptop has no conflict to open/);
  h.press("down");
  assert.match(h.frame(), /f its conflicts/);
  h.press("f");
  assert.equal(h.state.screen, "conflicts");
  assert.equal(h.state.conflicts.first, "box");
  assert.equal(h.state.conflicts.selected, 0);
  const frame = h.frame();
  assert.ok(frame.indexOf("box") < frame.indexOf("laptop"), "box is listed first");
  assert.equal(f.runs, 1, "nothing was run");
});

test("the reducer keeps each lane's writes in a capped list, with its start and end on the clock it was given", () => {
  let run = startRun([], 1000);
  run = reduce(run, HOSTS, 1000);
  run = reduce(run, { event: "host", host: "box", state: "start" }, 1500);
  assert.equal(run.lanes.find((l) => l.host === "box")!.from, 1500);
  for (let n = 1; n <= STEPS_KEPT + 20; n++) run = reduce(run, { event: "step", host: "box", step: "write-link", target: `~/f${n}`, n, of: 300 }, 1600);
  const box = run.lanes.find((l) => l.host === "box")!;
  assert.equal(box.steps.length, STEPS_KEPT);
  assert.equal(box.steps.at(-1)!.target, `~/f${STEPS_KEPT + 20}`);
  assert.equal(box.step!.n, STEPS_KEPT + 20);
  run = reduce(run, { event: "host", host: "box", state: "done", result: "ok", changes: 1 }, 4000);
  assert.deepEqual([box.to, run.lanes.find((l) => l.host === "box")!.to], [null, 4000]);
  run = finish(run, { exit: 0, code: "ok", conflicts: {}, messages: [], hosts: [] }, 5000);
  assert.equal(run.endedAt, 5000);
  assert.ok(run.feed.length <= 200);
  // A reader with no clock gets the run's own start.
  assert.equal(reduce(startRun(names.map((n) => ({ name: n.name, ssh: n.ssh, self: n.self })), 7), { event: "host", host: "laptop", state: "start" }).lanes[0]!.from, 7);
});
