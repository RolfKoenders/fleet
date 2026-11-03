import { BOLD, DIM } from "../buffer.ts";
import type { Canvas, Style } from "../buffer.ts";
import { theme } from "../theme.ts";
import { stringWidth, truncate } from "../width.ts";

export const s = {
  text: { fg: theme.text } as Style,
  bold: { fg: theme.text, attr: BOLD } as Style,
  sub: { fg: theme.sub } as Style,
  muted: { fg: theme.muted } as Style,
  faint: { fg: theme.faint } as Style,
  brand: { fg: theme.brand } as Style,
  brandBold: { fg: theme.brandBright, attr: BOLD } as Style,
  ok: { fg: theme.ok } as Style,
  warn: { fg: theme.warn } as Style,
  bad: { fg: theme.bad } as Style,
  info: { fg: theme.info } as Style,
  dim: { fg: theme.muted, attr: DIM } as Style,
};

export type Seg = [text: string, style: Style];

/** Draws segments one after another and returns the column after them. */
export function segments(c: Canvas, x: number, y: number, segs: Seg[], max = Infinity): number {
  let cx = x;
  for (const [text, style] of segs) {
    if (cx - x >= max) break;
    cx = c.text(cx, y, text, style, max - (cx - x));
  }
  return cx;
}

export const segWidth = (segs: Seg[]): number => segs.reduce((n, [t]) => n + stringWidth(t), 0);

export function pad(text: string, width: number): string {
  const t = truncate(text, width);
  return t + " ".repeat(Math.max(0, width - stringWidth(t)));
}

/** "12m", "3h", "2d" for a span in seconds. */
export function span(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 48 * 3600) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
