import { execFileSync, spawnSync } from "node:child_process";
import { findTool } from "./tools.ts";

export type RepoState = {
  branch: string | null;
  sha: string;
  clean: boolean;
  /** Commits not on the upstream, as of the last fetch. Null without an upstream. */
  ahead: number | null;
  behind: number | null;
};

export class MissingToolError extends Error {}

/** Reads local state only. Never fetches, so it needs no network. */
export function repoState(dir: string): RepoState {
  const gitPath = findTool("git");
  if (gitPath === null) throw new MissingToolError("git is not installed");
  const git = (...args: string[]) =>
    execFileSync(gitPath, args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    }).trim();

  let ahead: number | null = null;
  let behind: number | null = null;
  try {
    const [a, b] = git("rev-list", "--left-right", "--count", "HEAD...@{upstream}").split(/\s+/);
    ahead = Number(a);
    behind = Number(b);
  } catch {
    // no upstream configured
  }

  return {
    branch: git("branch", "--show-current") || null,
    sha: git("rev-parse", "HEAD"),
    clean: git("status", "--porcelain") === "",
    ahead,
    behind,
  };
}

export class UnreachableError extends Error {}

export type GitResult = { ok: boolean; stdout: string; stderr: string };

/** Runs git by absolute path and never prompts for credentials. A failure is a result, not a throw. */
export function runGit(cwd: string, ...args: string[]): GitResult {
  const gitPath = findTool("git");
  if (gitPath === null) throw new MissingToolError("git is not installed");
  const r = spawnSync(gitPath, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  return { ok: r.status === 0, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

/** What stops a clone from being fast-forwarded, as a phrase for a conflict. Null when nothing does. */
export function blockedState(state: RepoState): string | null {
  if (!state.clean) return "has uncommitted changes";
  const { ahead, behind } = state;
  if (ahead !== null && behind !== null && ahead > 0 && behind > 0) return `has diverged from its upstream (${ahead} ahead, ${behind} behind)`;
  if (ahead !== null && ahead > 0) return `has ${ahead} local commit${ahead === 1 ? "" : "s"} not on its upstream`;
  return null;
}

/**
 * Fetches `dir` from origin and fast-forwards it, unless it holds local work (`blocked` says what).
 * A clone with no upstream, such as a detached HEAD, has nothing to follow and is left alone.
 * A failed fetch throws `UnreachableError` with git's first line of explanation.
 */
export function syncRepo(dir: string): { blocked: string | null; moved: boolean } {
  const fetch = runGit(dir, "fetch", "--quiet", "origin");
  if (!fetch.ok) throw new UnreachableError(fetch.stderr.split("\n")[0] ?? "git fetch failed");
  const state = repoState(dir);
  const blocked = blockedState(state);
  if (blocked !== null || !state.behind) return { blocked, moved: false };
  const merge = runGit(dir, "merge", "--quiet", "--ff-only", "@{upstream}");
  if (!merge.ok) throw new Error(`cannot fast-forward ${dir}: ${merge.stderr.split("\n")[0]}`);
  return { blocked: null, moved: true };
}
