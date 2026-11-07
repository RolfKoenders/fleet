import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stateDir, writePrivateJson } from "./state.ts";
import { count, printable } from "./status.ts";
import { isObject } from "./yamlfile.ts";

/**
 * This host's doctor result: what the last `fleet doctor` found for each MCP server it picks, kept at
 * `~/.local/state/fleet/doctor.json`. It is separate from the applied state and is the only record of a
 * server's tools, since doctor is the only command that starts a server.
 *
 * It holds sizes and counts only: no tool name, description or schema, and never a rendered entry, which has
 * secret values in it.
 */

export type MeasuredServer = {
  name: string;
  /** Which agent's entry of the server this is. */
  agent: "claude" | "opencode";
  /** What the most recent run found, whether or not the server answered. */
  result: string;
  /**
   * The last good measurement: null until the server has answered once, and kept as it was when a later run fails.
   * `size` is characters (see `estimateTokens`), `measuredAt` an ISO time.
   */
  tools: number | null;
  size: number | null;
  measuredAt: string | null;
  /**
   * Hash of the catalog entry (secret names, not values) as it was when `size` was measured. A server whose
   * current entry hashes differently has changed since. Null until measured.
   */
  definition: string | null;
};

export type HostDoctorResult = { version: 1; host: string; servers: MeasuredServer[] };

const resultPath = (home: string): string => join(stateDir(home), "doctor.json");

const AGENTS = ["claude", "opencode"] as const;

function measuredOf(v: unknown): MeasuredServer | null {
  const agent = isObject(v) ? AGENTS.find((a) => a === v.agent) : undefined;
  const name = isObject(v) ? printable(v.name) : null;
  if (!isObject(v) || agent === undefined || name === null || name === "") return null;
  return {
    name,
    agent,
    result: printable(v.result) ?? "unknown",
    tools: count(v.tools),
    size: count(v.size),
    measuredAt: printable(v.measuredAt),
    definition: printable(v.definition),
  };
}

/** Null when there is no result yet, or the file is not one fleet wrote: both mean nothing has been measured. */
export function readDoctorResult(home: string = homedir()): HostDoctorResult | null {
  try {
    const doc: unknown = JSON.parse(readFileSync(resultPath(home), "utf8"));
    if (!isObject(doc) || doc.version !== 1 || !Array.isArray(doc.servers)) return null;
    const servers = doc.servers.map(measuredOf).filter((s) => s !== null);
    return { version: 1, host: printable(doc.host) ?? "", servers };
  } catch {
    return null;
  }
}

/** One server as this run found it. `size` is null when it did not answer. */
export type RunServer = { name: string; agent: "claude" | "opencode"; result: string; tools: number | null; size: number | null; definition: string };

/**
 * Saves this run. A server that answered is measured now. One that did not keeps its last good measurement
 * (counts, size, time and the definition hash it had then) and shows this run's result. Servers no longer
 * picked are dropped.
 */
export function saveDoctorResult(host: string, run: RunServer[], home: string = homedir(), now: Date = new Date()): void {
  const before = readDoctorResult(home)?.servers ?? [];
  const servers = run.map((s): MeasuredServer => {
    if (s.size !== null) return { name: s.name, agent: s.agent, result: s.result, tools: s.tools, size: s.size, measuredAt: now.toISOString(), definition: s.definition };
    const last = before.find((b) => b.name === s.name && b.agent === s.agent && b.size !== null);
    return { name: s.name, agent: s.agent, result: s.result, tools: last?.tools ?? null, size: last?.size ?? null, measuredAt: last?.measuredAt ?? null, definition: last?.definition ?? null };
  });
  writePrivateJson(resultPath(home), { version: 1, host, servers } satisfies HostDoctorResult);
}
