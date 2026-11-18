import { homedir } from "node:os";
import { AGENTS, agentOf, leftAlone } from "./agents/index.ts";
import type { Agent, Registered } from "./agents/index.ts";
import { loadConfig } from "./config.ts";
import type { AppliedState } from "./state.ts";
import { findTool } from "./tools.ts";

/** The agents installed on this host: those whose binary `findTool` finds. */
export const detectAgents = (home: string = homedir(), env: NodeJS.ProcessEnv = process.env): Registered[] =>
  AGENTS.filter((a) => findTool(a.binary, env, home) !== null);

export const notInstalledWarning = (agent: Agent): string => `${agent.name}: not installed, its config is left as is. Install it, or pin \`agents:\``;

/** The paths (`~/` form) fleet applied: every link it made and every key it wrote. */
export const appliedPaths = (state: AppliedState | null): string[] => [...(state?.keys ?? []).map((k) => k.file), ...(state?.links ?? []).map((l) => l.target)];

/** The agents off the host (`on` leaves them out) that fleet applied config for: what it has there is left as it is. */
function appliedElsewhere(on: readonly Agent[], applied: readonly string[]): Registered[] {
  const had = new Set(applied.filter((path) => leftAlone(path, on)).map((path) => agentOf(path)?.id));
  return AGENTS.filter((a) => had.has(a.id) && !on.some((o) => o.id === a.id));
}

/**
 * The agents fleet applied config for earlier (`applied`, `~/` paths) and cannot find now: no binary and no `agents:` list in
 * the host file. What they have on the host is left as it is. An agent the host never had config applied for is not named,
 * however much the shared config says about it, so nobody hears about an agent they do not use.
 */
export const notInstalledAgents = (on: readonly Agent[], pin: readonly string[] | null, applied: readonly string[]): Registered["id"][] =>
  pin !== null ? [] : appliedElsewhere(on, applied).map((a) => a.id);

/**
 * The agents a host's status, the bridge and the TUI name: the ones it gets (installed, or pinned in its host file) and the
 * installed ones it does not get (`agents:` leaves them out), and the ones fleet applied config for earlier. An agent that is none of
 * those is not mentioned, so a new agent changes nothing on a host that has nothing to do with it.
 */
export const namedAgents = (on: readonly Agent[], detected: readonly Agent[], applied: readonly string[]): Registered[] => {
  const left = appliedElsewhere(on, applied);
  return AGENTS.filter((a) => on.includes(a) || detected.includes(a) || left.includes(a));
};

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
