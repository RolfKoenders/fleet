import { drawBox } from "../buffer.ts";
import type { Canvas } from "../buffer.ts";
import type { State } from "../app.ts";
import type { Conflict } from "../../plan.ts";
import { spinner, theme } from "../theme.ts";
import { truncate, wrap } from "../width.ts";
import { pad, plural, s, segments } from "./ui.ts";
import type { Seg } from "./ui.ts";

/** Every conflict that can be selected: this host's first, then each other host's, in host order. */
export function conflictEntries(state: Pick<State, "model" | "conflicts">): { host: string; item: Conflict }[] {
  const out: { host: string; item: Conflict }[] = [];
  for (const h of state.model.hosts) {
    if (h.self) for (const item of state.conflicts.items) out.push({ host: h.name, item });
    else {
      const r = state.conflicts.remote[h.name]?.result;
      if (r?.ok) for (const item of r.items) out.push({ host: h.name, item });
    }
  }
  return out;
}

type Line = { head: Seg[] } | { entry: number };

/** What a host with nothing to list says instead, or null when its conflicts are listed under it. */
function hostNote(state: State, name: string, self: boolean): [string, Seg[1]] | null {
  if (self) {
    const c = state.conflicts;
    if (c.phase === "loading") return [`${spinner(state.now, state.motion)} planning against its config`, s.sub];
    if (c.detail !== null) return [`could not be planned: ${c.detail}`, s.warn];
    return c.items.length === 0 ? ["none", s.ok] : null;
  }
  const live = state.live[name];
  const r = live?.result;
  if (live?.seen) return ["not asked yet this run", s.muted];
  if (!r) return ["asking", s.muted];
  if (r.result === "timer") return ["unknown: no ssh destination", s.muted];
  if (r.result !== "ok") return ["unknown: no answer", s.muted];
  const n = r.status?.conflicts ?? null;
  if (n === null) return ["unknown", s.muted];
  if (n === 0) return ["none", s.ok];
  const rc = state.conflicts.remote[name];
  if (!rc || rc.phase === "loading") return [`${plural(n, "conflict")}; reading the detail`, s.warn];
  if (rc.result && !rc.result.ok) return rc.result.reason === "old" ? [`${plural(n, "conflict")}; detail needs a newer pin`, s.warn] : [`${plural(n, "conflict")}; the detail could not be read: ${rc.result.detail}`, s.warn];
  return rc.result?.ok && rc.result.items.length === 0 ? [`${plural(n, "conflict")} reported, none listed`, s.warn] : null;
}

export function drawConflicts(c: Canvas, state: State): void {
  const { conflicts, model } = state;
  const entries = conflictEntries(state);
  const total = entries.length;
  segments(c, 2, 1, total > 0 ? [[plural(total, "conflict"), s.bad], [" across hosts. Apply stops on a host until each is cleared.", s.muted]] : [["✓ ", s.ok], ["no conflicts known on any host", s.text]]);

  const lines: Line[] = [];
  let index = 0;
  for (const h of model.hosts) {
    const note = hostNote(state, h.name, h.self);
    lines.push({ head: [[pad(h.name + (h.self ? " (this host)" : ""), 22), s.bold], ...(note ? ([[note[0], note[1]]] as Seg[]) : [])] });
    const own = entries.filter((e) => e.host === h.name);
    for (let i = 0; i < own.length; i++) lines.push({ entry: index++ });
  }

  const listTop = 3;
  const detailH = total > 0 && c.h >= 18 ? 9 : 0;
  const listH = Math.max(1, c.h - listTop - detailH);
  const sel = Math.min(conflicts.selected, Math.max(0, total - 1));
  const at = Math.max(0, lines.findIndex((l) => "entry" in l && l.entry === sel));
  const start = Math.max(0, Math.min(at - Math.floor(listH / 2), lines.length - listH));
  lines.slice(start, start + listH).forEach((l, i) => {
    const y = listTop + i;
    if ("head" in l) return void segments(c, 2, y, l.head, c.w - 4);
    const { item } = entries[l.entry]!;
    const here = l.entry === sel;
    if (here) c.fill(0, y, c.w, 1, { bg: theme.raised });
    const bg = here ? { bg: theme.raised } : {};
    segments(c, 0, y, [
      [here ? "›" : " ", { fg: theme.brandBright, ...bg }],
      [`   ${pad(item.kind, 8)}`, { fg: theme.warn, ...bg }],
      [truncate(item.path, c.w - 16), { fg: here ? theme.text : theme.sub, ...bg }],
    ]);
  });
  if (start > 0) c.text(c.w - 3, listTop, "▲", s.muted);
  if (start + listH < lines.length) c.text(c.w - 3, listTop + listH - 1, "▼", s.muted);

  const picked = entries[sel];
  if (picked && detailH > 0) {
    const { item, host } = picked;
    const y = c.h - detailH;
    drawBox(c, 1, y, c.w - 2, detailH, "round", { fg: theme.border });
    c.text(3, y, ` ${host}: ${item.kind} `, { fg: theme.warn });
    const width = c.w - 8;
    const detail = wrap(item.detail, width).slice(0, 3);
    detail.forEach((t, i) => c.text(3, y + 1 + i, t, s.text));
    c.text(3, y + 2 + detail.length, "fix", s.brandBold);
    wrap(item.fix, width - 4).slice(0, detailH - 4 - detail.length).forEach((t, i) => c.text(7, y + 2 + detail.length + i, t, s.sub));
  }
}
