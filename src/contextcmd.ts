import { homedir } from "node:os";
import { currentDefinitions, measureContext } from "./context.ts";
import { renderContext } from "./contextview.ts";
import { collectUsage, PRIVACY_NOTE } from "./usage.ts";
import { renderUsage } from "./usageview.ts";
import { readHostName } from "./host.ts";
import { agentsOnHost } from "./hostagents.ts";
import type { ContextReport } from "./context.ts";
import type { Result } from "./output.ts";
import { detectLevel } from "./tui/color.ts";
import type { Level } from "./tui/color.ts";

/** The colours the bars use: what the terminal supports, or 256 when colour was asked for by `FORCE_COLOR`. */
export function levelFor(color: boolean, env: NodeJS.ProcessEnv): Level {
  if (!color) return "none";
  const level = detectLevel(env, true);
  return level === "none" ? "256" : level;
}

/** This host's report, and what limits it, as the messages `fleet context` prints. Reads only. */
export function measureHere(configDir: string | null, home: string, now: Date): { report: ContextReport; messages: string[] } {
  const messages: string[] = [];
  const host = readHostName(home);
  let definitions = null;
  if (configDir === null) messages.push("fleet: no config repo is set, so a measurement cannot be compared with the current config");
  else if (host === null) messages.push("fleet: no host name set; `fleet init <host>` writes one. Measurements cannot be compared with the current config");
  else {
    try {
      definitions = currentDefinitions(configDir, host, home);
    } catch (error) {
      messages.push(`fleet: the config could not be read, so a measurement cannot be compared with it (${(error as Error).message.split("\n")[0]})`);
    }
  }
  const report = measureContext(home, { now, definitions, agents: agentsOnHost(configDir, host, home) });
  messages.push(...report.notes.map((n) => `fleet: ${n}`), ...report.agents.flatMap((a) => a.notes.map((n) => `fleet: ${a.agent}: ${n}`)));
  return { report, messages };
}

/**
 * `fleet context`: what each agent on this host loads before the first prompt. A report, not a check, so it is
 * `ok` whenever it could be made. Reads only: no MCP server is started and no secret is decrypted.
 */
export function context(configDir: string | null, color: boolean, home: string = homedir(), now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): Result {
  const { report, messages } = measureHere(configDir, home, now);
  return { code: "ok", text: renderContext(report, levelFor(color, env)), messages, fields: { ...report } };
}

/**
 * `fleet context --usage`: the same report, and under it how often each MCP server and skill was used in the last 30
 * days, read from each agent's own history on this host. Slower than `context`, which reads no history. Only names
 * and counts are kept or printed.
 */
export async function contextWithUsage(configDir: string | null, color: boolean, home: string = homedir(), now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): Promise<Result> {
  const here = measureHere(configDir, home, now);
  const report: ContextReport = { ...here.report, usage: await collectUsage(here.report, home, env, now) };
  return { code: "ok", text: [renderContext(report, levelFor(color, env)), "", ...renderUsage(report), "", PRIVACY_NOTE].join("\n"), messages: here.messages, fields: { ...report } };
}
