import { BOLD } from "../buffer.ts";
import type { Canvas, Style } from "../buffer.ts";
import type { State } from "../app.ts";
import { spinner, theme } from "../theme.ts";
import { truncate, wrap } from "../width.ts";
import type { Replay } from "../../journal.ts";
import { looksSecret, STEP_WORDS } from "../../pushrun.ts";
import type { Change, Lane, Phase, PushRun } from "../../pushrun.ts";
import { pad, plural, s, segments } from "./ui.ts";
import type { Seg } from "./ui.ts";

/** The word a person types to confirm. */
export const CONFIRM_WORD = "push";

const STAGE_WORDS: Record<string, string> = { sync: "syncing repos", plan: "planning", write: "writing" };

/** The widths at which the screen gives something up: below `FEED_WIDTH` the host pane goes, below `LANES_WIDTH` the feed too. */
export const FEED_WIDTH = 80;
export const PANE_WIDTH = 100;
/** The room a lane's own time takes at the end of its line. */
const TIME_W = 7;

/** A span of time as `3.2s`, or `1m04s` from a minute on. */
export function clock(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
}

/** The longest commit message the box takes. */
export const MESSAGE_MAX = 200;

type Review = Extract<State["push"], { phase: "review" }>;

/** Why a push cannot start from this review, or null when typing the word would start it. */
export type Block = { kind: "preview" | "secrets" | "message"; text: string; files: string[] };

/**
 * Pressing enter on the word does nothing while this is not null. A file that looks like a plaintext secret blocks it
 * (`fleet push` itself does not look: this is the bridge's own care), and so does a commit message that is only the
 * confirmation word, which is far more likely a slip than a message.
 */
export function pushBlock(p: Review): Block | null {
  if (p.preview === null || !p.preview.ok) return { kind: "preview", text: "the preview has not been read", files: [] };
  const files = [...new Set(p.preview.preview.repos.flatMap((r) => r.flagged))];
  if (files.length > 0) return { kind: "secrets", text: `${plural(files.length, "file")} look${files.length === 1 ? "s" : ""} like a plaintext secret`, files };
  if (p.message.trim().toLowerCase() === CONFIRM_WORD) return { kind: "message", text: `the commit message is only '${CONFIRM_WORD}', which is the word that confirms; change it or clear it`, files: [] };
  return null;
}

