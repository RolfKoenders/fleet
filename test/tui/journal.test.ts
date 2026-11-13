import { test } from "node:test";
import assert from "node:assert/strict";
import { fakePusher, ok, pushBridge, tick } from "./pushfixture.ts";
import type { FakePusher } from "./pushfixture.ts";
import type { JournalEntry, StoredEvent, StoredJournal } from "../../src/journal.ts";
import type { FleetEvent } from "../../src/events.ts";

const HOSTS: FleetEvent = { event: "hosts", hosts: [{ host: "laptop", via: "local" }, { host: "box", via: "ssh" }] };

/** A push as the journal stores it: 3 seconds, ending ok, with box taking from 1.0s to 2.5s. */
const EVENTS: StoredEvent[] = [
  { t: 0, event: { event: "stage", stage: "validate" } },
  { t: 100, event: HOSTS },
  { t: 200, event: { event: "stage", stage: "apply", of: 2 } },
  { t: 300, event: { event: "host", host: "laptop", state: "start" } },
  { t: 1000, event: { event: "host", host: "laptop", state: "done", result: "ok", changes: 1 } },
  { t: 1000, event: { event: "host", host: "box", state: "start" } },
  { t: 2000, event: { event: "step", host: "box", step: "write-link", target: "~/.claude/skills/triage", n: 1, of: 1 } },
  { t: 2500, event: { event: "host", host: "box", state: "done", result: "ok", changes: 1 } },
];

const header = (over: Partial<JournalEntry["header"]> = {}): JournalEntry["header"] => ({
  journal: 1,
  v: 1,
  time: "2026-11-13T09:41:03.000Z",
  commit: "abc1234",
  only: null,
  hosts: ["laptop", "box"],
  ms: 3000,
  interrupted: false,
  result: "ok",
  end: { code: "ok", messages: [], hosts: [{ host: "laptop", result: "ok", changes: 1, created: [{ target: "~/a" }], updated: [], removed: [], conflicts: [] }, { host: "box", result: "ok", changes: 1, created: [], updated: [], removed: [], conflicts: [] }], conflicts: [] },
  ...over,
});

const entries: JournalEntry[] = [
  { file: "20261113T094103.000Z-3.jsonl", header: header() },
  { file: "20261112T081500.000Z-2.jsonl", header: header({ time: "2026-11-12T08:15:00.000Z", only: "box", hosts: ["box"], ms: 61_000 }) },
  { file: "20261111T081500.000Z-1.jsonl", header: header({ time: "2026-11-11T08:15:00.000Z", interrupted: true, result: null, end: null, ms: 900 }) },
];

function withJournal(f: FakePusher, list: JournalEntry[] = entries): { reads: string[] } {
  const reads: string[] = [];
  f.pusher.journal = {
    list: () => list,
    read: (file) => {
      reads.push(file);
      const e = list.find((x) => x.file === file);
      return e ? ({ header: e.header, events: EVENTS } satisfies StoredJournal) : null;
    },
  };
  return { reads };
}

async function history(size?: { cols: number; rows: number }) {
  const f = fakePusher();
  const { reads } = withJournal(f);
  const h = await pushBridge(f.pusher, size);
  h.press("7");
  await h.settle();
  h.press("h");
  await h.settle();
  return { f, h, reads };
}

test("h on the push screen lists the recorded pushes, newest first, with scope, result, duration and host count", async () => {
  const { h } = await history();
  const frame = h.frame();
  assert.match(frame, /Push history/);
  const rows = frame.split("\n").filter((l) => /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(l));
  assert.equal(rows.length, 3);
  assert.match(rows[0]!, /ok\s+3\.0s\s+all hosts\s+2 hosts/);
  assert.match(rows[1]!, /ok\s+1m01s\s+box\s+1 host\b/);
  assert.match(rows[2]!, /interrupted\s+0\.9s\s+all hosts/);
  assert.match(rows[0]!, /›/, "the first is selected");
  h.press("down");
  assert.match(h.frame().split("\n").find((l) => /1m01s/.test(l))!, /›/);
  assert.match(h.frame(), /enter\s+replay/);
});

test("with nothing recorded the history says so", async () => {
  const f = fakePusher();
  withJournal(f, []);
  const h = await pushBridge(f.pusher);
  h.press("7");
  await h.settle();
  h.press("h");
  await h.settle();
  assert.match(h.frame(), /No pushes recorded yet/);
});

test("esc closes the history, and the push keys do nothing while it is open", async () => {
  const { f, h } = await history();
  h.press("P");
  h.press("r");
  await h.settle();
  assert.equal(f.previews, 0, "P did not open a review");
  assert.equal(f.runs, 0);
  h.press("escape");
  assert.doesNotMatch(h.frame(), /Push history/);
  assert.match(h.frame(), /No push yet/);
  assert.match(h.frame(), /Press h/);
});

