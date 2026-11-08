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
export const PARTS: { kind: ContextKind; colour: number; plain: string }[] = [
  { kind: "instructions", colour: theme.brand, plain: "█" },
  { kind: "skills", colour: theme.info, plain: "▓" },
  { kind: "mcp", colour: theme.warn, plain: "░" },
];

const paint = (level: Level, colour: number, text: string): string => {
  const params = colorParams(colour, level, false);
  return params === "" ? text : `\u001b[${params}m${text}\u001b[0m`;
};

const tokensOf = (agent: AgentContext, kind: ContextKind): number => agent[kind].tokens;

/** Cells for each part of a bar `width` cells wide, by rounding where the part ends so the bar is as long as the total says, and a part that is there keeps one cell. */
export function cells(agent: AgentContext, largest: number, width: number = BAR_WIDTH): number[] {
  if (largest === 0) return PARTS.map(() => 0);
  let sum = 0;
  let before = 0;
  const widths = PARTS.map(({ kind }) => {
    sum += tokensOf(agent, kind);
    const edge = Math.round((width * sum) / largest);
    const cellsOfPart = edge - before;
    before = edge;
    return cellsOfPart;
  }).map((n, i) => (n === 0 && tokensOf(agent, PARTS[i]!.kind) > 0 ? 1 : n));
  while (widths.reduce((a, b) => a + b, 0) > width) widths[widths.indexOf(Math.max(...widths))]!--;
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

/** What each part of an agent weighs, in words: `none`, `~3.4k (12)`, `up to ~14.2k (3, 1 not measured)`. */
export function partTexts(agent: AgentContext): Record<ContextKind, string> {
  const { instructions, skills, mcp } = agent;
  return {
    instructions: instructions.count === 0 ? "none" : formatTokens(instructions.tokens),
    skills: skills.count === 0 ? "none" : `${formatTokens(skills.tokens)} (${skills.count})`,
    mcp:
      mcp.count === 0
        ? "none"
        : mcp.unmeasured === mcp.count
          ? `not measured (${mcp.count})`
          : `up to ${formatTokens(mcp.tokens)} (${mcp.count}${mcp.unmeasured > 0 ? `, ${mcp.unmeasured} not measured` : ""})`,
  };
}

/** An agent's total, with a `+` when a server is not measured and the total leaves it out. */
export const totalText = (agent: AgentContext): string => `${formatTokens(agent.tokens)}${agent.complete ? "" : "+"}`;

function facts(agent: AgentContext, level: Level): string {
  const texts = partTexts(agent);
  return PARTS.map((part) => `${paint(level, part.colour, part.kind)} ${texts[part.kind]}`).join(" · ");
}

// ---- items ----

const key = (item: ContextItem): string => `${item.kind}\0${item.name}`;
const bySize = (a: ContextItem, b: ContextItem): number => (b.tokens ?? -1) - (a.tokens ?? -1) || a.name.localeCompare(b.name);

/** Each item once, the same skill or server on two agents being one thing; the larger of the two when they differ. */
export function distinct(report: ContextReport, keep: (item: ContextItem) => boolean): ContextItem[] {
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

/** What doctor found for a server, as the result it saves: `auth-needed` is a server that wants a login. */
const LOGIN = "auth-needed";

/**
 * Why a server has no size, as the short text after its name: running doctor again helps only a server doctor has
 * not checked. A server that wants a login stays unmeasured, because doctor does not log in.
 */
export function unmeasuredReason(item: ContextItem, many = false): string {
  if (!item.fromConfig) return "not from config, doctor does not measure it";
  if (item.doctor === LOGIN) return many ? "need a login, so doctor cannot list their tools" : "needs a login, so doctor cannot list its tools";
  if (item.doctor === null || item.doctor === "ok") return "run fleet doctor";
  return `the last doctor run gave ${item.doctor}`;
}

/** Each server with no size once, across agents, keeping the entry that says the most about why. */
function unmeasuredServers(report: ContextReport): ContextItem[] {
  const seen = new Map<string, ContextItem>();
  for (const i of report.agents.flatMap((a) => a.items)) {
    if (i.kind !== "mcp" || i.tokens !== null) continue;
    const before = seen.get(i.name);
    if (before === undefined || (i.fromConfig && !before.fromConfig) || (i.fromConfig === before.fromConfig && before.doctor === null && i.doctor !== null)) seen.set(i.name, i);
  }
  return [...seen.values()];
}

/** The servers with no size, grouped by why: `issues, metrics (need a login, ...)`. */
function unmeasuredGroups(report: ContextReport): string[] {
  const groups = new Map<string, { item: ContextItem; names: string[] }>();
  for (const i of unmeasuredServers(report)) {
    const one = unmeasuredReason(i);
    const group = groups.get(one) ?? { item: i, names: [] };
    group.names.push(i.name);
    groups.set(one, group);
  }
  return [...groups.values()].map(({ item, names }) => `${names.join(", ")} (${unmeasuredReason(item, names.length > 1)})`);
}

/** The tokens of the largest agent in `reports`: the width of a full bar, when several hosts are drawn on one scale. */
export const largestAgent = (reports: ContextReport[]): number => Math.max(0, ...reports.flatMap((r) => r.agents.map((a) => a.tokens)));

/** `scale` is the tokens a full bar stands for, the report's own largest agent unless given. */
export function renderContext(report: ContextReport, level: Level, scale: number = largestAgent([report])): string {
  const largest = scale;
  const nameWidth = Math.max(...report.agents.map((a) => a.agent.length));
  const totals = report.agents.map(totalText);
  const totalWidth = Math.max(...totals.map((t) => t.length));
  const lines = report.agents.map((a, i) => `${a.agent.padEnd(nameWidth)}  ${bar(a, largest, level)}  ${totals[i]!.padStart(totalWidth)}   ${facts(a, level)}`);

  const top = largestItems(report);
  const unmeasured = unmeasuredGroups(report);
  const stale = distinct(report, (i) => i.measurement?.current === false).map((i) => i.name);
  const unmanaged = distinct(report, (i) => !i.fromConfig);

  const below = [
    ...(top.length > 0 ? [row("largest", top.map(describe))] : []),
    ...(unmeasured.length > 0 ? [row("not measured", unmeasured)] : []),
    ...(stale.length > 0 ? [row("out of date", [`${stale.join(", ")} (measured before the last change; run fleet doctor)`])] : []),
    ...(unmanaged.length > 0 ? [row("not from config", [...unmanaged.slice(0, UNMANAGED_SHOWN).map(short), ...(unmanaged.length > UNMANAGED_SHOWN ? [`+${unmanaged.length - UNMANAGED_SHOWN} more`] : [])])] : []),
    ...(report.agents.some((a) => !a.complete) ? ["A + after a total means a server was not measured, so the total is incomplete."] : []),
  ];
  return [...lines, ...(below.length > 0 ? ["", ...below] : [])].join("\n");
}
