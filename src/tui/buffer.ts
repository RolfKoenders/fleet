import { colorParams } from "./color.ts";
import type { Level } from "./color.ts";
import { graphemes, graphemeWidth } from "./width.ts";

export const BOLD = 1;
export const DIM = 2;
export const ITALIC = 4;
export const UNDERLINE = 8;
export const REVERSE = 16;

/** Unset colours are the terminal's own. */
export const DEFAULT = -1;

export type Style = {
  fg?: number;
  /** Left unset, a drawn character keeps the background already under it. */
  bg?: number;
  attr?: number;
};

/** A character that is not drawn as itself: controls, and the marks that reorder text. */
const UNSAFE = /^[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

/**
 * A grid of cells, the whole screen as the next frame will show it. A wide character holds its cell and
 * the one after it holds the empty string. Nothing written here can reach the terminal as a control: any
 * character that starts as one is drawn as `?`.
 */
export class Buffer {
  readonly cols: number;
  readonly rows: number;
  readonly chars: string[];
  readonly fg: Int32Array;
  readonly bg: Int32Array;
  readonly attr: Uint8Array;

  constructor(cols: number, rows: number) {
    this.cols = Math.max(0, cols);
    this.rows = Math.max(0, rows);
    const n = this.cols * this.rows;
    this.chars = new Array<string>(n).fill(" ");
    this.fg = new Int32Array(n).fill(DEFAULT);
    this.bg = new Int32Array(n).fill(DEFAULT);
    this.attr = new Uint8Array(n);
  }

  /** The frame as plain text, one string per row with trailing spaces cut. */
  lines(): string[] {
    const out: string[] = [];
    for (let y = 0; y < this.rows; y++) {
      let line = "";
      for (let x = 0; x < this.cols; x++) line += this.chars[y * this.cols + x];
      out.push(line.replace(/ +$/, ""));
    }
    return out;
  }

  toText(): string {
    return this.lines().join("\n");
  }

  /** Writes one cluster of `width` cells at (x, y), repairing any wide character it lands on. */
  put(x: number, y: number, cluster: string, width: number, style: Style): void {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return;
    const i = y * this.cols + x;
    this.blankPartnerOf(i, x);
    if (width === 2) {
      if (x + 1 >= this.cols) {
        this.set(i, " ", style);
        return;
      }
      this.blankPartnerOf(i + 1, x + 1);
      this.set(i, cluster, style);
      this.set(i + 1, "", style);
      return;
    }
    this.set(i, cluster, style);
  }

  private set(i: number, cluster: string, style: Style): void {
    this.chars[i] = cluster;
    this.fg[i] = style.fg ?? DEFAULT;
    if (style.bg !== undefined) this.bg[i] = style.bg;
    this.attr[i] = style.attr ?? 0;
  }

  /** Overwriting half of a wide character leaves the other half as a space. */
  private blankPartnerOf(i: number, x: number): void {
    if (this.chars[i] === "" && x > 0) this.chars[i - 1] = " ";
    else if (x + 1 < this.cols && this.chars[i + 1] === "" && this.chars[i] !== "") this.chars[i + 1] = " ";
  }
}

export type Rect = { x: number; y: number; w: number; h: number };

/** A window onto a buffer: coordinates are its own and nothing is drawn outside it. */
export class Canvas {
  readonly buf: Buffer;
  readonly x0: number;
  readonly y0: number;
  readonly w: number;
  readonly h: number;

  constructor(buf: Buffer, x0 = 0, y0 = 0, w = buf.cols, h = buf.rows) {
    this.buf = buf;
    this.x0 = x0;
    this.y0 = y0;
    this.w = Math.max(0, w);
    this.h = Math.max(0, h);
  }

  /** The part of this canvas at (x, y), clipped to it. */
  sub(x: number, y: number, w: number, h: number): Canvas {
    const left = Math.max(0, x);
    const top = Math.max(0, y);
    const right = Math.min(this.w, x + w);
    const bottom = Math.min(this.h, y + h);
    return new Canvas(this.buf, this.x0 + left, this.y0 + top, right - left, bottom - top);
  }

  /** Draws `text` from (x, y) and returns the column after it. Stops at `max` cells or the edge. */
  text(x: number, y: number, text: string, style: Style = {}, max = Infinity): number {
    if (y < 0 || y >= this.h) return x;
    const limit = Math.min(this.w, x + max);
    let cx = x;
    for (const g of graphemes(text)) {
      const unsafe = UNSAFE.test(g);
      const cluster = unsafe ? "?" : g;
      const width = unsafe ? 1 : graphemeWidth(g);
      if (width === 0) {
        // A combining mark joins the cell before it, when that cell is ours.
        const prev = cx - 1;
        if (prev >= 0 && prev < this.w && cx > x) {
          const i = (this.y0 + y) * this.buf.cols + this.x0 + prev;
          if (this.buf.chars[i] !== "") this.buf.chars[i] += cluster;
        }
        continue;
      }
      if (cx + width > limit) break;
      if (cx >= 0) this.buf.put(this.x0 + cx, this.y0 + y, cluster, width, style);
      cx += width;
    }
    return cx;
  }

  /** Text that ends at column `right` (exclusive). */
  textRight(right: number, y: number, text: string, style: Style = {}): void {
    let width = 0;
    for (const g of graphemes(text)) width += graphemeWidth(g);
    this.text(right - width, y, text, style);
  }

  fill(x: number, y: number, w: number, h: number, style: Style = {}, ch = " "): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.cell(x + i, y + j, ch, style);
  }

  cell(x: number, y: number, ch: string, style: Style = {}): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.buf.put(this.x0 + x, this.y0 + y, ch, 1, style);
  }

  /** Changes the style of cells already drawn, keeping their characters. */
  paint(x: number, y: number, w: number, h: number, style: Style): void {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const cx = x + i;
        const cy = y + j;
        if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) continue;
        const n = (this.y0 + cy) * this.buf.cols + this.x0 + cx;
        if (style.fg !== undefined) this.buf.fg[n] = style.fg;
        if (style.bg !== undefined) this.buf.bg[n] = style.bg;
        if (style.attr !== undefined) this.buf.attr[n] = (this.buf.attr[n] ?? 0) | style.attr;
      }
    }
  }
}

