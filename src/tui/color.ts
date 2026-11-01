/** Colours as 0xRRGGBB, written for a truecolor terminal and cut down for weaker ones. */

export type Level = "truecolor" | "256" | "16" | "none";

export type Env = Record<string, string | undefined>;

/** What the terminal can show. NO_COLOR wins over everything and leaves attributes (bold, reverse) only. */
export function detectLevel(env: Env, isTTY: boolean): Level {
  if ((env.NO_COLOR ?? "") !== "") return "none";
  const term = env.TERM ?? "";
  if (!isTTY || term === "dumb" || term === "") return "none";
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  if (term === "linux") return "16";
  if (term.includes("256color") || term.includes("truecolor") || term.includes("direct")) return "256";
  return "16";
}

export const rgb = (r: number, g: number, b: number): number => (r << 16) | (g << 8) | b;
const parts = (c: number): [number, number, number] => [(c >> 16) & 255, (c >> 8) & 255, c & 255];

/** `from` towards `to`, `t` from 0 to 1. */
export function mix(from: number, to: number, t: number): number {
  const [a, b] = [parts(from), parts(to)];
  const k = Math.max(0, Math.min(1, t));
  return rgb(...(a.map((v, i) => Math.round(v + (b[i]! - v) * k)) as [number, number, number]));
}

const XTERM16 = [0x000000, 0xcd0000, 0x00cd00, 0xcdcd00, 0x0000ee, 0xcd00cd, 0x00cdcd, 0xe5e5e5, 0x7f7f7f, 0xff0000, 0x00ff00, 0xffff00, 0x5c5cff, 0xff00ff, 0x00ffff, 0xffffff];

const distance = (x: number, y: number): number => {
  const [a, b] = [parts(x), parts(y)];
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
};

const nearest16 = (c: number): number => {
  let best = 0;
  for (let i = 1; i < 16; i++) if (distance(c, XTERM16[i]!) < distance(c, XTERM16[best]!)) best = i;
  return best;
};

const CUBE = [0, 95, 135, 175, 215, 255];

function nearest256(c: number): number {
  const [r, g, b] = parts(c);
  const near = (v: number) => CUBE.reduce((best, level, i) => (Math.abs(level - v) < Math.abs(CUBE[best]! - v) ? i : best), 0);
  const [ri, gi, bi] = [near(r), near(g), near(b)];
  const cube = 16 + 36 * ri + 6 * gi + bi;
  const average = Math.round((r + g + b) / 3);
  const grayIndex = Math.max(0, Math.min(23, Math.round((average - 8) / 10)));
  const gray = 232 + grayIndex;
  const grayValue = 8 + 10 * grayIndex;
  return distance(c, rgb(CUBE[ri]!, CUBE[gi]!, CUBE[bi]!)) <= distance(c, rgb(grayValue, grayValue, grayValue)) ? cube : gray;
}

/** The SGR parameters that set a foreground or background colour at `level`, or "" for none. */
export function colorParams(c: number, level: Level, background: boolean): string {
  if (c < 0 || level === "none") return "";
  if (level === "truecolor") {
    const [r, g, b] = parts(c);
    return `${background ? 48 : 38};2;${r};${g};${b}`;
  }
  if (level === "256") return `${background ? 48 : 38};5;${nearest256(c)}`;
  const n = nearest16(c);
  if (n < 8) return String((background ? 40 : 30) + n);
  return String((background ? 100 : 90) + n - 8);
}
