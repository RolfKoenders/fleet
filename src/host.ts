import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** This host's name, written by `fleet init` to `~/.config/fleet/host`. Null before init. */
export function readHostName(home: string = homedir()): string | null {
  try {
    const name = readFileSync(join(home, ".config/fleet/host"), "utf8").trim();
    return name === "" ? null : name;
  } catch {
    return null;
  }
}
