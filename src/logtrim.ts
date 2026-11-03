import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, readSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LAUNCHD_LOG, thisOs } from "./scheduler.ts";
import type { Os } from "./scheduler.ts";

/** Over this size the log is cut down. */
export const LOG_LIMIT = 1024 * 1024;
/** What is kept, from the end. Well under the limit, so the next trim is many runs away. */
export const LOG_KEEP = 256 * 1024;

/**
 * Keeps `~/Library/Logs/fleet.log` from growing for ever. On macOS launchd opens the file itself, once, by path,
 * and holds that descriptor for as long as the agent is loaded, so the file cannot be renamed or replaced: the
 * agent would go on writing to the old, unlinked one. It is cut down in place instead, in the same inode. The
 * tail is copied to the start and the file is then shortened, so there is no moment when it is empty.
 *
 * Whether launchd's descriptor appends (O_APPEND) is not documented. If it does, its next write lands at the new
 * end and all is well. If it keeps its own offset, that write lands past the end and leaves a gap of NUL bytes,
 * which is ugly but harmless. A line another writer appends during the few milliseconds of the trim can be lost.
 *
 * It runs at the start of an apply, under the apply lock, so no other apply is running. The agent's own apply has
 * written nothing yet, so the only writer left is launchd itself.
 *
 * A crash between the copy and the truncate leaves the new tail at the start followed by stale old bytes. Nothing
 * is lost beyond the old head, the file is still over the limit, and the next apply trims it again.
 *
 * A symlink or anything that is not a regular file is left alone: the log is launchd's, and following a link would
 * rewrite a file elsewhere. An unreadable or unwritable log is skipped. Linux has no such file and nothing happens.
 * A failure never stops an apply.
 *
 * Cannot be proven without a Mac: whether launchd opens StandardOutPath and StandardErrorPath with O_APPEND, and
 * whether it reopens them. The tests use a descriptor opened with "a" as a stand-in.
 */
export function trimLog(home: string = homedir(), os: Os = thisOs()): boolean {
  if (os !== "darwin") return false;
  let fd: number | null = null;
  try {
    const path = join(home, LAUNCHD_LOG);
    if (!lstatSync(path).isFile()) return false;
    fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
    const size = fstatSync(fd).size;
    if (size <= LOG_LIMIT) return false;
    const tail = Buffer.alloc(LOG_KEEP);
    let got = 0;
    while (got < LOG_KEEP) {
      const n = readSync(fd, tail, got, LOG_KEEP - got, size - LOG_KEEP + got);
      if (n === 0) break;
      got += n;
    }
    // Start at a line, not in the middle of one.
    const nl = tail.subarray(0, got).indexOf(10);
    const kept = nl === -1 ? tail.subarray(0, got) : tail.subarray(nl + 1, got);
    let written = 0;
    while (written < kept.length) written += writeSync(fd, kept, written, kept.length - written, written);
    ftruncateSync(fd, kept.length);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
