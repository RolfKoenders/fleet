import { BOLD, DIM, drawBox } from "../buffer.ts";
import type { BorderKind, Canvas, Style } from "../buffer.ts";
import { mix } from "../color.ts";
import type { ContextLive, HostLive, State } from "../app.ts";
import { CARD_H, firstVisible, homeLayout } from "../layout.ts";
import { totalLine } from "../contextshown.ts";
import { counts } from "../model.ts";
import type { HostInfo } from "../model.ts";
import { spinner, theme } from "../theme.ts";
import { stringWidth, truncate, wrap } from "../width.ts";
import { pad, plural, s, segments, segWidth, span } from "./ui.ts";
import type { Seg } from "./ui.ts";

type Health = "ok" | "warn" | "bad" | "unknown";

const color = (h: Health): number => (h === "ok" ? theme.ok : h === "warn" ? theme.warn : h === "bad" ? theme.bad : theme.muted);

function health(live: HostLive | undefined): Health {
  const r = live?.result;
  // What an earlier run saw says nothing about now.
  if (!r || live?.seen) return "unknown";
  if (r.result === "unreachable" || r.result === "error") return "bad";
  if (r.result === "timer" || !r.status) return "unknown";
  if (r.status.conflicts) return "bad";
  if (r.status.pending || !r.status.repos.fleet.clean) return "warn";
  return "ok";
}

const num = (n: number | null, bad: Style): Seg => (n === null ? ["?", s.muted] : n === 0 ? ["0", s.ok] : [String(n), bad]);

/** "seen 2h ago" for a host only an earlier run has seen, else null. */
export function seenAgo(live: Pick<HostLive, "seen"> | undefined, now: number): string | null {
  return live?.seen ? `seen ${span(live.seen.agoSeconds + Math.max(0, (now - live.seen.since) / 1000))} ago` : null;
}

/** How long ago the host last changed something, counting from when it answered. */
function lastChange(live: HostLive, now: number): string {
  const a = live.result?.status?.applied;
  if (!a || a.at === null || a.ageSeconds === null) return "never";
  const from = live.seen ? live.seen.since : live.at;
  const since = from === null ? 0 : Math.max(0, (now - from) / 1000);
  return `${span(a.ageSeconds + since)} ago`;
}

function shimmer(c: Canvas, x: number, y: number, width: number, now: number, motion: boolean, line: number): void {
  const head = motion ? ((now / 35 + line * 7) % (width + 14)) - 7 : -99;
  for (let i = 0; i < width; i++) {
    const glow = Math.max(0, 1 - Math.abs(i - head) / 6);
    c.cell(x + i, y, "░", { fg: mix(theme.faint, theme.sub, glow * 0.8) });
  }
}

const SKELETON = [22, 14, 18, 26, 20];

/**
 * `context ~18.6k`, with a `+` when a server is not measured, or nothing for a host with no startup context to show
 * (one on an older pin, or not asked yet). A remembered one is muted and marked, since the card may be live around it.
 */
function contextSegs(live: ContextLive | undefined): Seg[] {
  const total = totalLine(live?.report ?? null);
  if (total === null) return [];
  return live?.seen ? [["context ", s.faint], [`${total} ◌`, s.muted]] : [["context ", s.muted], [total, total.endsWith("+") ? s.warn : s.sub]];
}

/** Draws `left`, and `right` against the other edge when both fit. */
function sides(line: (n: number, segs: Seg[]) => void, n: number, iw: number, left: Seg[], right: Seg[]): void {
  const fits = right.length > 0 && segWidth(left) + 2 + segWidth(right) <= iw;
  line(n, fits ? [...left, [" ".repeat(iw - segWidth(left) - segWidth(right)), s.faint], ...right] : left);
}

