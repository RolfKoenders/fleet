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
 * The agents fleet applied config for earlier (`applied`, `~/` paths) and cannot find now: no binary and no `agents:` list in
 * the host file. What they have on the host is left as it is. An agent the host never had config applied for is not named,
 * however much the shared config says about it, so nobody hears about an agent they do not use.
 */
export function notInstalledAgents(on: readonly Agent[], pin: readonly string[] | null, applied: readonly string[]): Registered["id"][] {
  if (pin !== null) return [];
  const had = new Set(applied.filter((path) => leftAlone(path, on)).map((path) => agentOf(path)?.id));
  return AGENTS.filter((a) => had.has(a.id) && !on.some((o) => o.id === a.id)).map((a) => a.id);
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
