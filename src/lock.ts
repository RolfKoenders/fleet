import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stateDir } from "./state.ts";

export class LockedError extends Error {}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The apply lock: `~/.local/state/fleet/lock/`, which covers one host's files. */
export const acquireLock = (home: string = homedir()): (() => void) =>
  acquireNamed(home, "lock", (pid) => `another fleet apply is running (pid ${pid})`);

/** The push lock: `~/.local/state/fleet/push.lock/`, which covers a whole push, from validate to the last host. */
export const acquirePushLock = (home: string = homedir()): (() => void) =>
  acquireNamed(home, "push.lock", (pid) => `a push is already running (pid ${pid})`);

/**
 * Takes `~/.local/state/fleet/<name>/`, a directory holding a `pid` file. The directory is built
 * beside it and renamed into place, so it never exists without its pid. A lock whose pid is
 * not a live process is stale and is replaced. Returns the release function. `busy` words the
 * refusal when a live process holds it.
 */
function acquireNamed(home: string, name: string, busy: (pid: number) => string): () => void {
  const dir = stateDir(home);
  const lock = join(dir, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 3; attempt++) {
    const staging = mkdtempSync(join(dir, `${name}-`));
    writeFileSync(join(staging, "pid"), `${process.pid}\n`);
    try {
      renameSync(staging, lock);
      return () => rmSync(lock, { recursive: true, force: true });
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
    }

    const seen = readPid(lock);
    const pid = Number.parseInt(seen, 10);
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
      throw new LockedError(busy(pid));
    }
    removeStale(lock, seen, busy);
  }
  throw new Error(`could not take the lock at ${lock}`);
}

/**
 * Moves the stale lock aside before deleting it, because a rename has one winner. Two applies
 * that both judged the same lock stale cannot then delete the lock the first one just took.
 */
function removeStale(lock: string, seenPid: string, busy: (pid: number) => string): void {
  const aside = `${lock}.stale-${process.pid}`;
  try {
    renameSync(lock, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (readPid(aside) !== seenPid) {
    // Not the lock we judged: another apply replaced it first. Put it back and stand down.
    try {
      renameSync(aside, lock);
    } catch {
      // someone took the path again; the stale copy is still ours to drop
    }
    throw new LockedError(busy(Number.parseInt(readPid(lock), 10)));
  }
  rmSync(aside, { recursive: true, force: true });
}

function readPid(lock: string): string {
  try {
    return readFileSync(join(lock, "pid"), "utf8");
  } catch {
    return "";
  }
}
