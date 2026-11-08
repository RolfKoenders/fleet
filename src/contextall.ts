import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { levelFor, measureHere } from "./contextcmd.ts";
import { readContextReport } from "./contextread.ts";
import { largestAgent, renderContext } from "./contextview.ts";
import type { ContextReport } from "./context.ts";
import { readHostName } from "./host.ts";
import { paint } from "./output.ts";
import type { Result } from "./output.ts";
import { EXIT_ORDER, printable, sshArguments } from "./status.ts";
import type { SshOutcome } from "./status.ts";
import { hostTargets } from "./targets.ts";
import { findTool } from "./tools.ts";
import { formatTokens } from "./tokens.ts";

/**
 * `fleet context --all`: this host measured in place, every other host with an `ssh` destination asked over ssh,
 * all drawn on one scale.
 */

export const CONTEXT_COMMAND = "~/.local/bin/fleet context --json";

/**
 * One host's answer. `timer` is a host with no `ssh` destination. `old` is a host whose pinned fleet has no
 * `context` command yet: not an error, it just needs a newer pin.
 */
export type HostContext = {
  host: string;
  result: "ok" | "unreachable" | "timer" | "old" | "error";
  /** The `fleet context --json` document, for a host that answered. */
  context: ContextReport | null;
  /** Why it is not ok, as printable text. */
  detail?: string;
};

/** Reads one host's answer to `fleet context --json`. ssh exiting 255 is unreachable; an older fleet exits 2, whatever it printed. */
export function hostContextFrom(host: string, r: SshOutcome, notes: string[]): HostContext {
  if (r.error || r.status === 255) {
    const why = printable(r.error?.message ?? r.stderr.trim().split("\n")[0]) || "no reason given";
    notes.push(`fleet: ${host}: unreachable over ssh (${why})`);
    return { host, result: "unreachable", context: null };
  }
  if (r.status === 2) return { host, result: "old", context: null, detail: "needs a newer pin" };
  const read = readContextReport(r.stdout);
  if (read.ok) return { host, result: "ok", context: read.report };
  const detail = `${read.reason} (exit ${r.status ?? "none"})`;
  notes.push(`fleet: ${host}: ${detail}`);
  return { host, result: "error", context: null, detail };
}

function ask(ssh: string, dest: string, host: string, notes: string[]): HostContext {
  const r = spawnSync(ssh, sshArguments(dest, CONTEXT_COMMAND), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  return hostContextFrom(host, { error: r.error, status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }, notes);
}

const indent = (text: string): string => text.split("\n").map((l) => (l === "" ? l : `  ${l}`)).join("\n");

export function contextAll(configDir: string, color: boolean, home: string = homedir(), now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): Result {
  const self = readHostName(home);
  const problems: string[] = [];
  const targets = hostTargets(configDir, self, problems);
  if (problems.length > 0) return { code: "invalid", messages: problems.map((p) => `fleet: ${p}`) };
  const ssh = findTool("ssh", env, home);
  if (ssh === null && targets.some((t) => t.ssh !== null)) {
    return { code: "missing-prerequisite", messages: ["fleet: ssh is not installed, and a host has an 'ssh' destination"] };
  }

  const here = measureHere(configDir, home, now);
  const notes = [...here.messages];
  const records: HostContext[] = targets.map((t) => (t.ssh === null ? { host: t.host, result: "timer", context: null } : ask(ssh!, t.ssh, t.host, notes)));
  if (self !== null) records.push({ host: self, result: "ok", context: here.report });
  records.sort((a, b) => a.host.localeCompare(b.host));
  for (const r of records) {
    if (r.host === self || r.context === null) continue;
    notes.push(...r.context.notes.map((n) => `fleet: ${r.host}: ${n}`), ...r.context.agents.flatMap((a) => a.notes.map((n) => `fleet: ${r.host}: ${a.agent}: ${n}`)));
  }

  const level = levelFor(color, env);
  const answered = records.flatMap((r) => (r.context === null ? [] : [r.context]));
  const scale = largestAgent(answered);
  const blocks = records.map((record) => {
    const name = record.host === self ? `${record.host} (this host)` : record.host;
    const shown = record.result === "ok" ? paint(color, "green", "ok") : record.result === "timer" ? "timer (no ssh destination; it applies on its own schedule)" : record.result === "old" ? paint(color, "yellow", "needs a newer pin") : paint(color, "yellow", record.result);
    const detail = record.result === "old" || record.detail === undefined ? "" : ` (${record.detail})`;
    return [`${name}: ${shown}${detail}`, ...(record.context === null ? [] : [indent(renderContext(record.context, level, scale))])].join("\n");
  });
  const biggest = records.flatMap((r) => (r.context?.agents ?? []).map((a) => ({ host: r.host, agent: a.agent, tokens: a.tokens }))).sort((a, b) => b.tokens - a.tokens)[0];
  const legend = biggest === undefined || scale === 0 ? [] : [`All bars share one scale: a full bar is ${formatTokens(scale)}, ${biggest.agent} on ${biggest.host}.`];

  const worst = EXIT_ORDER.find((result) => records.some((r) => r.result === result));
  return { code: worst ?? "ok", text: [...blocks, ...(legend.length > 0 ? [legend.join("\n")] : [])].join("\n\n"), messages: notes, fields: { ...here.report, hosts: records } };
}
