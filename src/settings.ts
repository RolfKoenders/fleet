import { agentById, AGENTS } from "./agents/index.ts";
import type { Agent, Has } from "./agents/index.ts";
import { isObject } from "./yamlfile.ts";
import type { Obj } from "./yamlfile.ts";

/** The merged file each agent's `settings` map is written into. */
export const settingsFile = (id: string): string => (agentById(id) as Has<"settings">).settings.file;

/** One owned key as a host file declares it: a dotted path and the whole value at it. */
export type Declared = { agent: string; path: string; value: unknown };

/**
 * One owned key as the config resolves it, naming the file it lives in. `display` is the
 * value with secrets shown as `***`; only a key that used a secret has one.
 */
export type DesiredKey = { file: string; path: string; value: unknown; display?: unknown };

function notJson(value: unknown): string | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? null : "a number JSON cannot hold";
  if (Array.isArray(value)) return value.map(notJson).find((reason) => reason !== null) ?? null;
  if (isObject(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.values(value).map(notJson).find((reason) => reason !== null) ?? null;
  }
  return "a value JSON cannot hold (quote it if it is meant as text)";
}

/** Nested maps become dotted paths. The leaf is any non-map value, and an empty map. Lists are leaves. */
function flatten(map: Obj, prefix: string[], out: [string[], unknown][]): void {
  for (const [key, value] of Object.entries(map)) {
    if (isObject(value) && Object.keys(value).length > 0) flatten(value, [...prefix, key], out);
    else out.push([[...prefix, key], value]);
  }
}

/** Why a declared path may not be owned: it is, is inside, or holds a path the agent never lets fleet own. Null when it may. */
function deniedBy(path: string, denied: string[]): string | null {
  for (const d of denied) {
    if (path === d || path.startsWith(`${d}.`)) return `fleet never owns '${d}'`;
    if (d.startsWith(`${path}.`)) return `it holds '${d}', which fleet never owns; declare the members it may own instead`;
  }
  return null;
}

export function declareSettings(map: Obj, agent: Has<"settings", Agent>, file: string, problems: string[]): Declared[] {
  const leaves: [string[], unknown][] = [];
  flatten(map, [], leaves);
  const declared: Declared[] = [];
  for (const [segments, value] of leaves) {
    const path = segments.join(".");
    const at = `${file}: settings.${agent.id}.${path}`;
    const badSegment = segments.find((s) => s === "" || s.includes(".") || s === "__proto__");
    const denied = badSegment === undefined ? deniedBy(path, agent.settings.denied) : null;
    if (badSegment !== undefined) {
      problems.push(`${at}: key '${badSegment}' cannot be owned: keys must be non-empty, without '.', and not '__proto__'`);
    } else if (denied !== null) {
      problems.push(`${at}: not allowed, ${denied}`);
    } else {
      const reason = notJson(value);
      if (reason !== null) problems.push(`${at}: ${reason}`);
      else declared.push({ agent: agent.id, path, value });
    }
  }
  return declared;
}

/** The agent a `settings` key of a host file names, or what is wrong with the key. */
export function settingsAgent(key: string, agents: readonly Agent[] = AGENTS): Has<"settings", Agent> | string {
  const agent = agents.find((a) => a.id === key);
  if (agent === undefined) return `unknown key 'settings.${key}'`;
  if (agent.settings === undefined) return `'settings.${key}': ${agent.name} has no settings file fleet can merge`;
  return agent as Has<"settings", Agent>;
}

/**
 * The defaults' keys, with the host's replacing the same path. A path that is a parent of another
 * (`a` beside `a.b`) is a problem: it would be unclear which one owns the value.
 */
export function mergeSettings(defaults: Declared[], host: Declared[], problems: string[]): DesiredKey[] {
  const merged = new Map<string, Declared>();
  for (const key of [...defaults, ...host]) merged.set(`${key.agent}\0${key.path}`, key);
  const keys = [...merged.values()];
  for (const a of keys) {
    for (const b of keys) {
      if (a.agent === b.agent && b.path.startsWith(`${a.path}.`)) {
        problems.push(`settings.${a.agent}: '${a.path}' and '${b.path}' overlap; declare the whole value or its members, not both`);
      }
    }
  }
  return keys.map(({ agent, path, value }) => ({ file: settingsFile(agent), path, value }));
}
