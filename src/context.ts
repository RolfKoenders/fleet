import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { load } from "../vendor/js-yaml.mjs";
import { AGENT_LOCATIONS } from "./agentpaths.ts";
import { loadConfig } from "./config.ts";
import { readDoctorResult } from "./doctorresult.ts";
import type { MeasuredServer } from "./doctorresult.ts";
import { hashValue, readDoc } from "./keys.ts";
import { CLAUDE_JSON } from "./mcp.ts";
import { expandTarget } from "./plan.ts";
import { SETTINGS_FILE } from "./settings.ts";
import type { Tool } from "./settings.ts";
import { readState } from "./state.ts";
import type { AppliedState } from "./state.ts";
import { estimateTokens } from "./tokens.ts";
import { isObject } from "./yamlfile.ts";
import type { Obj } from "./yamlfile.ts";

/**
 * The startup context of this host: what each agent loads before the first prompt. This module only measures; the
 * data structure it returns is the `--json` shape of `fleet context`, and `contextview.ts` draws it.
 *
 * It starts no process and decrypts nothing. An MCP server's size comes from the doctor result. The two files that
 * hold server entries (`~/.claude.json`, `opencode.jsonc`) have secrets in them, so they are parsed only to take
 * the server names, the `instructions` and `skills` lists, and nothing else is kept.
 */

export type ContextKind = "instructions" | "skills" | "mcp";

/** What the doctor result knows about one server. */
export type Measurement = {
  tools: number | null;
  /** ISO time of the measurement. */
  measuredAt: string;
  ageSeconds: number;
  /**
   * Whether the server's catalog entry is what it was when measured: false means the config changed since.
   * Null when the current entry is not known (no config, or the server is not from config).
   */
  current: boolean | null;
};

export type ContextItem = {
  kind: ContextKind;
  /** The file (`~/...`) for instructions, the skill's name, the server's name. */
  name: string;
  /** Where it was read from, `~/...` when under the home directory. Null for an MCP server. */
  path: string | null;
  /** The estimate. Null for a server that has not been measured: its size is unknown. */
  tokens: number | null;
  /** Whether fleet put it there, by the applied state. */
  fromConfig: boolean;
  /** Set for a measured MCP server only. */
  measurement: Measurement | null;
};

export type ContextPart = {
  /** Tokens of the items whose size is known. */
  tokens: number;
  count: number;
  /** Items whose size is unknown. */
  unmeasured: number;
};

export type AgentContext = {
  agent: Tool;
  /** The three parts added up. A lower bound when `complete` is false. */
  tokens: number;
  /** False when some server has no measurement, so `tokens` leaves it out. */
  complete: boolean;
  instructions: ContextPart;
  skills: ContextPart;
  mcp: ContextPart;
  items: ContextItem[];
  /** Things listed in the agent's settings that were not counted, and why. */
  notes: string[];
};

export type ContextReport = {
  agents: AgentContext[];
  /** Things about this host that limit the report, such as an applied state that cannot be read. */
  notes: string[];
};

export type MeasureOptions = {
  now?: Date;
  /** Hash of each server's current catalog entry, by `definitionKey`. Null when the config could not be read. */
  definitions?: Map<string, string> | null;
};

export const definitionKey = (agent: Tool, name: string): string => `${agent}\0${name}`;

// ---- paths ----

const tilde = (path: string, home: string): string => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);
const absolute = (path: string, home: string): string => (path.startsWith("~/") ? expandTarget(path, home) : path);

function stat(path: string): "file" | "dir" | null {
  try {
    const s = statSync(path);
    return s.isDirectory() ? "dir" : s.isFile() ? "file" : null;
  } catch {
    return null;
  }
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith(".") && n !== "node_modules").sort();
  } catch {
    return [];
  }
}

const MAX_DEPTH = 6;

/** Files below `dir` with `keep` true, at any depth, following links. */
function filesBelow(dir: string, keep: (name: string) => boolean, depth = 0): string[] {
  if (depth > MAX_DEPTH) return [];
  return entries(dir).flatMap((name) => {
    const path = join(dir, name);
    const kind = stat(path);
    return kind === "dir" ? filesBelow(path, keep, depth + 1) : kind === "file" && keep(name) ? [path] : [];
  });
}

