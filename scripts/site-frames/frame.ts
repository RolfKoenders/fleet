import { theme } from "../../src/tui/theme.ts";

/** A run of cells with one style: text, foreground and background (-1 for the terminal's own), and attributes (1 bold, 2 dim). */
export type Span = [text: string, fg: number, bg: number, attr: number];
/** What the page draws: rows of runs. */
export type Frame = { cols: number; rows: number; lines: Span[][] };

/** The colours the page's block uses for the SGR codes a fleet command prints, in the colours of the bridge. */
const COLOURS: Record<number, number> = { 31: theme.bad, 32: theme.ok, 33: theme.warn, 36: theme.info };

/** Text with SGR codes, as a command prints it on a terminal, as a frame. Anything the commands do not print is an error, so a new code cannot slip by unseen. */
export function fromAnsi(text: string): Frame {
  const lines: Span[][] = [];
  let fg = -1;
  let attr = 0;
  for (const line of text.replace(/\n+$/, "").split("\n")) {
    const row: Span[] = [];
    for (const part of line.split(/(\u001b\[[0-9;]*m)/)) {
      const code = /^\u001b\[([0-9;]*)m$/.exec(part);
      if (code) {
        const params = code[1]!.split(";").map(Number);
        for (let i = 0; i < params.length; i++) {
          const p = params[i]!;
          if (p === 0) [fg, attr] = [-1, 0];
          else if (p === 1 || p === 2) attr |= p;
          else if (p === 38 && params[i + 1] === 2) {
            fg = (params[i + 2]! << 16) | (params[i + 3]! << 8) | params[i + 4]!;
            i += 4;
          } else if (COLOURS[p] !== undefined) fg = COLOURS[p]!;
          else throw new Error(`no colour for SGR ${p}`);
        }
      } else if (part !== "") row.push([part, fg, -1, attr]);
    }
    lines.push(row);
  }
  return { cols: Math.max(...lines.map((r) => [...r.map((s) => s[0]).join("")].length)), rows: lines.length, lines };
}
