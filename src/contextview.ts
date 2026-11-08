import { ago } from "./status.ts";
import { formatTokens } from "./tokens.ts";
import { colorParams } from "./tui/color.ts";
import type { Level } from "./tui/color.ts";
import { theme } from "./tui/theme.ts";
import type { AgentContext, ContextItem, ContextKind, ContextReport } from "./context.ts";

/**
 * Draws a `ContextReport`: one stacked bar per agent, scaled to the largest (or to a scale given, to compare hosts), then the largest items and what is
 * missing. It takes the report whole, so a later view of several hosts can call it once per host.
 */

/** Cells of the largest agent's bar. */
export const BAR_WIDTH = 30;
const LABEL_WIDTH = 16;
const LARGEST = 3;
const UNMANAGED_SHOWN = 5;

/**
 * Each part in a colour of the bridge, and in its own character where there is no colour, so the split reads
 * without it. The bars have the same width either way.
 */
const PARTS: { kind: ContextKind; colour: number; plain: string }[] = [
  { kind: "instructions", colour: theme.brand, plain: "█" },
  { kind: "skills", colour: theme.info, plain: "▓" },
  { kind: "mcp", colour: theme.warn, plain: "░" },
];

const paint = (level: Level, colour: number, text: string): string => {
  const params = colorParams(colour, level, false);
  return params === "" ? text : `\u001b[${params}m${text}\u001b[0m`;
};

const tokensOf = (agent: AgentContext, kind: ContextKind): number => agent[kind].tokens;

/** Cells for each part, by rounding where the part ends so the bar is as long as the total says, and a part that is there keeps one cell. */
function cells(agent: AgentContext, largest: number): number[] {
  if (largest === 0) return PARTS.map(() => 0);
  let sum = 0;
  let before = 0;
  const widths = PARTS.map(({ kind }) => {
    sum += tokensOf(agent, kind);
    const edge = Math.round((BAR_WIDTH * sum) / largest);
    const width = edge - before;
    before = edge;
    return width;
  }).map((width, i) => (width === 0 && tokensOf(agent, PARTS[i]!.kind) > 0 ? 1 : width));
  while (widths.reduce((a, b) => a + b, 0) > BAR_WIDTH) widths[widths.indexOf(Math.max(...widths))]!--;
  return widths;
}

function bar(agent: AgentContext, largest: number, level: Level): string {
  const widths = cells(agent, largest);
  const drawn = PARTS.map((part, i) => {
    const glyph = level === "none" ? part.plain : "█";
    return paint(level, part.colour, glyph.repeat(widths[i]!));
  }).join("");
  return drawn + " ".repeat(BAR_WIDTH - widths.reduce((a, b) => a + b, 0));
}

function facts(agent: AgentContext, level: Level): string {
  const label = (kind: ContextKind) => paint(level, PARTS.find((p) => p.kind === kind)!.colour, kind);
  const { instructions, skills, mcp } = agent;
  const servers =
    mcp.count === 0
      ? "none"
      : mcp.unmeasured === mcp.count
        ? `not measured (${mcp.count})`
        : `up to ${formatTokens(mcp.tokens)} (${mcp.count}${mcp.unmeasured > 0 ? `, ${mcp.unmeasured} not measured` : ""})`;
  return [
    `${label("instructions")} ${instructions.count === 0 ? "none" : formatTokens(instructions.tokens)}`,
    `${label("skills")} ${skills.count === 0 ? "none" : `${formatTokens(skills.tokens)} (${skills.count})`}`,
    `${label("mcp")} ${servers}`,
  ].join(" · ");
}

// ---- items ----

const key = (item: ContextItem): string => `${item.kind}\0${item.name}`;
const bySize = (a: ContextItem, b: ContextItem): number => (b.tokens ?? -1) - (a.tokens ?? -1) || a.name.localeCompare(b.name);

/** Each item once, the same skill or server on two agents being one thing; the larger of the two when they differ. */
function distinct(report: ContextReport, keep: (item: ContextItem) => boolean): ContextItem[] {
  const seen = new Map<string, ContextItem>();
  for (const item of report.agents.flatMap((a) => a.items).filter(keep)) {
    const before = seen.get(key(item));
    if (before === undefined || bySize(item, before) < 0) seen.set(key(item), item);
  }
  return [...seen.values()].sort(bySize);
}

