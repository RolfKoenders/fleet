import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type LinkRecord = { target: string; source: string };

/** An owned key fleet wrote. `desired` hashes the rendered value, `actual` what was read back after writing. */
export type KeyRecord = { file: string; path: string; desired: string; actual: string };

/** `~/.local/state/fleet/applied.json`. */
export type AppliedState = {
  version: 1;
  host: string;
  appliedAt: string;
  repos: Record<string, string>;
  links: LinkRecord[];
  keys: KeyRecord[];
};

export const stateDir = (home: string = homedir()) => join(home, ".local/state/fleet");
const statePath = (home: string) => join(stateDir(home), "applied.json");

/** Null when nothing has been applied yet. A file that cannot be read is an error, not an empty state. */
export function readState(home: string = homedir()): AppliedState | null {
  let text: string;
  try {
    text = readFileSync(statePath(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const state = JSON.parse(text) as AppliedState;
  if (state.version !== 1) throw new Error(`applied state has version ${state.version}, expected 1`);
  return state;
}

/** Writes through a temp file and a rename, so a crash never leaves half a file. Mode 600. */
export function writeState(state: AppliedState, home: string = homedir()): void {
  const path = statePath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