test("enter replays the push at real speed with its clock, through the reducer, and esc goes back to the list and then out", async () => {
  const { h, reads } = await history();
  h.press("enter");
  await h.settle();
  assert.deepEqual(reads, ["20261113T094103.000Z-3.jsonl"]);
  assert.match(h.frame(), /Replay of the push of 2026-11-13/);
  h.advance(500);
  let frame = h.frame();
  assert.match(frame, /laptop\s+(?!ok)/, "laptop is still running at 0.5s");
  assert.doesNotMatch(frame, /box\s+ok/);
  h.advance(1000);
  frame = h.frame();
  assert.match(frame.split("\n").find((l) => /laptop/.test(l) && /ok/.test(l))!, /\b0\.7s$/, "laptop took 0.7s on the stored clock");
  assert.match(frame.split("\n").find((l) => /box/.test(l) && /connecting/.test(l))!, /\b0\.5s$/, "box has been running for half a second");
  h.advance(2000);
  frame = h.frame();
  assert.match(frame, /Push finished/);
  assert.match(frame.split("\n").find((l) => /box\s+ok/.test(l))!, /\b1\.5s$/, "box took what it took");
  assert.match(frame.split("\n")[2]!, /\b3\.0s$/, "the whole push took what it took");
  h.advance(5000);
  assert.match(h.frame().split("\n")[2]!, /\b3\.0s$/, "and the clock stays");
  h.press("escape");
  assert.match(h.frame(), /Push history/);
  h.press("escape");
  assert.doesNotMatch(h.frame(), /Push history/);
});

test("the first push of a replay is the one selected, and an interrupted push replays without an end document", async () => {
  const { h, reads } = await history();
  h.press("down").press("down").press("enter");
  await h.settle();
  assert.deepEqual(reads, ["20261111T081500.000Z-1.jsonl"]);
  h.advance(5000);
  assert.match(h.frame(), /Push ended: no result document/);
});

test("the history and a replay fit the smallest window and a narrow one", async () => {
  for (const size of [{ cols: 30, rows: 8 }, { cols: 50, rows: 12 }]) {
    const { h } = await history(size);
    for (const line of h.frame().split("\n")) assert.ok([...line].length <= size.cols, `fits ${size.cols}: ${line}`);
    h.press("enter");
    await h.settle();
    h.advance(4000);
    const lines = h.frame().split("\n");
    assert.equal(lines.length, size.rows);
    for (const line of lines) assert.ok([...line].length <= size.cols, `fits ${size.cols}: ${line}`);
  }
});

/** Runs a push in the bridge and ends it, with `list` as the journal after it. */
async function pushedWith(list: JournalEntry[]) {
  const f = fakePusher();
  withJournal(f, list);
  const h = await pushBridge(f.pusher);
  h.press("P");
  await h.settle();
  h.advance(33);
  h.type("push").press("enter");
  await tick();
  f.emit(HOSTS);
  f.end(ok([["laptop", 1], ["box", 1]]));
  await h.settle();
  return h;
}

const soon = new Date(Date.now() + 60_000).toISOString();

test("the end of a push says how much faster or slower it was than the last push of its scope", async () => {
  const faster = await pushedWith([{ file: "20261113T100000.000Z-9.jsonl", header: header({ time: soon, ms: 3600 }) }, { file: "b", header: header({ ms: 5000 }) }]);
  assert.match(faster.frame(), /1\.4s faster than the last push/);
  const slower = await pushedWith([{ file: "20261113T100000.000Z-9.jsonl", header: header({ time: soon, ms: 6500 }) }, { file: "b", header: header({ ms: 5000 }) }]);
  assert.match(slower.frame(), /1\.5s slower than the last push/);
});

test("the line is left out when there is nothing to compare with", async () => {
  const first = await pushedWith([{ file: "a", header: header({ time: soon }) }]);
  assert.match(first.frame(), /Push finished/);
  assert.doesNotMatch(first.frame(), /than the last push/);
  const otherScope = await pushedWith([{ file: "a", header: header({ time: soon }) }, { file: "b", header: header({ only: "box" }) }]);
  assert.doesNotMatch(otherScope.frame(), /than the last push/);
  const stale = await pushedWith([{ file: "a", header: header({ time: "2020-01-01T00:00:00.000Z", ms: 1 }) }, { file: "b", header: header({ ms: 5000 }) }]);
  assert.doesNotMatch(stale.frame(), /than the last push/, "a journal that is not this push's is not used");
});
