import { AGENTS, agentById } from "./agents/index.ts";
import type { AgentId } from "./agents/index.ts";
import type { HistoryCount } from "./agents/history.ts";
import { agentContext } from "./context.ts";
import type { AgentContext, ContextItem, ContextReport } from "./context.ts";
import { count, printable } from "./status.ts";
import { isObject } from "./yamlfile.ts";

/**
 * How often each MCP server and skill was used, from each agent's own history: the data of `fleet context --usage`.
 * Each agent adapter reads its history (`usage` in `src/agents/`); this module asks it, puts the answers together,
 * and reads what another host sent. Every number here is a count and every name is one fleet already knows from the
 * agent's config: no text from a transcript is ever kept, returned or sent over ssh.
 */

/** How far back history is counted, in days. */
export const WINDOW_DAYS = 30;

/** Said at the end of the output, and in the docs. */
export const PRIVACY_NOTE = "read locally, names and counts only";

export type UsageCount = HistoryCount;

/** `ok`: counted. `none`: the agent keeps no history fleet can read. `unavailable`: it does, and this run could not read it. */
export type AgentUsage = {
  agent: AgentId;
  status: "ok" | "none" | "unavailable";
  /** Why it is not `ok`, or null. */
  reason: string | null;
  /** How many days of history there were, at most `windowDays`. */
  days: number;
  /** Top-level sessions with activity in the window. */
  sessions: number;
  servers: UsageCount[];
  skills: UsageCount[];
};

export type UsageReport = { windowDays: number; agents: AgentUsage[]; note: string };

const names = (items: ContextItem[], kind: "mcp" | "skills"): string[] => items.filter((i) => i.kind === kind).map((i) => i.name);

/**
 * Counts what `report` lists: each agent's history is read for the servers and skills the report names, and for
 * nothing else. An agent that cannot be read is reported with why, and the others are still counted.
 */
export async function collectUsage(report: ContextReport, home: string, env: NodeJS.ProcessEnv, now: Date): Promise<UsageReport> {
  const agents: AgentUsage[] = [];
  for (const context of report.agents) {
    const agent = agentById(context.agent);
    const blank = { agent: context.agent, days: 0, sessions: 0, servers: [], skills: [] };
    if (agent?.usage === undefined) {
      agents.push({ ...blank, status: "none", reason: "no readable history" });
      continue;
    }
    try {
      const read = await agent.usage.read({ home, env, now, windowDays: WINDOW_DAYS, servers: names(context.items, "mcp"), skills: names(context.items, "skills") });
      agents.push(read.ok ? { agent: context.agent, status: "ok", reason: null, days: read.days, sessions: read.sessions, servers: read.servers, skills: read.skills } : { ...blank, status: read.kind, reason: read.reason });
    } catch {
      agents.push({ ...blank, status: "unavailable", reason: "its history could not be read" });
    }
  }
  return { windowDays: WINDOW_DAYS, agents, note: PRIVACY_NOTE };
}

export const usageOf = (usage: UsageReport | undefined, agent: AgentId): AgentUsage | null => usage?.agents.find((a) => a.agent === agent) ?? null;

/** What an agent's history says about one server or skill, or null when it was not counted. */
export const countOf = (usage: AgentUsage | null, item: ContextItem): UsageCount | null =>
  usage === null || usage.status !== "ok" || item.kind === "instructions" ? null : ((item.kind === "mcp" ? usage.servers : usage.skills).find((c) => c.name === item.name) ?? null);

/** A server or skill that costs this much or more, and was never called, is worth a suggestion. Below it there is little to save. */
export const HINT_MIN_TOKENS = 1000;

/** True when the history covers the whole window and the server or skill was still never called. With less history it may just not have been needed yet. */
export const neverCalled = (report: UsageReport, usage: AgentUsage | null, found: UsageCount | null): boolean => usage !== null && usage.status === "ok" && usage.days >= report.windowDays && found !== null && found.calls === 0;

// ---- several hosts ----

