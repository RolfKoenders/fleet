import { having } from "../agents/index.ts";
import type { AgentId } from "../agents/index.ts";
import { InvalidConfigError } from "../config.ts";
import { applyOps, DEFAULTS_FILE, entryValue, hostFile } from "../edit/index.ts";
import type { EditOp, Files, Value } from "../edit/index.ts";
import { readList } from "../edit/lists.ts";
import { parseMcpCatalog, takes } from "../mcp.ts";
import { namesIn } from "../secrets.ts";
import { secretNames } from "../template.ts";
import { readFiles } from "../ui/edits.ts";
import type { StagedSkills } from "../ui/edits.ts";
import { setSecret } from "../ui/secretset.ts";
import { freeSecretName, looksSecret, secretNameProblem, sourceNameOf } from "./names.ts";
import { itemId } from "./machine.ts";
import type { Captured, Item, McpItem, SkillItem } from "./scan.ts";

/**
 * What one answer about one item turns into: edits to the config repo, in the engine's own terms, so every write keeps the
 * files' comments and styles and the page can hold the same edits on To push. A secret's value is encrypted here, one value at a
 * time, with the code the page's Set uses; the edits that come out hold ciphertext and `secret:NAME`, never a value.
 */

export type Scope = "host" | "all";

/** One env variable or header of a server, and whether it becomes a secret. The value is not here. */
export type KeyRow = { where: "env" | "headers"; key: string; secret: boolean; name: string | null };
export type SecretPick = { where: "env" | "headers"; key: string; name: string };

export type McpChoice = { scope: Scope; /** Which of the item's definitions to take, when the agents disagree. */ variant: number; /** Only the agents that had it, not every agent. */ onlyHad: boolean; secrets: SecretPick[] };
export type SkillChoice = { scope: Scope; bundle: string };

export type Decision =
  | { item: Item; action: "ignore" }
  | { item: Item; action: "takeover" }
  | { item: McpItem; action: "add"; choice: McpChoice }
  | { item: SkillItem; action: "add"; choice: SkillChoice };

export type Built = {
  /** Every edit so far: the ones before, then this decision's. */
  ops: EditOp[];
  /** What the page's skill check knows of a source this adds. */
  staged: StagedSkills;
  /** Whether fleet should own what is on this machine once the edits are written. */
  takeover: boolean;
  /** The secret names this decision set. */
  secrets: string[];
  notes: string[];
};
export type Refused = { refused: string };

const filesAfter = (configDir: string, ops: readonly EditOp[]): Files => applyOps(readFiles(configDir), ops).files;

/** The secret names that exist or are about to: in either secrets file, used by a catalog entry, or set by the edits so far. */
export function takenSecrets(configDir: string, host: string, ops: readonly EditOp[]): Set<string> {
  const taken = new Set<string>();
  for (const file of [host, "shared"]) {
    try {
      namesIn(configDir, file).forEach((n) => taken.add(n));
    } catch (error) {
      if (!(error instanceof InvalidConfigError)) throw error;
    }
  }
  for (const server of parseMcpCatalog(configDir, []).values()) {
    for (const name of secretNames({ env: server.env, headers: server.headers })) taken.add(name);
  }
  for (const op of ops) if (op.op === "setSecret") op.names.forEach((n) => taken.add(n));
  return taken;
}

const pairs = (server: Captured): { where: "env" | "headers"; key: string; value: string }[] => [
  ...Object.entries(server.env).map(([key, value]) => ({ where: "env" as const, key, value })),
  ...Object.entries(server.headers).map(([key, value]) => ({ where: "headers" as const, key, value })),
];

/**
 * Each env variable and header of the chosen definition, with the default answer: a secret when its name looks like one. Every row has the
 * name it would be given if it were a secret (null for a value too empty to keep), so a person who turns another key into a secret has one.
 */
export function keyRows(item: McpItem, variant: number, taken: ReadonlySet<string>): KeyRow[] {
  const server = item.variants[variant]?.server;
  if (server === undefined) return [];
  const used = new Set(taken);
  return pairs(server).map(({ where, key, value }): KeyRow => {
    // A value that is empty or only spaces cannot be encrypted, and holds nothing to hide.
    if (value.trim() === "") return { where, key, secret: false, name: null };
    const name = freeSecretName(item.name, key, used, where === "env");
    used.add(name);
    return { where, key, secret: looksSecret(key), name };
  });
}

