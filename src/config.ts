import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseCatalog, pickBundles } from "./catalog.ts";
import type { Catalog } from "./catalog.ts";
import { mcpKeys, parseMcpCatalog } from "./mcp.ts";
import type { Conflict } from "./plan.ts";
import { declareSettings, mergeSettings } from "./settings.ts";
import type { Declared, DesiredKey, Tool } from "./settings.ts";
import { findSkills, placeSource } from "./sources.ts";
import type { SourceMode } from "./sources.ts";
import { managedToolDir } from "./dirs.ts";
import { readPin } from "./pin.ts";
import { probedNode } from "./tools.ts";
import { fillVars, hasSecretRef, secretNames } from "./template.ts";
import { isObject, isStringList, parseFile } from "./yamlfile.ts";
import type { Obj } from "./yamlfile.ts";

export class InvalidConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.problems = problems;
  }
}

export type FileRecord = {
  /** Absolute path: inside the config repo, the tool's `skills/fleet`, or inside a skill source clone. */
  source: string;
  /** As written in the config: `~/...`. */
  target: string;
};

export type Config = {
  /** Linked files: the `files` records, then one per skill in the picked bundles. */
  files: FileRecord[];
  /** Owned keys in the merged files: defaults and host file, host winning per path. */
  keys: DesiredKey[];
  /** Repo conflicts met while getting skill sources in place. When any, `files` is empty. */
  conflicts: Conflict[];
  /** The secret names the owned keys refer to as `secret:NAME`, still unresolved in `keys`. */
  secrets: string[];
  /** The skills in the picked bundles, which `files` links into `~/.claude/skills`. Empty when `conflicts` is not. */
  skills: string[];
};

export type LoadOptions = {
  home?: string;
  /** `apply` puts skill sources in place; `diff` and `validate` only clone missing ones; `offline` clones nothing; `none` leaves them alone and skips skills. */
  sources?: SourceMode | "none";
};

type UnresolvedRecord = { source: string; target: string };

const SHARED_KEYS = ["vars", "bundles", "exclude", "mcp", "settings", "files"];
const HOST_ONLY_KEYS = ["ssh", "age", "admin"];

type Checked = { records: UnresolvedRecord[]; declared: Declared[]; vars: Record<string, string> };

function checkFile(path: string, doc: Obj, hostFile: boolean, problems: string[]): Checked {
  const allowed = hostFile ? [...SHARED_KEYS, ...HOST_ONLY_KEYS] : SHARED_KEYS;
  for (const key of Object.keys(doc)) {
    if (!allowed.includes(key)) problems.push(`${path}: unknown key '${key}'`);
  }

  const { vars, bundles, exclude, mcp, settings, files, ssh, age, admin } = doc;
  const ownVars: Record<string, string> = {};
  if (vars !== undefined) {
    if (!isObject(vars) || !Object.values(vars).every((v) => typeof v === "string")) {
      problems.push(`${path}: 'vars' must be a map of strings`);
    } else if ("HOME" in vars) {
      problems.push(`${path}: 'vars.HOME' is built in and cannot be set`);
    } else {
      for (const [name, value] of Object.entries(vars as Record<string, string>)) {
        if (hasSecretRef(value)) problems.push(`${path}: vars.${name} refers to a secret, which vars cannot hold`);
        else ownVars[name] = value;
      }
    }
  }
  for (const [name, value] of [["bundles", bundles], ["exclude", exclude]] as const) {
    if (value !== undefined && !isStringList(value)) problems.push(`${path}: '${name}' must be a list of strings`);
  }
  if (mcp !== undefined) {
    if (!isObject(mcp)) {
      problems.push(`${path}: 'mcp' must be a map`);
    } else {
      for (const [key, value] of Object.entries(mcp)) {
        if (key !== "include" && key !== "exclude") problems.push(`${path}: unknown key 'mcp.${key}'`);
        else if (!isStringList(value)) problems.push(`${path}: 'mcp.${key}' must be a list of strings`);
      }
    }
  }
  const declared: Declared[] = [];
  if (settings !== undefined) {
    if (!isObject(settings)) {
      problems.push(`${path}: 'settings' must be a map`);
    } else {
      for (const [key, value] of Object.entries(settings)) {
        if (key !== "claude" && key !== "opencode") problems.push(`${path}: unknown key 'settings.${key}'`);
        else if (!isObject(value)) problems.push(`${path}: 'settings.${key}' must be a map`);
        else declared.push(...declareSettings(value, key as Tool, path, problems));
      }
    }
  }
  if (ssh !== undefined && typeof ssh !== "string") problems.push(`${path}: 'ssh' must be a string`);
  if (age !== undefined && typeof age !== "string") problems.push(`${path}: 'age' must be a string`);
  if (admin !== undefined && typeof admin !== "boolean") problems.push(`${path}: 'admin' must be true or false`);

  const records: UnresolvedRecord[] = [];
  if (files === undefined) return { records, declared, vars: ownVars };
  if (!Array.isArray(files)) {
    problems.push(`${path}: 'files' must be a list`);
    return { records, declared, vars: ownVars };
  }
  const seen = new Set<string>();
  files.forEach((entry, i) => {
    const at = `${path}: files[${i}]`;
    if (!isObject(entry)) return problems.push(`${at} must be a map with 'source' and 'target'`);
    for (const key of Object.keys(entry)) {
      if (key !== "source" && key !== "target") problems.push(`${at}: unknown key '${key}'`);
    }
    const { source, target } = entry;
    if ([source, target].some((v) => typeof v === "string" && hasSecretRef(v))) {
      return problems.push(`${at}: files cannot refer to a secret`);
    }
    if (typeof source !== "string" || source === "") return problems.push(`${at}: 'source' must be a path`);
    if (isAbsolute(source) || source.split("/").includes("..")) {
      return problems.push(`${at}: 'source' must be a path inside the config repo, without '..'`);
    }
    if (typeof target !== "string" || !target.startsWith("~/") || target === "~/") {
      return problems.push(`${at}: 'target' must start with '~/'`);
    }
    if (target.slice(2).split("/").some((part) => part === "" || part === "." || part === "..")) {
      return problems.push(`${at}: 'target' must not contain '.', '..' or empty path segments`);
    }
    if (seen.has(target)) return problems.push(`${at}: target '${target}' is listed twice`);
    seen.add(target);
    records.push({ source, target });
  });
  return { records, declared, vars: ownVars };
}

