import { antigravity } from "./antigravity.ts";
import { claude } from "./claude.ts";
import { opencode } from "./opencode.ts";
import type { Agent } from "./types.ts";

export type { Agent, McpServer, ProbeEntry } from "./types.ts";
export { CLAUDE_JSON } from "./claude.ts";

/**
 * Every agent fleet sets up, in the order they are listed and drawn. Adding one is its own file and a line here:
 * everything else loops over this.
 */
export const AGENTS = [claude, opencode, antigravity] as const;

export type Registered = (typeof AGENTS)[number];
export type AgentId = Registered["id"];

/** An agent that has the part `K`. */
export type Has<K extends Part, A extends Agent = Registered> = A & Required<Pick<Agent, K>>;

type Part = "settings" | "mcp" | "skills" | "instructions";

export const AGENT_IDS: readonly AgentId[] = AGENTS.map((a) => a.id);

export const agentById = (id: unknown): Registered | undefined => AGENTS.find((a) => a.id === id);

export const isAgentId = (id: unknown): id is AgentId => agentById(id) !== undefined;

/** The agents that have `part`, in registry order. */
export const having = <K extends Part, A extends Agent = Registered>(part: K, agents: readonly A[] = AGENTS as readonly Agent[] as readonly A[]): Has<K, A>[] =>
  agents.filter((a): a is Has<K, A> => a[part] !== undefined);

const inside = (path: string, home: string): boolean => path === home || path.startsWith(`${home}/`);

/** The agent that owns `path` (in `~/` form), or null for a path no agent owns. */
export const agentOf = <A extends Agent = Registered>(path: string, agents: readonly A[] = AGENTS as readonly Agent[] as readonly A[]): A | null =>
  agents.find((a) => a.homes.some((home) => inside(path, home))) ?? null;

/** Every merged file fleet plans: each agent's settings file, then the files its MCP servers are in. Each once. */
export const mergedFiles = (agents: readonly Agent[] = AGENTS): string[] => [
  ...new Set([...having("settings", agents).map((a) => a.settings.file), ...having("mcp", agents).map((a) => a.mcp.file)]),
];

/** The agent and server name an owned key is an MCP entry of, or null for any other key. */
export function mcpEntryOf(key: { file: string; path: string }): { agent: Has<"mcp">; name: string } | null {
  for (const agent of having("mcp")) {
    if (key.file === agent.mcp.file && key.path.startsWith(`${agent.mcp.key}.`)) return { agent, name: key.path.slice(agent.mcp.key.length + 1) };
  }
  return null;
}

/** True for a key in a file whose writes go through an agent's own binary. */
export const writtenByBinary = (key: { file: string }): boolean => having("mcp").some((a) => a.mcp.needsBinary === true && a.mcp.file === key.file);

/** Every directory fleet links skills into, over the registered agents. */
export const SKILL_TARGETS: string[] = [...new Set(AGENTS.flatMap((a) => (a.skills === undefined || a.skills.target === null ? [] : [a.skills.target])))];

/**
 * The directories fleet links skills into for the agents on a host: each one's own target, and for an agent
 * with none the directory it reads that another registered agent targets (opencode reads Claude's), so one
 * directory serves both and a second is never linked for the one that reads it.
 */
export function skillTargets(agents: readonly Agent[]): string[] {
  return [
    ...new Set(
      agents.flatMap((a) => {
        if (a.skills === undefined) return [];
        return a.skills.target !== null ? [a.skills.target] : a.skills.dirs.filter((d) => SKILL_TARGETS.includes(d));
      }),
    ),
  ];
}

/**
 * The agents a host gets: the ones its host file names when it names any, else the ones found on it. A named
 * agent is set up whether or not it is installed.
 */
export const hostAgents = (pin: readonly string[] | null, detected: readonly Agent[]): Registered[] =>
  pin === null ? AGENTS.filter((a) => detected.some((d) => d.id === a.id)) : AGENTS.filter((a) => pin.includes(a.id));

/**
 * True for a path fleet leaves as it is on a host that gets `on`: it belongs to an agent that is not among them,
 * and no agent that is reads it as a skill directory.
 */
export function leftAlone(path: string, on: readonly Agent[]): boolean {
  const owner = agentOf(path);
  if (owner === null || on.some((a) => a.id === owner.id)) return false;
  return !skillTargets(on).some((dir) => inside(path, dir));
}

const inHome = (dir: string): string => dir.slice(2);

/** Where the agents' installers put binaries, relative to the home directory. */
export const binDirs = (): string[] => AGENTS.flatMap((a) => a.binDirs.map(inHome));

/** The agents' words joined for a sentence: `claude or opencode`, `a, b or c`. */
export function sayAgents(pick: (agent: Agent) => string, word: "and" | "or" = "or", agents: readonly Agent[] = AGENTS): string {
  const names = agents.map(pick);
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} ${word} ${names.at(-1)}`;
}