const addCounts = (lists: UsageCount[][]): UsageCount[] => {
  const sum = new Map<string, UsageCount>();
  for (const c of lists.flat()) {
    const before = sum.get(c.name);
    sum.set(c.name, { name: c.name, calls: (before?.calls ?? 0) + c.calls, sessions: (before?.sessions ?? 0) + c.sessions });
  }
  return [...sum.values()];
};

/**
 * Every host's usage added up per agent and name. The history is as long as the shortest one that was counted, so
 * a machine set up last week stops a server being called "never used in 30 days".
 */
export function sumUsage(reports: UsageReport[]): UsageReport {
  const agents = AGENTS.flatMap(({ id }): AgentUsage[] => {
    const all = reports.flatMap((r) => r.agents.filter((a) => a.agent === id));
    if (all.length === 0) return [];
    const counted = all.filter((a) => a.status === "ok");
    if (counted.length === 0) {
      const first = all.find((a) => a.status === "unavailable") ?? all[0]!;
      return [{ agent: id, status: first.status, reason: first.reason, days: 0, sessions: 0, servers: [], skills: [] }];
    }
    return [
      {
        agent: id,
        status: "ok",
        reason: null,
        days: Math.min(...counted.map((a) => a.days)),
        sessions: counted.reduce((n, a) => n + a.sessions, 0),
        servers: addCounts(counted.map((a) => a.servers)),
        skills: addCounts(counted.map((a) => a.skills)),
      },
    ];
  });
  return { windowDays: WINDOW_DAYS, agents, note: PRIVACY_NOTE };
}

/** One report from the startup contexts of several hosts: each server and skill once, the larger size when hosts differ, with their usage added up. */
export function combineReports(reports: ContextReport[]): ContextReport {
  const agents = AGENTS.flatMap(({ id }): AgentContext[] => {
    const of = reports.flatMap((r) => r.agents.filter((a) => a.agent === id));
    if (of.length === 0) return [];
    const items = new Map<string, ContextItem>();
    for (const item of of.flatMap((a) => a.items)) {
      const key = `${item.kind}\0${item.name}`;
      const before = items.get(key);
      if (before === undefined || (item.tokens ?? -1) > (before.tokens ?? -1)) items.set(key, item);
    }
    return [agentContext(id, [...items.values()], [])];
  });
  const usages = reports.flatMap((r) => (r.usage === undefined ? [] : [r.usage]));
  return { agents, notes: [], ...(usages.length === 0 ? {} : { usage: sumUsage(usages) }) };
}

// ---- what another host sent ----

const MAX_NAMES = 2000;
/** More than any history holds; a bigger number is a host that is wrong. */
const MAX_COUNT = 1_000_000_000;

const bounded = (value: unknown): number | null => {
  const n = count(value);
  return n !== null && n <= MAX_COUNT ? n : null;
};

function readCounts(value: unknown): UsageCount[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_NAMES).flatMap((entry): UsageCount[] => {
    if (!isObject(entry)) return [];
    const [name, calls, sessions] = [printable(entry.name), bounded(entry.calls), bounded(entry.sessions)];
    return name === null || name === "" || calls === null || sessions === null ? [] : [{ name, calls, sessions }];
  });
}

/**
 * The `usage` of a host's `fleet context --json`, cut down to the fields fleet knows, printable names and bounded
 * numbers. Null when the host sent none, as one that was not asked does, or one with an older fleet.
 */
export function readUsage(value: unknown): UsageReport | null {
  const listed: unknown = isObject(value) ? value.agents : null;
  if (!Array.isArray(listed)) return null;
  const agents = AGENTS.flatMap(({ id }): AgentUsage[] => {
    const found = listed.find((a: unknown) => isObject(a) && a.agent === id);
    if (!isObject(found)) return [];
    const status = found.status === "ok" || found.status === "none" || found.status === "unavailable" ? found.status : null;
    const [days, sessions] = [bounded(found.days), bounded(found.sessions)];
    if (status === null || days === null || sessions === null) return [];
    return [{ agent: id, status, reason: printable(found.reason), days: Math.min(days, WINDOW_DAYS), sessions, servers: readCounts(found.servers), skills: readCounts(found.skills) }];
  });
  return { windowDays: WINDOW_DAYS, agents, note: PRIVACY_NOTE };
}
