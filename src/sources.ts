import { redactUrl } from "./redact.ts";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Source } from "./catalog.ts";
import { blockedState, repoState, runGit, syncRepo, UnreachableError } from "./git.ts";
import type { Conflict } from "./plan.ts";

export const sourceDir = (home: string, name: string) => join(home, ".local/share/fleet/sources", name);

/**
 * `apply` moves clones; `diff` only clones missing ones and reports local work as a conflict;
 * `validate` is `diff` that lets a followed source hold local work, because `push` publishes it.
 * `offline` is `diff` that never clones either, for `status`: a missing clone is a problem to report.
 */
export type SourceMode = "apply" | "diff" | "validate" | "offline";

export type PlaceOutcome = { problems: string[]; conflicts: Conflict[] };

const firstLine = (text: string) => redactUrl(text.split("\n")[0] ?? "");

/** A clone that cannot be fast-forwarded because of work in it. `label` is how the repo is shown, and works in `git -C`. */
export function repoConflict(label: string, blocked: string): Conflict {
  return {
    kind: "repo",
    path: label,
    detail: `${label} ${blocked}`,
    fix: `Publish it with 'fleet push', or discard the work (git -C ${label} stash -u for changes, git -C ${label} reset --hard @{upstream} for commits), then run 'fleet apply'.`,
  };
}

/** Returns a problem when the repo answered but cannot give what the catalog asks for. */
function clone(source: Source, dir: string): string | null {
  mkdirSync(dirname(dir), { recursive: true });
  const branch = source.branch === null ? [] : ["--branch", source.branch];
  const r = runGit(dirname(dir), "clone", "--quiet", ...branch, source.repo, dir);
  if (r.ok) return null;
  const why = firstLine(r.stderr);
  if (/Remote branch .* not found/.test(r.stderr)) return `source '${source.name}': branch ${source.branch} is not in ${redactUrl(source.repo)}`;
  if (/already exists and is not an empty directory/.test(r.stderr)) {
    throw new Error(`${dir} exists but is not a git clone; move or delete it, then run 'fleet apply'`);
  }
  throw new UnreachableError(`cannot clone ${redactUrl(source.repo)} for source '${source.name}': ${why}`);
}

/** Fetches once, only when what is wanted is not already in the clone. */
function fetchUnlessHave(dir: string, source: Source, have: () => boolean): boolean {
  if (have()) return true;
  const r = runGit(dir, "fetch", "--quiet", "origin");
  if (!r.ok) throw new UnreachableError(`cannot fetch ${redactUrl(source.repo)} for source '${source.name}': ${firstLine(r.stderr)}`);
  return have();
}

/**
 * Gets one source clone to where the catalog says it sits: cloned if missing, a pinned source at
 * its commit, a followed one on its branch and fast-forwarded to its remote. Nothing is moved when
 * the clone has uncommitted work, and a followed one with local-only commits or a divergence is
 * left alone too (each a repo conflict). In `diff` and `validate` mode an existing clone is never moved or
 * fetched, because skill links point into it: a mismatch is reported as a problem and `apply`
 * fixes it.
 */
export function placeSource(source: Source, home: string, mode: SourceMode): PlaceOutcome {
  const dir = sourceDir(home, source.name);
  const outcome: PlaceOutcome = { problems: [], conflicts: [] };
  const shown = `~${dir.slice(home.length)}`;

  const fresh = !existsSync(join(dir, ".git"));
  if (fresh && mode === "offline") {
    return { problems: [`source '${source.name}' is not cloned yet, and status does not fetch; run 'fleet apply' or 'fleet diff'`], conflicts: [] };
  }
  if (fresh) {
    const problem = clone(source, dir);
    if (problem !== null) return { problems: [problem], conflicts: [] };
  }
  const may = fresh || mode === "apply";
  const state = repoState(dir);

  if (!state.clean && (source.commit !== null || state.branch !== source.branch)) {
    outcome.conflicts.push({
      kind: "repo",
      path: shown,
      detail: `${shown} has uncommitted changes, so fleet cannot move it to ${source.commit ?? `branch ${source.branch}`}`,
      fix: `Discard them (git -C ${shown} stash -u) or delete the clone (rm -r ${shown}), then run 'fleet apply'.`,
    });
    return outcome;
  }

  if (source.commit !== null) {
    if (state.sha === source.commit) return outcome;
    if (!may) {
      outcome.problems.push(`source '${source.name}' is at ${state.sha.slice(0, 7)}, not its pinned ${source.commit.slice(0, 7)}; run 'fleet apply' to check it out`);
      return outcome;
    }
    const have = () => runGit(dir, "cat-file", "-e", `${source.commit}^{commit}`).ok;
    if (!fetchUnlessHave(dir, source, have)) {
      outcome.problems.push(`source '${source.name}': pinned commit ${source.commit} is not in ${redactUrl(source.repo)}`);
      return outcome;
    }
    const r = runGit(dir, "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", source.commit);
    if (!r.ok) throw new Error(`cannot check out ${source.commit} in ${shown}: ${firstLine(r.stderr)}`);
    return outcome;
  }

  if (state.branch !== source.branch) {
    if (!may) {
      outcome.problems.push(`source '${source.name}' is on ${state.branch ?? "no branch"}, not its followed branch ${source.branch}; run 'fleet apply' to switch it`);
      return outcome;
    }
    const branch = source.branch as string;
    const have = () => runGit(dir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).ok || runGit(dir, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`).ok;
    if (!fetchUnlessHave(dir, source, have)) {
      outcome.problems.push(`source '${source.name}': branch ${branch} is not in ${redactUrl(source.repo)}`);
      return outcome;
    }
    const r = runGit(dir, "checkout", "--quiet", branch);
    if (!r.ok) throw new Error(`cannot check out branch ${branch} in ${shown}: ${firstLine(r.stderr)}`);
  }

  // On its branch now. A clone just made is level with the remote; `diff` only looks at what is local.
  if (fresh) return outcome;
  let blocked: string | null;
  if (mode === "apply") {
    try {
      blocked = syncRepo(dir).blocked;
    } catch (error) {
      if (error instanceof UnreachableError) throw new UnreachableError(`cannot fetch ${redactUrl(source.repo)} for source '${source.name}': ${error.message}`);
      throw error;
    }
  } else if (mode === "diff" || mode === "offline") {
    blocked = blockedState(repoState(dir));
  } else {
    blocked = null;
  }
  if (blocked !== null) outcome.conflicts.push(repoConflict(shown, blocked));
  return outcome;
}

/**
 * Every directory named `<skill>/` that holds a `SKILL.md`, at any depth under the source's
 * `path`, skipping directories whose name starts with a dot.
 */
export function findSkills(source: Source, home: string): { dirs: Map<string, string[]>; problem: string | null } {
  return findSkillsIn(sourceDir(home, source.name), source);
}

/** `findSkills` in a checkout of the source's repo at `clone`, wherever that is. */
export function findSkillsIn(clone: string, source: Source): { dirs: Map<string, string[]>; problem: string | null } {
  const root = join(clone, source.path);
  const dirs = new Map<string, string[]>();
  try {
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    return { dirs, problem: `source '${source.name}': path '${source.path}' is not a directory in ${redactUrl(source.repo)}` };
  }
  const named = basename(source.path);
  if (named !== "." && existsSync(join(root, "SKILL.md"))) dirs.set(named, [root]);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (existsSync(join(path, "SKILL.md"))) dirs.set(entry.name, [...(dirs.get(entry.name) ?? []), path]);
      walk(path);
    }
  };
  walk(root);
  return { dirs, problem: null };
}
