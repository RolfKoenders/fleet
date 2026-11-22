import { join } from "node:path";
import { having } from "../agents/index.ts";
import type { AgentId, Has, Registered } from "../agents/index.ts";
import { RESERVED_SKILLS } from "../catalog.ts";
import { appliedBy, skillItems } from "../context.ts";
import { lookup, readDoc } from "../keys.ts";
import { expandTarget } from "../plan.ts";
import { UNMANAGED_ITEM } from "../config.ts";
import { isObject, isStringList, parseFile } from "../yamlfile.ts";
import type { Obj } from "../yamlfile.ts";

/**
 * What this machine has that fleet did not put there: the MCP servers in each agent's file and the skills in each agent's
 * directories, minus what the applied state records and what the host file's `unmanaged` lists. It reads this machine and
 * nothing else. An entry's definition is held in memory for the caller and never printed (it holds tokens).
 */

export type LocalMcp = { name: string; entries: { agent: Has<"mcp">; entry: Obj }[] };
export type LocalSkill = { name: string; /** `~/...` of the skill's directory. */ path: string };
export type Local = { mcp: LocalMcp[]; skills: LocalSkill[]; notes: string[] };

/** The host file's `unmanaged` list as it stands, read alone: a host file that does not load says nothing here, `loadConfig` reports it. */
export function ignoredItems(configDir: string, host: string): string[] {
  const doc = parseFile(join(configDir, "hosts", `${host}.yaml`), true, []);
  const list = doc?.unmanaged;
  return isStringList(list) ? list.filter((item) => UNMANAGED_ITEM.test(item)) : [];
}

export const itemId = (kind: "mcp" | "skill", name: string): string => `${kind}:${name}`;

/** Everything on `home` that is not from config and not ignored, for the agents the host gets. */
export function readLocal(home: string, agents: readonly Registered[], ignored: readonly string[]): Local {
  const notes: string[] = [];
  const applied = appliedBy(home, notes);
  const mcp = new Map<string, LocalMcp>();
  for (const agent of having("mcp", agents)) {
    const { file, key, skip } = agent.mcp;
    const read = readDoc(expandTarget(file, home));
    if ("problem" in read) {
      notes.push(`${file} cannot be read (${read.problem})`);
      continue;
    }
    const found = lookup(read.doc, key);
    if (found.type !== "found" || !isObject(found.value)) continue;
    for (const [name, entry] of Object.entries(found.value)) {
      if (!isObject(entry) || skip?.(entry) === true || applied.hasKey(file, `${key}.${name}`) || ignored.includes(itemId("mcp", name))) continue;
      const item = mcp.get(name) ?? { name, entries: [] };
      item.entries.push({ agent, entry });
      mcp.set(name, item);
    }
  }
  const skills = new Map<string, LocalSkill>();
  for (const agent of agents) {
    for (const item of skillItems(agent, home, applied, notes)) {
      if (item.fromConfig || RESERVED_SKILLS.includes(item.name) || ignored.includes(itemId("skill", item.name)) || skills.has(item.name) || item.path === null) continue;
      skills.set(item.name, { name: item.name, path: item.path });
    }
  }
  return { mcp: [...mcp.values()].sort((a, b) => a.name.localeCompare(b.name)), skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)), notes };
}

/** How many MCP servers and skills are on `home` and not from config, not counting what the host ignores. */
export function countUnmanaged(home: string, agents: readonly Registered[], ignored: readonly string[]): number {
  const local = readLocal(home, agents, ignored);
  return local.mcp.length + local.skills.length;
}

export const agentIds = (entries: { agent: { id: AgentId } }[]): AgentId[] => entries.map((e) => e.agent.id);
