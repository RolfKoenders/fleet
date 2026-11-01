import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * The tool's directory is the code that is running (`toolDir`). The config's directory is the user's own
 * repo (`configDir`). Nothing reads a config file from the tool's directory.
 */

const MANAGED_TOOL = ".local/share/fleet/fleet";

/** The fleet clone fleet manages on a host, which `~/.local/bin/fleet` points into. */
export const managedToolDir = (home: string = homedir()): string => join(home, MANAGED_TOOL);

const realpath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

export const isManagedTool = (toolDir: string, home: string = homedir()): boolean => realpath(toolDir) === realpath(managedToolDir(home));

/** The file `fleet init` writes: one line, the absolute path of the config repo. */
export const CONFIG_FILE = ".config/fleet/config";

/**
 * `FLEET_CONFIG` overrides the file. Returns a problem, as a sentence, when
 * there is none or it is not a directory.
 */
export function findConfigDir(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): { dir: string } | { problem: string } {
  const override = env.FLEET_CONFIG;
  let dir: string;
  if (override !== undefined && override !== "") {
    dir = resolve(override);
  } else {
    const file = join(home, CONFIG_FILE);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return { problem: `no config repo is set: ~/${CONFIG_FILE} is missing; 'fleet init' writes it, or set FLEET_CONFIG to the repo's path` };
    }
    dir = text.split("\n")[0]!.trim();
    if (dir === "" || !isAbsolute(dir)) return { problem: `~/${CONFIG_FILE} must hold the absolute path of the config repo on its first line` };
  }
  try {
    if (!statSync(dir).isDirectory()) throw new Error("not a directory");
  } catch {
    return { problem: `the config repo ${dir} is not a directory` };
  }
  return { dir };
}
