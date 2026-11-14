import { redactUrl } from "./redact.ts";
import { InvalidConfigError } from "./config.ts";
import { repoState, runGit, UnreachableError } from "./git.ts";
import type { Pin } from "./pin.ts";
import type { Conflict } from "./plan.ts";

const firstLine = (text: string) => redactUrl(text.split("\n")[0] ?? "");

/** Why fleet will not move the fleet clone, as a conflict. Nobody works in the fleet clone, so the fix is to clear it. */
function toolConflict(dir: string, blocked: string, pin: Pin): Conflict {
  return {
    kind: "repo",
    path: dir,
    detail: `${dir} ${blocked}, so fleet cannot move it to the pinned commit ${pin.commit.slice(0, 7)}`,
    fix: `Nobody works in the fleet clone; develop the tool in a separate checkout. Discard the work (git -C ${dir} stash -u for changes, git -C ${dir} reset --hard for commits), then run 'fleet apply'.`,
  };
}

/** What stops the clone from being moved, as a phrase for a conflict. Null when nothing does. */
function blockedBy(dir: string, needsMove: boolean): string | null {
  if (!repoState(dir).clean) return "has uncommitted changes";
  if (!needsMove) return null;
  // Commits that no remote branch has: work done in the clone, which a checkout would leave behind.
  const local = Number(runGit(dir, "rev-list", "--count", "HEAD", "--not", "--remotes").stdout);
  return local > 0 ? `has ${local} local commit${local === 1 ? "" : "s"} not on any remote branch` : null;
}

/**
 * Puts the fleet clone at the commit the config pins, detached, fetching only when the commit is not in
 * the clone yet. Nothing is moved when the clone holds uncommitted changes or local commits (a repo
 * conflict). The caller holds the lock: this is the only place the tool's code changes under a running host.
 * A failed fetch throws `UnreachableError`; a pinned commit the repo does not have throws `InvalidConfigError`.
 */
export function placeTool(dir: string, pin: Pin): { conflict: Conflict | null; moved: boolean } {
  const needsMove = repoState(dir).sha !== pin.commit;
  const blocked = blockedBy(dir, needsMove);
  if (blocked !== null) return { conflict: toolConflict(dir, blocked, pin), moved: false };
  if (!needsMove) return { conflict: null, moved: false };

  // The config decides where the tool comes from, so a changed `tool.repo` takes effect here.
  const origin = runGit(dir, "remote", "get-url", "origin").stdout;
  if (origin !== pin.repo) {
    const set = runGit(dir, "remote", origin === "" ? "add" : "set-url", "origin", pin.repo);
    if (!set.ok) throw new Error(`cannot point ${dir} at ${redactUrl(pin.repo)}: ${firstLine(set.stderr)}`);
  }
  const have = () => runGit(dir, "cat-file", "-e", `${pin.commit}^{commit}`).ok;
  if (!have()) {
    const fetch = runGit(dir, "fetch", "--quiet", "origin");
    if (!fetch.ok) throw new UnreachableError(`cannot fetch the fleet clone from ${redactUrl(pin.repo)}: ${firstLine(fetch.stderr)}`);
    if (!have()) throw new InvalidConfigError([`fleet.yaml: the pinned tool commit ${pin.commit} is not in ${redactUrl(pin.repo)}`]);
  }
  const checkout = runGit(dir, "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", pin.commit);
  if (!checkout.ok) throw new Error(`cannot check out ${pin.commit} in ${dir}: ${firstLine(checkout.stderr)}`);
  return { conflict: null, moved: true };
}
