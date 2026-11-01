import type { Canvas } from "../buffer.ts";
import { BOLD } from "../buffer.ts";
import { mix } from "../color.ts";
import { theme, wordmark } from "../theme.ts";

type Part = { x: number; y: number; ch: string; at: number; role: "box" | "doc" | "line" | "dot" };

const parts: Part[] = [];
const add = (x: number, y: number, ch: string, at: number, role: Part["role"]) => parts.push({ x, y, ch, at, role });
const run = (x: number, y: number, text: string, from: number, per: number, role: Part["role"]) => [...text].forEach((ch, i) => add(x + i, y, ch, from + i * per, role));

// The logo's fan-out: a file on the left, one line that splits into three, a server at the end of each.
run(0, 1, "┌──────┐", 0, 18, "box");
run(0, 2, "│ ≡≡≡≡ │", 20, 18, "box");
run(0, 3, "│ ≡≡≡≡ ├", 40, 18, "box");
run(0, 4, "│ ≡≡   │", 60, 18, "box");
run(0, 5, "└──────┘", 80, 18, "box");
run(8, 3, "────────┼", 250, 22, "line");
for (const [y, d] of [[2, 0], [1, 1], [4, 0], [5, 1]] as const) add(16, y, "│", 420 + (d + Math.abs(3 - y)) * 40, "line");
add(16, 0, "╭", 560, "line");
add(16, 6, "╰", 560, "line");
for (const y of [0, 3, 6]) run(17, y, "─────────", 600, 22, "line");
const SERVER_AT = [820, 900, 980];
[0, 3, 6].forEach((y, i) => {
  run(26, y, "┃ ▪▪▪   ┃", SERVER_AT[i]!, 14, "box");
  add(32, y, "●", SERVER_AT[i]! + 220, "dot");
});

export const WIDTH = 35;
export const HEIGHT = 7;

/** The boot animation at `t` milliseconds in, centred on the canvas. A pure function of the time. */
export function drawBoot(c: Canvas, t: number): void {
  const ox = Math.floor((c.w - WIDTH) / 2);
  const oy = Math.max(0, Math.floor((c.h - HEIGHT - 5) / 2));
  for (const p of parts) {
    if (t < p.at) continue;
    const young = Math.max(0, 1 - (t - p.at) / 160);
    const base = p.role === "box" ? theme.text : p.role === "dot" ? theme.brand : p.role === "doc" ? theme.brand : theme.muted;
    const isDoc = p.role === "box" && p.ch === "≡";
    const fg = mix(isDoc ? theme.brand : base, theme.brandBright, young);
    c.cell(ox + p.x, oy + p.y, p.ch, { fg, ...(young > 0.5 ? { attr: BOLD } : {}) });
  }
  const word = "f l e e t";
  const wx = Math.floor((c.w - word.length) / 2);
  [...word].forEach((ch, i) => {
    const at = 900 + i * 35;
    if (ch === " " || t < at) return;
    c.cell(wx + i, oy + HEIGHT + 2, ch, { fg: mix(theme.faint, wordmark(i, word.length), Math.min(1, (t - at) / 220)), attr: BOLD });
  });
  if (t > 1150) {
    const sub = "bridge";
    c.text(Math.floor((c.w - sub.length) / 2), oy + HEIGHT + 4, sub, { fg: mix(theme.faint, theme.muted, Math.min(1, (t - 1150) / 200)) });
  }
}
