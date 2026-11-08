import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, sep } from "node:path";
import { readHostName } from "../host.ts";
import type { Relayed, Result } from "../output.ts";
import { createApp } from "./app.ts";
import { readCache, readContextCache, remember, rememberContext } from "./cache.ts";
import { detectLevel } from "./color.ts";
import type { Env } from "./color.ts";
import { loadModel } from "./model.ts";
import type { Model } from "./model.ts";
import { realProbe } from "./probe.ts";
import { RealPusher } from "./pusher.ts";
import { runOnTerminal } from "./runtime.ts";
import { checkHost, checkView } from "./start.ts";
import type { Screen } from "./palette.ts";

/** Whether the boot animation and the spinners may move: not when the user or a plain terminal asks for none. */
export const motionAllowed = (env: Env): boolean => (env.FLEET_NO_MOTION ?? "") === "" && env.TERM !== "dumb" && env.TERM !== "linux";

/**
 * Whether this is the demo's bridge: `fleet demo` starts it with `FLEET_DEMO_ROOT` set to its sandbox. The root must be
 * a directory the demo makes (its name, in the temp directory) and the home must be inside it, so the variable cannot
 * dress a real home up as made up.
 */
export function inDemo(env: Env, home: string): boolean {
  const root = env.FLEET_DEMO_ROOT;
  if (root === undefined || root === "") return false;
  try {
    return basename(root).startsWith("fleet-demo-") && root.startsWith(realpathSync(tmpdir()) + sep) && home.startsWith(root + sep);
  } catch {
    return false;
  }
}

/**
 * `fleet bridge`: the full-screen view. It reads the config, this host and, over ssh, the others, and writes
 * nothing. It needs a terminal, so an agent or a pipe gets a refusal that points at `fleet status`. `view` and `host`
 * say where it opens; a name that is not one is refused (exit 2) before the screen is taken over.
 */
export async function bridge(toolDir: string, configDir: () => string, json: boolean, env: Env = process.env, home: string = homedir(), where: { view?: string; host?: string } = {}): Promise<Result | Relayed> {
  if (json) return { code: "invalid", messages: ["fleet: 'bridge' is a full-screen view and has no --json form; use 'fleet status --all --json'"] };
  // The config is read before the terminal is checked only when a host is named, the one name that needs it.
  let dir: string | null = null;
  let loaded: Model | null = null;
  const load = (): Model => {
    dir ??= configDir();
    return (loaded ??= loadModel(dir, readHostName(home)));
  };
  const refused = checkView(where.view) ?? (where.host === undefined ? null : checkHost(load(), where.host));
  if (refused !== null) return refused;
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    return { code: "invalid", messages: ["fleet: 'bridge' needs a terminal; to read the same facts without one, run 'fleet status --all'"] };
  }
  const model = load();
  const level = detectLevel(env, true);
  const motion = motionAllowed(env);
  const pusher = new RealPusher(toolDir, dir!, home, model.hosts);
  const demo = inDemo(env, home);
  const app = createApp({ model, probe: realProbe(toolDir, dir!, home), pusher, motion, boot: motion && level !== "none", ...(demo ? { demo: true, noDoctor: "the hosts are made up, and doctor would start real servers" } : {}), cached: readCache(home), cachedContext: readContextCache(home), plain: level === "none", ...(where.view !== undefined ? { view: where.view as Screen } : {}), ...(where.host !== undefined ? { host: where.host } : {}), remember: (host, status) => remember(home, host, status), rememberContext: (host, report) => rememberContext(home, host, report) });
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
