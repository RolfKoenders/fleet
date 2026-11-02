import { parentPort, workerData } from "node:worker_threads";
import { diff, planConflicts } from "../apply.ts";
import { repoState, runGit } from "../git.ts";
import { publishedRepos } from "../push.ts";
import { status } from "../status.ts";
import { looksSecret } from "./pushrun.ts";

/** Runs one read-only question off the main thread, so the screen keeps moving while it is asked. */
export type Job = { op: "status" | "conflicts" | "preview"; toolDir: string; configDir: string; home: string };

/** A repo `push` would publish, with what it would commit: `push` runs `git add -A` in it first. */
export type RepoPreview = {
  shown: string;
  branch: string | null;
  ahead: number | null;
  behind: number | null;
  /** `git status --porcelain`: the two status letters and the path. */
  files: { status: string; path: string }[];
  /** The paths among ALL the changed files (not just the ones listed) that look like a plaintext secret and would be committed. A push from the bridge is blocked while there are any. */
  flagged: string[];
};

export type Preview = { code: string; plan: string[]; repos: RepoPreview[] };

const FILE_CAP = 200;

function preview(job: Job): Preview {
  const planned = diff(job.configDir, false, job.home);
  const repos = publishedRepos(job.configDir, job.home).map(({ dir, shown }): RepoPreview => {
    const state = repoState(dir);
    const porcelain = runGit(dir, "status", "--porcelain", "--untracked-files=all");
    const all = porcelain.stdout.split("\n").filter((l) => l !== "").map((l) => {
      // The output is trimmed, which can eat the first line's leading space, so the status is whatever comes before the gap.
      const m = /^(\S{1,2})\s+(.+)$/.exec(l);
      return { status: m?.[1] ?? "?", path: m?.[2] ?? l };
    });
    // A file that is being deleted is not a secret being published.
    const flagged = all.filter((f) => !f.status.includes("D") && looksSecret(f.path)).map((f) => f.path).slice(0, FILE_CAP);
    return { shown, branch: state.branch, ahead: state.ahead, behind: state.behind, files: all.slice(0, FILE_CAP), flagged };
  });
  return { code: planned.code, plan: [...(planned.text ?? "").split("\n").filter((l) => l !== ""), ...(planned.messages ?? [])], repos };
}

const job = workerData as Job;
try {
  if (job.op === "status") {
    const r = status(job.toolDir, job.configDir, false, job.home);
    parentPort!.postMessage({ code: r.code, fields: r.fields ?? null, messages: r.messages ?? [] });
  } else if (job.op === "preview") {
    parentPort!.postMessage({ code: "ok", preview: preview(job) });
  } else {
    const r = planConflicts(job.configDir, job.home);
    parentPort!.postMessage(Array.isArray(r) ? { code: "ok", conflicts: r } : { code: r.code, messages: r.messages ?? [] });
  }
} catch (error) {
  parentPort!.postMessage({ code: "error", messages: [(error as Error).message] });
}