function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => (part === "**/" ? "(?:.*/)?" : part === "**" ? ".*" : part === "*" ? "[^/]*" : part === "?" ? "[^/]" : part.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`);
}

/** The files a path or glob names. */
function expandPattern(pattern: string): string[] {
  if (!/[*?]/.test(pattern)) return stat(pattern) === "file" ? [pattern] : [];
  const segments = pattern.split("/");
  const at = segments.findIndex((s) => /[*?]/.test(s));
  const base = segments.slice(0, at).join("/") || "/";
  const rest = globToRegExp(segments.slice(at).join("/"));
  return filesBelow(base, () => true).filter((f) => rest.test(f.slice(base === "/" ? 1 : base.length + 1)));
}

// ---- what fleet put there ----

type Applied = { fromConfig: (tildePath: string) => boolean; hasKey: (file: string, path: string) => boolean };

function appliedBy(home: string, notes: string[]): Applied {
  let state: AppliedState | null = null;
  try {
    state = readState(home);
  } catch {
    notes.push("the applied state cannot be read, so nothing is marked as from config");
  }
  const targets = (state?.links ?? []).map((l) => l.target);
  const keys = new Set((state?.keys ?? []).map((k) => `${k.file}\0${k.path}`));
  return {
    // A link may be the file itself or a directory above it.
    fromConfig: (path) => targets.some((t) => path === t || path.startsWith(`${t}/`)),
    hasKey: (file, path) => keys.has(`${file}\0${path}`),
  };
}

// ---- settings files ----

/** One top-level key of a settings file, or what to say when it cannot be read. */
function settingsKey(file: string, key: string, home: string): { value: unknown } | { problem: string } {
  try {
    const read = readDoc(expandTarget(file, home));
    return "problem" in read ? { problem: `${file} cannot be read (${read.problem})` } : { value: read.doc[key] };
  } catch {
    return { problem: `${file} cannot be read` };
  }
}

// ---- instructions ----

function instructionItems(agent: Tool, home: string, applied: Applied, notes: string[]): ContextItem[] {
  const where = AGENT_LOCATIONS[agent];
  const paths = new Set<string>(where.instructionFiles.map((f) => absolute(f, home)));
  for (const dir of where.instructionDirs) for (const f of filesBelow(absolute(dir, home), (n) => n.endsWith(".md"))) paths.add(f);

  if (where.instructionsSetting !== null) {
    const setting = settingsKey(where.instructionsSetting, "instructions", home);
    if ("problem" in setting) notes.push(setting.problem);
    else if (Array.isArray(setting.value)) {
      for (const entry of setting.value) {
        if (typeof entry !== "string") continue;
        if (/^https?:\/\//.test(entry)) notes.push(`instructions: ${entry} is a URL, not counted`);
        else if (!entry.startsWith("~/") && !entry.startsWith("/")) notes.push(`instructions: ${entry} is relative to a project, not counted`);
        else for (const f of expandPattern(absolute(entry, home))) paths.add(f);
      }
    }
  }

  return [...paths].flatMap((path): ContextItem[] => {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    const name = tilde(path, home);
    return [{ kind: "instructions", name, path: name, tokens: estimateTokens(text.length), fromConfig: applied.fromConfig(name), measurement: null }];
  });
}

// ---- skills ----

function frontmatter(text: string): Obj {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (block === undefined) return {};
  try {
    const doc: unknown = load(block);
    return isObject(doc) ? doc : {};
  } catch {
    // A description with a colon in it is not valid YAML, but the agent still reads it.
    const line = (key: string) => new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(block)?.[1];
    return { name: line("name"), description: line("description") };
  }
}

type FoundSkill = { id: string; /** The directory, or the file for a flat skill. */ path: string; file: string };

/** Claude takes `<dir>/<name>/SKILL.md`. opencode also takes `<dir>/<name>.md` and `SKILL.md` below grouping directories. */
function findSkills(dir: string, nested: boolean, depth = 0): FoundSkill[] {
  const found: FoundSkill[] = [];
  for (const name of entries(dir)) {
    const path = join(dir, name);
    const kind = stat(path);
    if (kind === "file" && nested && depth === 0 && name.endsWith(".md") && name !== "SKILL.md") found.push({ id: name.slice(0, -3), path, file: path });
    else if (kind === "dir" && stat(join(path, "SKILL.md")) === "file") found.push({ id: name, path, file: join(path, "SKILL.md") });
    else if (kind === "dir" && nested && depth < MAX_DEPTH) found.push(...findSkills(path, nested, depth + 1));
  }
  return found;
}

function skillItems(agent: Tool, home: string, applied: Applied, notes: string[]): ContextItem[] {
  const where = AGENT_LOCATIONS[agent];
  const nested = agent === "opencode";
  const dirs = where.skillDirs.map((d) => absolute(d, home));
  if (where.skillsSetting !== null) {
    const setting = settingsKey(where.skillsSetting, "skills", home);
    if ("problem" in setting) notes.push(setting.problem);
    else if (Array.isArray(setting.value)) {
      for (const entry of setting.value) {
        if (typeof entry === "string" && (entry.startsWith("~/") || entry.startsWith("/"))) dirs.push(absolute(entry, home));
        else if (typeof entry === "string") notes.push(`skills: ${entry} is a URL or relative to a project, not counted`);
      }
    }
  }

  // A skill is picked by its name, and the one found last wins.
  const byId = new Map<string, FoundSkill>();
  for (const dir of dirs) for (const skill of findSkills(dir, nested)) byId.set(skill.id, skill);

  return [...byId.values()].flatMap((skill): ContextItem[] => {
    let meta: Obj;
    try {
      meta = frontmatter(readFileSync(skill.file, "utf8"));
    } catch {
      return [];
    }
    const description = typeof meta.description === "string" ? meta.description : "";
    const optedOut = meta["disable-model-invocation"] === true || (nested && isObject(meta.metadata) && meta.metadata["opencode/autoinvoke"] === false);
    // Neither agent offers a skill the model may not invoke, and opencode offers none without a description.
    if (optedOut || (nested && description === "")) return [];
    const name = typeof meta.name === "string" ? meta.name : skill.id;
    const path = tilde(skill.path, home);
    return [{ kind: "skills", name: skill.id, path, tokens: estimateTokens(name.length + description.length), fromConfig: applied.fromConfig(path), measurement: null }];
  });
}

// ---- MCP servers ----

function measurementOf(agent: Tool, name: string, doctor: MeasuredServer[], options: MeasureOptions, now: Date): { tokens: number; measurement: Measurement } | null {
  const m = doctor.find((s) => s.agent === agent && s.name === name);
  if (m === undefined || m.size === null || m.measuredAt === null) return null;
  const at = Date.parse(m.measuredAt);
  if (Number.isNaN(at)) return null;
  const current = options.definitions?.get(definitionKey(agent, name));
  return {
    tokens: estimateTokens(m.size),
    measurement: { tools: m.tools, measuredAt: m.measuredAt, ageSeconds: Math.max(0, Math.floor((now.getTime() - at) / 1000)), current: current === undefined ? null : current === m.definition },
  };
}

function mcpItems(agent: Tool, home: string, applied: Applied, doctor: MeasuredServer[], options: MeasureOptions, now: Date, notes: string[]): ContextItem[] {
  const { file, key } = AGENT_LOCATIONS[agent].mcp;
  const setting = settingsKey(file, key, home);
  if ("problem" in setting) {
    notes.push(setting.problem);
    return [];
  }
  if (!isObject(setting.value)) return [];
  return Object.entries(setting.value)
    // opencode skips a server that is switched off.
    .filter(([, entry]) => !(agent === "opencode" && isObject(entry) && entry.enabled === false))
    .map(([name]): ContextItem => {
      const measured = measurementOf(agent, name, doctor, options, now);
      return { kind: "mcp", name, path: null, tokens: measured?.tokens ?? null, fromConfig: applied.hasKey(file, `${key}.${name}`), measurement: measured?.measurement ?? null };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---- the report ----

function part(items: ContextItem[], kind: ContextKind): ContextPart {
  const of = items.filter((i) => i.kind === kind);
  return { tokens: of.reduce((sum, i) => sum + (i.tokens ?? 0), 0), count: of.length, unmeasured: of.filter((i) => i.tokens === null).length };
}

/** Reads this host and nothing else: no process is started and no secret is decrypted. */
export function measureContext(home: string = homedir(), options: MeasureOptions = {}): ContextReport {
  const now = options.now ?? new Date();
  const doctor = readDoctorResult(home)?.servers ?? [];
  const hostNotes: string[] = [];
  const applied = appliedBy(home, hostNotes);
  const agents = (["claude", "opencode"] as const).map((agent): AgentContext => {
    const notes: string[] = [];
    const items = [...instructionItems(agent, home, applied, notes), ...skillItems(agent, home, applied, notes), ...mcpItems(agent, home, applied, doctor, options, now, notes)];
    const [instructions, skills, mcp] = [part(items, "instructions"), part(items, "skills"), part(items, "mcp")];
    return { agent, tokens: instructions.tokens + skills.tokens + mcp.tokens, complete: mcp.unmeasured === 0, instructions, skills, mcp, items, notes };
  });
  return { agents, notes: hostNotes };
}

/**
 * The hash of each picked server's catalog entry as the config has it now, made the way doctor made it when it
 * measured: before any secret is filled in, so no secret is read. Throws what `loadConfig` throws.
 */
export function currentDefinitions(configDir: string, host: string, home: string = homedir()): Map<string, string> {
  const config = loadConfig(configDir, host, { home, sources: "none" });
  const map = new Map<string, string>();
  for (const key of config.keys) {
    if (key.file === CLAUDE_JSON && key.path.startsWith("mcpServers.")) map.set(definitionKey("claude", key.path.slice("mcpServers.".length)), hashValue(key.value));
    else if (key.file === SETTINGS_FILE.opencode && key.path.startsWith("mcp.")) map.set(definitionKey("opencode", key.path.slice("mcp.".length)), hashValue(key.value));
  }
  return map;
}
