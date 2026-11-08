import { drawBox } from "../buffer.ts";
import type { Canvas, Style } from "../buffer.ts";
import type { ContextItem, ContextKind, ContextReport } from "../../context.ts";
import { cells, distinct, largestAgent, partTexts, PARTS, totalText } from "../../contextview.ts";
import { formatTokens } from "../../tokens.ts";
import type { ContextLive, State } from "../app.ts";
import { spinner, theme } from "../theme.ts";
import { truncate } from "../width.ts";
import { seenAgo } from "./home.ts";
import { pad, plural, s, segments, segWidth } from "./ui.ts";
import type { Seg } from "./ui.ts";

/**
 * The context screen: one stacked bar per host and agent, all on one scale, and under them the largest items of
 * the selected host. The bars use the colours `fleet context` gives its parts, from the bridge palette.
 */

const HOST_W = 12;
const AGENT_W = 9;
const TOTAL_W = 9;
const MAX_BAR = 40;
const MIN_BAR = 10;
/** Rows kept for the selected host's box when there are more hosts than fit. */
const DETAIL_MIN = 8;

const colourOf = (kind: ContextKind): number => PARTS.find((p) => p.kind === kind)!.colour;

/** Why a host has no bar: what it said, or that it has not said yet. */
function noReport(live: ContextLive | undefined, state: State): Seg {
  if (live === undefined || (live.phase === "loading" && live.failure === null)) return [`${spinner(state.now, state.motion)} asking`, s.sub];
  const f = live.failure;
  if (f === null) return ["no answer", s.muted];
  if (f.result === "old") return ["needs a newer pin: its fleet has no context command yet", s.warn];
  if (f.result === "timer") return ["on a timer: no ssh destination, so it is not asked", s.muted];
  if (f.result === "unreachable") return [`unreachable over ssh${f.detail === "" ? "" : `: ${f.detail}`}`, s.bad];
  return [`no usable answer${f.detail === "" ? "" : `: ${f.detail}`}`, s.warn];
}

type Row = { host: number; segs: Seg[] };

function barSegs(report: ContextReport, agentIndex: number, scale: number, width: number, plain: boolean): Seg[] {
  const agent = report.agents[agentIndex]!;
  const widths = cells(agent, scale, width);
  const bar: Seg[] = PARTS.map((part, i) => [(plain ? part.plain : "█").repeat(widths[i]!), { fg: part.colour }]);
  return [...bar, [" ".repeat(width - widths.reduce((a, b) => a + b, 0)), s.text]];
}

function rowsFor(state: State, scale: number, barWidth: number): Row[] {
  const rows: Row[] = [];
  state.model.hosts.forEach((host, h) => {
    const live = state.contexts[host.name];
    const name: Seg = [pad(host.name, HOST_W), s.bold];
    const blank: Seg = [" ".repeat(HOST_W), s.text];
    const report = live?.report ?? null;
    if (report === null) return void rows.push({ host: h, segs: [name, noReport(live, state)] });
    const old = seenAgo(live, state.now);
    report.agents.forEach((agent, i) => {
      const total = totalText(agent);
      const mark: Seg[] = i === 0 && old !== null ? [["  ", s.text], [`${old}, not live`, s.warn]] : [];
      const asking: Seg[] = i === 0 && live?.phase === "loading" && old === null ? [["  ", s.text], [spinner(state.now, state.motion), s.brand]] : [];
      rows.push({ host: h, segs: [i === 0 ? name : blank, [pad(agent.agent, AGENT_W), s.sub], ...barSegs(report, i, scale, barWidth, state.plain), [` ${total.padStart(TOTAL_W - 1)}`, agent.complete ? s.text : s.warn], ...mark, ...asking] });
    });
  });
  return rows;
}

const KIND_NAMES: Record<ContextKind, string> = { instructions: "instructions", skills: "skill", mcp: "mcp" };

function itemLine(item: ContextItem, nameWidth: number): Seg[] {
  const size: Seg = item.tokens === null ? [pad("unknown", 9), s.warn] : [pad(formatTokens(item.tokens), 9), s.text];
  // "unknown" says it is not measured; the mark says what to do about it, where something can be done.
  const marks: Seg[] = [
    ...(item.fromConfig ? [] : ([["not from config", s.muted]] as Seg[])),
    ...(item.tokens === null && item.fromConfig ? ([["run fleet doctor", s.warn]] as Seg[]) : []),
  ];
  return [size, [pad(item.name, nameWidth), s.sub], [pad(KIND_NAMES[item.kind], 13), { fg: colourOf(item.kind) }], ...marks];
}

