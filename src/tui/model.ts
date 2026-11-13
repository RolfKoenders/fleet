import { join } from "node:path";
import { parseCatalog } from "../catalog.ts";
import { parseMcpCatalog } from "../mcp.ts";
import { hasSecretRef } from "../template.ts";
import { hostNames } from "../recipients.ts";
import { hostTargets } from "../targets.ts";
import { isObject, isStringList, parseFile } from "../yamlfile.ts";
import type { Obj, Overlay } from "../yamlfile.ts";

export type HostInfo = { name: string; ssh: string | null; self: boolean };

/** Which file did it: the defaults, the host's own file, or both. */
export type Origin = "defaults" | "host" | "both";

export type Cell = {
  on: boolean;
  /** Which files list it. Kept when `excluded`, to say what the exclude overrode. */
  picked: Origin | null;
  /** Which files exclude it. */
  excluded: Origin | null;
};

export type Row = {
  kind: "bundle" | "server" | "skill";
  name: string;
  /** For a bundle, its skills. For a skill, its bundle. */
  skills: string[];
  bundle?: string;
  server?: { kind: "stdio" | "http" | "sse"; only: string[]; secrets: number };
  cells: Record<string, Cell>;
};

export type SourceInfo = { name: string; repo: string; path: string; commit: string | null; track: string | null; branch: string | null; review: boolean };

export type Model = {
  configDir: string;
  self: string | null;
  hosts: HostInfo[];
  bundles: Row[];
  servers: Row[];
  /** The skill sources of the catalog, as written. */
  sources: SourceInfo[];
  /** Why the config could not be read in full. Shown, never thrown: the bridge opens on a broken config too. */
  problems: string[];
};

const stringList = (doc: Obj | null, key: string): string[] => (doc && isStringList(doc[key]) ? (doc[key] as string[]) : []);
const mcpList = (doc: Obj | null, key: string): string[] => (doc && isObject(doc.mcp) ? stringList(doc.mcp, key) : []);

const origin = (inDefaults: boolean, inHost: boolean): Origin | null => (inDefaults && inHost ? "both" : inDefaults ? "defaults" : inHost ? "host" : null);

function cellFor(name: string, adds: string[][], excludes: string[][]): Cell {
  const picked = origin(adds[0]!.includes(name), adds[1]!.includes(name));
  const excluded = origin(excludes[0]!.includes(name), excludes[1]!.includes(name));
  return { on: picked !== null && excluded === null, picked, excluded };
}

/**
 * What the config says each host gets, computed from the files alone: no host is touched, no clone is made. Files in
 * `overlay` (repo-relative path to text) stand in for the ones on disk, to show a config that is not written yet.
 */
export function loadModel(configDir: string, self: string | null, held?: Readonly<Record<string, string>>): Model {
  const overlay: Overlay | undefined = held && { root: configDir, files: held };
  const problems: string[] = [];
  const defaults = parseFile(join(configDir, "hosts/_defaults.yaml"), true, problems, overlay);
  const targets = hostTargets(configDir, null, problems, overlay);
  const docs = new Map<string, Obj | null>();
  for (const name of hostNames(configDir)) docs.set(name, parseFile(join(configDir, "hosts", `${name}.yaml`), false, problems, overlay));
  const catalog = parseCatalog(configDir, problems, overlay);
  const servers = parseMcpCatalog(configDir, problems, overlay);

  // This host first, then the others by name.
  const hosts: HostInfo[] = targets.map((t) => ({ name: t.host, ssh: t.ssh, self: t.host === self })).sort((a, b) => Number(b.self) - Number(a.self));
  const rowOf = (kind: Row["kind"], name: string, skills: string[], listKey: "bundles" | "mcp", extra: Partial<Row> = {}): Row => {
    const cells: Record<string, Cell> = {};
    for (const h of hosts) {
      const own = docs.get(h.name) ?? null;
      const list = (doc: Obj | null, key: string) => (listKey === "bundles" ? stringList(doc, key) : mcpList(doc, key));
      const add = listKey === "bundles" ? "bundles" : "include";
      cells[h.name] = cellFor(name, [list(defaults, add), list(own, add)], [list(defaults, "exclude"), list(own, "exclude")]);
    }
    return { kind, name, skills, cells, ...extra };
  };

  const bundles = [...catalog.bundles].map(([name, skills]) => rowOf("bundle", name, skills, "bundles"));
  const serverRows = [...servers.values()].map((s) =>
    rowOf("server", s.name, [], "mcp", {
      server: {
        kind: s.command !== null ? "stdio" : (s.transport ?? "http"),
        only: s.only,
        // Only how many are named, never what they hold.
        secrets: [...Object.values(s.env), ...Object.values(s.headers), s.url ?? ""].filter((v) => hasSecretRef(v)).length,
      },
    }),
  );
  return { configDir, self, hosts, bundles, servers: serverRows, sources: catalog.sources, problems };
}

/** The rows of the matrix as shown: bundles, then servers, with the skills of the bundles named in `expanded` under them. */
export function visibleRows(model: Model, expanded: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  for (const b of model.bundles) {
    rows.push(b);
    if (!expanded.has(b.name)) continue;
    for (const skill of b.skills) rows.push({ kind: "skill", name: skill, skills: [], bundle: b.name, cells: b.cells });
  }
  return [...rows, ...model.servers];
}

/** One host's picks, for its card before its status has come back. */
export function counts(model: Model, host: string): { skills: number; servers: number } {
  let skills = 0;
  for (const b of model.bundles) if (b.cells[host]?.on) skills += b.skills.length;
  return { skills, servers: model.servers.filter((s) => s.cells[host]?.on).length };
}

const file = (which: "defaults" | "host", host: string): string => (which === "defaults" ? "hosts/_defaults.yaml" : `hosts/${host}.yaml`);

const joinFiles = (o: Origin, host: string): string => (o === "both" ? `${file("defaults", host)} and ${file("host", host)}` : file(o, host));

/** Why a cell is on or off, as lines for the cursor to show. */
export function explain(row: Row, host: string): string[] {
  const cell = row.cells[host];
  if (!cell) return [];
  const list = row.kind === "server" ? "mcp.include" : "bundles";
  const exclude = row.kind === "server" ? "mcp.exclude" : "exclude";
  const via = row.kind === "skill" ? `in bundle ${row.bundle}: ` : "";
  const subject = row.kind === "skill" ? `skill ${row.name} (bundle ${row.bundle})` : `${row.kind} ${row.name}`;
  const target = row.kind === "skill" ? `bundle ${row.bundle}` : row.name;
  if (cell.on) return [`${subject} is on for ${host}`, `${via}picked by ${list} in ${joinFiles(cell.picked!, host)}`];
  if (cell.excluded) {
    const lines = [`${subject} is off for ${host}`, `${via}removed by ${exclude} in ${joinFiles(cell.excluded, host)}`];
    lines.push(cell.picked ? `${list} in ${joinFiles(cell.picked, host)} picks ${target}, but an exclude wins` : `no file picks ${target} either`);
    return lines;
  }
  return [`${subject} is off for ${host}`, `no file picks ${target}: it is in neither ${file("defaults", host)} nor ${file("host", host)}`];
}