const listOf = (doc: Obj | null, key: string): string[] => (doc && isStringList(doc[key]) ? (doc[key] as string[]) : []);
const mcpListOf = (doc: Obj | null, key: string): string[] => (doc && isObject(doc.mcp) ? listOf(doc.mcp, key) : []);

function resolveSkills(catalog: Catalog, skills: string[], home: string, problems: string[]): Map<string, string> {
  const found = new Map<string, { source: string; dir: string }[]>();
  for (const source of catalog.sources) {
    const { dirs, problem } = findSkills(source, home);
    if (problem) problems.push(problem);
    for (const skill of skills) {
      for (const dir of dirs.get(skill) ?? []) found.set(skill, [...(found.get(skill) ?? []), { source: source.name, dir }]);
    }
  }

  const resolved = new Map<string, string>();
  const shown = (dir: string) => `~${dir.slice(home.length)}`;
  for (const skill of skills) {
    const hits = found.get(skill) ?? [];
    const sources = [...new Set(hits.map((h) => h.source))];
    if (hits.length === 0) {
      problems.push(`skill '${skill}' is in no source: no directory '${skill}/' with a SKILL.md under any source path`);
    } else if (sources.length > 1) {
      problems.push(`skill '${skill}' is in more than one source (${sources.join(", ")}); keep it in one`);
    } else if (hits.length > 1) {
      problems.push(`skill '${skill}' is more than one directory in source '${sources[0]}': ${hits.map((h) => shown(h.dir)).join(", ")}`);
    } else {
      resolved.set(skill, hits[0]!.dir);
    }
  }
  return resolved;
}

/** The one skill every apply installs from the tool, whatever the config says. */
export const FLEET_SKILL_TARGET = "~/.claude/skills/fleet";

/**
 * Reads `fleet.yaml`, `hosts/_defaults.yaml`, `hosts/<host>.yaml` and `catalog/skills.yaml` under the
 * config repo, validates them and merges them. A host's file record replaces the default's at the same
 * target, keeping its place. The `fleet` skill comes first, linked from the managed fleet clone whichever
 * checkout is running (a link to a development checkout would conflict with the host's own), and left out on a
 * host that has no managed clone yet. Then the file records, then the skills from the picked bundles.
 */
