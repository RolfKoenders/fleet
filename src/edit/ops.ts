import { addEntry, entryNames } from "./entries.ts";
import type { Section, Value } from "./entries.ts";
import { addToList, readList, removeFromList } from "./lists.ts";
import type { ListPath } from "./lists.ts";
import { newHostFile } from "./hostfile.ts";
import { CannotEdit } from "./yamltext.ts";

/** What a host picks from: skill bundles, or MCP servers. */
export type PickKind = "bundles" | "mcp";

/**
 * One change to the config, described by what the person wants and not by which text moves. Held in
 * memory and replayed on the files as they are.
 */
export type EditOp =
  /** The host gets the bundle or server. */
  | { op: "add"; host: string; kind: PickKind; name: string }
  /** The host no longer gets it. A pick in the host's file is taken out; one that comes from the defaults is excluded in the host's file. */
  | { op: "remove"; host: string; kind: PickKind; name: string }
  /** Every host gets it: the only edit that writes `hosts/_defaults.yaml` to add. */
  | { op: "addEverywhere"; kind: PickKind; name: string }
  /** No host gets it from the defaults. Hosts that pick it themselves keep it. */
  | { op: "removeEverywhere"; kind: PickKind; name: string }
  /** A new MCP server in `catalog/mcp.yaml`. */
  | { op: "addServer"; name: string; entry: Record<string, Value> }
  /** A new skill source in `catalog/skills.yaml`. */
  | { op: "addSource"; name: string; entry: Record<string, Value> }
  /** A new bundle in `catalog/skills.yaml`. */
  | { op: "addBundle"; name: string; skills: string[] }
  /** A new host file, reached over `ssh`, with nothing picked yet or a copy of what `from` picks and sets. */
  | { op: "addHost"; host: string; ssh: string; from: string | null };

/** Config files by repo-relative path (`hosts/laptop.yaml`) to their text. */
export type Files = Record<string, string>;

export type Dropped = {
  op: EditOp;
  /** `stale`: the file changed and the op has nothing left to do. `cannot-edit`: the file has a shape that cannot be spliced safely. */
  why: "stale" | "cannot-edit";
  reason: string;
};

export type Applied = { files: Files; changed: string[]; applied: EditOp[]; dropped: Dropped[] };

const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const DEFAULTS_FILE = "hosts/_defaults.yaml";
export const hostFile = (host: string): string => `hosts/${host}.yaml`;
export const CATALOG_FILES = { servers: "catalog/mcp.yaml", sources: "catalog/skills.yaml", bundles: "catalog/skills.yaml" } as const;

const INCLUDE: Record<PickKind, ListPath> = { bundles: ["bundles"], mcp: ["mcp", "include"] };
const EXCLUDE: Record<PickKind, ListPath> = { bundles: ["exclude"], mcp: ["mcp", "exclude"] };

class Stale extends Error {}

/**
 * Replays `ops`, in order, on `files`. Each is spliced into the text so that everything outside its
 * own lines stays byte for byte. An op that no longer applies, or that meets a shape that cannot be
 * spliced safely, is dropped and reported, and changes nothing. A catalog file that is missing is made.
 */
export function applyOps(files: Files, ops: readonly EditOp[]): Applied {
  let current: Files = { ...files };
  const applied: EditOp[] = [];
  const dropped: Dropped[] = [];
  for (const op of ops) {
    const work = { ...current };
    try {
      run(work, op);
      current = work;
      applied.push(op);
    } catch (error) {
      if (error instanceof Stale) dropped.push({ op, why: "stale", reason: error.message });
      else if (error instanceof CannotEdit) dropped.push({ op, why: "cannot-edit", reason: `cannot edit this shape: ${error.message}` });
      else throw error;
    }
  }
  const changed = Object.keys(current).filter((path) => current[path] !== files[path]);
  return { files: current, changed, applied, dropped };
}

