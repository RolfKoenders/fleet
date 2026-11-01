import { lstatSync, readlinkSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { FileRecord } from "./config.ts";
import type { LinkRecord } from "./state.ts";

export type Conflict = {
  kind: "link" | "key" | "repo" | "removal";
  path: string;
  detail: string;
  fix: string;
};

export type LinkPlan = {
  /** Missing paths to link. */
  creates: LinkRecord[];
  /** Links in state, no longer desired, still pointing where state says. */
  removes: LinkRecord[];
  /** Correct links, to be recorded in state. */
  noops: LinkRecord[];
  /** Records whose path is already gone, dropped from state without touching the host. */
  forgets: LinkRecord[];
  conflicts: Conflict[];
};

export const emptyPlan = (): LinkPlan => ({ creates: [], removes: [], noops: [], forgets: [], conflicts: [] });

export const expandTarget = (target: string, home: string): string => join(home, target.slice(2));

type Found =
  | { type: "missing" }
  | { type: "symlink"; points: string }
  | { type: "file" }
  | { type: "directory" }
  | { type: "blocked"; by: string };

function inspect(path: string): Found {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return { type: "symlink", points: resolve(dirname(path), readlinkSync(path)) };
    return { type: stat.isDirectory() ? "directory" : "file" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return danglingAncestor(path) ?? { type: "missing" };
    if (code === "ENOTDIR") return { type: "blocked", by: nearestExisting(dirname(path)) };
    throw error;
  }
}

function nearestExisting(path: string): string {
  for (let p = path; ; p = dirname(p)) {
    try {
      lstatSync(p);
      return p;
    } catch {
      // keep climbing
    }
  }
}

/** A symlink in the path that points nowhere, so no parent directory can be made under it. */
function danglingAncestor(path: string): Found | null {
  const ancestor = nearestExisting(dirname(path));
  if (!lstatSync(ancestor).isSymbolicLink()) return null;
  try {
    statSync(ancestor);
    return null;
  } catch {
    return { type: "blocked", by: ancestor };
  }
}

/** Reads the host, never writes. */
export function planLinks(desired: FileRecord[], recorded: LinkRecord[], home: string): LinkPlan {
  const plan = emptyPlan();
  const display = (path: string) => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

  for (const { target, source } of desired) {
    const path = expandTarget(target, home);
    const found = inspect(path);
    if (found.type === "missing") {
      plan.creates.push({ target, source });
    } else if (found.type === "symlink" && found.points === source) {
      plan.noops.push({ target, source });
    } else if (found.type === "blocked") {
      plan.conflicts.push({
        kind: "link",
        path: display(found.by),
        detail: `${display(found.by)} is not a usable directory, so ${target} cannot be created`,
        fix: `Move or delete ${display(found.by)}, then run 'fleet apply'.`,
      });
    } else if (found.type === "symlink") {
      plan.conflicts.push({
        kind: "link",
        path: target,
        detail: `${target} is a symlink to ${found.points}, not to ${source}`,
        fix: `Delete the link (rm ${target}), then run 'fleet apply'.`,
      });
    } else if (found.type === "directory") {
      plan.conflicts.push({
        kind: "link",
        path: target,
        detail: `${target} is a directory`,
        fix: `Move or delete it (rm -r ${target}), then run 'fleet apply'. To keep its content, copy it to ${source} first.`,
      });
    } else {
      plan.conflicts.push({
        kind: "link",
        path: target,
        detail: `${target} is a file, not a link to ${source}`,
        fix: `Move or delete it (rm ${target}), then run 'fleet apply'. To keep its content, copy it to ${source} first.`,
      });
    }
  }

  const wanted = new Set(desired.map((d) => d.target));
  for (const record of recorded) {
    if (wanted.has(record.target)) continue;
    const found = inspect(expandTarget(record.target, home));
    if (found.type === "missing" || found.type === "blocked") {
      plan.forgets.push(record);
    } else if (found.type === "symlink" && found.points === record.source) {
      plan.removes.push(record);
    } else {
      plan.conflicts.push({
        kind: "removal",
        path: record.target,
        detail: `${record.target} is no longer in the config, but it is not the link fleet made to ${record.source}`,
        fix: `Move or delete ${record.target} by hand, then run 'fleet apply' so fleet forgets it.`,
      });
    }
  }
  return plan;
}
