/**
 * What an agent adapter gives `fleet context --usage`: a way to count, in the agent's own history, how often each
 * MCP server and skill was used. A reader keeps only tool names, skill names, session ids and times, and discards
 * every other part of what it reads as it goes. Nothing it returns holds text from a prompt, a file or a tool result.
 */

export type HistoryRequest = {
  home: string;
  env: NodeJS.ProcessEnv;
  now: Date;
  /** How far back to count, in days. */
  windowDays: number;
  /** The names of the agent's configured MCP servers. Calls to any other server are not counted. */
  servers: string[];
  /** The names of the skills the agent knows. A skill that is not one of them is not counted. */
  skills: string[];
};

/** How one server or skill was used: calls, and the top-level sessions that made at least one. */
export type HistoryCount = { name: string; calls: number; sessions: number };

export type HistoryRead =
  | {
      ok: true;
      /** How many days of history there were, at most `windowDays`. 0 when the agent has none. */
      days: number;
      /** Top-level sessions with activity in the window. */
      sessions: number;
      /** One entry for every name asked for, so a name never used is there with 0 calls. */
      servers: HistoryCount[];
      skills: HistoryCount[];
    }
  // `none`: the agent keeps no history fleet can read. `unavailable`: it does, but this run could not read it.
  | { ok: false; kind: "none" | "unavailable"; reason: string };

export const DAY_MS = 86_400_000;

/** Whole days from `then` to `now`, rounded up so that a history that starts today is one day, and 0 for no history. */
export const daysSince = (then: number | null, now: number): number => (then === null ? 0 : Math.max(1, Math.ceil((now - then) / DAY_MS)));

/** The name as an agent puts it into a tool name: anything outside `A-Za-z0-9_-` becomes `_`. */
export const toolSafe = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, "_");

/** The configured name a tool name starts with, `<name><separator>` being the part before the tool's own name. The longest wins, since names contain the separator too. */
export function serverOfTool(tool: string, names: string[], separator: string): string | null {
  let best: { name: string; length: number } | null = null;
  for (const name of names) {
    const safe = toolSafe(name);
    if (safe !== "" && tool.startsWith(safe + separator) && (best === null || safe.length > best.length)) best = { name, length: safe.length };
  }
  return best?.name ?? null;
}

/** Counts calls per name, and the sessions each name was called in. Only names it was created with are kept. */
export class Tally {
  readonly sessions = new Set<string>();
  readonly #calls: Record<"servers" | "skills", Map<string, { calls: number; sessions: Set<string> }>>;

  constructor(servers: string[], skills: string[]) {
    const empty = (names: string[]) => new Map(names.map((n) => [n, { calls: 0, sessions: new Set<string>() }]));
    this.#calls = { servers: empty(servers), skills: empty(skills) };
  }

  /** Counts one call. A name that was not asked for is ignored, so only configured names are ever kept. */
  call(kind: "servers" | "skills", name: string, session: string): void {
    const entry = this.#calls[kind].get(name);
    if (entry === undefined) return;
    entry.calls++;
    entry.sessions.add(session);
    this.sessions.add(session);
  }

  has(kind: "servers" | "skills", name: string): boolean {
    return this.#calls[kind].has(name);
  }

  counts(kind: "servers" | "skills"): HistoryCount[] {
    return [...this.#calls[kind]].map(([name, e]) => ({ name, calls: e.calls, sessions: e.sessions.size }));
  }
}

/** `node:sqlite` warns that it is experimental on some Node versions. Suppressed here, and only that warning, so it is not printed over the screen. */
let quiet = 0;
let emitWarning: typeof process.emitWarning | null = null;

/** Runs `work` while the `node:sqlite` ExperimentalWarning is dropped. Every other warning goes through. */
export async function withoutSqliteWarning<T>(work: () => Promise<T> | T): Promise<T> {
  if (quiet++ === 0) {
    emitWarning = process.emitWarning;
    const original = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      const text = typeof warning === "string" ? warning : warning.message;
      const first = rest[0];
      const type = typeof first === "string" ? first : typeof first === "object" && first !== null && "type" in first ? String(first.type) : typeof warning === "string" ? "Warning" : warning.name;
      if (type === "ExperimentalWarning" && /sqlite/i.test(text)) return;
      return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
  }
  try {
    return await work();
  } finally {
    if (--quiet === 0 && emitWarning !== null) {
      process.emitWarning = emitWarning;
      emitWarning = null;
    }
  }
}
