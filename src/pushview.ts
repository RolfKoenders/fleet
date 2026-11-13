import { eventsOn } from "./events.ts";
import type { Env, FleetEvent } from "./events.ts";
import { paint, useColor } from "./output.ts";
import type { HostRecord } from "./push.ts";
import { reduce, startRun } from "./pushrun.ts";
import type { Lane, PushRun } from "./pushrun.ts";
import { isObject } from "./yamlfile.ts";

/**
 * What `fleet push` shows on stderr. On a terminal it draws a live block: the pipeline, then one lane per host. Everywhere
 * else it prints plain lines. When the push ends the block is replaced by a summary that stays in the scrollback.
 */

export type Mode = "live" | "plain";

/** Below this many columns a lane has no room for anything but its host and its stage, so a narrow terminal gets plain lines. */
export const MIN_LIVE_WIDTH = 50;

/** The live block needs a terminal that moves the cursor: not a pipe, not `TERM=dumb` (or no `TERM`), and not a very narrow one. `NO_COLOR` is about color only. */
export function chooseMode(env: Env, isTTY: boolean, columns: number): Mode {
  const term = env.TERM ?? "";
  return isTTY && term !== "" && term !== "dumb" && columns >= MIN_LIVE_WIDTH ? "live" : "plain";
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The changes of one host by kind, such as `2 links, 1 key`: an entry with a `file` is a key, any other is a link. */
export function kinds({ created, updated, removed }: HostRecord): string {
  const all = [...created, ...updated, ...removed];
  const keys = all.filter((e) => isObject(e) && "file" in e).length;
  return [[all.length - keys, "link"] as const, [keys, "key"] as const].filter(([n]) => n > 0).map(([n, kind]) => plural(n, kind)).join(", ");
}

/** What one host's record says, as lines: its result, changes and time, then each conflict with its fix. `took` is the seconds its apply took, unset when it was not applied. */
export function hostLines(record: HostRecord, took: number | undefined, color: boolean): string[] {
  const { host, result, conflicts } = record;
  const shown = result === "ok" ? paint(color, "green", result) : result === "timer" ? result : paint(color, "yellow", result);
  const what = kinds(record);
  const lines = [`${host}: ${shown}${what === "" ? "" : ` · ${what}`}${took === undefined || result === "unreachable" ? "" : ` (${took.toFixed(1)}s)`}`];
  for (const c of conflicts) lines.push(`  ${c.path}: ${c.detail}`, `  fix: ${c.fix}`);
  return lines;
}

/** One host in the summary: finished with a record, cut short by ctrl-c, or never started. */
export type Outcome = { host: string; record: HostRecord | null; seconds?: number; state: "done" | "interrupted" | "not reached" };

/** The summary that stays in the scrollback: a line per host (conflicts with their fix under it) and a total. Pure. */
export function summary(outcomes: Outcome[], total: number, color: boolean, interrupted: boolean): string[] {
  const lines: string[] = [];
  const counts = new Map<string, number>();
  for (const o of outcomes) {
    const label = o.record?.result ?? o.state;
    counts.set(label, (counts.get(label) ?? 0) + 1);
    if (o.record !== null) lines.push(...hostLines(o.record, o.seconds, color));
    else if (o.state === "interrupted") lines.push(`${o.host}: ${paint(color, "yellow", "interrupted")}${o.seconds === undefined ? "" : ` (${o.seconds.toFixed(1)}s)`}`);
    else lines.push(`${o.host}: ${paint(color, "dim", "not reached")}`);
  }
  const tally = [...counts].map(([label, n]) => `${n} ${label}`).join(", ");
  lines.push("", `${interrupted ? "interrupted after" : "pushed in"} ${total.toFixed(1)}s${tally === "" ? "" : `: ${tally}`}`);
  return lines;
}

// The live block

type Style = "green" | "yellow" | "dim" | "bold" | "cyan";
/** A piece of a line and its style. */
type Seg = [text: string, style?: Style];

/** What the live block shows, all of it: the reducer's run, each host's record once it has one, and when each host started and ended (ms). */
export type View = { run: PushRun; records: Map<string, HostRecord>; times: Map<string, { from: number; to: number | null }>; began: number };

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const BAR = 12;
const STAGES: Record<string, string> = { sync: "syncing repos", plan: "planning", write: "writing" };
const STEPS: Record<string, string> = { "write-link": "link", "write-keys": "keys", "add-server": "add server", "remove-server": "remove server", "remove-link": "remove link" };

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const length = (segs: Seg[]) => segs.reduce((n, [t]) => n + [...t].length, 0);
const pad = (text: string, n: number) => text + " ".repeat(Math.max(0, n - [...text].length));

/**
 * Cuts a line to `width` cells and paints it. The segment at `shrink` gives way first (a path ends in `…`), then
 * whatever is still too long is cut off. A line is never wrapped.
 */
function fit(segs: Seg[], shrink: number, width: number, color: boolean): string {
  const parts = segs.map((s): Seg => [...s]);
  const target = parts[shrink];
  if (target !== undefined) {
    const room = width - (length(parts) - [...target[0]].length);
    const chars = [...target[0]];
    if (room <= 0) target[0] = "";
    else if (chars.length > room) target[0] = `${chars.slice(0, room - 1).join("")}…`;
  }
  let left = width;
  let out = "";
  for (const [text, style] of parts) {
    const chars = [...text];
    if (chars.length === 0) continue;
    const kept = chars.slice(0, Math.max(0, left)).join("");
    left -= chars.length;
    out += style === undefined ? kept : paint(color, style, kept);
    if (left <= 0) break;
  }
  return out;
}

const lane = (l: Lane, view: View, now: number, hostWidth: number): { segs: Seg[]; shrink: number } => {
  const time = view.times.get(l.host);
  const lead: Seg[] = [[" "], [pad(l.host, hostWidth), l.state === "waiting" || l.state === "skipped" ? "dim" : "bold"], ["  "], [pad(l.via, 5), "dim"], [" "]];
  const mark = (text: string, style?: Style): Seg[] => [[" "], [text, style]];
  const trail = (ms: number | undefined): Seg[] => (ms === undefined ? [] : [["  "], [secs(ms), "dim"]]);
  if (l.state === "running") {
    const spin = SPINNER[Math.floor(now / 80) % SPINNER.length]!;
    const elapsed = time === undefined ? undefined : now - time.from;
    if (l.step !== null && l.step.of > 0) {
      const filled = Math.min(BAR, Math.round((l.step.n / l.step.of) * BAR));
      const text: Seg[] = [[`${l.step.n}/${l.step.of} `], [`${STEPS[l.step.name] ?? l.step.name} `, "dim"]];
      const segs = [...mark(spin, "cyan"), ...lead, ["█".repeat(filled), "cyan"], ["░".repeat(BAR - filled), "dim"], [" "], ...text, [l.step.target, "dim"], ...trail(elapsed)] as Seg[];
      return { segs, shrink: 2 + lead.length + 3 + text.length };
    }
    const doing = l.stage !== null ? (STAGES[l.stage] ?? l.stage) : l.via === "ssh" ? "connecting over ssh" : "starting";
    return { segs: [...mark(spin, "cyan"), ...lead, [doing, "dim"], ...trail(elapsed)], shrink: -1 };
  }
  if (l.state === "done") {
    const record = view.records.get(l.host);
    const ended = time?.to != null ? time.to - time.from : undefined;
    if (l.result === "timer") return { segs: [...mark("◌", "dim"), ...lead, ["timer: applies on its own schedule", "dim"]], shrink: -1 };
    const what = record === undefined ? (l.changes > 0 ? plural(l.changes, "change") : "") : kinds(record);
    const bad = l.result !== "ok";
    return { segs: [...mark(bad ? "✕" : "✓", bad ? "yellow" : "green"), ...lead, [l.result ?? "done", bad ? "yellow" : "green"], [what === "" ? "" : ` · ${what}`], ...(l.result === "unreachable" ? [] : trail(ended))], shrink: -1 };
  }
  if (l.state === "skipped") return { segs: [...mark("·", "dim"), ...lead, ["not reached: an earlier host stopped the push", "dim"]], shrink: -1 };
  return { segs: [...mark("·", "dim"), ...lead, [l.via === "timer" ? "applies on its own schedule" : "waiting its turn", "dim"]], shrink: -1 };
};

/** The live block as lines no longer than `width - 1` cells (so none wraps), for the time `now` (ms on the same clock as `view`'s times). Pure. */
export function liveBlock(view: View, width: number, now: number, color: boolean): string[] {
  const { run } = view;
  const spin = SPINNER[Math.floor(now / 80) % SPINNER.length]!;
  const glyph = (p: PushRun["phases"]["validate"]): Seg => (p === "done" ? ["✓", "green"] : p === "running" ? [spin, "cyan"] : p === "failed" ? ["✕", "yellow"] : ["·", "dim"]);
  const done = run.lanes.filter((l) => l.state === "done").length;
  const publish = run.publish.of > 0 ? ` ${run.publish.n}/${run.publish.of}` : "";
  const applying = run.phases.apply === "waiting" || run.lanes.length === 0 ? "" : ` ${done}/${run.lanes.length}`;
  const pipeline: Seg[] = [[" "], glyph(run.phases.validate), [" validate   "], glyph(run.phases.publish), [` publish${publish}   `], glyph(run.phases.apply), [` apply${applying}   `], [secs(now - view.began), "dim"]];
  const max = width - 1;
  const hostWidth = Math.max(0, ...run.lanes.map((l) => [...l.host].length));
  const lines = [fit(pipeline, -1, max, color)];
  if (run.lanes.length > 0) lines.push("");
  for (const l of run.lanes) {
    const { segs, shrink } = lane(l, view, now, hostWidth);
    lines.push(fit(segs, shrink, max, color));
  }
  return lines;
}

// The controller

type Options = { width: () => number; color: boolean; now?: () => number; wall?: () => Date; interval?: number };

const HIDE = "\u001b[?25l";
const SHOW = "\u001b[?25h";
const clock = (d: Date) => [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
/** A host's own text, without the `fleet: ` its fleet put in front of it. */
const said = (text: string) => text.replace(/^fleet: /, "");

/**
 * Shows a push on stderr as events arrive. `live` keeps a block at the bottom of the terminal and prints host
 * messages above it; `plain` prints a timestamped line when a host starts and when it has a result, and the host
 * messages. Both end with `finish` (or `interrupt`, when the push is cut short).
 */
export class Progress {
  readonly mode: Mode;
  /** Whether the summary was written, so the same lines need not be printed again on stdout. */
  summarized = false;
  private view: View;
  private height = 0;
  private timer: NodeJS.Timeout | null = null;
  private over = false;
  private readonly seconds = new Map<string, number>();
  private readonly write: (text: string) => void;
  private readonly options: Options;
  private readonly now: () => number;
  private readonly wall: () => Date;

  constructor(mode: Mode, write: (text: string) => void, options: Options) {
    this.mode = mode;
    this.write = write;
    this.options = options;
    this.now = options.now ?? (() => performance.now());
    this.wall = options.wall ?? (() => new Date());
    this.view = { run: startRun([], 0), records: new Map(), times: new Map(), began: this.now() };
  }

  /** Starts drawing: hides the cursor, which `finish`, `interrupt` and the end of the process all put back. */
  start(): void {
    if (this.mode !== "live") return;
    process.once("exit", this.restore);
    this.write(HIDE);
    this.redraw();
    const every = this.options.interval ?? 100;
    if (every <= 0) return;
    this.timer = setInterval(() => this.redraw(), every);
    this.timer.unref();
  }

  /** What an event changes: the block, and a line when it is a host's text or (in plain mode) a host starting. */
  event(event: FleetEvent): void {
    if (this.over) return;
    const at = this.now();
    this.view.run = reduce(this.view.run, event);
    if (event.event === "host") {
      if (event.state === "start") this.view.times.set(event.host, { from: at, to: null });
      else if (event.state === "done") {
        const t = this.view.times.get(event.host);
        if (t !== undefined) t.to = at;
      }
      if (event.state === "start" && this.mode === "plain") this.line(`${event.host}: started`);
    } else if (event.event === "message") {
      this.line(event.host ? `${event.host}: ${said(event.text)}` : event.text);
    }
    if (this.mode === "live" && event.event !== "message") this.redraw();
  }

  /** A host's record, once its apply is over: the result line of plain mode, and the changes by kind in the block. */
  record(record: HostRecord, seconds: number | undefined): void {
    if (this.over) return;
    this.view.records.set(record.host, record);
    if (seconds !== undefined) this.seconds.set(record.host, seconds);
    if (this.mode === "plain") for (const text of hostLines(record, seconds, this.options.color)) this.line(text, text.startsWith(" "));
    else this.redraw();
  }

  /** The push is over: the block goes, and the summary takes its place. A push that never reached apply has nothing to summarize. */
  finish(): void {
    this.end("finish");
  }

  /** Ctrl-C or a terminate: stop drawing, put the cursor back and say how far it got. */
  interrupt(): void {
    this.end("interrupt");
  }

  /** The push failed with an error that is reported on its own: only put the terminal back. */
  abort(): void {
    this.end("abort");
  }

  private end(how: "finish" | "interrupt" | "abort"): void {
    const interrupted = how === "interrupt";
    if (this.over) return;
    this.over = true;
    if (this.timer !== null) clearInterval(this.timer);
    process.off("exit", this.restore);
    this.clear();
    const { run } = this.view;
    if ((how === "interrupt" || (how === "finish" && this.mode === "live")) && run.phases.apply !== "waiting" && run.lanes.length > 0) {
      const outcomes = run.lanes.map((l): Outcome => {
        const record = this.view.records.get(l.host) ?? null;
        const time = this.view.times.get(l.host);
        if (record !== null) return { host: l.host, record, ...(this.seconds.has(l.host) ? { seconds: this.seconds.get(l.host)! } : {}), state: "done" };
        if (l.state === "running" && interrupted) return { host: l.host, record: null, ...(time === undefined ? {} : { seconds: (this.now() - time.from) / 1000 }), state: "interrupted" };
        return { host: l.host, record: null, state: "not reached" };
      });
      this.write(`${summary(outcomes, (this.now() - this.view.began) / 1000, this.options.color, interrupted).join("\n")}\n`);
      this.summarized = true;
    }
    if (this.mode === "live") this.write(SHOW);
  }

  private readonly restore = (): void => {
    this.write(SHOW);
  };

  /** One line of history: above the block in live mode (the block is drawn again under it), stamped with the time in plain mode. */
  private line(text: string, bare = false): void {
    if (this.mode === "plain") this.write(`${bare ? "" : `${clock(this.wall())} `}${text}\n`);
    else this.write(`${this.erase()}${text}\n${this.paint()}`);
  }

  private erase(): string {
    const up = this.height === 0 ? "" : `\u001b[${this.height}F`;
    return `${up}\u001b[J`;
  }

  private paint(): string {
    const lines = liveBlock(this.view, this.options.width(), this.now(), this.options.color);
    this.height = lines.length;
    return lines.map((l) => `${l}\n`).join("");
  }

  /** Draws the block again, for the spinner and the clocks. The timer does this; a test with its own clock calls it. */
  redraw(): void {
    if (this.over || this.mode !== "live") return;
    this.write(`${this.erase()}${this.paint()}`);
  }

  private clear(): void {
    if (this.mode !== "live") return;
    this.write(this.erase());
    this.height = 0;
  }
}

/** The progress of a push on this process's stderr, or none when the events themselves are on stderr: a reader of those wants nothing else there. */
export function progressFor(env: Env, stream: { isTTY?: boolean; columns?: number; write: (text: string) => unknown }): Progress | null {
  if (eventsOn(env)) return null;
  const tty = stream.isTTY === true;
  const mode = chooseMode(env, tty, stream.columns ?? 0);
  return new Progress(mode, (text) => void stream.write(text), { width: () => stream.columns ?? 80, color: useColor(env, tty) });
}