function drawReview(c: Canvas, state: State): void {
  const p = state.push;
  if (p.phase !== "review") return;
  c.text(2, 0, "Review before you push", s.bold);
  wrap("fleet push commits everything listed here (git add -A), pushes it to GitHub, then applies on every host.", c.w - 4).slice(0, 2).forEach((t, i) => c.text(2, 1 + i, t, s.muted));
  if (state.demo) c.text(2, 3, "Demo: fake hosts, nothing real is touched.", s.warn);
  const prompt = (typed: string, block: ReturnType<typeof pushBlock>) => {
    const y = c.h - 2;
    const focused = p.focus === "confirm";
    segments(c, 2, y, [[`Type ${CONFIRM_WORD} and press enter to go: `, block === null ? s.text : s.muted], [typed, s.brandBold], [focused ? "▏" : "", s.brand]]);
    if (block !== null && block.kind !== "preview") c.text(2, y + 1, truncate(`Blocked: ${block.text}.${block.kind === "secrets" ? ` ${block.files.slice(0, 3).join(", ")}${block.files.length > 3 ? ", ..." : ""}. Remove or gitignore ${block.files.length === 1 ? "it" : "them"}, then ctrl-r reads again.` : ""}`, c.w - 4), s.bad);
    else if (typed !== "" && typed !== CONFIRM_WORD) c.text(2, y + 1, `that is not '${CONFIRM_WORD}'`, s.warn);
  };
  const messageLine = () => {
    const y = c.h - 3;
    const focused = p.focus === "message";
    const empty = p.message === "";
    const tail: Seg[] = empty
      ? [[focused ? "▏" : "", s.brand], [focused ? " empty: fleet writes one" : "none: fleet writes one, such as 'fleet push from <host>: 3 files'", s.faint]]
      : [[truncate(p.message, c.w - 22), s.brandBold], [focused ? "▏" : "", s.brand]];
    segments(c, 2, y, [["Commit message: ", focused ? s.text : s.muted], ...tail], c.w - 4);
  };
  if (p.preview === null) {
    segments(c, 2, 4, [[`${spinner(state.now, state.motion)} `, s.brand], ["reading the config repo and planning this host", s.sub]]);
    return;
  }
  if (!p.preview.ok) {
    c.text(2, 4, "The preview could not be read, so nothing can be pushed from here", s.warn);
    wrap(p.preview.detail, c.w - 4).slice(0, 4).forEach((t, i) => c.text(2, 5 + i, t, s.muted));
    c.text(2, c.h - 2, "esc goes back. Run fleet push yourself, or fix the cause and press P again.", s.muted, c.w - 4);
    return;
  }
  const { repos, plan } = p.preview.preview;
  const order = state.model.hosts.map((h) => `${h.name} (${h.self ? "here" : h.ssh === null ? "timer" : "ssh"})`).join(" then ");
  const budget = Math.max(2, c.h - 13);
  let y = 4;
  c.text(2, y++, "TO COMMIT AND PUBLISH", { fg: theme.muted, attr: BOLD });
  const fileBudget = Math.max(1, Math.floor(budget * 0.55));
  let left = fileBudget;
  for (const repo of repos) {
    // The files that block a push are listed first, so a long list never hides them.
    const files = [...repo.files].sort((a, b) => Number(looksSecret(b.path) && !b.status.includes("D")) - Number(looksSecret(a.path) && !a.status.includes("D")));
    const where = repo.branch === null ? "not on a branch" : `${repo.branch}, ${repo.ahead ?? "?"} ahead, ${repo.behind ?? "?"} behind`;
    segments(c, 2, y++, [[repo.shown, s.sub], [`  ${repo.files.length === 0 ? "clean" : plural(repo.files.length, "changed file")}  (${where})`, repo.files.length === 0 ? s.muted : s.text]], c.w - 4);
    const shown = files.slice(0, left);
    left -= shown.length;
    for (const f of shown) {
      const secret = looksSecret(f.path) && !f.status.includes("D");
      segments(c, 4, y++, [[pad(f.status, 3), s.warn], [truncate(f.path, c.w - 12), secret ? s.bad : s.text], ...(secret ? ([["  looks like a secret", s.bad]] as Seg[]) : [])], c.w - 6);
    }
    if (repo.files.length > shown.length) c.text(4, y++, `and ${repo.files.length - shown.length} more (git status in that repo lists them)`, s.faint);
  }
  y++;
  c.text(2, y++, "PLAN FOR THIS HOST (fleet diff)", { fg: theme.muted, attr: BOLD });
  const room = Math.max(1, c.h - 5 - y);
  for (const line of plan.slice(0, room)) c.text(4, y++, truncate(line, c.w - 6), /^conflict|^fix/.test(line) ? s.warn : s.sub);
  if (plan.length > room) c.text(4, y++, `and ${plan.length - room} more lines`, s.faint);
  c.text(2, c.h - 4, truncate(`Then in order: ${order}`, c.w - 4), s.muted);
  messageLine();
  prompt(p.typed, pushBlock(p));
}

const phaseGlyph = (phase: Phase, state: State): Seg => (phase === "done" ? ["✓", s.ok] : phase === "failed" ? ["✕", s.bad] : phase === "running" ? [spinner(state.now, state.motion), s.brand] : ["·", s.faint]);

function drawPipeline(c: Canvas, run: PushRun, state: State, y: number): void {
  const parts: Seg[] = [];
  const add = (label: string, phase: Phase, extra = "") => {
    const [glyph, style] = phaseGlyph(phase, state);
    parts.push([glyph, style], [` ${label}`, phase === "waiting" ? s.faint : s.text], ...(extra === "" ? [] : ([[` ${extra}`, s.muted]] as Seg[])), ["   ", s.faint]);
  };
  add("validate", run.phases.validate);
  add("publish", run.phases.publish, run.publish.of > 0 && run.phases.publish !== "waiting" ? `${run.publish.n}/${run.publish.of}` : "");
  const done = run.lanes.filter((l) => l.state === "done").length;
  add("apply", run.phases.apply, run.phases.apply === "waiting" ? "" : `${done}/${run.lanes.length} hosts`);
  const elapsed = clock((run.endedAt ?? state.now) - run.startedAt);
  c.textRight(c.w - 2, y, elapsed, run.endedAt === null ? s.sub : s.muted);
  segments(c, 2, y, parts, c.w - 5 - elapsed.length);
}

