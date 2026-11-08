import { runGit } from "./git.ts";

/** A release: the tag `vX.Y.Z` and the commit it points at. */
export type Release = { tag: string; version: [number, number, number]; commit: string };

const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The version a tag name holds, or null for anything that is not exactly `vX.Y.Z`: a suffix, a prefix, other text. */
export function versionOf(tag: string): [number, number, number] | null {
  const m = RELEASE_TAG.exec(tag);
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Negative when `a` is the lower version. Version order, never the date a tag was made. */
export const compareVersions = (a: readonly number[], b: readonly number[]): number => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;

/**
 * The newest release in the output of `git ls-remote --tags`. An annotated tag is listed twice, and the line
 * ending in `^{}` holds the commit it points at, so that one wins over the tag object's own sha.
 */
export function newestRelease(lsRemote: string): Release | null {
  const found = new Map<string, string>();
  for (const line of lsRemote.split("\n")) {
    const m = /^([0-9a-f]{40})\trefs\/tags\/(.+?)(\^\{\})?$/.exec(line);
    if (m === null || versionOf(m[2]!) === null) continue;
    if (m[3] !== undefined || !found.has(m[2]!)) found.set(m[2]!, m[1]!);
  }
  let newest: Release | null = null;
  for (const [tag, commit] of found) {
    const version = versionOf(tag)!;
    if (newest === null || compareVersions(version, newest.version) > 0) newest = { tag, version, commit };
  }
  return newest;
}

/** Whether `ancestor` is `commit` or in its history, in a clone that has both. */
export const isAncestor = (dir: string, ancestor: string, commit: string): boolean => runGit(dir, "merge-base", "--is-ancestor", ancestor, commit).ok;

/**
 * The major version `commit` is in: that of the newest release in its history. 0 when it has none, so a move to
 * a first major version is flagged too.
 */
export function majorOf(dir: string, commit: string): number {
  const tags = runGit(dir, "tag", "--merged", commit, "--list", "v*");
  const majors = (tags.ok ? tags.stdout.split("\n") : []).map((t) => versionOf(t)?.[0] ?? 0);
  return Math.max(0, ...majors);
}