/** The answer given when nobody chooses: this host, every agent, and a secret for each key that looks like one. */
export const defaultMcpChoice = (item: McpItem, taken: ReadonlySet<string>): McpChoice => ({
  scope: "host",
  variant: 0,
  onlyHad: false,
  secrets: keyRows(item, 0, taken).flatMap((r) => (r.secret && r.name !== null ? [{ where: r.where, key: r.key, name: r.name }] : [])),
});

const hasPick = (files: Files, host: string, kind: "mcp" | "bundles", name: string): boolean => {
  const [include, exclude]: [readonly [string] | readonly [string, string], readonly [string] | readonly [string, string]] = kind === "mcp" ? [["mcp", "include"], ["mcp", "exclude"]] : [["bundles"], ["exclude"]];
  const picked = readList(files[hostFile(host)] ?? "", include).includes(name) || readList(files[DEFAULTS_FILE] ?? "", include).includes(name);
  return picked && !readList(files[hostFile(host)] ?? "", exclude).includes(name);
};

/** The pick: this host's, or every host's. Nothing when it is already so. */
function pickOps(files: Files, host: string, scope: Scope, kind: "mcp" | "bundles", name: string): EditOp[] {
  if (scope === "host") return hasPick(files, host, kind, name) ? [] : [{ op: "add", host, kind, name }];
  return readList(files[DEFAULTS_FILE] ?? "", kind === "mcp" ? ["mcp", "include"] : ["bundles"]).includes(name) ? [] : [{ op: "addEverywhere", kind, name }];
}

/** The agents a captured server is for, as `only`, or null for every agent that can have servers. */
function onlyFor(item: McpItem, server: Captured, onlyHad: boolean): AgentId[] | null {
  const all = having("mcp");
  const shape = { command: server.command, transport: server.transport };
  const can = all.filter((a) => takes(a, shape)).map((a) => a.id);
  const wanted = onlyHad ? can.filter((id) => item.agents.includes(id)) : can;
  return wanted.length === all.length ? null : wanted;
}

function serverEntry(item: McpItem, server: Captured, secrets: readonly SecretPick[], onlyHad: boolean): Record<string, Value> {
  const named = (where: "env" | "headers", map: Record<string, string>): Record<string, Value> =>
    Object.fromEntries(
      Object.entries(map).map(([key, value]) => {
        const pick = secrets.find((s) => s.where === where && s.key === key);
        return [key, pick === undefined ? value : `secret:${pick.name}`];
      }),
    );
  const entry: Record<string, Value> = {};
  if (server.command !== null) {
    entry.command = server.command;
    if (Object.keys(server.env).length > 0) entry.env = named("env", server.env);
  } else {
    entry.transport = server.transport!;
    entry.url = server.url!;
    if (Object.keys(server.headers).length > 0) entry.headers = named("headers", server.headers);
  }
  const only = onlyFor(item, server, onlyHad);
  if (only !== null) entry.only = only;
  return entry;
}

const refuse = (message: string): Refused => ({ refused: message });
const itemOf = (decision: Decision): string => itemId(decision.item.kind, decision.item.name);

/** The edits for one decision, after `ops`. Nothing is written. */
export function build(configDir: string, home: string, host: string, ops: readonly EditOp[], decision: Decision): Built | Refused {
  const done = { staged: {} as StagedSkills, takeover: false, secrets: [] as string[], notes: [] as string[] };
  if (decision.action === "ignore") return check(configDir, ops, [{ op: "ignore", host, item: itemOf(decision) }], done);
  if (decision.action === "takeover") return { ops: [...ops], ...done, takeover: true };
  return decision.item.kind === "mcp" ? buildMcp(configDir, home, host, ops, decision as Extract<Decision, { item: McpItem; action: "add" }>) : buildSkill(configDir, host, ops, decision as Extract<Decision, { item: SkillItem; action: "add" }>);
}

/** Replays the new edits on the old, and refuses when one no longer applies. */
function check(configDir: string, before: readonly EditOp[], added: readonly EditOp[], done: Omit<Built, "ops">): Built | Refused {
  const ops = [...before, ...added];
  const out = applyOps(readFiles(configDir), ops);
  const dropped = out.dropped[0];
  if (dropped !== undefined) return refuse(dropped.reason);
  return { ops, ...done };
}