function run(files: Files, op: EditOp): void {
  switch (op.op) {
    case "add":
      return add(files, op);
    case "remove":
      return remove(files, op);
    case "addEverywhere": {
      const path = INCLUDE[op.kind];
      if (readList(files[DEFAULTS_FILE] ?? "", path).includes(op.name)) throw new Stale(`'${op.name}' is already in ${DEFAULTS_FILE}`);
      files[DEFAULTS_FILE] = addToList(files[DEFAULTS_FILE] ?? "", path, op.name);
      return;
    }
    case "removeEverywhere": {
      const path = INCLUDE[op.kind];
      if (!readList(files[DEFAULTS_FILE] ?? "", path).includes(op.name)) throw new Stale(`'${op.name}' is not in ${DEFAULTS_FILE}`);
      files[DEFAULTS_FILE] = removeFromList(files[DEFAULTS_FILE] ?? "", path, op.name);
      return;
    }
    case "addServer":
      return addCatalog(files, "servers", op.name, op.entry);
    case "addSource":
      return addCatalog(files, "sources", op.name, op.entry);
    case "addBundle":
      return addCatalog(files, "bundles", op.name, op.skills);
    case "addHost": {
      if (!HOST_NAME.test(op.host)) throw new Stale(`'${op.host}' is not a host name`);
      if (hostFile(op.host) in files) throw new Stale(`${hostFile(op.host)} already exists`);
      const source = op.from === null ? null : files[hostFile(op.from)];
      if (op.from !== null && source === undefined) throw new Stale(`${hostFile(op.from)} does not exist`);
      files[hostFile(op.host)] = newHostFile(op.ssh, source ?? null);
      return;
    }
  }
}

/** What the host gets of one kind, and why: the defaults add, the host adds, either excludes. */
function state(files: Files, host: string, kind: PickKind) {
  if (!HOST_NAME.test(host)) throw new Stale(`'${host}' is not a host name`);
  const path = hostFile(host);
  const own = files[path];
  if (own === undefined) throw new Stale(`${path} does not exist`);
  const defaults = files[DEFAULTS_FILE] ?? "";
  return {
    path,
    own,
    defaults,
    inHost: (name: string) => readList(own, INCLUDE[kind]).includes(name),
    inDefaults: (name: string) => readList(defaults, INCLUDE[kind]).includes(name),
    hostExcludes: (name: string) => readList(own, EXCLUDE[kind]).includes(name),
    defaultsExcludes: (name: string) => readList(defaults, EXCLUDE[kind]).includes(name),
  };
}

function add(files: Files, op: Extract<EditOp, { op: "add" }>): void {
  const s = state(files, op.host, op.kind);
  const { name } = op;
  if (s.defaultsExcludes(name)) throw new Stale(`'${name}' is excluded for every host in ${DEFAULTS_FILE}`);
  const picked = s.inHost(name) || s.inDefaults(name);
  const excluded = s.hostExcludes(name);
  if (picked && !excluded) throw new Stale(`'${name}' is already picked by ${op.host}`);
  let text = s.own;
  if (excluded) text = removeFromList(text, EXCLUDE[op.kind], name);
  if (!picked) text = addToList(text, INCLUDE[op.kind], name);
  files[s.path] = text;
}

function remove(files: Files, op: Extract<EditOp, { op: "remove" }>): void {
  const s = state(files, op.host, op.kind);
  const { name } = op;
  const inHost = s.inHost(name);
  const inDefaults = s.inDefaults(name);
  if (!(inHost || inDefaults) || s.hostExcludes(name) || s.defaultsExcludes(name)) throw new Stale(`'${name}' is not picked by ${op.host}`);
  let text = s.own;
  if (inHost) text = removeFromList(text, INCLUDE[op.kind], name);
  if (inDefaults) text = addToList(text, EXCLUDE[op.kind], name);
  files[s.path] = text;
}

function addCatalog(files: Files, section: Section, name: string, entry: Value): void {
  const path = CATALOG_FILES[section];
  const text = files[path] ?? "";
  if (entryNames(text, section).includes(name)) throw new Stale(`${section} already has '${name}' in ${path}`);
  files[path] = addEntry(text, section, name, entry);
}
