import { ago } from "../status.ts";
import { gridMax, levelOf } from "./data.ts";
import type { CardData, CardHost } from "./data.ts";
import { hidden, labelOf, plural, pushesCount, pushesText, pushesWord, shown, sinceText, summaryText } from "./words.ts";
import type { Style } from "./words.ts";

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

/**
 * The card's colours, the landing page's tokens (`site/style.css`). The card is dark only.
 */
const C = { ink: "#0b0f14", surface: "#161b22", raised: "#1f2630", border: "#30363d", borderSoft: "#21262d", text: "#e6edf3", sub: "#b1bac4", muted: "#7d8590", brand: "#3fb950", bright: "#7ee787", deep: "#196c2e", warn: "#d29922" };
/** The five shades of the activity grid, none first. */
const SHADES = [C.surface, "#0e4429", C.deep, "#2ea043", "#56d364"];

/**
 * An SVG file cannot count on the viewer's fonts and must not fetch any, so each text names the site's font first and then the
 * monospace faces that ship with the common systems (all about 0.6 em wide, like JetBrains Mono, which the layout is measured
 * with). Geist is the site's face for the big counts; where it is missing they fall back to the same monospace, never to a
 * stray system font. `fleet ui` puts the bundled JetBrains Mono into the file it turns into a PNG.
 */
export const MONO = "'JetBrains Mono','Fira Code',ui-monospace,SFMono-Regular,Menlo,Consolas,'DejaVu Sans Mono',monospace";
const NUMBERS = `Geist,${MONO}`;
const ADVANCE = 0.6;

const esc = (text: string): string => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const width = (text: string, size: number): number => Math.ceil(text.length * size * ADVANCE);
const fit = (text: string, chars: number): string => (text.length <= chars ? text : `${text.slice(0, Math.max(1, chars - 1))}…`);
const n = (x: number): string => String(Math.round(x * 10) / 10);

type TextOptions = { x: number; y: number; size: number; fill: string; weight?: number; anchor?: "start" | "end" | "middle"; family?: string; spacing?: number };
const text = (body: string, o: TextOptions): string =>
  `<text x="${n(o.x)}" y="${n(o.y)}" font-family="${o.family ?? MONO}" font-size="${o.size}" font-weight="${o.weight ?? 400}" fill="${o.fill}"${o.anchor === undefined || o.anchor === "start" ? "" : ` text-anchor="${o.anchor}"`}${o.spacing === undefined ? "" : ` letter-spacing="${o.spacing}"`}>${body}</text>`;
/** A run inside a text that is bold and bright, as the bottom lines mark their numbers. */
const strong = (body: string): string => `<tspan font-weight="700" fill="${C.text}">${esc(body)}</tspan>`;

/** The logo mark of the site's header, at 120 x 84, scaled. */
const MARK = `<path d="M8 20h22l10 10v32H8Z" fill="none" stroke="${C.brand}" stroke-width="5"/><path d="M15 38h18M15 46h18M15 54h11" stroke="${C.brand}" stroke-width="4"/><path d="M40 42C62 42 62 16 84 16M40 42H84M40 42C62 42 62 68 84 68" fill="none" stroke="${C.muted}" stroke-width="4"/><g fill="none" stroke="${C.text}" stroke-width="4"><rect x="84" y="9" width="32" height="14" rx="2"/><rect x="84" y="35" width="32" height="14" rx="2"/><rect x="84" y="61" width="32" height="14" rx="2"/></g>`;

const frame = (label: string, body: string): string => {
  const glow = (id: string, cx: number, cy: number, rx: number, ry: number, color: string, opacity: number) =>
    `<radialGradient id="${id}"><stop offset="0" stop-color="${color}" stop-opacity="${opacity}"/><stop offset=".7" stop-color="${color}" stop-opacity="0"/></radialGradient><ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#${id})"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title><defs><pattern id="dots" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="${C.text}" fill-opacity=".06"/></pattern><filter id="blur" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="16"/></filter></defs><rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${C.ink}"/>${glow("g1", 144, -113, 900, 420, C.brand, 0.2)}${glow("g2", 1200, 693, 700, 400, "#58a6ff", 0.08)}<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#dots)"/>${body}</svg>`;
};

