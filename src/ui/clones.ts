import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSkillsIn } from "../sources.ts";
import { findTool } from "../tools.ts";
import { branchProblem, repoProblem } from "./opsof.ts";
import { BadRequest } from "./request.ts";

/**
 * The shallow clones the Add-a-skill-source form makes to list a repo's skills and read its head commit. Each lives in a
 * temp directory under an id the page holds, and is deleted when the form is closed (`discard`), when a newer one replaces
 * it, and when the server stops (`clear`). Nothing here is ever a source clone under `~/.local/share/fleet`.
 */

const CLONE_MS = 60_000;
const MAX_CLONES = 3;

export type Cloned = {
  id: string;
  repo: string;
  /** The full sha at the head of what was cloned. */
  commit: string;
  /** The branch cloned: the one asked for, or the repo's own default. Null for a detached head. */
  branch: string | null;
  path: string;
  /** Skill names found under `path`, sorted, with where each is (one path relative to `path`). */
  skills: string[];
  /** Why no skills were found: `path` is not a directory in the repo. Null otherwise. */
  problem: string | null;
};

const run = (file: string, args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      // No prompt for a credential or a host key, and no remote helper: only the transports a source may use.
      { cwd, encoding: "utf8", timeout: CLONE_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file:git:http:https:ssh", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" } },
      (error, stdout, stderr) => resolve({ ok: error === null, stdout: stdout.trim(), stderr: (error && "killed" in error && error.killed ? "timed out" : stderr).trim() }),
    );
  });

export class CloneStore {
  private readonly dirs = new Map<string, string>();

  /** Clones `repo` shallowly, at `branch` when given. Throws `BadRequest` for an argument git must not see, `Error` for a clone that failed. */
  async create(repo: string, path: string, branch: string | null): Promise<Cloned> {
    const bad = repoProblem(repo) ?? (branch === null ? null : branchProblem(branch));
    if (bad !== null) throw new BadRequest(bad);
    if (path === "" || path.startsWith("/") || path.split("/").includes("..") || /[\u0000-\u001f\u007f]/.test(path)) throw new BadRequest("the path must be a directory inside the repo, without '..'");
    const git = findTool("git");
    if (git === null) throw new Error("git is not installed");
    const root = mkdtempSync(join(tmpdir(), "fleet-ui-clone-"));
    const dir = join(root, "repo");
    mkdirSync(dir);
    const id = randomBytes(12).toString("base64url");
    this.dirs.set(id, root);
    try {
      // `--` ends the options, so a repo can never be read as one.
      const clone = await run(git, ["clone", "--quiet", "--depth", "1", ...(branch === null ? [] : ["--branch", branch]), "--", repo, dir], root);
      if (!clone.ok) throw new Error(`cannot clone ${repo}: ${clone.stderr.split("\n")[0] || "git failed"}`);
      const head = await run(git, ["rev-parse", "HEAD"], dir);
      const name = await run(git, ["branch", "--show-current"], dir);
      if (!head.ok || !/^[0-9a-f]{40}$/.test(head.stdout)) throw new Error(`cannot read the head commit of ${repo}`);
      const found = findSkillsIn(dir, { name: "new", repo, path, commit: null, track: null, branch: null, review: false });
      this.evict();
      return { id, repo, commit: head.stdout, branch: name.ok && name.stdout !== "" ? name.stdout : null, path, skills: [...found.dirs.keys()].sort(), problem: found.problem };
    } catch (error) {
      this.discard(id);
      throw error;
    }
  }

  /** Deletes a clone. An id that is not held is nothing to do. */
  discard(id: string): void {
    const root = this.dirs.get(id);
    if (root === undefined) return;
    this.dirs.delete(id);
    rmSync(root, { recursive: true, force: true });
  }

  /** Deletes every clone: the server is stopping. */
  clear(): void {
    for (const id of [...this.dirs.keys()]) this.discard(id);
  }

  get size(): number {
    return this.dirs.size;
  }

  /** A page that forgot to discard cannot fill the disk: the oldest clones go first. */
  private evict(): void {
    for (const id of [...this.dirs.keys()].slice(0, Math.max(0, this.dirs.size - MAX_CLONES))) this.discard(id);
  }
}
