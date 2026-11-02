import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { failure } from "./apply.ts";
import { eventsOn, readLine, send } from "./events.ts";
import { parseCatalog } from "./catalog.ts";
import { loadConfig } from "./config.ts";
import { repoState, runGit, UnreachableError } from "./git.ts";
import { readHostName } from "./host.ts";
import { paint } from "./output.ts";
import type { Result } from "./output.ts";
import type { Conflict } from "./plan.ts";
import { sourceDir } from "./sources.ts";
import { hostTargets } from "./targets.ts";
import type { Target } from "./targets.ts";
import { findTool, probedNode } from "./tools.ts";
import { isObject, parseFile } from "./yamlfile.ts";

/** One host's outcome. `timer` is a host fleet cannot reach, which applies on its own schedule. */
type HostRecord = {
  host: string;
  result: "ok" | "conflict" | "unreachable" | "timer" | "error";
  /** Links and keys created, updated or removed. */
  changes: number;
  conflicts: Conflict[];
};

export type Repo = { dir: string; shown: string };
/** `ssh` is the program to reach the other hosts with, null only when no host needs it. */
type Checked = { host: string; targets: Target[]; repos: Repo[]; ssh: string | null };

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";
const invalid = (...problems: string[]): Result => ({ code: "invalid", messages: problems.map((p) => `fleet: ${p}`) });

/**
 * What the remote runs. The remote shell expands `~`, because non-interactive ssh has no `~/.local/bin` on its PATH.
 * With events on, the variable goes in the command itself, because ssh does not carry ours across; a fleet that
 * does not know it ignores it.
 */
const remoteCommand = (events: boolean): string => `${events ? "FLEET_EVENTS=1 " : ""}~/.local/bin/fleet apply --json`;

/**
 * The repos a push publishes, in order: each followed source's clone, then the config repo. Never the tool: the
 * fleet clone is not anyone's to publish from.
 */
export function publishedRepos(configDir: string, home: string): Repo[] {
  const followed = parseCatalog(configDir, []).sources.filter((s) => s.branch !== null).sort((a, b) => a.name.localeCompare(b.name));
  const repos: Repo[] = followed
    .map((s) => sourceDir(home, s.name))
    .filter((dir) => existsSync(join(dir, ".git")))
    .map((dir) => ({ dir, shown: `~${dir.slice(home.length)}` }));
  repos.push({ dir: configDir, shown: configDir });
  return repos;
}

/**
 * Validates the config, checks that every secrets file is encrypted, and finds the other hosts and the
 * repos to publish. Writes nothing.
 */
function check(configDir: string, home: string): Checked | Result {
  const host = readHostName(home);
  if (host === null) return invalid("no host name set; `fleet init <host>` writes one");
  try {
    // Local work in a followed source is what this push publishes, so it is not a conflict here.
    loadConfig(configDir, host, { home, sources: "validate" });
  } catch (error) {
    const result = failure(error);
    if (result === null) throw error;
    return result;
  }

  const problems: string[] = [];
  let secretFiles: string[] = [];
  try {
    secretFiles = readdirSync(join(configDir, "secrets")).filter((f) => f.endsWith(".enc.yaml")).sort();
  } catch {
    // no secrets yet
  }
  for (const file of secretFiles) {
    const doc = parseFile(join(configDir, "secrets", file), false, problems);
    if (doc !== null && !isObject(doc.sops)) problems.push(`secrets/${file} has no 'sops' key, so it is not encrypted; encrypt it with 'fleet secrets set', never push it as it is`);
  }

  const targets = hostTargets(configDir, host, problems);
  if (problems.length > 0) return invalid(...problems);

  const repos = publishedRepos(configDir, home);

  const ssh = findTool("ssh", process.env, home);
  if (ssh === null && targets.some((t) => t.ssh !== null)) {
    return { code: "missing-prerequisite", messages: ["fleet: ssh is not installed, and a host has an 'ssh' destination"] };
  }
  return { host, targets, repos, ssh };
}

const must = (r: { ok: boolean; stderr: string }, what: string) => {
  if (!r.ok) throw new Error(`${what}: ${firstLine(r.stderr)}`);
};

const requireBranch = ({ dir, shown }: Repo) => {
  if (repoState(dir).branch === null) throw new Error(`${shown} is not on a branch, so there is nothing to push`);
};

/**
 * Takes what GitHub has if it only moved ahead, then pushes what is ahead of it. Returns a conflict when
 * both sides moved. A failed fetch or push throws `UnreachableError`.
 */