const header = (): string =>
  `<g transform="translate(64 52) scale(.45)">${MARK}</g>${text("fleet", { x: 132, y: 84, size: 34, weight: 700, fill: C.text, spacing: -0.7 })}${text("rolflab.nl/fleet", { x: 1136, y: 80, size: 20, weight: 500, fill: C.muted, anchor: "end" })}`;

/** A pill with an agent's name. Returns it and where the next one starts; null when it would not fit before `limit`. */
function pill(name: string, x: number, midY: number, size: number, limit: number): { svg: string; end: number } | null {
  const w = width(name, size) + 20;
  if (x + w > limit) return null;
  const h = size + 14;
  return { svg: `<rect x="${n(x)}" y="${n(midY - h / 2)}" width="${w}" height="${h}" rx="6" fill="${C.raised}"/>${text(esc(name), { x: x + 10, y: midY + size * 0.35, size, weight: 500, fill: C.sub })}`, end: x + w + 8 };
}

/** Agent pills from `x`, as many as fit before `limit`, then `+N`. A host nobody has seen says so instead. */
function pills(host: CardHost, x: number, midY: number, size: number, limit: number): string {
  if (host.agents === null) return text("not seen yet", { x, y: midY + size * 0.35, size, fill: C.muted });
  if (host.agents.length === 0) return text("no agents", { x, y: midY + size * 0.35, size, fill: C.muted });
  let out = "";
  let at = x;
  for (const [i, name] of host.agents.entries()) {
    const left = host.agents.length - i;
    const next = pill(name, at, midY, size, left === 1 ? limit : limit - width("+9", size) - 28);
    if (next === null) {
      out += pill(`+${left}`, at, midY, size, limit)?.svg ?? "";
      break;
    }
    out += next.svg;
    at = next.end;
  }
  return out;
}

const SIZES = [
  { h: 52, gap: 12, name: 20, badge: 16, os: 17 },
  { h: 44, gap: 10, name: 19, badge: 15, os: 16 },
  { h: 40, gap: 8, name: 17, badge: 14, os: 15 },
  { h: 32, gap: 6, name: 16, badge: 13, os: 14 },
];

/** The activity grid, one square per day, a week to a column. `x`, `y` is its top left. */
function activity(grid: NonNullable<CardData["activity"]>, x: number, y: number, cell: number, gap: number): string {
  const max = gridMax(grid);
  const byLevel: string[][] = [[], [], [], [], []];
  for (const [w, week] of grid.entries()) {
    for (const [d, count] of week.entries()) {
      if (count === null) continue;
      byLevel[levelOf(count, max)]!.push(`<rect x="${x + w * (cell + gap)}" y="${y + d * (cell + gap)}" width="${cell}" height="${cell}"/>`);
    }
  }
  return byLevel.map((rects, level) => (rects.length === 0 ? "" : `<g fill="${SHADES[level]}">${rects.join("")}</g>`)).join("");
}

const gridWidth = (grid: NonNullable<CardData["activity"]>, cell: number, gap: number): number => grid.length * (cell + gap) - gap;

