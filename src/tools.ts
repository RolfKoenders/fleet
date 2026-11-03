import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Homebrew keeps its binaries in `/opt/homebrew/bin` on Apple Silicon and `/usr/local/bin` on Intel, which
 * is already a system directory here. The versioned Node formulas (`node@26`, `node@24`, `node@22`) are keg-only, newest first, so they are in
 * `opt/<formula>/bin` and on no directory above. `bin/fleet` and `install.sh` are shell and repeat these
 * lists; a test keeps them equal.
 */
export const HOMEBREW_BIN = "/opt/homebrew/bin";
export const HOMEBREW_KEG_NODES = ["/opt/homebrew", "/usr/local"].flatMap((prefix) => [26, 24, 22].map((v) => `${prefix}/opt/node@${v}/bin/node`));

/** The directories searched before `PATH`, in order. The home ones come first, so a host's own copy wins. */
export const probeDirs = (home: string = homedir()): string[] => [join(home, ".local/bin"), join(home, ".opencode/bin"), "/usr/bin", "/usr/local/bin", HOMEBREW_BIN];

/** The same directories as a shell `PATH` prefix, with `$HOME` left for the shell to expand. */
export const SHELL_PROBE_PATH = ["$HOME/.local/bin", "$HOME/.opencode/bin", "/usr/bin", "/usr/local/bin", HOMEBREW_BIN].join(":");

/** Node candidates a shell script tries after the fnm alias and `~/.local/bin/node`, as quoted words. */
export const SHELL_NODE_CANDIDATES = [`${HOMEBREW_BIN}/node`, ...HOMEBREW_KEG_NODES].map((p) => `"${p}"`);

/** The Node fleet runs under, as `bin/fleet` probed it (an fnm alias, not a resolved path). */
export const probedNode = (): string => process.env.FLEET_NODE_PATH ?? process.execPath;

/** External tools are called by absolute path, searched for in this order. */
export function findTool(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | null {
  const dirs = [...probeDirs(home), ...(env.PATH ?? "").split(delimiter).filter((d) => d !== "")];
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