export function syncAndPush(repo: Repo, notes: string[]): Conflict | null {
  const { dir, shown } = repo;
  requireBranch(repo);
  const fetch = runGit(dir, "fetch", "--quiet", "origin");
  if (!fetch.ok) throw new UnreachableError(`cannot fetch ${shown}: ${firstLine(fetch.stderr)}`);
  const { ahead, behind } = repoState(dir);
  if (ahead === null || behind === null) throw new Error(`${shown} has no upstream branch to push to`);
  if (ahead > 0 && behind > 0) {
    return {
      kind: "repo",
      path: shown,
      detail: `${shown} has diverged from its upstream (${ahead} ahead, ${behind} behind)`,
      fix: `Bring the upstream work into it (git -C ${shown} pull --rebase), then run 'fleet push' again.`,
    };
  }
  if (behind > 0) {
    // Not ahead as well (that was the divergence above), so there is nothing to push after this.
    must(runGit(dir, "merge", "--quiet", "--ff-only", "@{upstream}"), `cannot fast-forward ${shown}`);
  } else if (ahead > 0) {
    const push = runGit(dir, "push", "--quiet");
    if (!push.ok) throw new UnreachableError(`cannot push ${shown}: ${firstLine(push.stderr)}`);
    notes.push(`fleet: pushed ${shown}`);
  }
  return null;
}

/** Commits what is there, then brings the repo level with GitHub. */
function publish(repo: Repo, host: string, message: string | undefined, notes: string[]): Conflict | null {
  const { dir, shown } = repo;
  requireBranch(repo);

  if (!repoState(dir).clean) {
    must(runGit(dir, "add", "-A"), `cannot stage ${shown}`);
    const files = runGit(dir, "diff", "--cached", "--name-only").stdout.split("\n").filter((l) => l !== "").length;
    if (files > 0) {
      must(runGit(dir, "commit", "--quiet", "-m", message ?? `fleet push from ${host}: ${files} files`), `cannot commit in ${shown}`);
      notes.push(`fleet: committed ${files} file${files === 1 ? "" : "s"} in ${shown}`);
    }
  }
  return syncAndPush(repo, notes);
}

function recordFrom(host: string, status: number | null, stdout: string, notes: string[]): HostRecord {
  let doc: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(stdout);
    doc = isObject(parsed) ? parsed : null;
  } catch {
    // not a document
  }
  const count = (key: string) => (Array.isArray(doc?.[key]) ? (doc[key] as unknown[]).length : 0);
  const conflicts = Array.isArray(doc?.conflicts) ? (doc.conflicts as Conflict[]) : [];
  const changes = count("created") + count("updated") + count("removed");
  if (status === 0 && doc?.code === "ok") return { host, result: "ok", changes, conflicts: [] };
  if (doc?.code === "conflict") return { host, result: "conflict", changes, conflicts };
  const why = doc === null ? "its output was not a fleet document" : `${String(doc.code)}`;
  notes.push(`fleet: ${host}: apply failed (exit ${status ?? "none"}, ${why})`);
  return { host, result: "error", changes, conflicts: [] };
}

type Ran = { error?: Error; status: number | null; stdout: string; stderr: string };

/**
 * Runs a program without blocking and hands each line of its stderr to `onLine` as it arrives. With `onLine`
 * unset the stderr is collected instead (and with `inherit`, passed straight through).
 */
function run(program: string, args: string[], options: { env?: NodeJS.ProcessEnv; inherit?: boolean; onLine?: (line: string) => void }): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { env: options.env, stdio: ["ignore", "pipe", options.inherit ? "inherit" : "pipe"] });
    let [stdout, stderr, pending] = ["", "", ""];
    child.stdout!.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr?.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
      if (options.onLine === undefined) return;
      pending += d;
      for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
        const line = pending.slice(0, at);
        pending = pending.slice(at + 1);
        if (line.trim() !== "") options.onLine(line);
      }
    });
    child.once("error", (error) => resolve({ error, status: null, stdout, stderr }));
    child.once("close", (status) => {
      if (pending.trim() !== "") options.onLine?.(pending);
      resolve({ status, stdout, stderr });
    });
  });
}

/** Forwards a child's stderr line as an event of its lane. */
const forward = (host: string) => (line: string) => send(readLine(line, host));

