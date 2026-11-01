import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** The Node fleet runs under, as `bin/fleet` probed it (an fnm alias, not a resolved path). */
export const probedNode = (): string => process.env.FLEET_NODE_PATH ?? process.execPath;

/** External tools are called by absolute path, searched for in this order. */
export function findTool(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | null {
  const dirs = [
    join(home, ".local/bin"),
    join(home, ".opencode/bin"),
    "/usr/bin",
    "/usr/local/bin",
    ...(env.PATH ?? "").split(delimiter).filter((d) => d !== ""),
  ];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}