export function loadConfig(configDir: string, host: string, options: LoadOptions): Config {
  const home = options.home ?? homedir();
  const problems: string[] = [];
  const defaultsPath = join(configDir, "hosts/_defaults.yaml");
  const hostPath = join(configDir, "hosts", `${host}.yaml`);
  const defaults = parseFile(defaultsPath, true, problems);
  const own = parseFile(hostPath, false, problems);
  const catalog = parseCatalog(configDir, problems);
  readPin(configDir, problems);

  const empty: Checked = { records: [], declared: [], vars: {} };
  const checkedDefaults = defaults ? checkFile(defaultsPath, defaults, false, problems) : empty;
  const checkedHost = own ? checkFile(hostPath, own, true, problems) : empty;
  const vars = { ...checkedDefaults.vars, ...checkedHost.vars, HOME: home };
  const keys = mergeSettings(checkedDefaults.declared, checkedHost.declared, problems).map((key) => {
    const { value, unknown } = fillVars(key.value, vars);
    for (const name of unknown) problems.push(`${key.file} ${key.path}: {{ vars.${name} }} is not defined in any 'vars'`);
    return { ...key, value };
  });

  const servers = parseMcpCatalog(configDir, problems);
  for (const [path, doc, key] of [[defaultsPath, defaults, "include"], [defaultsPath, defaults, "exclude"], [hostPath, own, "include"], [hostPath, own, "exclude"]] as const) {
    for (const name of mcpListOf(doc, key)) {
      if (!servers.has(name)) problems.push(`${path}: 'mcp.${key}' names server '${name}', which is not in catalog/mcp.yaml`);
    }
  }
  const pickedServers = pickBundles(
    [mcpListOf(defaults, "include"), mcpListOf(own, "include")],
    [mcpListOf(defaults, "exclude"), mcpListOf(own, "exclude")],
  ).flatMap((name) => servers.get(name) ?? []);
  keys.push(...mcpKeys(pickedServers, vars, probedNode(), problems));

  const merged = new Map<string, UnresolvedRecord>();
  for (const record of [...checkedDefaults.records, ...checkedHost.records]) merged.set(record.target, record);

  const fleetSkill = join(managedToolDir(home), "skills/fleet");
  const files: FileRecord[] = existsSync(fleetSkill) ? [{ source: fleetSkill, target: FLEET_SKILL_TARGET }] : [];
  for (const { source, target } of merged.values()) {
    if (target === FLEET_SKILL_TARGET) {
      problems.push(`files: target '${target}' is the fleet skill, which every apply installs from the tool; a config cannot set it`);
      continue;
    }
    const absolute = resolve(configDir, source);
    try {
      statSync(absolute);
    } catch {
      problems.push(`files: source '${source}' for ${target} does not exist in the config repo`);
      continue;
    }
    files.push({ source: absolute, target });
  }

  for (const [path, doc, key] of [[defaultsPath, defaults, "bundles"], [defaultsPath, defaults, "exclude"], [hostPath, own, "bundles"], [hostPath, own, "exclude"]] as const) {
    for (const name of listOf(doc, key)) {
      if (!catalog.bundles.has(name)) problems.push(`${path}: '${key}' names bundle '${name}', which is not in catalog/skills.yaml`);
    }
  }
  const picked = pickBundles(
    [listOf(defaults, "bundles"), listOf(own, "bundles")],
    [listOf(defaults, "exclude"), listOf(own, "exclude")],
  ).filter((bundle) => catalog.bundles.has(bundle));
  const skills = picked.flatMap((bundle) => catalog.bundles.get(bundle) ?? []);

  const conflicts: Conflict[] = [];
  const mode = options.sources ?? "apply";
  if (problems.length === 0 && skills.length > 0 && mode !== "none") {
    for (const source of catalog.sources) {
      const outcome = placeSource(source, home, mode);
      problems.push(...outcome.problems);
      conflicts.push(...outcome.conflicts);
    }
    if (problems.length === 0 && conflicts.length === 0) {
      for (const [skill, dir] of resolveSkills(catalog, skills, home, problems)) {
        const target = `~/.claude/skills/${skill}`;
        if (merged.has(target)) problems.push(`skill '${skill}' and a files record both target ${target}`);
        else files.push({ source: dir, target });
      }
    }
  }

  if (problems.length > 0) throw new InvalidConfigError(problems);
  const secrets = [...new Set(keys.flatMap((key) => secretNames(key.value)))].sort();
  return conflicts.length > 0 ? { files: [], keys: [], conflicts, secrets: [], skills: [] } : { files, keys, conflicts, secrets, skills };
}
