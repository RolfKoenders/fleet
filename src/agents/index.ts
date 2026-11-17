import { claude } from "./claude.ts";
import { opencode } from "./opencode.ts";
import type { Agent } from "./types.ts";

export type { Agent, McpServer, ProbeEntry } from "./types.ts";
export { CLAUDE_JSON } from "./claude.ts";

/**
 * Every agent fleet sets up, in the order they are listed and drawn. Adding one is its own file and a line here:
 * everything else loops over this.
 */
export const AGENTS = [claude, opencode] as const;

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

/** The directory fleet links skills into. An agent with no target of its own reads it too, so one directory serves them all. */
export const SKILL_DIR: string = having("skills").flatMap((a) => (a.skills.target === null ? [] : [a.skills.target]))[0]!;

const inHome = (dir: string): string => dir.slice(2);

/** Where the agents' installers put binaries, relative to the home directory. */
export const binDirs = (): string[] => AGENTS.flatMap((a) => a.binDirs.map(inHome));

/** The agents' words joined for a sentence: `claude or opencode`, `a, b or c`. */
export function sayAgents(pick: (agent: Agent) => string, word: "and" | "or" = "or", agents: readonly Agent[] = AGENTS): string {
  const names = agents.map(pick);
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} ${word} ${names.at(-1)}`;
}
