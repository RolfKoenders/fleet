import { BOLD } from "../buffer.ts";
import type { Canvas } from "../buffer.ts";
import { SCREENS } from "../palette.ts";
import type { State } from "../app.ts";
import { spinner, theme, wordmark } from "../theme.ts";
import { stringWidth } from "../width.ts";
import { s, segments, segWidth } from "./ui.ts";
import type { Seg } from "./ui.ts";

/** The pending work worth showing in the header: hosts still being asked. */
export function asking(state: State): number {
  return Object.values(state.live).filter((l) => l.phase === "loading").length;
}

export function conflictTotal(state: State): number {
  let n = state.conflicts.items.length;
  for (const h of state.model.hosts) {
    const r = state.live[h.name]?.result;
    if (!h.self && r?.status && r.status.conflicts) n += r.status.conflicts;
  }
  return n;
}

export function drawHeader(c: Canvas, state: State): void {
  const w = c.w;
  // The mark: three bars, the fleet, in the wordmark's colours.
  [0, 1, 2].forEach((i) => c.cell(1 + i, 0, "▰", { fg: wordmark(i, 3), attr: BOLD }));
  c.text(5, 0, "fleet", s.bold);
  if (w >= 40) c.text(11, 0, "bridge", s.muted);

  const total = conflictTotal(state);
  const wide = w >= 62;
  let x = wide ? 20 : 11 + (w >= 40 ? 7 : 0);
  for (const tab of SCREENS) {
    const active = tab.id === state.screen;
    const badge = tab.id === "conflicts" && total > 0 ? ` ${total}` : "";
    const label = wide || active ? `${tab.key} ${tab.title}${badge}` : `${tab.key}`;
    const style = active ? { fg: theme.text, attr: BOLD } : s.muted;
    const end = c.text(x + 1, 0, label, style);
    if (badge) c.text(end - badge.length, 0, badge, { fg: theme.bad, attr: BOLD });
    // The line under the bar, lit under the open tab.
    if (active) for (let i = x; i <= end; i++) c.cell(i, 1, "━", { fg: theme.brand });
    x = end + 2;
  }
  for (let i = 0; i < w; i++) if (c.buf.chars[(c.y0 + 1) * c.buf.cols + c.x0 + i] === " ") c.cell(i, 1, "─", { fg: theme.border });

  const pill = " read-only ";
  if (w >= 80) c.text(w - stringWidth(pill) - 1, 0, pill, { fg: theme.muted, bg: theme.surface });
  if (asking(state) > 0 && w >= 100) c.text(w - stringWidth(pill) - 4, 0, spinner(state.now, state.motion), s.brand);
}

export type Hint = [key: string, label: string];

export function drawFooter(c: Canvas, y: number, hints: Hint[]): void {
  let x = 1;
  for (const [key, label] of hints) {
    const segs: Seg[] = [[key, s.brandBold], [` ${label}`, s.muted]];
    if (x + segWidth(segs) > c.w - 1) break;
    x = segments(c, x, y, segs) + 2;
  }
}