function detail(c: Canvas, y: number, h: number, state: State): void {
  const host = state.model.hosts[state.contextHost];
  if (host === undefined) return;
  const live = state.contexts[host.name];
  const report = live?.report ?? null;
  drawBox(c, 0, y, c.w, h, "round", { fg: theme.border });
  c.text(2, y, truncate(` ${host.name} `, c.w - 4), s.bold);
  const lines: Seg[][] = [];
  const old = seenAgo(live, state.now);
  if (old !== null) lines.push([[`${old}, not live; asking again`, s.warn]]);
  if (report === null) {
    lines.push([noReport(live, state)]);
  } else {
    for (const a of report.agents) {
      const texts = partTexts(a);
      const [first, ...rest] = PARTS.map((part): Seg[] => [[part.kind, { fg: part.colour }], [` ${texts[part.kind]}`, s.sub]]);
      const joined = (parts: Seg[][]): Seg[] => parts.flatMap((p, i): Seg[] => [...(i === 0 ? [] : ([[" · ", s.faint]] as Seg[])), ...p]);
      const whole = joined([first!, ...rest]);
      // On a narrow window the last part, which is the longest, goes under the others.
      const fits = AGENT_W + segWidth(whole) <= c.w - 4;
      lines.push([[pad(a.agent, AGENT_W), s.sub], ...(fits ? whole : joined([first!, ...rest.slice(0, -1)]))]);
      if (!fits) lines.push([[" ".repeat(AGENT_W), s.text], ...rest.at(-1)!]);
    }
    const items = distinct(report, () => true);
    const sized = items.filter((i) => i.tokens !== null);
    const unknown = items.filter((i) => i.tokens === null);
    // One line is kept for "+N more" when the list is cut.
    const space = Math.max(1, h - 2 - lines.length);
    const room = items.length > space ? Math.max(1, space - 1) : space;
    const unknownShown = Math.min(unknown.length, Math.min(3, Math.max(0, room - 1)));
    const sizedShown = Math.min(sized.length, room - unknownShown);
    const listed = [...sized.slice(0, sizedShown), ...unknown.slice(0, unknownShown)];
    const nameWidth = Math.max(8, Math.min(30, ...[Math.max(...listed.map((i) => i.name.length))]));
    for (const i of listed) lines.push(itemLine(i, nameWidth + 2));
    const hidden = items.length - sizedShown - unknownShown;
    if (hidden > 0) lines.push([[`+${plural(hidden, "more item")}`, s.muted]]);
  }
  lines.slice(0, h - 2).forEach((segs, i) => segments(c, 2, y + 1 + i, segs, c.w - 4));
}

export function drawContext(c: Canvas, state: State): void {
  const hosts = state.model.hosts;
  if (hosts.length === 0) {
    c.text(2, 2, "No hosts yet.", s.text);
    return;
  }
  const reports = hosts.flatMap((h) => (state.contexts[h.name]?.report ? [state.contexts[h.name]!.report!] : []));
  const scale = largestAgent(reports);
  const biggest = hosts.flatMap((h) => (state.contexts[h.name]?.report?.agents ?? []).map((a) => ({ host: h.name, agent: a.agent, tokens: a.tokens }))).sort((a, b) => b.tokens - a.tokens)[0];

  segments(c, 1, 0, [["What each agent loads before the first prompt, in estimated tokens.", s.muted]], c.w - 2);
  segments(
    c,
    1,
    1,
    [
      ...PARTS.flatMap((part, i): Seg[] => [...(i === 0 ? [] : ([["  ", s.text]] as Seg[])), [state.plain ? part.plain : "█", { fg: part.colour }], [` ${part.kind}`, s.sub]]),
      ...(biggest === undefined || scale === 0 ? [] : ([["   ", s.text], [`a full bar is ${formatTokens(scale)} (${biggest.agent}, ${biggest.host})`, s.muted]] as Seg[])),
    ],
    c.w - 2,
  );

  const barWidth = Math.max(MIN_BAR, Math.min(MAX_BAR, c.w - 2 - HOST_W - AGENT_W - TOTAL_W - 2));
  const rows = rowsFor(state, scale, barWidth);
  const top = 3;
  const listH = Math.max(2, Math.min(rows.length, c.h - top - DETAIL_MIN));
  const last = rows.map((r) => r.host).lastIndexOf(state.contextHost);
  const first = Math.max(0, Math.min(rows.length - listH, last + 1 - listH));
  rows.slice(first, first + listH).forEach((row, i) => {
    const here = row.host === state.contextHost;
    const y = top + i;
    if (here) c.fill(0, y, c.w, 1, { bg: theme.raised });
    const bg = here ? { bg: theme.raised } : {};
    const mark: Seg = [here ? "›" : " ", { fg: theme.brandBright, ...bg }];
    segments(c, 0, y, [mark, ...row.segs.map(([t, st]): Seg => [t, { ...st, ...bg } as Style])], c.w);
  });
  const below = top + listH + 1;
  if (first > 0) c.textRight(c.w - 1, top - 1, "▲ more", s.muted);
  if (first + listH < rows.length) c.textRight(c.w - 1, below - 1, "▼ more", s.muted);
  if (c.h - below >= 4) detail(c, below, c.h - below, state);
}