/** Style A: the four counts, a row per machine, the activity grid beside the rows, and the year at the bottom. */
function machines(data: CardData, names: boolean): string {
  const counts: [number, string, string][] = [[data.hosts.length, "machine", "machines"], [data.agents, "agent", "agents"], [data.skills, "skill", "skills"], [data.servers, "MCP server", "MCP servers"]];
  let out = header();
  for (const [i, [value, one, many]] of counts.entries()) {
    out += text(String(value), { x: 64 + i * 268, y: 212, size: 88, weight: 800, fill: i === 0 ? C.bright : C.text, family: NUMBERS, spacing: -3.5 });
    out += text(value === 1 ? one : many, { x: 64 + i * 268, y: 249, size: 21, weight: 500, fill: C.muted });
  }

  const list = shown(data);
  const more = hidden(data);
  const sizes = SIZES[Math.max(0, Math.min(3, list.length - 3))]!;
  const gridCell = 8;
  const gridGap = 2;
  const gridW = data.activity === null ? 0 : gridWidth(data.activity, gridCell, gridGap);
  const rowsW = data.activity === null ? 1072 : 1072 - gridW - 36;
  const total = list.length * sizes.h + Math.max(0, list.length - 1) * sizes.gap + (more > 0 ? 26 : 0);
  const top = 410 - total / 2;
  const longest = Math.max(1, ...list.map((h, i) => labelOf(i, h, names).length));
  const nameCol = Math.min(190, Math.max(110, Math.ceil(longest * sizes.name * ADVANCE) + 24));
  for (const [i, host] of list.entries()) {
    const y = top + i * (sizes.h + sizes.gap);
    const mid = y + sizes.h / 2;
    const label = fit(labelOf(i, host, names), Math.floor((nameCol - 12) / (sizes.name * ADVANCE)));
    out += `<rect x="65" y="${n(y + 0.75)}" width="${rowsW - 1.5}" height="${sizes.h - 1.5}" rx="10" fill="${C.surface}" fill-opacity=".7" stroke="${C.borderSoft}" stroke-width="1.5"/>`;
    out += text(esc(label), { x: 64 + 16, y: mid + sizes.name * 0.35, size: sizes.name, weight: 700, fill: C.text });
    const os = host.os ?? "";
    const osW = os === "" ? 0 : width(os, sizes.os);
    if (os !== "") out += text(os, { x: 64 + rowsW - 16, y: mid + sizes.os * 0.35, size: sizes.os, fill: C.muted, anchor: "end" });
    out += pills(host, 64 + 16 + nameCol, mid, sizes.badge, 64 + rowsW - 16 - osW - 14);
  }
  if (more > 0) out += text(`+${more} more`, { x: 64 + 16, y: top + total - 6, size: 17, fill: C.muted });

  if (data.activity !== null) {
    const x = 1136 - gridW;
    const gridH = 7 * (gridCell + gridGap) - gridGap;
    out += text("activity, 12 months", { x, y: 410 - gridH / 2 - 14, size: 15, fill: C.muted });
    out += activity(data.activity, x, 410 - gridH / 2 + 4, gridCell, gridGap);
  }
  out += text("one config · every machine", { x: 64, y: 571, size: 19, fill: C.muted });
  out += text(`${strong(`${plural(data.changes, "change")}`)} in the last year · ${strong(pushesText(data))}${esc(sinceText(data))}`, { x: 1136, y: 571, size: 19, fill: C.muted, anchor: "end" });
  return frame(summaryText(data), out);
}

const NODE_W = 270;
const NODE_H = 124;
const MORE_H = 84;

/** Where each tile of the map goes, top left. A tile is a machine or the "+N more" card. */
function slots(count: number): { x: number; y: number }[] {
  if (count === 1) return [{ x: 465, y: 420 }];
  if (count === 2) return [{ x: 90, y: 256 }, { x: 840, y: 256 }];
  const rows = Math.ceil(count / 2);
  const ys = rows === 2 ? [140, 420] : [112, 262, 412];
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 2);
    // An odd last tile sits in the middle of its row. Seven tiles are three rows and a card below the hub.
    if (count % 2 === 1 && i === count - 1) out.push({ x: 465, y: count === 7 ? 420 : ys[row]! });
    else out.push({ x: i % 2 === 0 ? 90 : 840, y: ys[row]! });
  }
  return out;
}

