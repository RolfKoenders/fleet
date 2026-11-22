import { homedir } from "node:os";
import { runGit, repoState } from "./git.ts";
import { Journal, listJournals, type JournalEntry } from "./journal.ts";
import { pushLocked, whileHoldingPushLock } from "./push.ts";
import type { Progress } from "./pushview.ts";
import type { Result } from "./output.ts";
import { LockedError } from "./lock.ts";
import { failure } from "./apply.ts";

const USAGE = "usage: fleet undo [--no-push] [--yes] [<commit>]";

/** The streams a prompt talks to; a terminal in use, a fake in a test. */
export type PromptIO = {
  stdin: NodeJS.ReadableStream & { setRawMode?: (on: boolean) => unknown };
  stdout: { write: (text: string) => unknown };
};

export type UndoOptions = {
  /** Stop after the revert commit. */
  noPush?: boolean;
  /** Skip the terminal prompt. */
  yes?: boolean;
  color?: boolean;
  json?: boolean;
  /** For tests. */
  home?: string;
  /** For tests. Null when there is no terminal or --json wants a document only. */
  terminal?: PromptIO | null;
  /** For tests. */
  progress?: Progress | null;
};

type PushToUndo = {
  entry: JournalEntry;
  commit: string;
  subject: string;
  files: string[];
  scope: "all" | { host: string };
};

const invalid = (...problems: string[]): Result => ({ code: "invalid", messages: problems.map((p) => `fleet: ${p}`) });
const conflict = (...problems: string[]): Result => ({ code: "conflict", messages: problems.map((p) => `fleet: ${p}`) });
const short = (sha: string): string => sha.slice(0, 7);

/** A local `2026-11-22 14:30`. */
function when(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function readPush(configDir: string, home: string, args: string[]): PushToUndo | Result {
  if (args.length > 1) return invalid(USAGE);
  const target = args[0];
  const entries = listJournals(home);
  let entry: JournalEntry | undefined;
  if (target === undefined) {
    entry = entries[0];
    if (entry === undefined) return invalid("no push recorded yet");
  } else {
    entry = entries.find((e) => e.header.commit !== null && (e.header.commit === target || e.header.commit.startsWith(target)));
    if (entry === undefined) return invalid(`no recorded push matches commit '${target}'`);
  }
  const commit = entry.header.commit;
  if (commit === null) return invalid("that push never published a commit");
  if (!runGit(configDir, "cat-file", "-e", `${commit}^{commit}`).ok) {
    return invalid(`commit ${short(commit)} is not in the config repo`);
  }
  if (!runGit(configDir, "merge-base", "--is-ancestor", commit, "HEAD").ok) {
    return invalid(`commit ${short(commit)} is not in the current branch's history`);
  }
  const subject = runGit(configDir, "log", "-1", "--format=%s", commit).stdout || "unknown";
  const files = runGit(configDir, "diff-tree", "--no-commit-id", "--name-only", "-r", commit)
    .stdout.split("\n")
    .filter((f) => f !== "");
  return { entry, commit, subject, files, scope: entry.header.only === null ? "all" : { host: entry.header.only } };
}

function hasSecrets(files: string[]): boolean {
  return files.some((f) => f.startsWith("secrets/") && f.endsWith(".enc.yaml"));
}

function describeScope(scope: PushToUndo["scope"]): string {
  return scope === "all" ? "all hosts" : scope.host;
}

function describePush(p: PushToUndo): string {
  const lines = [
    `Undo this push?`,
    `  Time:  ${when(p.entry.header.time)}`,
    `  Commit: ${short(p.commit)} ${p.subject}`,
    `  Scope: ${describeScope(p.scope)}`,
    `  Files: ${p.files.join(", ") || "(none)"}`,
  ];
  if (hasSecrets(p.files)) {
    lines.push("  This push changed a secrets file. The revert brings back the old encrypted values; check those secrets before you push.");
  }
  return lines.join("\n");
}

function readChoice(stdin: PromptIO["stdin"]): Promise<boolean> {
  stdin.setRawMode?.(true);
  stdin.setEncoding?.("utf8");
  stdin.resume();
  return new Promise((resolve) => {
    const done = (yes: boolean) => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.setRawMode?.(false);
      stdin.pause();
      resolve(yes);
    };
    const onData = (chunk: string | Buffer) => {
      const ch = String(chunk);
      if (ch === "y" || ch === "Y") done(true);
      else if (ch === "n" || ch === "N" || ch === "\u0003" || ch === "\u0004" || ch === "\r" || ch === "\n") done(false);
    };
    const onEnd = () => done(false);
    stdin.on("data", onData);
    stdin.once("end", onEnd);
  });
}

async function askYesNo(terminal: PromptIO, text: string): Promise<boolean> {
  terminal.stdout.write(`${text}\nPress y to undo, N to cancel: `);
  return readChoice(terminal.stdin);
}

type RevertResult = { ok: true; reverted: string[] } | { ok: false; reason: string };

function abortRevert(configDir: string): void {
  runGit(configDir, "revert", "--abort");
}

function newerCommit(configDir: string, since: string, file: string): string | null {
  const r = runGit(configDir, "log", "-1", "--format=%H", `${since}..HEAD`, "--", file);
  return r.ok && r.stdout !== "" ? r.stdout : null;
}

function newerSubject(configDir: string, sha: string | null): string {
  if (sha === null) return "";
  const r = runGit(configDir, "log", "-1", "--format=%s", sha);
  return r.ok ? ` (${r.stdout})` : "";
}

