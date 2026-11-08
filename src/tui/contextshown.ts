import { KINDS, readTokens } from "../contextread.ts";
import type { AgentContext, ContextItem, ContextKind, ContextPart, ContextReport } from "../context.ts";
import { formatTokens } from "../tokens.ts";
import { count, printable } from "../status.ts";
import { isObject } from "../yamlfile.ts";

/**
 * A host's startup context as the bridge keeps it: a `ContextReport` cut down to what its screen and cards show.
 * The three parts of each agent keep their full counts and sizes; of the items only the largest and the ones
 * with no size are kept, as `kind`, `name`, `tokens`, `fromConfig` and `doctor`. Paths, measurement times and notes are
 * gone. The same cut is made on a live answer and on what is read back from the bridge's memory, so a screen
 * looks the same either way.
 */

const AGENTS = ["claude", "opencode"] as const;
const SIZED = 10;
const UNSIZED = 6;
const MAX_AGENTS = AGENTS.length;

const bySize = (a: ContextItem, b: ContextItem): number => (b.tokens ?? -1) - (a.tokens ?? -1) || a.name.localeCompare(b.name);

const plain = (i: ContextItem): ContextItem => ({ kind: i.kind, name: i.name, path: null, tokens: i.tokens, fromConfig: i.fromConfig, measurement: null, doctor: i.doctor });

/** The largest items of an agent with a size, and the servers with none. */
function kept(items: ContextItem[]): ContextItem[] {
  const sorted = [...items].sort(bySize);
  return [...sorted.filter((i) => i.tokens !== null).slice(0, SIZED), ...sorted.filter((i) => i.tokens === null).slice(0, UNSIZED)].map(plain);
}

const agentOf = (a: AgentContext): AgentContext => ({ ...a, items: kept(a.items), notes: [] });

export const shown = (report: ContextReport): ContextReport => ({ agents: report.agents.map(agentOf), notes: [] });

// ---- what the cards say ----

/** The heaviest agent's total, with a `+` when any agent leaves a server out, or null when there is nothing to total. */
export function totalLine(report: ContextReport | null): string | null {
  if (report === null || report.agents.length === 0) return null;
  const largest = Math.max(...report.agents.map((a) => a.tokens));
  return `${formatTokens(largest)}${report.agents.every((a) => a.complete) ? "" : "+"}`;
}

// ---- the bridge's memory ----

const part = (p: ContextPart): ContextPart => ({ tokens: p.tokens, count: p.count, unmeasured: p.unmeasured });

/** What goes into the memory file: the fields above and nothing else. */
export function toMemory(report: ContextReport): unknown {
  return {
    agents: report.agents.map((a) => ({
      agent: a.agent,
      instructions: part(a.instructions),
      skills: part(a.skills),
      mcp: part(a.mcp),
      items: a.items.map((i) => ({ kind: i.kind, name: i.name, tokens: i.tokens, fromConfig: i.fromConfig, doctor: i.doctor })),
    })),
  };
}

const readPart = (value: unknown): ContextPart | null => {
  if (!isObject(value)) return null;
  const [tokens, n, unmeasured] = [readTokens(value.tokens), count(value.count), count(value.unmeasured)];
  return tokens === null || n === null || unmeasured === null || unmeasured > n ? null : { tokens, count: n, unmeasured };
};

function readItem(value: unknown): ContextItem | null {
  if (!isObject(value)) return null;
  const kind = KINDS.find((k: ContextKind) => k === value.kind);
  const name = printable(value.name);
  if (kind === undefined || name === null || name === "") return null;
  return { kind, name, path: null, tokens: value.tokens === null ? null : readTokens(value.tokens), fromConfig: value.fromConfig === true, measurement: null, doctor: kind === "mcp" ? printable(value.doctor) : null };
}

/**
 * The remembered report in `value`, treated like text from a host: only the known fields, printable text, bounded
 * numbers. Null when it is not one, so a foreign or damaged entry is simply not shown.
 */
export function fromMemory(value: unknown): ContextReport | null {
  if (!isObject(value) || !Array.isArray(value.agents)) return null;
  const agents: AgentContext[] = [];
  for (const a of value.agents.slice(0, MAX_AGENTS)) {
    const name = isObject(a) ? AGENTS.find((n) => n === a.agent) : undefined;
    if (!isObject(a) || name === undefined) continue;
    const [instructions, skills, mcp] = [readPart(a.instructions), readPart(a.skills), readPart(a.mcp)];
    if (instructions === null || skills === null || mcp === null) continue;
    const items = (Array.isArray(a.items) ? a.items.slice(0, SIZED + UNSIZED) : []).flatMap((i) => readItem(i) ?? []);
    agents.push({ agent: name, tokens: instructions.tokens + skills.tokens + mcp.tokens, complete: mcp.unmeasured === 0, instructions, skills, mcp, items, notes: [] });
  }
  return agents.length === 0 ? null : { agents, notes: [] };
}
