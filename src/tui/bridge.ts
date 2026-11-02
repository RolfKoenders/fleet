import { homedir } from "node:os";
import { readHostName } from "../host.ts";
import type { Relayed, Result } from "../output.ts";
import { createApp } from "./app.ts";
import { detectLevel } from "./color.ts";
import type { Env } from "./color.ts";
import { loadModel } from "./model.ts";
import { realProbe } from "./probe.ts";
import { RealPusher } from "./pusher.ts";
import { runOnTerminal } from "./runtime.ts";

/** Whether the boot animation and the spinners may move: not when the user or a plain terminal asks for none. */
export const motionAllowed = (env: Env): boolean => (env.FLEET_NO_MOTION ?? "") === "" && env.TERM !== "dumb" && env.TERM !== "linux";

/**
 * `fleet bridge`: the full-screen view. It reads the config, this host and, over ssh, the others, and writes
 * nothing. It needs a terminal, so an agent or a pipe gets a refusal that points at `fleet status`.
 */
export async function bridge(toolDir: string, configDir: string, json: boolean, env: Env = process.env, home: string = homedir()): Promise<Result | Relayed> {
  if (json) return { code: "invalid", messages: ["fleet: 'bridge' is a full-screen view and has no --json form; use 'fleet status --all --json'"] };
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    return { code: "invalid", messages: ["fleet: 'bridge' needs a terminal; to read the same facts without one, run 'fleet status --all'"] };
  }
  const level = detectLevel(env, true);
  const motion = motionAllowed(env);
  const model = loadModel(configDir, readHostName(home));
  const pusher = new RealPusher(toolDir, configDir, home, model.hosts);
  const app = createApp({ model, probe: realProbe(toolDir, configDir, home), pusher, motion, boot: motion && level !== "none" });
  const code = await runOnTerminal(app, { stdin: process.stdin, stdout: process.stdout }, { level });
  // The screen is gone but a push that was started from it is not: say so, and stay until it has ended.
  const waiting = pusher.whenDone();
  if (waiting === null) return { relayed: code };
  process.stderr.write(`fleet: a push is still running (${pusher.running()}). Leaving the bridge did not stop it; waiting for it to end.\n`);
  const end = await waiting;
  const how = end.code === null ? `no result (exit ${end.exit ?? "none"})` : end.code;
  process.stderr.write(`fleet: the push ended: ${how}\n`);
  return { relayed: code, messages: end.messages };
}
