import { agentContext } from "./context.ts";
import type { AgentContext, ContextItem, ContextKind, ContextReport, Measurement } from "./context.ts";
import { count, printable } from "./status.ts";
import { isObject } from "./yamlfile.ts";
import type { Obj } from "./yamlfile.ts";

/**
 * Reads what another host printed for `fleet context --json`. It runs nothing and draws nothing, so the ssh in
 * `contextall.ts` and a later view of every host can both use it.
 */

export type ContextRead = { ok: true; report: ContextReport } | { ok: false; reason: string };

const AGENTS = ["claude", "opencode"] as const;
export const KINDS: ContextKind[] = ["instructions", "skills", "mcp"];
const MAX_ITEMS = 2000;
const MAX_NOTES = 50;
/** Far more than any model reads; a bigger number is a host that is wrong, and would stretch every bar. */
const MAX_TOKENS = 1_000_000_000;

export const readTokens = (value: unknown): number | null => {
  const n = count(value);
  return n !== null && n <= MAX_TOKENS ? n : null;
};

function measurement(value: unknown): Measurement | null {
  if (!isObject(value)) return null;
  const measuredAt = printable(value.measuredAt);
  const ageSeconds = count(value.ageSeconds);
  if (measuredAt === null || ageSeconds === null) return null;
  return { tools: count(value.tools), measuredAt, ageSeconds, current: typeof value.current === "boolean" ? value.current : null };
}

function item(value: unknown): ContextItem | null {
  if (!isObject(value)) return null;
  const kind = KINDS.find((k) => k === value.kind);
  const name = printable(value.name);
  if (kind === undefined || name === null) return null;
  return { kind, name, path: kind === "mcp" ? null : printable(value.path), tokens: readTokens(value.tokens), fromConfig: value.fromConfig === true, measurement: kind === "mcp" ? measurement(value.measurement) : null };
}

const notes = (value: unknown): string[] => (Array.isArray(value) ? value.slice(0, MAX_NOTES).flatMap((n) => printable(n) ?? []) : []);

function agent(name: (typeof AGENTS)[number], value: Obj): AgentContext {
  const items = (Array.isArray(value.items) ? value.items.slice(0, MAX_ITEMS) : []).flatMap((i) => item(i) ?? []);
  // Totals are made from the items, not taken from the host, so a bar always agrees with the list under it.
  return agentContext(name, items, notes(value.notes));
}

/**
 * The report in `stdout`, cut down to the fields fleet knows and to printable text, because it is shown on a
 * terminal and a host can be wrong. An agent fleet does not
 * know is left out. The reason is for a person.
 */
export function readContextReport(stdout: string): ContextRead {
  let doc: Obj | null = null;
  try {
    const parsed: unknown = JSON.parse(stdout);
    doc = isObject(parsed) ? parsed : null;
  } catch {
    // not a document
  }
  if (doc === null) return { ok: false, reason: "its output was not a fleet context document" };
  const listed: unknown = doc.agents;
  if (doc.code !== "ok" || !Array.isArray(listed)) {
    const first = Array.isArray(doc.messages) ? printable(doc.messages[0]) : null;
    return { ok: false, reason: typeof doc.code === "string" && doc.code !== "ok" ? `its context gave ${printable(doc.code)}${first === null ? "" : `: ${first}`}` : "its output was not a fleet context document" };
  }
  const agents = AGENTS.flatMap((name) => {
    const found = listed.find((a: unknown) => isObject(a) && a.agent === name);
    return isObject(found) ? [agent(name, found)] : [];
  });
  if (agents.length === 0) return { ok: false, reason: "its context named no agent fleet knows" };
  return { ok: true, report: { agents, notes: notes(doc.notes) } };
}