/** How long a lane has been at it, or took: nothing before it starts, and nothing for a host that is not applied. */
const laneTime = (l: Lane, now: number): string | null => (l.from === null || l.result === "timer" ? null : clock((l.to ?? now) - l.from));

function laneMark(l: Lane, state: State): Seg {
  if (l.state === "running") return [spinner(state.now, state.motion), s.brand];
  if (l.state === "waiting") return ["·", s.faint];
  if (l.state === "skipped") return ["–", s.faint];
  if (l.result === "ok") return ["✓", s.ok];
  if (l.result === "timer") return ["◌", s.muted];
  if (l.result === "conflict") return ["✕", s.warn];
  return ["✕", s.bad];
}

/** What a lane says, as segments, within `width` cells. */
function laneText(l: Lane, width: number, run: PushRun, stopped: string | null): Seg[] {
  if (l.state === "waiting") return [[l.via === "timer" ? "no ssh destination: it applies on its own schedule" : "waiting its turn", s.muted]];
  if (l.state === "skipped") return [[stopped ?? "not reached", s.faint]];
  if (l.state === "done") {
    const changes = l.changes > 0 ? ` (${plural(l.changes, "change")})` : "";
    if (l.result === "timer") return [["timer: not asked; it catches up on its own schedule", s.muted]];
    if (l.result === "ok") return [["ok", s.ok], [changes, s.muted]];
    return [[l.result ?? "no result", l.result === "conflict" ? s.warn : s.bad], [l.result === "conflict" ? " nothing written on this host" : l.note ? `  ${l.note}` : "", s.muted]];
  }
  if (l.step === null) {
    const what = laneStage(l);
    const count = l.stage === "write" && l.of !== null ? ` 0/${l.of}` : "";
    return [[what + count, s.sub]];
  }
  const { n, of, name, target } = l.step;
  const bar = Math.max(4, Math.min(12, Math.floor(width / 4)));
  const filled = of === 0 ? bar : Math.round((n / of) * bar);
  return [["█".repeat(filled), s.brand], ["░".repeat(bar - filled), s.faint], [` ${n}/${of} `, s.text], [`${STEP_WORDS[name] ?? name} `, s.muted], [target, s.sub]].filter((_, i) => i < 5) as Seg[];
}

const TRUNK: Record<string, string> = { "1111": "╋", "1101": "┣", "0101": "┏", "1001": "┗", "1011": "┻", "0111": "┳", "0011": "━" };

/** A moving dot along `len` cells, from `x`. */
function packet(c: Canvas, x: number, y: number, len: number, state: State, lit: number, line: number): void {
  c.fill(x, y, len, 1, { fg: lit }, "━");
  if (state.motion) c.cell(x + (Math.floor(state.now / 90 + line * 3) % len), y, "●", { fg: theme.brandBright, attr: BOLD });
}

