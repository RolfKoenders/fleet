import { EXIT } from "./exit.ts";
import type { ExitName } from "./exit.ts";

/** What a command returns. `text` is the human form, `fields` the extra keys of the `--json` document. */
export type Result = {
  code: ExitName;
  text?: string;
  fields?: Record<string, unknown>;
  messages?: string[];
};

/** A command that ran `fleet` again and let it print. Only its exit code is left to report. */
export type Relayed = { relayed: number; messages?: string[] };

export type Sink = { stdout: (s: string) => void; stderr: (s: string) => void };

/**
 * Results go to stdout, messages to stderr. With `json`, stdout is exactly one document and
 * the messages are also listed in it.
 */
export function emit(result: Result | Relayed, host: string | null, json: boolean, sink: Sink): number {
  const messages = result.messages ?? [];
  for (const message of messages) sink.stderr(`${message}\n`);
  if ("relayed" in result) return result.relayed;
  if (json) {
    const doc = { ok: result.code === "ok", code: result.code, host, messages, ...result.fields };
    sink.stdout(`${JSON.stringify(doc, null, 2)}\n`);
  } else if (result.text !== undefined) {
    sink.stdout(result.text.endsWith("\n") ? result.text : `${result.text}\n`);
  }
  return EXIT[result.code];
}

/** https://no-color.org: NO_COLOR wins, FORCE_COLOR forces, otherwise only a terminal gets color. */
export function useColor(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if ((env.NO_COLOR ?? "") !== "") return false;
  if ((env.FORCE_COLOR ?? "") !== "") return env.FORCE_COLOR !== "0";
  return isTTY;
}

export function paint(color: boolean, code: "green" | "yellow", text: string): string {
  if (!color) return text;
  return `\u001b[${code === "green" ? 32 : 33}m${text}\u001b[0m`;
}