/** The biggest items with a known size, over every agent. */
export const largestItems = (report: ContextReport, n: number = LARGEST): ContextItem[] => distinct(report, (i) => i.tokens !== null).slice(0, n);

/** `measured 2d ago`, or that the config changed since. */
export function measuredText(item: ContextItem): string | null {
  const m = item.measurement;
  if (m === null) return null;
  return m.current === false ? "measured before the last change" : `measured ${ago(m.ageSeconds)}`;
}

const sizeOf = (item: ContextItem): string => (item.tokens === null ? "" : ` ${formatTokens(item.tokens)}`);

function describe(item: ContextItem): string {
  const base = item.kind === "skills" ? `${item.name} skill` : item.name;
  const tools = item.measurement?.tools;
  const details = [tools == null ? null : `${tools} tool${tools === 1 ? "" : "s"}`, measuredText(item), item.fromConfig ? null : "not from config"].filter((d) => d !== null);
  return `${base}${sizeOf(item)}${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
}

const short = (item: ContextItem): string => `${item.kind === "mcp" ? `${item.name} mcp` : item.kind === "skills" ? `${item.name} skill` : item.name}${sizeOf(item)}`;

const row = (label: string, parts: string[]): string => `${label.padEnd(LABEL_WIDTH)}${parts.join("   ")}`;

/** Server names across agents, with whether fleet put any of them there. */
function serverNames(items: ContextItem[]): { name: string; fromConfig: boolean }[] {
  const names = new Map<string, boolean>();
  for (const i of items) names.set(i.name, (names.get(i.name) ?? false) || i.fromConfig);
  return [...names].map(([name, fromConfig]) => ({ name, fromConfig }));
}

/** The tokens of the largest agent in `reports`: the width of a full bar, when several hosts are drawn on one scale. */
export const largestAgent = (reports: ContextReport[]): number => Math.max(0, ...reports.flatMap((r) => r.agents.map((a) => a.tokens)));

/** `scale` is the tokens a full bar stands for, the report's own largest agent unless given. */
export function renderContext(report: ContextReport, level: Level, scale: number = largestAgent([report])): string {
  const largest = scale;
  const nameWidth = Math.max(...report.agents.map((a) => a.agent.length));
  const totals = report.agents.map((a) => `${formatTokens(a.tokens)}${a.complete ? "" : "+"}`);
  const totalWidth = Math.max(...totals.map((t) => t.length));
  const lines = report.agents.map((a, i) => `${a.agent.padEnd(nameWidth)}  ${bar(a, largest, level)}  ${totals[i]!.padStart(totalWidth)}   ${facts(a, level)}`);

  const top = largestItems(report);
  const unmeasured = serverNames(distinct(report, (i) => i.kind === "mcp" && i.tokens === null));
  const toRun = unmeasured.filter((s) => s.fromConfig).map((s) => s.name);
  const stale = distinct(report, (i) => i.measurement?.current === false).map((i) => i.name);
  const unmanaged = distinct(report, (i) => !i.fromConfig);

  const below = [
    ...(top.length > 0 ? [row("largest", top.map(describe))] : []),
    ...(toRun.length > 0 || unmeasured.some((s) => !s.fromConfig)
      ? [row("not measured", [...(toRun.length > 0 ? [`${toRun.join(", ")} (run fleet doctor)`] : []), ...unmeasured.filter((s) => !s.fromConfig).map((s) => `${s.name} (not from config, doctor does not measure it)`)])]
      : []),
    ...(stale.length > 0 ? [row("out of date", [`${stale.join(", ")} (measured before the last change; run fleet doctor)`])] : []),
    ...(unmanaged.length > 0 ? [row("not from config", [...unmanaged.slice(0, UNMANAGED_SHOWN).map(short), ...(unmanaged.length > UNMANAGED_SHOWN ? [`+${unmanaged.length - UNMANAGED_SHOWN} more`] : [])])] : []),
    ...(report.agents.some((a) => !a.complete) ? ["A + after a total means a server was not measured, so the total is incomplete."] : []),
  ];
  return [...lines, ...(below.length > 0 ? ["", ...below] : [])].join("\n");
}