function drawLanes(c: Canvas, run: PushRun, state: State, top: number, selected: number): number {
  const lanes = run.lanes;
  const stopped = run.lanes[0]?.result === "conflict" ? `not reached: ${run.lanes[0].host} has a conflict, so the rest wait` : run.phases.publish === "failed" || run.phases.validate === "failed" ? "not reached: the push stopped before the apply" : run.end !== null ? "not reached" : null;
  const nameW = Math.min(14, Math.max(...lanes.map((l) => l.host.length)));
  const diagram = c.w >= 76 && lanes.length > 0;
  const bx = 24;
  const textX = diagram ? bx + 11 : 2;
  const trunkRow = Math.floor(lanes.length / 2);
  const publishing = run.phases.publish === "running";
  const published = run.phases.publish === "done";

  if (diagram) {
    const ty = top + trunkRow;
    segments(c, 2, ty, [["config", s.bold]]);
    const l1 = published ? theme.ok : publishing ? theme.brand : theme.faint;
    if (publishing) packet(c, 9, ty, 5, state, l1, 0);
    else c.fill(9, ty, 5, 1, { fg: l1 }, published ? "━" : "╌");
    c.cell(14, ty, published || publishing ? "▶" : "▷", { fg: l1 });
    segments(c, 16, ty, [["GitHub", s.bold]]);
    c.fill(23, ty, bx - 23, 1, { fg: published ? theme.ok : theme.faint }, published ? "━" : "╌");
  }
  lanes.forEach((l, i) => {
    const y = top + i;
    if (diagram) {
      const lit = l.state === "done" ? (l.result === "ok" ? theme.ok : l.result === "timer" ? theme.muted : l.result === "conflict" ? theme.warn : theme.bad) : l.state === "running" ? theme.brand : theme.faint;
      const key = `${i > 0 ? 1 : 0}${i < lanes.length - 1 ? 1 : 0}${i === trunkRow ? 1 : 0}1`;
      c.cell(bx, y, TRUNK[key] ?? "┣", { fg: published || publishing ? theme.ok : theme.faint });
      if (l.state === "running") packet(c, bx + 1, y, 7, state, lit, i + 1);
      else c.fill(bx + 1, y, 7, 1, { fg: lit }, l.state === "done" ? (l.result === "timer" ? "┄" : "━") : "╌");
      c.cell(bx + 8, y, l.state === "done" && l.result !== "ok" && l.result !== "timer" ? "✕" : "▶", { fg: lit });
    }
    const [glyph, gs] = laneMark(l, state);
    const head: Seg[] = [[glyph, gs], [" ", s.text], [pad(l.host, nameW), l.state === "waiting" || l.state === "skipped" ? s.muted : s.bold], ["  ", s.text]];
    const x = segments(c, textX, y, head);
    const time = laneTime(l, state.now);
    const room = c.w - x - 2 - (time === null ? 0 : TIME_W);
    segments(c, x, y, laneText(l, room, run, stopped), room);
    if (time !== null) c.textRight(c.w - 2, y, time, l.state === "running" ? s.sub : s.muted);
    if (i === selected && run.lanes.length > 1) c.text(0, y, "›", s.brandBold);
  });
  return top + lanes.length;
}

export type Over = Extract<State["push"], { phase: "running" | "finished" }>;

/** The lane the host pane shows and `r` and `f` act on: the one picked with the arrows, or until one is, the host being applied now (else the last one done). */
export function pickedLane(p: Over): number {
  const { lanes } = p.run;
  if (p.selected !== null) return Math.max(0, Math.min(p.selected, lanes.length - 1));
  const running = lanes.findIndex((l) => l.state === "running");
  if (running >= 0) return running;
  // Between hosts, or once it is over: the one that finished last.
  return Math.max(0, lanes.findLastIndex((l) => l.state === "done"));
}

/** The activity feed: every event as it arrived, newest last, with its time since the push began and its host. */
function drawFeed(c: Canvas, run: PushRun, x: number, y: number, w: number, h: number): void {
  if (h < 2 || w < 20) return;
  c.text(x, y, "ACTIVITY", { fg: theme.muted, attr: BOLD });
  const nameW = Math.min(12, Math.max(4, ...run.lanes.map((l) => l.host.length)));
  const lines = run.feed.slice(-(h - 1));
  lines.forEach((line, i) => {
    const at = pad(clock(line.at - run.startedAt), 7);
    const head: Seg[] = [[at, s.faint], [pad(line.host ?? "push", nameW), line.host === null ? s.muted : s.sub], [" ", s.text]];
    const after = segments(c, x, y + 1 + i, head, w);
    c.text(after, y + 1 + i, truncate(line.text, w - (after - x)), s.text, w - (after - x));
  });
  if (lines.length === 0) c.text(x, y + 1, "nothing yet", s.faint);
}

const mark = (kind: "+" | "~" | "-"): Seg => [`${kind} `, kind === "+" ? s.ok : kind === "-" ? s.warn : s.info];