function drawCard(c: Canvas, x: number, y: number, w: number, host: HostInfo, live: HostLive | undefined, selected: boolean, state: State): void {
  const { now, motion, model } = state;
  const h = health(live);
  const result = live?.result ?? null;
  const loading = live?.phase === "loading";
  const status = result?.status ?? null;
  const stale = live?.seen != null;
  const unknown = (result !== null && result.result !== "ok") || stale;
  const kind: BorderKind = selected ? "heavy" : unknown ? "dashed" : "round";
  const base = selected ? theme.brandBright : loading && result === null ? theme.faint : h === "bad" ? mix(theme.bad, theme.faint, 0.45) : h === "warn" ? mix(theme.warn, theme.faint, 0.5) : theme.faint;
  const bg = selected ? theme.selected : theme.surface;
  c.fill(x, y, w, CARD_H, { bg });
  // While loading, a bright spot runs along the top edge.
  const sweep = loading && motion ? (i: number) => mix(base, theme.brandBright, Math.max(0, 1 - Math.abs(i - ((now / 28) % (w + 16)) + 8) / 5)) : undefined;
  drawBox(c, x, y, w, CARD_H, kind, { fg: base, bg }, sweep);

  const dot = loading && result === null ? spinner(now, motion) : stale ? "◌" : unknown ? (result?.result === "timer" ? "◌" : "✕") : status?.applied.at === null ? "○" : "●";
  const nameStyle: Style = { fg: theme.text, attr: BOLD, bg };
  const title: Seg[] = [[` ${dot} `, { fg: color(h === "unknown" && loading && !stale ? "ok" : h), bg }], [`${host.name} `, nameStyle]];
  segments(c, x + 1, y, title);
  const tag = host.self ? " this host " : host.ssh !== null ? ` ${host.ssh} ` : " timer ";
  if (stringWidth(tag) + 4 + stringWidth(host.name) < w - 6) c.text(x + w - 2 - stringWidth(tag), y, tag, { fg: host.self ? theme.brand : theme.muted, bg });
  if (loading && result !== null) c.text(x + w - 4, y + CARD_H - 1, spinner(now, motion), { fg: theme.brand, bg });
  // Old news is labelled on the card's edge, where it cannot be taken for a reading.
  const ago = seenAgo(live, now);
  if (ago !== null) c.text(x + 2, y + CARD_H - 1, ` ${ago}, not live `, { fg: theme.warn, bg });

  const ix = x + 2;
  const iw = w - 4;
  const bgd = (st: Style): Style => ({ ...st, bg });
  const line = (n: number, segs: Seg[]) => segments(c, ix, y + 1 + n, segs.map(([t, st]): Seg => [t, bgd(st)]), iw);
  const cfg = counts(model, host.name);
  const config: Seg[] = [["config ", s.faint], [`${plural(cfg.skills, "skill")} · ${plural(cfg.servers, "server")}`, s.muted]];

  if (loading && result === null) {
    line(0, [[host.self ? "reading local state" : "asking over ssh", s.sub]]);
    SKELETON.forEach((n, i) => shimmer(c, ix, y + 2 + i, Math.min(n, iw), now, motion, i));
    line(6, config);
    return;
  }

  const dimmed = loading; // an older answer, being asked again
  if (result?.result === "timer") {
    wrap("No ssh destination, so it applies on its own schedule. Its status is unknown from here.", iw).slice(0, 4).forEach((t, i) => line(i, [[t, s.sub]]));
    line(6, config);
    return;
  }
  if (result && result.result !== "ok") {
    line(0, [[result.result === "unreachable" ? "unreachable over ssh" : "no usable answer", result.result === "unreachable" ? s.bad : s.warn]]);
    wrap(result.detail ?? "", iw).slice(0, 3).forEach((t, i) => line(1 + i, [[t, s.muted]]));
    sides(line, 5, iw, [["status unknown", s.faint]], contextSegs(state.contexts[host.name]));
    line(6, config);
    return;
  }
  if (!status) return;

  const t = status.tools;
  const fleet = status.repos.fleet;
  const sync = [fleet.ahead ? ` ↑${fleet.ahead}` : "", fleet.behind ? ` ↓${fleet.behind}` : ""].join("");
  const timerStyle = status.timer === "active" ? s.ok : status.timer === null ? s.muted : s.warn;
  const gap = iw >= 36 ? "  " : " ";
  const tool = (name: string, v: string | null): Seg[] => [[`${name} `, s.faint], [v ?? "–", v === null ? s.faint : s.sub], [gap, s.faint]];
  line(0, [["last change ", s.muted], [lastChange(live!, now), status.applied.at === null ? s.warn : s.text]]);
  sides(line, 1, iw, [["timer ", s.muted], [status.timer ?? "unknown", timerStyle]], contextSegs(state.contexts[host.name]));
  line(2, [["pending ", s.muted], num(status.pending, s.warn), ["   conflicts ", s.muted], num(status.conflicts, s.bad)]);
  line(3, [["clone ", s.muted], [`${fleet.branch ?? "detached"}@${fleet.sha.slice(0, 7)}`, s.sub], [fleet.clean ? " clean" : " dirty", fleet.clean ? s.ok : s.warn], [sync, s.warn]]);
  line(4, [...tool("claude", t.claude), ...tool("opencode", t.opencode)]);
  line(5, [...tool("sops", t.sops), ...tool("node", t.node), ...tool("t3", t.t3)]);
  line(6, config);
  if (dimmed) c.paint(ix, y + 1, iw, 6, { attr: DIM });
}

