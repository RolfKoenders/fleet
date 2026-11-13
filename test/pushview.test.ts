import { test } from "node:test";
import assert from "node:assert/strict";
import type { FleetEvent } from "../src/events.ts";
import type { HostRecord } from "../src/push.ts";
import { reduce, startRun } from "../src/pushrun.ts";
import { chooseMode, liveBlock, MIN_LIVE_WIDTH, Progress, progressFor, summary } from "../src/pushview.ts";
import type { View } from "../src/pushview.ts";

const ESC = /\u001b\[[0-9;?]*[A-Za-z]/g;
const plain = (text: string) => text.replace(ESC, "");
const cells = (line: string) => [...plain(line)].length;

const record = (host: string, result: HostRecord["result"], extra: Partial<HostRecord> = {}): HostRecord => ({ host, result, changes: 0, created: [], updated: [], removed: [], conflicts: [], ...extra });

const TARGET = "~/.config/opencode/skills/a-very-long-skill-name-that-will-not-fit/SKILL.md";
const EVENTS: FleetEvent[] = [
  { event: "stage", stage: "validate" },
  { event: "hosts", hosts: [{ host: "laptop", via: "local" }, { host: "server", via: "ssh" }, { host: "edge", via: "timer" }] },
  { event: "stage", stage: "publish", of: 1 },
  { event: "step", step: "publish", target: "~/fleet-config", n: 1, of: 1 },
  { event: "stage", stage: "apply", of: 3 },
  { event: "host", host: "laptop", state: "start" },
  { event: "host", host: "laptop", state: "done", result: "ok", changes: 2 },
  { event: "host", host: "server", state: "start" },
  { event: "stage", host: "server", stage: "write", of: 5 },
  { event: "step", host: "server", step: "write-link", target: TARGET, n: 2, of: 5 },
];

function view(): View {
  const run = EVENTS.reduce(reduce, startRun([], 0));
  const laptop = record("laptop", "ok", { created: [{ target: "~/.claude/a" }, { target: "~/.claude/b" }] });
  return { run, records: new Map([["laptop", laptop]]), times: new Map([["laptop", { from: 0, to: 1800 }], ["server", { from: 1800, to: null }]]), began: 0 };
}

test("the live block is drawn only on a terminal that is not dumb and is wide enough, whatever NO_COLOR says", () => {
  assert.equal(chooseMode({ TERM: "xterm-256color" }, true, 100), "live");
  assert.equal(chooseMode({ TERM: "xterm-256color" }, false, 100), "plain", "piped");
  assert.equal(chooseMode({ TERM: "dumb" }, true, 100), "plain");
  assert.equal(chooseMode({}, true, 100), "plain", "no TERM at all");
  assert.equal(chooseMode({ TERM: "xterm" }, true, MIN_LIVE_WIDTH - 1), "plain");
  assert.equal(chooseMode({ TERM: "xterm" }, true, MIN_LIVE_WIDTH), "live");
  assert.equal(chooseMode({ TERM: "xterm", NO_COLOR: "1" }, true, 100), "live", "NO_COLOR is not a reason to give up the block");
});

test("progressFor: NO_COLOR keeps the block and drops the color, and the event stream on stderr gets no progress at all", () => {
  const written: string[] = [];
  const stream = { isTTY: true, columns: 100, write: (t: string) => written.push(t) };
  const quiet = progressFor({ TERM: "xterm", NO_COLOR: "1" }, stream)!;
  assert.equal(quiet.mode, "live");
  quiet.start();
  quiet.interrupt();
  const out = written.join("");
  assert.match(out, /validate/);
  assert.doesNotMatch(out, /\u001b\[\d+m/, "no SGR color code");
  assert.match(out, /\u001b\[\?25l/, "the cursor is still hidden");
  assert.equal(progressFor({ TERM: "xterm", FLEET_EVENTS: "1" }, stream), null);
});

test("the live block: a lane shows its bar, step and time, and a finished host its changes by kind", () => {
  const lines = liveBlock(view(), 200, 2500, false);
  assert.match(lines[0]!, /^ ✓ validate {3}✓ publish 1\/1 {3}[⠀-⣿] apply 1\/3 {3}2\.5s$/);
  assert.equal(lines[1], "");
  assert.match(lines[2]!, /^ ✓ laptop {2}local ok · 2 links {2}1\.8s$/);
  assert.match(lines[3]!, /^ [⠀-⣿] server {2}ssh {3}█████░░░░░░░ 2\/5 link .*SKILL\.md {2}0\.7s$/);
  assert.match(lines[4]!, /^ · edge {4}timer applies on its own schedule$/);
});

test("the live block cuts every line to the terminal, the target first and ending in an ellipsis, and never wraps", () => {
  const wide = liveBlock(view(), 200, 2500, false)[3]!;
  assert.ok(wide.includes(TARGET));
  for (const width of [110, 90, 70, 60, MIN_LIVE_WIDTH, 40, 20]) {
    for (const color of [false, true]) {
      const lines = liveBlock(view(), width, 2500, color);
      for (const line of lines) assert.ok(cells(line) <= width - 1, `${width} columns, color ${color}: ${cells(line)} cells in ${JSON.stringify(plain(line))}`);
    }
  }
  const narrow = plain(liveBlock(view(), 70, 2500, false)[3]!);
  assert.match(narrow, /…\s+0\.7s$/, "the path gives way and ends in an ellipsis, the time stays");
  assert.match(narrow, /server {2}ssh {3}█████░░░░░░░ 2\/5 link ~\/\.config/, "the bar and the step name stay");
  assert.ok(!narrow.includes("SKILL.md"));
});

test("the live block paints with color unless told not to, and the same text is under it", () => {
  const colored = liveBlock(view(), 100, 2500, true);
  assert.ok(colored.some((l) => /\u001b\[3[26]m/.test(l)));
  assert.deepEqual(colored.map(plain), liveBlock(view(), 100, 2500, false));
});

const run = (events: FleetEvent[], now: () => number, color = false) => {
  const written: string[] = [];
  const progress = new Progress("live", (t) => void written.push(t), { width: () => 100, color, now, wall: () => new Date(2026, 10, 13, 9, 5, 7), interval: 0 });
  progress.start();
  for (const e of events) progress.event(e);
  return { progress, written };
};

test("a host's own text is printed above the block, with the host's name, and the block is drawn again under it", () => {
  let t = 0;
  const { progress, written } = run(EVENTS, () => t);
  written.length = 0;
  t = 100;
  progress.event({ event: "message", host: "server", text: "fleet: skill triage is new" });
  assert.equal(written.length, 1, "one write, so the block does not flicker");
  const [before, after] = written[0]!.split("server: skill triage is new\n") as [string, string];
  assert.match(before, /^\u001b\[5F\u001b\[J$/, "the old block (5 lines) is erased first");
  assert.match(plain(after), /^ ✓ validate/, "the block follows the text");
  assert.equal(after.split("\n").length - 1, 5);
});

test("ctrl-c: finished hosts with their result, the running host as interrupted, the rest as not reached", () => {
  let t = 0;
  const { progress, written } = run(EVENTS, () => t);
  progress.record(record("laptop", "ok", { created: [{ target: "~/.claude/a" }, { file: "~/.claude.json", path: "mcpServers.docs" }] }), 1.8);
  t = 3200;
  written.length = 0;
  progress.interrupt();
  const out = plain(written.join(""));
  assert.match(out, /laptop: ok · 1 link, 1 key \(1\.8s\)\nserver: interrupted \(3\.2s\)\nedge: not reached\n\ninterrupted after 3\.2s: 1 ok, 1 interrupted, 1 not reached\n/);
  assert.match(written.join(""), /\u001b\[\?25h$/, "the cursor is put back last");
  assert.equal(progress.summarized, true);
  written.length = 0;
  progress.event({ event: "host", host: "server", state: "done", result: "ok", changes: 0 });
  progress.interrupt();
  assert.deepEqual(written, [], "after the end it draws nothing more");
});

test("the summary: results, changes and time, a conflict with its fix, and a total", () => {
  const lines = summary(
    [
      { host: "laptop", record: record("laptop", "ok", { created: [{ target: "a" }, { target: "b" }, { file: "f", path: "p" }] }), seconds: 1.8, state: "done" },
      { host: "server", record: record("server", "conflict", { conflicts: [{ kind: "link", path: "~/.claude/x.md", detail: "is a real file", fix: "move it" }] }), seconds: 0.4, state: "done" },
      { host: "edge", record: record("edge", "timer"), state: "done" },
      { host: "box", record: null, state: "not reached" },
    ],
    8,
    false,
    false,
  );
  assert.deepEqual(lines, ["laptop: ok · 2 links, 1 key (1.8s)", "server: conflict (0.4s)", "  ~/.claude/x.md: is a real file", "  fix: move it", "edge: timer", "box: not reached", "", "pushed in 8.0s: 1 ok, 1 conflict, 1 timer, 1 not reached"]);
});

test("plain mode: a timestamped line for each host start and result, the host's text, and no line per step", () => {
  const written: string[] = [];
  const progress = new Progress("plain", (t) => void written.push(t), { width: () => 100, color: false, wall: () => new Date(2026, 10, 13, 9, 5, 7) });
  progress.start();
  for (const e of EVENTS) progress.event(e);
  progress.event({ event: "message", host: "server", text: "fleet: heads up" });
  progress.record(record("laptop", "ok", { created: [{ target: "a" }] }), 1.8);
  progress.finish();
  assert.deepEqual(written.join("").split("\n"), ["09:05:07 laptop: started", "09:05:07 server: started", "09:05:07 server: heads up", "09:05:07 laptop: ok · 1 link (1.8s)", ""]);
  assert.equal(progress.summarized, false);
});
