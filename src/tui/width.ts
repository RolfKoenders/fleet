/** How many terminal cells text takes: wide characters are two, combining marks and joiners none. */

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const graphemes = (text: string): string[] => Array.from(segmenter.segment(text), (s) => s.segment);

const ZERO: [number, number][] = [
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff],
  [0x1f3fb, 0x1f3ff],
  [0xe0100, 0xe01ef],
];

const WIDE: [number, number][] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

const within = (table: [number, number][], cp: number): boolean => table.some(([lo, hi]) => cp >= lo && cp <= hi);

/** Cells taken by one code point. Control characters take none: they are never drawn. */
export function codePointWidth(cp: number): 0 | 1 | 2 {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x300) return 1;
  if (within(ZERO, cp)) return 0;
  return within(WIDE, cp) ? 2 : 1;
}

/** Cells taken by one grapheme cluster. An emoji presentation selector or a joined sequence makes it wide. */
export function graphemeWidth(cluster: string): 0 | 1 | 2 {
  let width: 0 | 1 | 2 = 0;
  for (const ch of cluster) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0xfe0f) return 2;
    const w = codePointWidth(cp);
    if (w > width) width = w;
  }
  return width;
}

export function stringWidth(text: string): number {
  let total = 0;
  for (const g of graphemes(text)) total += graphemeWidth(g);
  return total;
}

/** The longest prefix of `text` that fits in `max` cells, with `…` as the last cell when it was cut. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (stringWidth(text) <= max) return text;
  let out = "";
  let used = 0;
  for (const g of graphemes(text)) {
    const w = graphemeWidth(g);
    if (used + w > max - 1) break;
    out += g;
    used += w;
  }
  return `${out}…`;
}

/** Lines of at most `width` cells, broken at spaces where possible. */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((w) => w !== "")) {
    let rest = word;
    while (stringWidth(rest) > width) {
      if (line !== "") {
        lines.push(line);
        line = "";
      }
      let piece = "";
      for (const g of graphemes(rest)) {
        if (stringWidth(piece + g) > width) break;
        piece += g;
      }
      lines.push(piece);
      rest = rest.slice(piece.length);
    }
    if (line === "") line = rest;
    else if (stringWidth(line) + 1 + stringWidth(rest) <= width) line += ` ${rest}`;
    else {
      lines.push(line);
      line = rest;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}