function drawRow(c: Canvas, y: number, host: HostInfo, live: HostLive | undefined, selected: boolean, state: State): void {
  const h = health(live);
  const r = live?.result;
  const loading = live?.phase === "loading";
  const bg = selected ? theme.selected : undefined;
  const st = (style: Style): Style => (bg === undefined ? style : { ...style, bg });
  if (selected) c.fill(0, y, c.w, 1, { bg });
  const dot = loading && !r ? spinner(state.now, state.motion) : r?.result === "timer" ? "◌" : r && r.result !== "ok" ? "✕" : "●";
  const detail =
    !r ? "asking" : live?.seen ? `${seenAgo(live, state.now)}, not live: ${lastChange(live, state.now)}  p${r.status?.pending ?? "?"} c${r.status?.conflicts ?? "?"}` : r.result === "timer" ? "timer, unknown" : r.result === "unreachable" ? "unreachable" : r.result === "error" ? "no usable answer" : `${lastChange(live!, state.now)}  p${r.status?.pending ?? "?"} c${r.status?.conflicts ?? "?"}`;
  const total = totalLine(state.contexts[host.name]?.report ?? null);
  const withContext = total === null || !r || r.result !== "ok" ? detail : `${detail}  context ${total}`;
  segments(c, 0, y, [[selected ? "▌" : " ", st(s.brand)], [`${dot} `, st({ fg: color(h) })], [pad(host.name, 12), st(s.bold)], [` ${truncate(withContext, Math.max(0, c.w - 17))}`, st(s.sub)]]);
}

function summary(state: State): Seg[] {
  const hosts = state.model.hosts;
  const lives = hosts.map((h) => state.live[h.name]);
  const n = (f: (l: HostLive | undefined) => boolean) => lives.filter(f).length;
  const loading = n((l) => l?.phase === "loading");
  const down = n((l) => l?.result?.result === "unreachable" || l?.result?.result === "error");
  const timer = n((l) => l?.result?.result === "timer");
  const old = n((l) => l?.seen != null);
  // Only what a host has said this run is counted.
  const pending = lives.reduce((a, l) => a + (l?.seen ? 0 : (l?.result?.status?.pending ?? 0)), 0);
  const conflicts = lives.reduce((a, l) => a + (l?.seen ? 0 : (l?.result?.status?.conflicts ?? 0)), 0);
  const sep: Seg = ["  ·  ", s.faint];
  const segs: Seg[] = [[plural(hosts.length, "host"), s.text]];
  if (loading > 0) segs.push(sep, [`${spinner(state.now, state.motion)} asking ${loading}`, s.brand]);
  if (old > 0) segs.push(sep, [`${old} seen earlier, not live`, s.warn]);
  if (down > 0) segs.push(sep, [`${down} unreachable`, s.bad]);
  if (timer > 0) segs.push(sep, [state.size.cols >= 100 ? `${timer} on timer, status unknown` : `${timer} timer`, s.muted]);
  segs.push(sep, ["pending ", s.muted], [String(pending), pending ? s.warn : s.ok], sep, ["conflicts ", s.muted], [String(conflicts), conflicts ? s.bad : s.ok]);
  return segs;
}

