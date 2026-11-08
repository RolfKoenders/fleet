import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addedSections } from "./changelog.ts";
import { runGit } from "./git.ts";

/**
 * What changed between two tool commits, as text from a repo: `heading` and `body` are printable characters
 * only and cut to a size, and `omitted` counts the lines or subjects that did not fit.
 */
export type Changes =
  | { source: "changelog"; sections: { heading: string; body: string }[]; omitted: number }
  | { source: "commits"; subjects: string[]; omitted: number }
  | { source: "none" };

const MAX_LINE = 160;
const MAX_LINES = 40;
const MAX_SUBJECTS = 30;

// Control characters (an escape sequence would drive the terminal), format characters (bidirectional text can
// reorder what is shown), line and paragraph separators, private use, surrogates and unassigned code points.
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\p{Cn}]/gu;

function printable(text: string): string {
  const chars = [...text.replaceAll("\t", " ").replace(UNPRINTABLE, "").trimEnd()];
  return chars.length > MAX_LINE ? `${chars.slice(0, MAX_LINE - 3).join("")}...` : chars.join("");
}

const nonBlank = (lines: string[]) => lines.filter((l) => l !== "").length;

/** Keeps the first `MAX_LINES` lines across the sections, a heading counting as one, and says how many were left out. */
function fit(added: { heading: string; body: string }[]): Extract<Changes, { source: "changelog" }> {
  let room = MAX_LINES;
  let omitted = 0;
  const kept: { heading: string; body: string }[] = [];
  for (const section of added) {
    const body = section.body.split("\n").map(printable);
    if (room <= 0) {
      omitted += 1 + nonBlank(body);
      continue;
    }
    const shown = body.slice(0, room - 1);
    kept.push({ heading: printable(section.heading), body: shown.join("\n").trim() });
    omitted += nonBlank(body.slice(shown.length));
    room -= 1 + shown.length;
  }
  return { source: "changelog", sections: kept, omitted };
}

function show(clone: string, commit: string, path: string): string | null {
  const r = runGit(clone, "show", `${commit}:${path}`);
  return r.ok ? r.stdout : null;
}

/** A throwaway clone of the tool's repo: no files checked out, only history. */
export type Clone = { dir: string; has: (sha: string) => boolean };

/**
 * Runs `use` with a throwaway clone of `repo`, then removes it, so no clone that hosts run from moves. The clone is
 * null when it fails. `tags` brings the repo's tags along; `branch` makes the clone fail unless that branch exists.
 */
export function withClone<T>(repo: string, how: { branch?: string; tags?: boolean }, use: (clone: Clone | null) => T): T {
  const tmp = mkdtempSync(join(tmpdir(), "fleet-update-"));
  try {
    const dir = join(tmp, "repo");
    const options = [how.tags ? "--config=remote.origin.tagOpt=--tags" : "--no-tags", ...(how.branch === undefined ? [] : [`--branch=${how.branch}`])];
    const clone = runGit(tmp, "clone", "--quiet", "--no-checkout", ...options, "--", repo, dir);
    return use(clone.ok ? { dir, has: (sha) => runGit(dir, "cat-file", "-e", `${sha}^{commit}`).ok } : null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * What changed in the tool between pin `from` and `to`: the changelog sections `to` has that `from` does not,
 * or, when the changelog says nothing, the commit subjects. `none` when `from` is no longer in the repo (a
 * rewritten branch) or there is no clone: the pin can still move, there is only nothing to read.
 */
export function changesBetween(clone: Clone | null, from: string, to: string): Changes {
  if (clone === null || !clone.has(from) || !clone.has(to)) return { source: "none" };
  const { dir } = clone;

  const before = show(dir, from, "CHANGELOG.md");
  const after = show(dir, to, "CHANGELOG.md");
  if (after !== null) {
    const added = addedSections(before ?? "", after);
    if (added.length > 0) return fit(added);
  }

  const log = runGit(dir, "log", "--format=%s", `${from}..${to}`);
  const subjects = log.ok ? log.stdout.split("\n").map(printable).filter((s) => s !== "") : [];
  if (subjects.length === 0) return { source: "none" };
  return { source: "commits", subjects: subjects.slice(0, MAX_SUBJECTS), omitted: Math.max(0, subjects.length - MAX_SUBJECTS) };
}

/** `changesBetween` in a clone of the branch `track`. */
export const pinChanges = (repo: string, track: string, from: string, to: string): Changes =>
  withClone(repo, { branch: track }, (clone) => changesBetween(clone, from, to));

/** The text form: sections as in the changelog, or one subject per line, or that there is nothing to read. */
export function describeChanges(changes: Changes): string {
  if (changes.source === "none") return "no history available";
  const more = changes.omitted > 0 ? [`... and ${changes.omitted} more, see the tool's repo`] : [];
  if (changes.source === "commits") return [...changes.subjects.map((s) => `- ${s}`), ...more].join("\n");
  const blocks = changes.sections.map((s) => (s.body === "" ? `## ${s.heading}` : `## ${s.heading}\n${s.body}`));
  return [blocks.join("\n\n"), ...more].join("\n\n");
}