/** What the selected host got, or is getting: its writes so far and how many remain, and after the push its receipt. */
function drawHostPane(c: Canvas, run: PushRun, lane: Lane, x: number, y: number, w: number, h: number): void {
  if (h < 2 || w < 16) return;
  c.text(x, y, lane.host.toUpperCase(), { fg: theme.muted, attr: BOLD });
  const line = (i: number, segs: Seg[]) => void (i < h && segments(c, x, y + i, segs, w));
  let row = 1;
  const doc = run.end?.hosts.find((r) => r.host === lane.host);
  if (run.end !== null && doc?.receipt !== undefined && lane.state === "done" && (doc.receipt.created.length + doc.receipt.updated.length + doc.receipt.removed.length > 0)) {
    const { created, updated, removed } = doc.receipt;
    line(row++, [[`${created.length} created, ${updated.length} updated, ${removed.length} removed`, s.text]]);
    const all: [Change, "+" | "~" | "-"][] = [...created.map((e): [Change, "+"] => [e, "+"]), ...updated.map((e): [Change, "~"] => [e, "~"]), ...removed.map((e): [Change, "-"] => [e, "-"])];
    const room = h - row;
    const shown = all.length > room ? all.slice(0, Math.max(0, room - 1)) : all;
    for (const [e, kind] of shown) line(row++, [mark(kind), [truncate(e.label, w - 2), s.sub]]);
    if (shown.length < all.length) line(row++, [[`and ${all.length - shown.length} more`, s.faint]]);
    return;
  }
  const writes = lane.steps;
  if (lane.state === "waiting") return line(row, [[lane.via === "timer" ? "no ssh destination: it applies on its own schedule" : "not started yet", s.muted]]);
  if (lane.state === "skipped") return line(row, [["not reached", s.faint]]);
  if (run.end !== null && lane.state === "done") {
    const why = lane.result === "ok" ? (lane.changes > 0 ? `${plural(lane.changes, "change")}; the host sent no list` : "already matched: nothing written") : lane.result === "timer" ? "not asked; it catches up on its own schedule" : lane.result === "conflict" ? "conflict: nothing written" : `${lane.result ?? "no result"}: no receipt`;
    return line(row, [[truncate(why, w), lane.result === "ok" || lane.result === "timer" ? s.muted : s.warn]]);
  }
  const done = lane.step?.n ?? 0;
  line(row++, [[lane.of === null ? (lane.state === "done" ? `${writes.length} writes` : "steps to come: not known yet") : `${done} of ${lane.of} writes done, ${Math.max(0, lane.of - done)} to go`, s.text]]);
  const room = h - row;
  const shown = writes.slice(-Math.max(0, room));
  for (const st of shown) line(row++, [mark("+"), [truncate(`${STEP_WORDS[st.name] ?? st.name} ${st.target}`, w - 2), s.sub]]);
  if (writes.length === 0 && lane.state === "running") line(row, [[truncate(laneStage(lane), w), s.muted]]);
}

const laneStage = (l: Lane): string => (l.stage === null ? (l.via === "ssh" ? "connecting over ssh" : "starting") : (STAGE_WORDS[l.stage] ?? l.stage));

/** What the history's push replay looks like to the screen of a live push: running until its end has come. */
export function replayOver(replay: Replay, lane: number | null): Over {
  const { time, only } = replay.stored.header;
  const when = new Date(time);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const at = `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())} ${pad2(when.getHours())}:${pad2(when.getMinutes())}`;
  return { phase: replay.over ? "finished" : "running", run: replay.run, selected: lane, notice: `Replay of the push of ${at}${only === null ? "" : ` to ${only}`}. esc goes back.` };
}

/** How the push that just ended compares with the last one of its scope. */
export function versusText(delta: number): string {
  return Math.abs(delta) < 50 ? "as fast as the last push" : `${clock(Math.abs(delta))} ${delta > 0 ? "faster" : "slower"} than the last push`;
}