/** Style B: the config in the middle and each machine around it. */
function map(data: CardData, names: boolean): string {
  const list = shown(data);
  const more = hidden(data);
  const tiles = slots(list.length + (more > 0 ? 1 : 0));
  const heights = tiles.map((_, i) => (i < list.length ? NODE_H : MORE_H));
  let out = header();
  out += `<g stroke="${C.brand}" stroke-opacity=".45" stroke-width="2" stroke-dasharray="6 8" fill="none">${tiles.map((t, i) => `<path d="M600 318 L${t.x + NODE_W / 2} ${t.y + heights[i]! / 2}"/>`).join("")}</g>`;
  out += `<rect x="500" y="262" width="200" height="112" rx="16" fill="${C.brand}" fill-opacity=".3" filter="url(#blur)"/><rect x="501" y="263" width="198" height="110" rx="16" fill="#0d1e12" stroke="${C.brand}" stroke-width="2"/>`;
  out += text("config", { x: 600, y: 312, size: 24, weight: 700, fill: C.bright, anchor: "middle" });
  out += text("one private repo", { x: 600, y: 341, size: 15, fill: C.muted, anchor: "middle" });

  for (const [i, host] of list.entries()) {
    const { x, y } = tiles[i]!;
    out += `<rect x="${x + 0.75}" y="${y + 0.75}" width="${NODE_W - 1.5}" height="${NODE_H - 1.5}" rx="14" fill="${C.surface}" stroke="${C.border}" stroke-width="1.5"/>`;
    out += text(esc(fit(labelOf(i, host, names), 11)), { x: x + 20, y: y + 40, size: 24, weight: 700, fill: C.text });
    const state = !host.seen ? null : host.conflicts !== null && host.conflicts > 0 ? { word: "conflicts", color: C.warn } : { word: "ok", color: C.bright };
    if (state !== null) {
      out += text(state.word, { x: x + NODE_W - 20, y: y + 40, size: 18, fill: state.color, anchor: "end" });
      out += `<circle cx="${x + NODE_W - 20 - width(state.word, 18) - 11}" cy="${y + 34}" r="4.5" fill="${state.color === C.warn ? C.warn : C.brand}"/>`;
    }
    out += pills(host, x + 20, y + 70, 15, x + NODE_W - 20);
    const small = [host.os, host.appliedAgo === null ? null : ago(host.appliedAgo)].filter((p): p is string => p !== null);
    out += text(esc(small.join(" · ")), { x: x + 20, y: y + 106, size: 16, fill: C.muted });
  }
  if (more > 0) {
    const { x, y } = tiles[list.length]!;
    out += `<rect x="${x + 0.75}" y="${y + 0.75}" width="${NODE_W - 1.5}" height="${MORE_H - 1.5}" rx="14" fill="${C.surface}" fill-opacity=".6" stroke="${C.border}" stroke-width="1.5" stroke-dasharray="6 6"/>`;
    out += text(`+${more} more`, { x: x + NODE_W / 2, y: y + 40, size: 24, weight: 700, fill: C.sub, anchor: "middle" });
    out += text(more === 1 ? "machine not shown" : "machines not shown", { x: x + NODE_W / 2, y: y + 66, size: 15, fill: C.muted, anchor: "middle" });
  }
  out += text(`${strong(String(data.skills))} ${data.skills === 1 ? "skill" : "skills"} · ${strong(String(data.servers))} MCP ${data.servers === 1 ? "server" : "servers"}`, { x: 64, y: 577, size: 20, weight: 500, fill: C.sub });
  out += text(`${strong(String(data.changes))} ${data.changes === 1 ? "change" : "changes"} this year · ${strong(pushesCount(data))} ${pushesWord(data)}`, { x: 1136, y: 577, size: 20, weight: 500, fill: C.sub, anchor: "end" });
  return frame(summaryText(data), out);
}

/** The card as one SVG document, 1200 x 630. Hostnames are `host 1`, `host 2`, ... unless `names` asks for the real ones. */
export function renderCard(data: CardData, style: Style, names: boolean): string {
  return style === "map" ? map(data, names) : machines(data, names);
}

/** The README badge: `fleet · 3 machines · 3 agents`, in the card's colours. It holds no hostname. */
export function renderBadge(data: CardData): string {
  const size = 11;
  const label = plural(data.hosts.length, "machine") + " · " + plural(data.agents, "agent");
  const left = 21 + width("fleet", size) + 9;
  const right = width(label, size) + 20;
  const total = left + right;
  const aria = `fleet: ${plural(data.hosts.length, "machine")}, ${plural(data.agents, "agent")}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" viewBox="0 0 ${total} 20" role="img" aria-label="${esc(aria)}"><title>${esc(aria)}</title><rect rx="4" width="${total}" height="20" fill="#0d1117"/><rect x="${left}" rx="4" width="${right}" height="20" fill="${C.deep}"/><rect x="${left}" width="6" height="20" fill="${C.deep}"/><circle cx="12" cy="10" r="4" fill="${C.brand}"/>${text("fleet", { x: 21, y: 14, size, weight: 700, fill: C.text })}${text(esc(label), { x: left + 10, y: 14, size, fill: C.text })}</svg>\n`;
}