/** Files changed by `commit` that also have a newer commit between `commit` and HEAD. */
function clashingFiles(configDir: string, commit: string, files: string[]): { files: string[]; newer: string | null } {
  let newest: string | null = null;
  const clashing: string[] = [];
  for (const file of files) {
    const newer = newerCommit(configDir, commit, file);
    if (newer !== null) {
      clashing.push(file);
      newest = newest === null || runGit(configDir, "merge-base", "--is-ancestor", newest, newer).ok ? newer : newest;
    }
  }
  return { files: clashing, newer: newest };
}

function tryRevert(configDir: string, commit: string, files: string[]): RevertResult {
  const state = repoState(configDir);
  if (state.branch === null) return { ok: false, reason: "the config repo is not on a branch" };
  if (!state.clean) return { ok: false, reason: "the config repo has uncommitted changes" };

  const revert = runGit(configDir, "revert", "--no-commit", "--no-edit", commit);
  if (!revert.ok) {
    abortRevert(configDir);
    const { files: clash, newer } = clashingFiles(configDir, commit, files);
    if (clash.length > 0) {
      const detail = newer === null ? clash.join(", ") : `${clash.join(", ")} (newer commit: ${short(newer)}${newerSubject(configDir, newer)})`;
      return { ok: false, reason: `revert clashes with a newer commit: ${detail}` };
    }
    return { ok: false, reason: `cannot revert ${short(commit)}: ${revert.stderr || "it clashes with a newer commit"}` };
  }

  const status = runGit(configDir, "status", "--porcelain").stdout.split("\n");
  const unmerged = status.filter((l) => /^(UU|AA|DD|AU|UA|DU|UD)/.test(l));
  if (unmerged.length > 0) {
    const unmergedFiles = unmerged.map((l) => l.slice(3));
    const { newer } = clashingFiles(configDir, commit, unmergedFiles);
    abortRevert(configDir);
    const detail = newer === null ? unmergedFiles.join(", ") : `${unmergedFiles.join(", ")} (newer commit: ${short(newer)}${newerSubject(configDir, newer)})`;
    return { ok: false, reason: `revert clashes with a newer commit: ${detail}` };
  }

  const reverted = runGit(configDir, "diff", "--cached", "--name-only").stdout.split("\n").filter((f) => f !== "");
  if (reverted.length === 0) {
    // Nothing to commit, so end the revert rather than leave git in the middle of one.
    abortRevert(configDir);
    return { ok: true, reverted: [] };
  }

  const commitResult = runGit(configDir, "commit", "-m", `Revert "${runGit(configDir, "log", "-1", "--format=%s", commit).stdout}"`);
  if (!commitResult.ok) {
    // This should be rare: the tree staged cleanly but could not be committed.
    abortRevert(configDir);
    return { ok: false, reason: `revert staged but could not be committed: ${commitResult.stderr}` };
  }
  return { ok: true, reverted };
}

/**
 * `fleet undo [--no-push] [--yes] [<commit>]`: revert a recorded push with a new commit, then push it to the same scope.
 * Without a terminal, or with `--json`, the command only acts when `--yes` is given.
 */
export async function undo(toolDir: string, configDir: string, args: string[], options: UndoOptions = {}): Promise<Result> {
  const home = options.home ?? homedir();
  const target = readPush(configDir, home, args);
  if ("code" in target) return target;

  const terminal = options.terminal ?? null;
  if (terminal === null && !options.yes) {
    return invalid("no terminal to ask on; pass --yes to undo");
  }

  if (terminal !== null && !options.yes) {
    const ok = await askYesNo(terminal, describePush(target));
    if (!ok) return { code: "ok", messages: ["fleet: undo cancelled"] };
  }

  const notes: string[] = [];
  if (hasSecrets(target.files)) {
    notes.push("fleet: this push changed a secrets file; the revert brings back the old encrypted values. Check those secrets before you push.");
  }

  try {
    return await whileHoldingPushLock(
      home,
      async () => {
        const revert = tryRevert(configDir, target.commit, target.files);
        if (!revert.ok) return conflict(revert.reason);
        if (revert.reverted.length === 0) {
          return { code: "ok", messages: [...notes, "fleet: nothing to revert; the commit's changes are already gone"] };
        }
        notes.push(`fleet: reverted ${revert.reverted.length} file${revert.reverted.length === 1 ? "" : "s"} in ${configDir}`);
        if (options.noPush) {
          return {
            code: "ok",
            text: `Reverted ${short(target.commit)}: ${revert.reverted.join(", ")}\nThe revert is committed but not pushed. Run 'fleet push' to publish it.`,
            messages: notes,
            fields: { commit: target.commit, reverted: revert.reverted, pushed: false },
          };
        }
        const only = target.scope === "all" ? undefined : target.scope.host;
        const journal = new Journal(home, only ?? null);
        const pushResult = await pushLocked(toolDir, configDir, `Revert "${target.subject}"`, options.color ?? false, home, options.progress ?? null, only, journal);
        const problem = journal.write(pushResult);
        return {
          ...pushResult,
          messages: [...notes, ...(pushResult.messages ?? []), ...(problem === null ? [] : [problem])],
          fields: { ...(pushResult.fields ?? {}), commit: target.commit, reverted: revert.reverted, pushed: true },
        };
      },
      () => {},
    );
  } catch (error) {
    if (error instanceof LockedError) return { code: "locked", messages: [`fleet: ${error.message}`] };
    const result = failure(error);
    if (result === null) throw error;
    return result;
  }
}
