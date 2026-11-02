import { BOLD, drawBox } from "../buffer.ts";
import type { Canvas } from "../buffer.ts";
import type { State } from "../app.ts";
import { items, search } from "../palette.ts";
import { describeRunning, remaining } from "../pushrun.ts";
import { theme } from "../theme.ts";
import { stringWidth, truncate, wrap } from "../width.ts";
import { pad, s, segments } from "./ui.ts";

function frame(c: Canvas, w: number, h: number, title: string): Canvas {
  const width = Math.min(c.w - 2, w);
  const height = Math.min(c.h - 2, h);
  const x = Math.floor((c.w - width) / 2);
  const y = Math.max(1, Math.floor((c.h - height) / 2.4));
  c.fill(x, y, width, height, { bg: theme.surface });
  drawBox(c, x, y, width, height, "round", { fg: theme.brand, bg: theme.surface });
  c.text(x + 2, y, ` ${title} `, { fg: theme.brandBright, attr: BOLD, bg: theme.surface });
  return c.sub(x, y, width, height);
}

const HELP: [string, string][] = [
  ["1 2 3 4  tab", "switch screen"],
  ["← ↑ ↓ →  hjkl", "move"],
  ["enter", "home: open in matrix; matrix: show skills"],
  ["ctrl-k  :", "command palette"],
  ["P", "review a push, then type push to run it"],
  ["r", "ask every host again"],
  ["c", "home: go to conflicts"],
  ["esc", "close, or back to home"],
  ["?", "this help"],
  ["q  ctrl-c", "quit"],
];

export function drawHelp(root: Canvas): void {
  const c = frame(root, 72, HELP.length + 10, "keys");
  const bg = { bg: theme.surface };
  HELP.forEach(([k, d], i) => segments(c, 3, 2 + i, [[pad(k, 16), { ...s.brandBold, ...bg }], [d, { ...s.sub, ...bg }]], c.w - 6));
  const y = 3 + HELP.length;
  c.text(3, y, "legend", { fg: theme.muted, attr: BOLD, bg: theme.surface });
  segments(c, 3, y + 1, [["●", { ...s.ok, ...bg }], [" from the defaults   ", { ...s.muted, ...bg }], ["◆", { fg: theme.host, ...bg }], [" from the host's file   ", { ...s.muted, ...bg }], ["◉", { ...s.ok, ...bg }], [" both", { ...s.muted, ...bg }]], c.w - 6);
  segments(c, 3, y + 2, [["✕", { ...s.warn, ...bg }], [" excluded   ", { ...s.muted, ...bg }], ["·", { ...s.faint, ...bg }], [" not picked", { ...s.muted, ...bg }]], c.w - 6);
  c.text(3, y + 4, truncate("The bridge only reads, until you press P and type push. Then it runs fleet push.", c.w - 6), { ...s.sub, ...bg });
}

export function drawPalette(root: Canvas, state: State): void {
  const o = state.overlay;
  if (o?.kind !== "palette") return;
  const matches = search(items(state.model), o.query);
  const listH = Math.min(matches.length, Math.max(1, Math.min(10, root.h - 10)));
  const c = frame(root, 62, listH + 6 + (matches.length === 0 ? 1 : 0), "go to");
  const bg = { bg: theme.surface };
  segments(c, 2, 1, [["❯ ", { ...s.brandBold, ...bg }], [o.query, { ...s.text, ...bg }], ["▏", { ...s.brand, ...bg }]], c.w - 4);
  for (let x = 2; x < c.w - 2; x++) c.cell(x, 2, "─", { fg: theme.border, bg: theme.surface });
  if (matches.length === 0) c.text(3, 3, "nothing matches", { ...s.muted, ...bg });
  const first = o.selected < listH ? 0 : o.selected - listH + 1;
  matches.slice(first, first + listH).forEach((m, i) => {
    const y = 3 + i;
    const here = first + i === o.selected;
    const rowBg = here ? theme.raised : theme.surface;
    c.fill(1, y, c.w - 2, 1, { bg: rowBg });
    c.text(2, y, here ? "›" : " ", { fg: theme.brandBright, bg: rowBg });
    c.text(4, y, pad(m.item.kind, 7), { fg: theme.faint, bg: rowBg });
    const label = m.item.label;
    c.text(12, y, truncate(label, c.w - 14), { fg: here ? theme.text : theme.sub, attr: here ? BOLD : 0, bg: rowBg });
    for (const at of m.at) {
      if (at < stringWidth(label)) c.cell(12 + at, y, label[at]!, { fg: theme.brandBright, attr: BOLD, bg: rowBg });
    }
  });
  const chosen = matches[o.selected]?.item;
  const y = c.h - 2;
  if (chosen) {
    segments(c, 3, y, chosen.command === null ? [["equals ", { ...s.faint, ...bg }], [chosen.note, { ...s.muted, ...bg }]] : [["equals ", { ...s.faint, ...bg }], [chosen.command, { ...s.brandBold, ...bg }]], c.w - 6);
  }
}

/** The warning for quitting while a push is still running. */
export function drawLeave(root: Canvas, state: State): void {
  const p = state.push;
  if (p.phase !== "running") return;
  const c = frame(root, 68, 11, "a push is still running");
  const bg = { bg: theme.surface };
  const lines: string[] = [
    `Right now: ${describeRunning(p.run)}.`,
    `Still to do: ${remaining(p.run).join(", ") || "nothing but the last step"}.`,
    "",
    "Leaving the bridge does not stop it. The push carries on by itself, and fleet will wait for it in this terminal and print how it ended.",
  ];
  let y = 2;
  for (const line of lines) for (const t of wrap(line, c.w - 6).concat(line === "" ? [""] : [])) c.text(3, y++, t, { ...s.text, ...bg });
  segments(c, 3, c.h - 2, [["q", { ...s.brandBold, ...bg }], [" leave anyway    ", { ...s.muted, ...bg }], ["esc", { ...s.brandBold, ...bg }], [" stay", { ...s.muted, ...bg }]]);
}
