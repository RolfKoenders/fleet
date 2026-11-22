import { agentById } from "./agents/index.ts";
import type { ContextItem, ContextReport } from "./context.ts";
import { formatTokens } from "./tokens.ts";
import { countOf, HINT_MIN_TOKENS, neverCalled } from "./usage.ts";
import type { AgentUsage, UsageCount, UsageReport } from "./usage.ts";

/**
 * Draws the usage of a `ContextReport` that has some: a table for each agent that was counted, with the calls and the
 * share of sessions next to each server's and skill's size, then a line for each one never called that costs real tokens.
 */

/** Rows shown for each agent; the rest are counted in "+N more". The suggestions cover every row. */
const ROWS = 20;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

const nameOf = (agent: AgentUsage["agent"]): string => agentById(agent)?.name ?? agent;

/** `in 8% of sessions`, with `<1%` for a share that rounds to nothing, and `no sessions` where there were none. */
export function shareText(found: UsageCount, sessions: number): string {
  if (sessions === 0) return "no sessions";
  const percent = (100 * found.sessions) / sessions;
  return `in ${found.sessions === 0 ? "0%" : percent < 1 ? "<1%" : `${Math.round(percent)}%`} of sessions`;
}

/** `Claude Code: 30 days, opencode: 9 days`: how much history each counted agent had. */
export const historyText = (usage: UsageReport): string =>
  usage.agents.filter((a) => a.status === "ok").map((a) => `${nameOf(a.agent)}: ${a.days === 0 ? "no history" : plural(a.days, "day")}`).join(", ");

/** The lines for an agent that was not counted: `usage unavailable for opencode: ...`, or that it keeps no history fleet can read. */
export const uncountedLines = (usage: UsageReport): string[] =>
  usage.agents.flatMap((a) => (a.status === "unavailable" ? [`usage unavailable for ${nameOf(a.agent)}: ${a.reason ?? "unknown reason"}`] : a.status === "none" ? [`${nameOf(a.agent)}: ${a.reason ?? "no readable history"}`] : []));

type Row = { item: ContextItem; found: UsageCount };

/** What each server and skill of an agent costs and was used, the heaviest first. A server or skill the history was not asked about is not here. */
export function rowsOf(report: ContextReport, agent: AgentUsage): Row[] {
  const context = report.agents.find((a) => a.agent === agent.agent);
  return (context?.items ?? [])
    .flatMap((item): Row[] => {
      const found = countOf(agent, item);
      return found === null ? [] : [{ item, found }];
    })
    .sort((a, b) => (b.item.tokens ?? -1) - (a.item.tokens ?? -1) || a.item.name.localeCompare(b.item.name));
}

/** The suggestion for a server or skill: never called in the whole window, and it costs enough to matter. Null otherwise. */
export function hintFor(usage: UsageReport, agent: AgentUsage, row: Row): string | null {
  const { item, found } = row;
  if (!neverCalled(usage, agent, found) || item.tokens === null || item.tokens < HINT_MIN_TOKENS) return null;
  return `never called in ${usage.windowDays} days, ${formatTokens(item.tokens).replace(/^~/, "")} tokens per session: consider exclude`;
}

/** The suggestions of a report: one for each server or skill that has one. */
export function hints(report: ContextReport): { agent: AgentUsage["agent"]; kind: ContextItem["kind"]; name: string; text: string }[] {
  const usage = report.usage;
  if (usage === undefined) return [];
  return usage.agents.flatMap((agent) =>
    rowsOf(report, agent).flatMap((row) => {
      const text = hintFor(usage, agent, row);
      return text === null ? [] : [{ agent: agent.agent, kind: row.item.kind, name: row.item.name, text }];
    }),
  );
}

function table(report: ContextReport, usage: UsageReport, agent: AgentUsage): string[] {
  if (agent.days === 0) return [`${nameOf(agent.agent)}: no history`];
  const rows = rowsOf(report, agent);
  if (rows.length === 0) return [`${nameOf(agent.agent)}: ${plural(agent.sessions, "session")}, no servers or skills listed`];
  const shown = rows.slice(0, ROWS);
  const nameWidth = Math.max(...shown.map((r) => r.item.name.length));
  const sizeWidth = Math.max(...shown.map((r) => (r.item.tokens === null ? 0 : formatTokens(r.item.tokens).length)));
  const callsWidth = Math.max(...shown.map((r) => String(r.found.calls).length));
  const lines = shown.map(({ item, found }) => {
    const size = item.tokens === null ? "" : formatTokens(item.tokens);
    const label = item.kind === "mcp" ? "mcp  " : "skill";
    return `  ${item.name.padEnd(nameWidth)}  ${label}  ${size.padStart(sizeWidth)}  ${String(found.calls).padStart(callsWidth)} ${found.calls === 1 ? "call " : "calls"}  ${shareText(found, agent.sessions)}`;
  });
  return [`${nameOf(agent.agent)}: ${plural(agent.sessions, "session")}`, ...lines, ...(rows.length > ROWS ? [`  +${rows.length - ROWS} more`] : [])];
}

/**
 * The usage section, as lines, or none when the report has no usage. It does not end with the privacy note: the
 * caller puts that once at the end of everything it prints (see `PRIVACY_NOTE`).
 */
export function renderUsage(report: ContextReport, title: string = `usage, last ${report.usage?.windowDays ?? 0} days`): string[] {
  const usage = report.usage;
  if (usage === undefined) return [];
  const history = historyText(usage);
  const blocks = usage.agents.filter((a) => a.status === "ok").map((a) => table(report, usage, a).join("\n"));
  const suggestions = hints(report).map((h) => `  ${h.name} (${h.kind === "mcp" ? "mcp" : "skill"}, ${nameOf(h.agent)}): ${h.text}`);
  return [
    `${title}${history === "" ? "" : ` (${history})`}`,
    ...blocks.flatMap((b) => ["", b]),
    ...(suggestions.length > 0 ? ["", "suggestions", ...suggestions] : []),
    ...(uncountedLines(usage).length > 0 ? ["", ...uncountedLines(usage)] : []),
  ];
}
