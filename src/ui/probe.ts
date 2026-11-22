import { having } from "../agents/index.ts";
import type { AgentId } from "../agents/index.ts";
import { clean, planEntry } from "../doctor.ts";
import { parseMcpCatalog, renderFor } from "../mcp.ts";
import { probe } from "../mcpprobe.ts";
import type { ProbeResult } from "../mcpprobe.ts";
import { resolveSecrets, secretFileFor, secretFiles, lastSetForSecret } from "../secrets.ts";
import type { SecretFile } from "../secrets.ts";
import { fillSecrets, fillVars, secretNames } from "../template.ts";
import { estimateTokens } from "../tokens.ts";
import { probedNode, probeExtraDirs } from "../tools.ts";
import type { Value } from "../edit/index.ts";

/**
 * "Check it starts": doctor's probe, on one catalog entry that is not on disk yet, on this machine. It runs the command
 * (or calls the URL) with the real credentials it can read, so the page asks first. A secret with no value here is left
 * out and named, so the server starts without it. No value ever leaves this function: the answer holds names only, and
 * the probe's own text is cleaned of every value it was given.
 */

export type Checked = {
  /** The probe's result, or `not-run` when something in the entry could not be filled in. */
  result: ProbeResult | "not-run";
  /** The agent whose rendering was probed. */
  agent: AgentId;
  transport: "stdio" | "http" | "sse";
  tools: number | null;
  size: number | null;
  tokens: number | null;
  latencyMs: number | null;
  protocol: string | null;
  detail: string | null;
  /** Secrets the entry names that have no value on this host, and so were left out. */
  unset: string[];
  /** Secrets the entry uses, when the server rejected them. */
  secrets: { name: string; file: SecretFile; lastSet: string | null }[];
};

const TIMEOUT_MS = 30_000;

function secretRefs(configDir: string, host: string, files: Map<SecretFile, Set<string>>, names: string[]): { name: string; file: SecretFile; lastSet: string | null }[] {
  return names.map((name) => {
    const file = secretFileFor(files, name) ?? "shared";
    return { name, file, lastSet: lastSetForSecret(configDir, file, name) };
  });
}

/** Drops the entries of `map` whose value names a secret in `unset`. */
const without = (map: Record<string, string> | undefined, unset: Set<string>): Record<string, string> | undefined =>
  map === undefined ? undefined : Object.fromEntries(Object.entries(map).filter(([, v]) => !secretNames(v).some((n) => unset.has(n))));

export async function checkEntry(configDir: string, host: string | null, home: string, name: string, entry: Record<string, Value>): Promise<Checked> {
  const problems: string[] = [];
  const parsed = parseMcpCatalog(".", problems, { root: ".", files: { "catalog/mcp.yaml": JSON.stringify({ servers: { [name]: entry } }) } }).get(name);
  // The first agent the entry is for, or the first agent there is when the entry does not load.
  const agent = having("mcp").find((a) => a.id === parsed?.only[0]) ?? having("mcp")[0]!;
  const blank = (over: Partial<Checked>): Checked => ({ result: "not-run", agent: agent.id, transport: parsed?.command !== null ? "stdio" : (parsed?.transport ?? "http"), tools: null, size: null, tokens: null, latencyMs: null, protocol: null, detail: null, unset: [], secrets: [], ...over });
  if (parsed === undefined) return blank({ detail: problems[0] ?? "the entry does not load" });

  // Only the secrets this entry names are read, one at a time: one with no value here does not stop the others.
  const values = new Map<string, string>();
  const unset = new Set<string>();
  for (const secret of secretNames(entry)) {
    try {
      if (host === null) throw new Error("no host");
      for (const [k, v] of resolveSecrets(configDir, host, home, [secret])) values.set(k, v);
    } catch {
      unset.add(secret);
    }
  }
  const server = { ...parsed, env: without(parsed.env, unset)!, headers: without(parsed.headers, unset)! };
  const filled = fillVars({ command: server.command, env: server.env, url: server.url, headers: server.headers }, { HOME: home });
  if (filled.unknown.length > 0) return blank({ unset: [...unset].sort(), detail: `the entry uses {{ vars.${filled.unknown[0]} }}, which this check does not fill in` });
  const withVars = { ...server, ...(filled.value as Pick<typeof server, "command" | "env" | "url" | "headers">) };
  if (withVars.url !== null && secretNames(withVars.url).some((n) => unset.has(n))) {
    return blank({ unset: [...unset].sort(), detail: "the URL holds a secret that has no value on this host, so there is nothing to call" });
  }
  const rendered = fillSecrets(renderFor(agent, withVars, probedNode()), values).value;
  const planned = planEntry(name, agent, rendered, home);
  if (planned.target === null) return blank({ unset: [...unset].sort(), detail: "the rendered entry has an unexpected shape" });
  const r = await probe(planned.target, TIMEOUT_MS, probeExtraDirs(home));
  const usedSecrets = secretNames(entry).filter((n) => !unset.has(n));
  const secretFilesMap = host === null ? new Map<SecretFile, Set<string>>() : secretFiles(configDir, host);
  return {
    result: r.result,
    agent: agent.id,
    transport: planned.transport === "remote" ? "http" : planned.transport,
    tools: r.tools,
    size: r.size,
    tokens: r.size === null ? null : estimateTokens(r.size),
    latencyMs: r.latencyMs,
    protocol: r.protocol,
    detail: r.detail === null ? null : clean(r.detail, [...values.values()]),
    unset: [...unset].sort(),
    secrets: r.result === "bad-auth" ? secretRefs(configDir, host ?? "", secretFilesMap, usedSecrets) : [],
  };
}
