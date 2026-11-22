import { realpathSync } from "node:fs";
import { relative, sep } from "node:path";
import { mcpEntryOf, SKILL_TARGETS } from "../agents/index.ts";
import type { AgentId, Registered } from "../agents/index.ts";
import { parseCatalog } from "../catalog.ts";
import { InvalidConfigError, loadConfig } from "../config.ts";
import type { Config } from "../config.ts";
import { applyOps } from "../edit/index.ts";
import { runGit } from "../git.ts";
import { hashValue } from "../keys.ts";
import { parseMcpCatalog } from "../mcp.ts";
import type { Server } from "../mcp.ts";
import { expandTarget, planLinks } from "../plan.ts";
import { MCP_URL_CREDENTIALS, REPO_CREDENTIALS, urlHoldsCredentials } from "../redact.ts";
import { renderKeys, resolveSecrets } from "../secrets.ts";
import { NeedsSecretError } from "../sops.ts";
import { secretNames } from "../template.ts";
import { readFiles } from "../ui/edits.ts";
import { withoutEmpty } from "../agents/shape.ts";
import { holdsCredentialArg, holdsCredentialQuery, sameRepo } from "./names.ts";
import { agentIds, ignoredItems, readLocal } from "./machine.ts";
import type { LocalMcp, LocalSkill } from "./machine.ts";
import type { Obj } from "../yamlfile.ts";

/**
 * Sorts what a machine has that is not from config into what capture can do about each. An item is one of:
 *  - `new`: nothing in the catalog is called that, so it can be added;
 *  - `catalog`: the catalog has it, this host does not pick it, and what is here is what the config would give it;
 *  - `takeover`: this host picks it and what is here is what the config would render, so fleet can own it as it stands;
 *  - `blocked`: capture cannot take it, and `message` says why (the only choice left is to ignore it).
 * An item the catalog has under the same name but another definition is none of these: it is in `differs`, and stays a conflict.
 * Secrets are decrypted only to compare (nothing is shown), and every value found is kept in memory for the caller to use.
 */

/** An MCP server as a catalog entry would hold it, with its real values. Never printed or logged as it is. */
export type Captured = {
  command: string[] | null;
  env: Record<string, string>;
  transport: "http" | "sse" | null;
  url: string | null;
  headers: Record<string, string>;
};

/** One definition and the agents that have it. */
export type Variant = { agents: AgentId[]; server: Captured };

export type ItemState = "new" | "catalog" | "takeover" | "blocked";

export type McpItem = {
  kind: "mcp";
  name: string;
  state: ItemState;
  message: string | null;
  /** The agents that have it, not from config. */
  agents: AgentId[];
  /** The distinct definitions among them. More than one when the agents disagree. Empty for a blocked item whose shape is not understood. */
  variants: Variant[];
};

/** Where a skill's repo is, as a catalog source would hold it. */
export type RepoInfo = {
  /** The remote's address. */
  repo: string;
  /** The directory in the repo that holds the skill's directory (`.` for the top). */
  path: string;
  commit: string;
  track: string;
  /** The skill's directory has changes that are not committed. */
  dirty: boolean;
  /** The catalog source that already has this repo, when one does. */
  source: string | null;
};

export type SkillItem = {
  kind: "skill";
  name: string;
  state: ItemState;
  message: string | null;
  /** `~/...` of the skill's directory. */
  path: string;
  repo: RepoInfo | null;
  /** The bundle that holds it, for a skill the catalog has. */
  bundle: string | null;
};

export type Item = McpItem | SkillItem;

/** An item the catalog has with another definition: capture leaves it as the conflict apply reports. */
export type Differing = { kind: "mcp" | "skill"; name: string };

export type Scan = { items: Item[]; differs: Differing[]; notes: string[] };

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The entry as the catalog would hold it, or why it cannot be. */
export function capturedOf(agent: Registered, entry: Obj, cwd: string): Captured | string {
  const read = agent.mcp?.read(entry, cwd);
  if (read === undefined || read === null) return `${agent.name} has it in a form fleet does not read`;
  const { target } = read;
  if (target.kind === "stdio") return { command: target.command, env: target.env, transport: null, url: null, headers: {} };
  return { command: null, env: {}, transport: target.transport === "sse" ? "sse" : "http", url: target.url, headers: target.headers };
}