/** Applies here, as its own `fleet apply` process, the way the timer and the other hosts run it. */
async function applyHere(toolDir: string, host: string, home: string, notes: string[], events: boolean): Promise<HostRecord> {
  const r = await run(join(toolDir, "bin/fleet"), ["apply", "--json"], {
    env: { ...process.env, FLEET_NODE: probedNode(), HOME: home },
    inherit: !events,
    ...(events ? { onLine: forward(host) } : {}),
  });
  if (r.error) {
    notes.push(`fleet: ${host}: cannot run ${join(toolDir, "bin/fleet")}: ${r.error.message}`);
    return { host, result: "error", changes: 0, conflicts: [] };
  }
  return recordFrom(host, r.status, r.stdout, notes);
}

async function applyThere(ssh: string, target: Target & { ssh: string }, notes: string[], events: boolean, home: string): Promise<HostRecord> {
  const r = await run(ssh, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target.ssh, remoteCommand(events)], {
    env: { ...process.env, HOME: home },
    ...(events ? { onLine: forward(target.host) } : {}),
  });
  if (r.error || r.status === 255) {
    notes.push(`fleet: ${target.host}: unreachable over ssh (${r.error?.message ?? (firstLine(r.stderr) || "no reason given")})`);
    return { host: target.host, result: "unreachable", changes: 0, conflicts: [] };
  }
  return recordFrom(target.host, r.status, r.stdout, notes);
}

const EXIT_ORDER = ["conflict", "unreachable", "error"] as const;

function render(records: HostRecord[], color: boolean): string {
  const lines: string[] = [];
  for (const { host, result, changes, conflicts } of records) {
    const shown = result === "ok" ? paint(color, "green", result) : result === "timer" ? result : paint(color, "yellow", result);
    lines.push(`${host}: ${shown}${changes > 0 ? ` (${changes} change${changes === 1 ? "" : "s"})` : ""}`);
    for (const c of conflicts) lines.push(`  ${c.path}: ${c.detail}`, `  fix: ${c.fix}`);
  }
  return lines.join("\n");
}

export async function push(toolDir: string, configDir: string, message: string | undefined, color: boolean, home: string = homedir()): Promise<Result> {
  const events = eventsOn();
  try {
    send({ event: "stage", stage: "validate" });
    const checked = check(configDir, home);
    if ("code" in checked) return checked;
    const { host, targets, repos, ssh } = checked;
    send({ event: "hosts", hosts: [{ host, via: "local" }, ...targets.map((t) => ({ host: t.host, via: t.ssh === null ? ("timer" as const) : ("ssh" as const) }))] });

    const notes: string[] = [];
    send({ event: "stage", stage: "publish", of: repos.length });
    for (const [i, repo] of repos.entries()) {
      const conflict = publish(repo, host, message, notes);
      if (conflict !== null) {
        return { code: "conflict", text: `${conflict.path}: ${conflict.detail}\n  fix: ${conflict.fix}`, messages: [...notes, `fleet: ${conflict.path} has diverged; nothing more was pushed or applied`], fields: { hosts: [], conflicts: [conflict] } };
      }
      send({ event: "step", step: "publish", target: repo.shown, n: i + 1, of: repos.length });
    }

    send({ event: "stage", stage: "apply", of: targets.length + 1 });
    const visit = async (name: string, go: () => Promise<HostRecord>): Promise<HostRecord> => {
      send({ event: "host", host: name, state: "start" });
      const record = await go();
      send({ event: "host", host: name, state: "done", result: record.result, changes: record.changes });
      return record;
    };
    const records = [await visit(host, () => applyHere(toolDir, host, home, notes, events))];
    // A conflict here means the config is not ready for any host, so none of them is touched.
    if (records[0]!.result !== "conflict") {
      for (const target of targets) {
        if (target.ssh === null) {
          records.push(await visit(target.host, async () => ({ host: target.host, result: "timer", changes: 0, conflicts: [] })));
        } else {
          records.push(await visit(target.host, () => applyThere(ssh!, { ...target, ssh: target.ssh! }, notes, events, home)));
        }
      }
    } else {
      for (const target of targets) send({ event: "host", host: target.host, state: "skip" });
    }

    const worst = EXIT_ORDER.find((result) => records.some((r) => r.result === result));
    return { code: worst ?? "ok", text: render(records, color), messages: notes, fields: { hosts: records } };
  } catch (error) {
    const result = failure(error);
    if (result === null) throw error;
    return result;
  }
}
