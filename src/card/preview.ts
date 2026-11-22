import { paint } from "../output.ts";
import { gridMax } from "./data.ts";
import type { CardData, Grid } from "./data.ts";
import { hidden, labelOf, plural, pushesText, shown, sinceText } from "./words.ts";

const BARS = "▁▂▃▄▅▆▇█";

/** A week to a character, the busiest week the tallest. A week with no commit is the lowest bar, one with any is above it. */
export function sparkline(grid: Grid): string {
  const weeks = grid.map((week) => week.reduce<number>((sum, day) => sum + (day ?? 0), 0));
  const max = Math.max(0, ...weeks);
  return weeks.map((w) => (w === 0 || max === 0 ? BARS[0]! : BARS[Math.min(7, 1 + Math.floor((6 * w) / max))]!)).join("");
}

export const unseen = (data: CardData): number[] => data.hosts.flatMap((h, i) => (h.seen ? [] : [i]));

/**
 * What `fleet card` prints before it writes the file: the card in words, with the same hostnames the card has. A host the
 * bridge never saw is said so, because the card is made from what was last seen and asks no host.
 */
export function previewText(data: CardData, names: boolean, color: boolean): string {
  const list = shown(data);
  const label = (i: number) => labelOf(i, list[i]!, names);
  const wide = Math.max(0, ...list.map((_, i) => label(i).length));
  const agents = list.map((h) => (h.agents === null ? "(not seen yet)" : h.agents.join(" ")));
  const agentsWide = Math.max(0, ...agents.map((a) => a.length));
  const dim = (t: string) => paint(color, "dim", t);
  const lines = [
    `  ${paint(color, "green", "●")} fleet   ${dim([plural(data.hosts.length, "machine"), plural(data.agents, "agent"), plural(data.skills, "skill"), plural(data.servers, "MCP server")].join(" · "))}`,
    "",
    ...list.map((h, i) => `  ${label(i).padEnd(wide)}  ${agents[i]!.padEnd(agentsWide)}   ${dim(h.os ?? "")}`.trimEnd()),
    ...(hidden(data) > 0 ? [`  ${dim(`+${hidden(data)} more`)}`] : []),
  ];
  const missing = unseen(data).filter((i) => i < list.length);
  if (missing.length > 0) {
    lines.push("", `  ${dim(`${missing.map(label).join(", ")} ${missing.length === 1 ? "was" : "were"} never seen by the bridge, so ${missing.length === 1 ? "its" : "their"} agents and OS are blank. fleet bridge reads ${missing.length === 1 ? "it" : "them"}.`)}`);
  }
  if (data.activity !== null && gridMax(data.activity) > 0) lines.push("", `  ${dim("activity, 12 months")}  ${paint(color, "green", sparkline(data.activity))}`);
  lines.push("", `  ${dim(`${plural(data.changes, "change")} this year · ${pushesText(data)}${sinceText(data)} · hostnames ${names ? "shown" : "hidden"}`)}`);
  return lines.join("\n");
}