/** What stops a definition from going into the catalog, or null. */
export function captureProblem(name: string, server: Captured): string | null {
  if (!SERVER_NAME.test(name)) return `'${name}' is not a name the catalog takes: letters, digits, '_' and '-'`;
  if (server.command !== null && holdsCredentialArg(server.command.slice(1))) return "its command line holds a credential, which every user on the machine can read; move it to an environment variable and capture it again";
  if (server.url !== null) {
    if (urlHoldsCredentials(server.url)) return `its ${MCP_URL_CREDENTIALS.replace(/^the URL/, "URL")}`;
    if (holdsCredentialQuery(server.url)) return "its URL holds a credential in a query parameter; use a header and capture it again";
    if (/[\u0000- \u007f]/.test(server.url)) return "its URL holds a space or a control character";
  }
  return null;
}

const same = (a: Captured, b: Captured): boolean => hashValue(a) === hashValue(b);

function variantsOf(local: LocalMcp, home: string): { variants: Variant[]; problems: string[] } {
  const variants: Variant[] = [];
  const problems: string[] = [];
  for (const { agent, entry } of local.entries) {
    const server = capturedOf(agent, entry, home);
    if (typeof server === "string") {
      problems.push(server);
      continue;
    }
    const twin = variants.find((v) => same(v.server, server));
    if (twin !== undefined) twin.agents.push(agent.id);
    else variants.push({ agents: [agent.id], server });
  }
  return { variants, problems };
}

/** What the catalog's own pick of a server would write for the agents that have it here, and whether each of those entries is what is on disk. */
type Comparison = "equal" | "differs" | { unreadable: string };

function compareMcp(local: LocalMcp, keys: Config["keys"], secrets: Map<string, string> | string): Comparison {
  if (typeof secrets === "string") return { unreadable: secrets };
  const rendered = renderKeys(keys, secrets);
  for (const { agent, entry } of local.entries) {
    const key = rendered.find((k) => k.file === agent.mcp!.file && k.path === `${agent.mcp!.key}.${local.name}`);
    // A tool may store defaults the catalog leaves out (`args: []`), which is no difference.
    if (key === undefined || hashValue(key.value) !== hashValue(withoutEmpty(entry))) return "differs";
  }
  return "equal";
}

