import { homedir } from "node:os";
import { currentDefinitions, measureContext } from "./context.ts";
import { renderContext } from "./contextview.ts";
import { readHostName } from "./host.ts";
import type { Result } from "./output.ts";
import { detectLevel } from "./tui/color.ts";
import type { Level } from "./tui/color.ts";

/** The colours the bars use: what the terminal supports, or 256 when colour was asked for by `FORCE_COLOR`. */
function levelFor(color: boolean, env: NodeJS.ProcessEnv): Level {
  if (!color) return "none";
  const level = detectLevel(env, true);
  return level === "none" ? "256" : level;
}

/**
 * `fleet context`: what each agent on this host loads before the first prompt. A report, not a check, so it is
 * `ok` whenever it could be made. Reads only: no MCP server is started and no secret is decrypted.
 */
export function context(configDir: string | null, color: boolean, home: string = homedir(), now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): Result {
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
  const report = measureContext(home, { now, definitions });
  messages.push(...report.notes.map((n) => `fleet: ${n}`), ...report.agents.flatMap((a) => a.notes.map((n) => `fleet: ${a.agent}: ${n}`)));
  return { code: "ok", text: renderContext(report, levelFor(color, env)), messages, fields: { ...report } };
}