function buildMcp(configDir: string, home: string, host: string, before: readonly EditOp[], decision: Extract<Decision, { item: McpItem; action: "add" }>): Built | Refused {
  const { item, choice } = decision;
  const server = item.variants[choice.variant]?.server;
  if (server === undefined) return refuse(`there is no definition ${choice.variant + 1} of ${item.name}`);
  if (item.state === "blocked") return refuse(item.message ?? `${item.name} cannot be captured`);
  const files = filesAfter(configDir, before);
  const inCatalog = entryValue(files, "server", item.name) !== null;
  let ops: EditOp[] = [...before];
  const names: string[] = [];
  if (!inCatalog) {
    const taken = takenSecrets(configDir, host, before);
    for (const pick of choice.secrets) {
      const problem = secretNameProblem(pick.name, taken) ?? (names.includes(pick.name) ? `'${pick.name}' is picked twice` : null);
      if (problem !== null) return refuse(problem);
      names.push(pick.name);
    }
    const missing = choice.secrets.filter((p) => !pairs(server).some((x) => x.where === p.where && x.key === p.key && x.value.trim() !== ""));
    if (missing.length > 0) return refuse(`${missing[0]!.key} has no value to keep as a secret`);
    ops.push({ op: "addServer", name: item.name, entry: serverEntry(item, server, choice.secrets, choice.onlyHad) });
    for (const pick of choice.secrets) {
      const value = pairs(server).find((x) => x.where === pick.where && x.key === pick.key)!.value;
      const made = setSecret(configDir, home, { name: pick.name, value, files: [choice.scope === "host" ? host : "shared"], ops });
      if ("refused" in made) return refuse(made.refused.message);
      ops = [...ops.filter((o) => !(o.op === "setSecret" && made.replaces.includes(o.file))), ...made.ops];
    }
  }
  const after = filesAfter(configDir, ops);
  return check(configDir, ops, pickOps(after, host, choice.scope, "mcp", item.name), { staged: {}, takeover: true, secrets: names, notes: [] });
}

function buildSkill(configDir: string, host: string, before: readonly EditOp[], decision: Extract<Decision, { item: SkillItem; action: "add" }>): Built | Refused {
  const { item, choice } = decision;
  if (item.state === "blocked") return refuse(item.message ?? `${item.name} cannot be captured`);
  const files = filesAfter(configDir, before);
  const added: EditOp[] = [];
  const staged: StagedSkills = {};
  let bundle = item.bundle;
  if (item.state === "new") {
    const repo = item.repo;
    if (repo === null) return refuse(item.message ?? `${item.name} cannot be captured`);
    let source = repo.source;
    if (source === null) {
      source = uniqueName(sourceNameOf(repo.repo), (name) => entryValue(files, "source", name) !== null);
      added.push({ op: "addSource", name: source, entry: { repo: repo.repo, path: repo.path, commit: repo.commit, track: repo.track, review: true } });
      staged[source] = [item.name];
    }
    bundle = choice.bundle;
    const held = entryValue(files, "bundle", bundle);
    if (held === null) added.push({ op: "addBundle", name: bundle, skills: [item.name] });
    else if (Array.isArray(held)) added.push({ op: "editBundle", name: bundle, from: held as string[], to: [...(held as string[]), item.name] });
  }
  const after = applyOps(files, added).files;
  return check(configDir, before, [...added, ...pickOps(after, host, choice.scope, "bundles", bundle!)], { staged, takeover: true, secrets: [], notes: [] });
}

/** `name`, or `name-2` and up, whichever `taken` does not say is used. */
export function uniqueName(name: string, taken: (name: string) => boolean): string {
  if (!taken(name)) return name;
  for (let n = 2; ; n++) if (!taken(`${name}-${n}`)) return `${name}-${n}`;
}

/** The answer given for an item when nobody chooses (`--yes`): what its state allows, this host, and nothing for what cannot be captured. */
export function defaultDecision(configDir: string, host: string, ops: readonly EditOp[], item: Item): Decision | null {
  if (item.state === "blocked") return null;
  if (item.state === "takeover") return { item, action: "takeover" };
  if (item.kind === "mcp") return { item, action: "add", choice: defaultMcpChoice(item, takenSecrets(configDir, host, ops)) };
  const bundle = item.bundle ?? item.repo?.source ?? sourceNameOf(item.repo?.repo ?? item.name);
  return { item, action: "add", choice: { scope: "host", bundle } };
}