/** What the selected host gets from the config, and the facts the cards leave out. */
function drawDetail(c: Canvas, y: number, h: number, host: HostInfo, state: State): void {
  const { model } = state;
  drawBox(c, 1, y, c.w - 2, h, "round", { fg: theme.border });
  c.text(3, y, ` ${host.name} `, s.bold);
  const names = (rows: { name: string; cells: Record<string, { on: boolean }> }[]) => rows.filter((r) => r.cells[host.name]?.on).map((r) => r.name).join(", ") || "none";
  const fleet = state.live[host.name]?.result?.status?.repos.fleet;
  const at = state.live[host.name]?.result?.status?.applied.at;
  const rows: [string, string][] = [
    ["bundles", names(model.bundles)],
    ["servers", names(model.servers)],
    ["clone", fleet ? `${fleet.sha}${fleet.branch ? ` on ${fleet.branch}` : ""}` : "unknown"],
    ["changed", at ?? "unknown"],
    ...(seenAgo(state.live[host.name], state.now) === null ? [] : ([["seen", `${seenAgo(state.live[host.name], state.now)!.slice(5)}, not live; asking again`]] as [string, string][])),
  ];
  rows.slice(0, h - 2).forEach(([k, v], i) => segments(c, 3, y + 1 + i, [[pad(k, 9), s.muted], [v, s.sub]], c.w - 6));
}

export function drawHome(c: Canvas, state: State): void {
  const layout = homeLayout(state.size);
  const hosts = state.model.hosts;
  if (hosts.length === 0) {
    c.text(2, 2, "No hosts yet.", s.text);
    c.text(2, 3, "A host is a file in hosts/ in the config repo.", s.muted);
    return;
  }
  segments(c, 1, 0, summary(state), c.w - 2);
  const sel = state.home.selected;
  if (layout.mode === "list") {
    const first = firstVisible(sel, layout.visibleRows);
    hosts.slice(first, first + layout.visibleRows).forEach((host, i) => drawRow(c, layout.top + i, host, state.live[host.name], first + i === sel, state));
    return;
  }
  const first = firstVisible(Math.floor(sel / layout.cols), layout.visibleRows);
  hosts.forEach((host, i) => {
    const row = Math.floor(i / layout.cols) - first;
    if (row < 0 || row >= layout.visibleRows) return;
    const x = 1 + (i % layout.cols) * (layout.cardW + 1);
    drawCard(c, x, layout.top + row * CARD_H, layout.cardW, host, state.live[host.name], i === sel, state);
  });
  const rowsTotal = Math.ceil(hosts.length / layout.cols);
  const used = Math.min(layout.visibleRows, rowsTotal - first) * CARD_H;
  const spare = layout.bodyH - layout.top - used;
  if (spare >= 6) drawDetail(c, layout.top + used, Math.min(spare, 7), hosts[sel]!, state);
  if (first + layout.visibleRows < rowsTotal) c.textRight(c.w - 1, c.h - 1, "▼ more", s.muted);
  if (first > 0) c.textRight(c.w - 1, 1, "▲ more", s.muted);
}
