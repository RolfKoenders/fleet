import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { note } from "./events.ts";
import type { Relayed } from "./output.ts";
import { probedNode } from "./tools.ts";

const MARK = "FLEET_RELAUNCHED";

/** True in a process that another `fleet` started to run newer code, so it never starts a third. */
export const relaunched = (): boolean => process.env[MARK] === "1";

/**
 * Runs `bin/fleet` from `root` with `args`, its output going straight to ours, and returns its exit
 * code. This is how `fleet apply` hands over to the code it just checked out.
 */
export function relaunch(root: string, args: string[]): Relayed {
  note("fleet: the fleet clone moved; running its new code");
  const r = spawnSync(join(root, "bin/fleet"), args, {
    stdio: "inherit",
    // The wrapper already found a usable Node; the new run reuses it rather than probing again.
    env: { ...process.env, FLEET_NODE: probedNode(), [MARK]: "1" },
  });
  if (r.error) return { relayed: 1, messages: [`fleet: cannot run the new code at ${join(root, "bin/fleet")}: ${r.error.message}`] };
  return { relayed: r.status ?? 1 };
}