type Frame = { tl: string; tr: string; bl: string; br: string; h: string; v: string };

export const BORDERS = {
  round: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  dashed: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "╌", v: "╎" },
  square: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  heavy: { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" },
} satisfies Record<string, Frame>;

export type BorderKind = keyof typeof BORDERS;

/** The outline of a box. `edge` can colour each cell of the top edge (for a moving highlight). */
export function drawBox(c: Canvas, x: number, y: number, w: number, h: number, kind: BorderKind, style: Style, edge?: (i: number, length: number) => number): void {
  if (w < 2 || h < 2) return;
  const f = BORDERS[kind];
  const top = (i: number): Style => (edge ? { ...style, fg: edge(i, w) } : style);
  c.cell(x, y, f.tl, top(0));
  c.cell(x + w - 1, y, f.tr, top(w - 1));
  for (let i = 1; i < w - 1; i++) {
    c.cell(x + i, y, f.h, top(i));
    c.cell(x + i, y + h - 1, f.h, style);
  }
  for (let j = 1; j < h - 1; j++) {
    c.cell(x, y + j, f.v, style);
    c.cell(x + w - 1, y + j, f.v, style);
  }
  c.cell(x, y + h - 1, f.bl, style);
  c.cell(x + w - 1, y + h - 1, f.br, style);
}

const same = (a: Buffer, b: Buffer, i: number): boolean => a.chars[i] === b.chars[i] && a.fg[i] === b.fg[i] && a.bg[i] === b.bg[i] && a.attr[i] === b.attr[i];

function sgr(fg: number, bg: number, attr: number, level: Level): string {
  const p: string[] = ["0"];
  if (attr & BOLD) p.push("1");
  if (attr & DIM) p.push("2");
  if (attr & ITALIC) p.push("3");
  if (attr & UNDERLINE) p.push("4");
  if (attr & REVERSE) p.push("7");
  const f = colorParams(fg, level, false);
  const b = colorParams(bg, level, true);
  if (f) p.push(f);
  if (b) p.push(b);
  return `\u001b[${p.join(";")}m`;
}

/**
 * The bytes that turn what `prev` shows into `next`: only the cells that differ are written, each run after
 * one cursor move. With no `prev`, or one of another size, the screen is cleared and drawn whole.
 */
export function paintDiff(prev: Buffer | null, next: Buffer, level: Level): string {
  const whole = prev === null || prev.cols !== next.cols || prev.rows !== next.rows;
  let out = whole ? "\u001b[0m\u001b[2J" : "";
  let curFg = -2;
  let curBg = -2;
  let curAttr = -1;
  let curX = -1;
  let curY = -1;
  for (let y = 0; y < next.rows; y++) {
    for (let x = 0; x < next.cols; x++) {
      const i = y * next.cols + x;
      if (!whole && same(prev, next, i)) continue;
      const ch = next.chars[i]!;
      if (ch === "") continue; // second half of a wide character, written with the first
      if (curX !== x || curY !== y) out += `\u001b[${y + 1};${x + 1}H`;
      const [fg, bg, attr] = [next.fg[i]!, next.bg[i]!, next.attr[i]!];
      if (fg !== curFg || bg !== curBg || attr !== curAttr) {
        out += sgr(fg, bg, attr, level);
        [curFg, curBg, curAttr] = [fg, bg, attr];
      }
      out += ch;
      curX = x + graphemeWidth(ch);
      curY = y;
    }
  }
  return out === "" ? "" : `${out}\u001b[0m`;
}
