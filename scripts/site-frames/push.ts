// The "Watch it land" clip on the landing page: what `fleet push` draws on a terminal, and the plain lines it prints when piped.
//
// The real `fleet push` runs in the demo sandbox (the same made-up world as `fleet demo`: three hosts, a change to
// push, a conflict on server) with its events on, and what it said is kept: the events, in order, with each host's
// own text, and the document with each host's result, changes and conflict. Those are played through the real
// renderer (src/pushview.ts) on a simulated clock and a terminal of fixed size, so two runs give the same bytes on any
// machine. The time each step takes is made up, paced for someone watching a page; the events and results are not.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseEvent } from "../../src/events.ts";
import type { FleetEvent } from "../../src/events.ts";
import { buildSandbox, destroy, sandboxEnv } from "../../src/demo/sandbox.ts";
import type { HostRecord } from "../../src/push.ts";
import { Progress } from "../../src/pushview.ts";
import { theme } from "../../src/tui/theme.ts";
import { fromAnsi } from "./frame.ts";
import type { Frame, Span } from "./frame.ts";
import { Screen } from "./vt.ts";

/** The terminal's width in columns. */
const COLS = 100;
const FRAME_MS = 33;
const COMMAND = 'fleet push -m "Add the triage skill"';

type Real = { events: FleetEvent[]; records: HostRecord[] };

/** Runs the sandbox's own `fleet push` and keeps what it said, with the sandbox's paths made into the ones a person sees. */
function runPush(): Real {
  const toolDir = join(import.meta.dirname, "../..");
  const sandbox = buildSandbox(toolDir);
  try {
    const env = { ...sandboxEnv(sandbox.root, sandbox.admin.home, { config: sandbox.config }), FLEET_EVENTS: "1" };
    const r = spawnSync(join(sandbox.admin.home, ".local/bin/fleet"), ["push", "-m", "Add the triage skill", "--json"], { cwd: sandbox.config, env, encoding: "utf8" });
    if (r.status !== 3) throw new Error(`the demo's push should stop on server's conflict (exit 3), not ${r.status}: ${r.stderr}`);
    // A path in a host's home is `~`, and the config repo is where `fleet init` puts it.
    const root = sandbox.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const shown = (text: string) => text.replace(new RegExp(`${root}/(laptop|server|devbox)/fleet-config`, "g"), "~/fleet-config").replace(new RegExp(`${root}/(laptop|server|devbox)`, "g"), "~").replaceAll(sandbox.root, "/demo");
    const all = shown(r.stderr).split("\n").filter((l) => l !== "").map(parseEvent);
    // What push says about itself once the last host is done is not part of the run.
    const last = all.findLastIndex((e) => e.event === "host");
    const events = all.slice(0, last + 1);
    const doc = JSON.parse(shown(r.stdout)) as { hosts: HostRecord[] };
    return { events, records: doc.hosts };
  } finally {
    destroy(sandbox.root);
  }
}

/** How long the page waits after each event, in ms: slow enough to read each step. */
function pause(e: FleetEvent): number {
  switch (e.event) {
    case "hosts": return 500;
    case "stage": return e.host ? (e.stage === "write" ? 600 : 500) : 600;
    case "step": return e.host ? 1000 : 700;
    case "host": return e.state === "start" ? 400 : 600;
    case "message": return 900;
  }
}

/** Each event with the time it happens, on the page's clock. */
function schedule(events: FleetEvent[]): { at: number; event: FleetEvent }[] {
  let at = 400;
  return events.map((event) => {
    const item = { at, event };
    at += pause(event);
    return item;
  });
}

const prompt = (): Span[] => [["$ ", theme.brand, -1, 0], [COMMAND, -1, -1, 0]];

/** What the terminal shows, as a frame: the prompt, then what fleet wrote, padded to `rows` so the clip never changes height. */
function frameOf(ansi: string, rows: number): Frame {
  const lines = [prompt(), ...(ansi === "" ? [] : fromAnsi(ansi).lines)];
  return { cols: COLS, rows, lines: [...lines, ...Array.from({ length: rows - lines.length }, (): Span[] => [])] };
}

/** The push as a person sees it on a terminal, frame by frame, from the start to the summary that stays. */
function drawn(real: Real): Frame[] {
  const screen = new Screen(COLS);
  let now = 0;
  const progress = new Progress("live", (t) => screen.write(t), { width: () => COLS, color: true, now: () => now, interval: 0 });
  progress.start();
  const plan = schedule(real.events);
  const began = new Map<string, number>();
  const frames: string[] = [];
  const end = plan[plan.length - 1]!.at + 1500;
  let next = 0;
  for (now = 0; now <= end; now += FRAME_MS) {
    let fed = false;
    while (next < plan.length && plan[next]!.at <= now) {
      const { event } = plan[next++]!;
      progress.event(event);
      fed = true;
      if (event.event === "host" && event.state === "start") began.set(event.host, now);
      if (event.event === "host" && event.state === "done") {
        const record = real.records.find((r) => r.host === event.host)!;
        progress.record(record, record.result === "timer" ? undefined : (now - began.get(event.host)!) / 1000);
      }
    }
    if (!fed) progress.redraw();
    frames.push(screen.ansi());
  }
  progress.finish();
  // The summary stays: a few seconds of it before the clip starts over.
  for (let hold = 0; hold < 3000; hold += FRAME_MS) frames.push(screen.ansi());
  const rows = 1 + Math.max(...frames.map((f) => (f === "" ? 0 : f.split("\n").length)));
  return frames.map((ansi) => frameOf(ansi, rows));
}

/** The same events piped: a line for each host's start and result, and the host's own text. As a frame, under the command that printed it. */
function piped(real: Real): Frame {
  const out: string[] = [];
  let now = 0;
  const progress = new Progress("plain", (t) => out.push(t), { width: () => COLS, color: false, now: () => now, wall: () => new Date(2026, 10, 13, 9, 41, 0, now) });
  const began = new Map<string, number>();
  for (const { at, event } of schedule(real.events)) {
    now = at;
    progress.event(event);
    if (event.event === "host" && event.state === "start") began.set(event.host, at);
    if (event.event === "host" && event.state === "done") {
      const record = real.records.find((r) => r.host === event.host)!;
      progress.record(record, record.result === "timer" ? undefined : (at - began.get(event.host)!) / 1000);
    }
  }
  progress.finish();
  const body = fromAnsi(out.join("")).lines;
  return { cols: COLS, rows: body.length + 1, lines: [[["$ ", theme.brand, -1, 0], [`${COMMAND} 2>&1 | tee push.log`, -1, -1, 0]], ...body] };
}

export function recordWatch(): { live: Frame[]; piped: Frame } {
  const real = runPush();
  return { live: drawn(real), piped: piped(real) };
}
