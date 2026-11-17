import { homedir } from "node:os";
import { AGENTS, agentOf, leftAlone } from "./agents/index.ts";
import type { Agent, Registered } from "./agents/index.ts";
import { loadConfig } from "./config.ts";
import { findTool } from "./tools.ts";

/** The agents installed on this host: those whose binary `findTool` finds. */
export const detectAgents = (home: string = homedir(), env: NodeJS.ProcessEnv = process.env): Registered[] =>
  AGENTS.filter((a) => findTool(a.binary, env, home) !== null);

export const notInstalledWarning = (agent: Agent): string => `${agent.name}: not installed, its config is left as is. Install it, or pin \`agents:\``;

/**
 * One warning per agent that fleet has config for and cannot find: something wanted for it (`wanted`, the agents whose
 * config was dropped) or something it applied earlier (`applied`, `~/` paths), and no binary and no `agents:` list in
 * the host file. What the agent has on the host is left as it is.
 */
export function notInstalledWarnings(on: readonly Agent[], pin: readonly string[] | null, wanted: readonly Registered["id"][], applied: readonly string[]): string[] {
  if (pin !== null) return [];
  const had = new Set(applied.filter((path) => leftAlone(path, on)).map((path) => agentOf(path)?.id));
  return AGENTS.filter((a) => !on.some((o) => o.id === a.id) && (wanted.includes(a.id) || had.has(a.id))).map(notInstalledWarning);
}

/**
 * The agents this host gets: its host file's pin, else the installed ones. When the config cannot be read, the installed ones,
 * so a command that only reports does not fail for a broken config.
 */
export function agentsOnHost(configDir: string | null, host: string | null, home: string = homedir()): Registered[] {
  const detected = detectAgents(home);
  if (configDir === null || host === null) return detected;
  try {
    return loadConfig(configDir, host, { home, sources: "none", agents: detected }).agents;
  } catch {
    return detected;
  }
}