function drawRun(c: Canvas, state: State, p: Over, versus: number | null = null): void {
  const run = p.run;
  const running = p.phase === "running";
  drawPipeline(c, run, state, 0);
  const selected = pickedLane(p);
  const bottom = drawLanes(c, run, state, 2, selected);
  let y = bottom + 1;
  const first = run.lanes[0];
  const timers = run.lanes.filter((l) => l.via === "timer").map((l) => l.host);
  if (running) {
    if (first && run.lanes.length > 1) c.text(2, y++, truncate(`Hosts run one after another, in name order. A conflict on ${first.host} stops the rest.`, c.w - 4), s.muted);
    if (timers.length > 0) c.text(2, y++, truncate(`${timers.join(", ")} ${timers.length === 1 ? "has" : "have"} no ssh destination: fleet does not reach ${timers.length === 1 ? "it" : "them"}; ${timers.length === 1 ? "it catches" : "they catch"} up on ${timers.length === 1 ? "its" : "their"} own schedule.`, c.w - 4), s.muted);
  } else if (run.end !== null) {
    const end = run.end;
    const good = end.code === "ok";
    segments(c, 2, y++, [[good ? "✓ " : "✕ ", good ? s.ok : s.bad], [good ? "Push finished" : `Push ended: ${end.code ?? "no result document"}`, s.bold], [`  exit ${end.exit ?? "none"}`, s.muted]]);
    for (const l of run.lanes) {
      for (const k of end.conflicts[l.host] ?? []) {
        if (y >= c.h - 2) break;
        c.text(2, y++, truncate(`${l.host}: ${k.path}: ${k.detail}`, c.w - 4), s.warn);
        wrap(`fix: ${k.fix}`, c.w - 6).slice(0, 2).forEach((t) => c.text(4, y++, t, s.sub));
      }
    }
    for (const k of end.conflicts[""] ?? []) {
      c.text(2, y++, truncate(`${k.path}: ${k.detail}`, c.w - 4), s.warn);
      wrap(`fix: ${k.fix}`, c.w - 6).slice(0, 2).forEach((t) => c.text(4, y++, t, s.sub));
    }
    for (const m of end.messages) if (y < c.h - 1) c.text(2, y++, truncate(m, c.w - 4), s.muted);
    if (versus !== null && y < c.h - 1) c.text(2, y++, truncate(versusText(versus), c.w - 4), versus > 0 ? s.ok : s.muted);
  }
  if (p.notice !== null) c.text(2, y++, truncate(p.notice, c.w - 4), s.warn);
  // By width: everything from PANE_WIDTH, no host pane below it, and no feed below FEED_WIDTH.
  const top = y + 1;
  const room = c.h - top - 1;
  if (c.w < FEED_WIDTH || room < 3) return;
  const lane = run.lanes[selected];
  if (c.w < PANE_WIDTH || lane === undefined) return drawFeed(c, run, 2, top, c.w - 4, room);
  const paneW = Math.min(46, Math.floor((c.w - 4) * 0.42));
  const feedW = c.w - 4 - paneW - 3;
  drawFeed(c, run, 2, top, feedW, room);
  for (let i = 0; i < room; i++) c.cell(2 + feedW + 1, top + i, "│", s.faint);
  drawHostPane(c, run, lane, c.w - 2 - paneW, top, paneW, room);
}

export function drawPush(c: Canvas, state: State): void {
  const j = state.journal;
  if (j.phase === "replay") {
    if (j.replay === null) return void segments(c, 2, 1, [[`${spinner(state.now, state.motion)} `, s.brand], ["reading the journal", s.sub]]);
    return drawRun(c, state, replayOver(j.replay, j.lane));
  }
  const p = state.push;
  if (p.phase === "idle") {
    c.text(2, 1, "No push yet", s.bold);
    const lines = wrap("Press P to see what would be pushed. Nothing happens until you type push and press enter. The push itself is the real fleet push, run for you, with its progress shown here.", c.w - 4);
    lines.forEach((t, i) => c.text(2, 3 + i, t, s.muted));
    c.text(2, 4 + lines.length, truncate("Press h for the pushes this host recorded: enter replays one.", c.w - 4), s.muted);
    return;
  }
  if (p.phase === "review") return drawReview(c, state);
  drawRun(c, state, p, state.versus);
}
