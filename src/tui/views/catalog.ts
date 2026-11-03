import { drawBox } from "../buffer.ts";
import type { Canvas, Style } from "../buffer.ts";
import type { State } from "../app.ts";
import { firstVisible } from "../layout.ts";
import { fuzzy } from "../palette.ts";
import type { CatalogView, ServerInfo, SkillInfo } from "../reads.ts";
import { spinner, theme } from "../theme.ts";
import { truncate, wrap } from "../width.ts";
import { pad, plural, s, segments } from "./ui.ts";

export type CatalogItem = { kind: "skill"; skill: SkillInfo; label: string } | { kind: "server"; server: ServerInfo; label: string };

/** Skills then servers, or the ones that match `query` best first. */
export function catalogItems(view: CatalogView | null, query: string): CatalogItem[] {
  if (view === null) return [];
  const all: CatalogItem[] = [...view.skills.map((skill): CatalogItem => ({ kind: "skill", skill, label: skill.name })), ...view.servers.map((server): CatalogItem => ({ kind: "server", server, label: server.name }))];
  if (query.trim() === "") return all;
  return all
    .map((item) => ({ item, m: fuzzy(query, item.label) }))
    .filter((x): x is { item: CatalogItem; m: { score: number; at: number[] } } => x.m !== null)
    .sort((a, b) => b.m.score - a.m.score)
    .map((x) => x.item);
}

type Line = [text: string, style: Style];

/** The hosts that get a bundle or a server, from the same cells the matrix shows. */
export function hostsFor(state: State, item: CatalogItem): string[] {
  const row = item.kind === "skill" ? state.model.bundles.find((b) => b.name === item.skill.bundle) : state.model.servers.find((r) => r.name === item.server.name);
  return row ? state.model.hosts.filter((h) => row.cells[h.name]?.on).map((h) => h.name) : [];
}

function facts(state: State, item: CatalogItem): Line[] {
  const hosts = hostsFor(state, item);
  const got: Line = [`hosts that get it: ${hosts.length > 0 ? hosts.join(", ") : "none"}`, s.text];
  if (item.kind === "server") {
    const v = item.server;
    return [[`transport: ${v.transport}${v.only.length < 2 ? `, only for ${v.only.join(", ")}` : ""}`, s.text], [`secret names: ${v.secrets.length > 0 ? v.secrets.join(", ") : "none"}`, s.text], got];
  }
  const k = item.skill;
  const src: Line = k.source ? [`source: ${k.source.name}, ${k.source.pin}`, s.text] : [k.notCloned.length > 0 ? `source: not cloned (${k.notCloned.join(", ")}); the bridge never clones, fleet apply does` : "source: no cloned source holds it", s.warn];
  return [[`bundle: ${k.bundle}`, s.text], src, got, [k.tokens === null ? "size: unknown" : `size: about ${k.tokens} tokens (an estimate: characters / 4)`, s.text]];
}

export function drawCatalog(c: Canvas, state: State): void {
  const { catalog: cat, now, motion } = state;
  if (cat.view === null) return void segments(c, 2, 1, [[`${spinner(now, motion)} `, s.brand], ["reading the catalog", s.sub]]);
  const items = catalogItems(cat.view, cat.query);
  segments(c, 2, 1, [[plural(cat.view.skills.length, "skill"), s.text], [" and ", s.muted], [plural(cat.view.servers.length, "server"), s.text], ["   filter ", s.muted], [cat.query === "" && !cat.typing ? "(f to type)" : cat.query, cat.typing ? s.text : s.brandBold], [cat.typing ? "▏" : "", s.brand]], c.w - 4);
  cat.view.problems.slice(0, 1).forEach((p) => c.text(2, 2, truncate(p, c.w - 4), s.warn));

  const top = 3;
  const listH = Math.max(3, Math.min(items.length, Math.floor((c.h - top) * 0.4)));
  const sel = Math.min(cat.selected, Math.max(0, items.length - 1));
  const first = firstVisible(sel, listH);
  items.slice(first, first + listH).forEach((item, i) => {
    const here = first + i === sel;
    const y = top + i;
    if (here) c.fill(0, y, c.w, 1, { bg: theme.raised });
    const bg = here ? { bg: theme.raised } : {};
    const note = item.kind === "skill" ? (item.skill.source ? item.skill.source.name : item.skill.notCloned.length > 0 ? "not cloned" : "not found") : item.server.transport;
    segments(c, 0, y, [[here ? "›" : " ", { fg: theme.brandBright, ...bg }], [` ${pad(item.kind, 7)}`, { fg: theme.faint, ...bg }], [pad(item.label, 28), { fg: here ? theme.text : theme.sub, ...bg }], [note, { fg: item.kind === "skill" && !item.skill.source ? theme.warn : theme.muted, ...bg }]], c.w);
  });
  if (items.length === 0) c.text(2, top, cat.query === "" ? "the catalog is empty" : "nothing matches; esc clears the filter", s.muted);

  const py = top + listH + (items.length === 0 ? 1 : 0);
  const ph = c.h - py;
  const item = items[sel];
  if (!item || ph < 4) return;
  drawBox(c, 0, py, c.w, ph, "round", { fg: theme.border });
  c.text(2, py, truncate(` ${item.label} `, c.w - 4), s.bold);
  const head = facts(state, item);
  const lines: Line[] = head.flatMap(([t, st]) => wrap(t, c.w - 6).map((w): Line => [w, st]));
  if (item.kind === "skill" && item.skill.text !== null) {
    lines.push(["SKILL.md", { fg: theme.muted, attr: 1 }], ...item.skill.text.map((t): Line => [t, s.sub]));
  }
  const inner = ph - 2;
  const scroll = Math.min(cat.scroll, Math.max(0, lines.length - inner));
  lines.slice(scroll, scroll + inner).forEach(([text, style], i) => c.text(2, py + 1 + i, text, style, c.w - 4));
  if (lines.length > inner) c.textRight(c.w - 2, py + ph - 1, ` ${scroll + 1}-${Math.min(lines.length, scroll + inner)} of ${lines.length} `, s.faint);
}
