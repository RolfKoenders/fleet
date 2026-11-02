import { BOLD } from "../buffer.ts";
import type { Canvas, Style } from "../buffer.ts";
import type { State } from "../app.ts";
import { spinner, theme } from "../theme.ts";
import { truncate, wrap } from "../width.ts";
import { looksSecret } from "../pushrun.ts";
import type { Lane, Phase, PushRun } from "../pushrun.ts";
import { pad, plural, s, segments } from "./ui.ts";
import type { Seg } from "./ui.ts";

/** The word a person types to confirm. */
export const CONFIRM_WORD = "push";

const STAGE_WORDS: Record<string, string> = { sync: "syncing repos", plan: "planning", write: "writing" };
const STEP_WORDS: Record<string, string> = { "write-link": "link", "remove-link": "unlink", "write-keys": "keys", "add-server": "add server", "remove-server": "remove server" };

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
  segments(c, 2, y, parts, c.w - 4);
}

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
    const what = l.stage === null ? (l.via === "ssh" ? "connecting over ssh" : "starting") : (STAGE_WORDS[l.stage] ?? l.stage);
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

function drawLanes(c: Canvas, run: PushRun, state: State, top: number): number {
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
    segments(c, x, y, laneText(l, c.w - x - 2, run, stopped), c.w - x - 2);
  });
  return top + lanes.length;
}

function drawRun(c: Canvas, state: State, run: PushRun, running: boolean): void {
  drawPipeline(c, run, state, 0);
  const bottom = drawLanes(c, run, state, 2);
  let y = bottom + 1;
  const first = run.lanes[0];
  const timers = run.lanes.filter((l) => l.via === "timer").map((l) => l.host);
  if (running) {
    if (first) c.text(2, y++, truncate(`Hosts run one after another, in name order. A conflict on ${first.host} stops the rest.`, c.w - 4), s.muted);
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
  }
  const room = c.h - y - 1;
  const lines = run.log.filter((l) => l !== "").slice(-Math.max(0, room));
  if (lines.length > 0 && room > 1) {
    y++;
    c.text(2, y++, "MESSAGES", { fg: theme.muted, attr: BOLD });
    for (const line of lines.slice(-(c.h - y))) c.text(4, y++, truncate(line, c.w - 6), s.sub);
  }
}

export function drawPush(c: Canvas, state: State): void {
  const p = state.push;
  if (p.phase === "idle") {
    c.text(2, 1, "No push yet", s.bold);
    wrap("Press P to see what would be pushed. Nothing happens until you type push and press enter. The push itself is the real fleet push, run for you, with its progress shown here.", c.w - 4).forEach((t, i) => c.text(2, 3 + i, t, s.muted));
    return;
  }
  if (p.phase === "review") return drawReview(c, state);
  drawRun(c, state, p.run, p.phase === "running");
}