/** The repo of a skill's directory, or why it has none capture can use. */
export function repoOf(configDir: string, home: string, tilde: string, sources: readonly { name: string; repo: string; path: string }[]): RepoInfo | string {
  let real: string;
  try {
    real = realpathSync(expandTarget(tilde, home));
  } catch {
    return "it cannot be read";
  }
  const inside = (root: string): boolean => {
    try {
      const base = realpathSync(root);
      return real === base || real.startsWith(base + sep);
    } catch {
      return false;
    }
  };
  if (inside(configDir)) return "it is stored in the config repo, which capture does not handle yet";
  const top = runGit(real, "rev-parse", "--show-toplevel");
  if (!top.ok) return "it is not in a git repo: put it in a repo with a remote first";
  const remote = runGit(real, "remote", "get-url", "origin");
  if (!remote.ok || remote.stdout === "") return "its repo has no remote called origin: add one and push first";
  if (urlHoldsCredentials(remote.stdout)) return `its repo's remote holds credentials. ${REPO_CREDENTIALS}`;
  const commit = runGit(real, "rev-parse", "HEAD");
  if (!commit.ok) return "its repo has no commits yet";
  if (runGit(real, "branch", "--remotes", "--contains", commit.stdout).stdout === "") return "its latest commit is not on the remote yet: push the repo first";
  const root = realpathSync(top.stdout);
  const path = relative(root, real).split(sep).slice(0, -1).join("/") || ".";
  if (relative(root, real) === "") return "it is a whole repo, and a skill source holds skills in a directory";
  const branch = runGit(real, "branch", "--show-current").stdout || runGit(real, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").stdout.replace(/^origin\//, "") || "main";
  const dirty = runGit(real, "status", "--porcelain", "--", real).stdout !== "";
  const known = sources.find((s) => sameRepo(s.repo, remote.stdout) && s.path === path)?.name ?? null;
  return { repo: remote.stdout, path, commit: commit.stdout, track: branch, dirty, source: known };
}

/** Loads the config for this host, as `adopt` does (a missing source is cloned), and falls back to a load that skips the skills. */
function loadFor(configDir: string, host: string, home: string, agents: readonly Registered[], overlay: Record<string, string> | undefined, notes: string[]): Config | null {
  for (const sources of ["diff", "none"] as const) {
    try {
      return loadConfig(configDir, host, { home, sources, agents, ...(overlay === undefined ? {} : { overlay }) });
    } catch (error) {
      if (!(error instanceof InvalidConfigError) && sources === "none") throw error;
      if (sources === "none") notes.push(`the config could not be read, so nothing was compared with it: ${(error as Error).message.split("\n")[0]}`);
      else if (error instanceof InvalidConfigError) notes.push(`the skill sources could not be read (${error.problems[0] ?? "invalid config"}); skills the catalog has are not compared`);
    }
  }
  return null;
}

/** Everything capture would offer on this machine. Writes nothing. */
export function scanMachine(configDir: string, host: string, home: string, agents: readonly Registered[]): Scan {
  const ignored = ignoredItems(configDir, host);
  const local = readLocal(home, agents, ignored);
  const notes = [...local.notes];
  const problems: string[] = [];
  const servers = parseMcpCatalog(configDir, problems);
  const catalog = parseCatalog(configDir, problems);
  const base = loadFor(configDir, host, home, agents, undefined, notes);
  const items: Item[] = [];
  const differs: Differing[] = [];

  // A server the catalog has but this host does not pick is compared as if it did: the engine adds the pick in memory.
  const pickedBase = pickedServers(base);
  const unpicked = local.mcp.filter((m) => servers.has(m.name) && !pickedBase.has(m.name));
  const overlay =
    unpicked.length === 0 || base === null
      ? null
      : loadFor(configDir, host, home, agents, applyOps(readFiles(configDir), unpicked.map((m) => ({ op: "add" as const, host, kind: "mcp" as const, name: m.name }))).files, notes);

  for (const m of local.mcp) {
    const picked = pickedBase.has(m.name);
    const known = servers.get(m.name);
    if (known !== undefined) {
      const config = picked ? base : overlay;
      const keys = config?.keys.filter((k) => mcpEntryOf(k)?.name === m.name) ?? [];
      let secrets: Map<string, string> | string = new Map();
      if (config !== null) {
        try {
          secrets = resolveSecrets(configDir, host, home, [...new Set(keys.flatMap((k) => secretNames(k.value)))].sort());
        } catch (error) {
          if (!(error instanceof NeedsSecretError)) throw error;
          secrets = error.message;
        }
      }
      const result: Comparison = config === null ? { unreadable: "the config could not be read" } : compareMcp(m, keys, secrets);
      if (result === "equal") items.push({ kind: "mcp", name: m.name, state: picked ? "takeover" : "catalog", message: null, agents: agentIds(m.entries), variants: variantsOf(m, home).variants });
      else {
        differs.push({ kind: "mcp", name: m.name });
        if (typeof result === "object") notes.push(`${m.name}: not compared with the catalog: ${result.unreadable}`);
      }
      continue;
    }
    const { variants, problems: shapes } = variantsOf(m, home);
    const stop = shapes[0] ?? variants.map((v) => captureProblem(m.name, v.server)).find((p) => p !== null) ?? null;
    items.push({ kind: "mcp", name: m.name, state: stop === null ? "new" : "blocked", message: stop, agents: agentIds(m.entries), variants });
  }

  const holder = new Map(catalog.bundles.entries().flatMap(([bundle, skills]) => skills.map((s) => [s, bundle] as const)));
  for (const s of local.skills) items.push(...skillItem(s, holder.get(s.name) ?? null, { configDir, home, base, catalog, differs }));
  return { items: items.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)), differs, notes };
}

/** The names of the servers a config has keys for. */
const pickedServers = (config: Config | null): Set<string> => new Set((config?.keys ?? []).flatMap((k) => mcpEntryOf(k)?.name ?? []));

function skillItem(skill: LocalSkill, bundle: string | null, ctx: { configDir: string; home: string; base: Config | null; catalog: ReturnType<typeof parseCatalog>; differs: Differing[] }): Item[] {
  const { configDir, home, base, catalog } = ctx;
  if (bundle !== null) {
    const picked = base?.skills.includes(skill.name) === true;
    if (!picked) return [{ kind: "skill", name: skill.name, state: "catalog", message: null, path: skill.path, repo: null, bundle }];
    const records = base!.files.filter((f) => SKILL_TARGETS.some((dir) => f.target === `${dir}/${skill.name}`));
    const plan = planLinks(records, [], home);
    if (records.length > 0 && plan.conflicts.length === 0 && plan.creates.length === 0) return [{ kind: "skill", name: skill.name, state: "takeover", message: null, path: skill.path, repo: null, bundle }];
    ctx.differs.push({ kind: "skill", name: skill.name });
    return [];
  }
  const repo = repoOf(configDir, home, skill.path, catalog.sources);
  if (typeof repo === "string") return [{ kind: "skill", name: skill.name, state: "blocked", message: repo, path: skill.path, repo: null, bundle: null }];
  return [{ kind: "skill", name: skill.name, state: "new", message: null, path: skill.path, repo, bundle: null }];
}
