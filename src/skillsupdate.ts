import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { failure } from "./apply.ts";
import { parseCatalog } from "./catalog.ts";
import type { Source } from "./catalog.ts";
import { runGit, UnreachableError } from "./git.ts";
import type { Result } from "./output.ts";
import { replaceCommit } from "./pinedit.ts";
import { findSkillsIn } from "./sources.ts";

const USAGE = "usage: fleet skills update [<source>]";
const CATALOG = "catalog/skills.yaml";

const invalid = (messages: string[]): Result => ({ code: "invalid", messages: messages.map((m) => `fleet: ${m}`) });
const short = (sha: string) => sha.slice(0, 7);

type Moved = { source: string; from: string; to: string; skills: string[] };

/** What reading one source's track branch found: it did not move, it moved, or why it cannot. */
type Reading = { moved: Moved | null } | { problems: string[] };

/** The sha under `git clone`'s `--branch`, a checkout of nothing yet. Returns a problem when the repo lacks the branch. */
function cloneTrack(source: Source, into: string): string | null {
  const r = runGit(into, "clone", "--quiet", "--no-checkout", `--branch=${source.track}`, "--", source.repo, join(into, "repo"));
  if (r.ok) return null;
  if (/Remote branch .* not found/.test(r.stderr)) return `source '${source.name}': branch ${source.track} is not in ${source.repo}`;
  throw new UnreachableError(`cannot clone ${source.repo} for source '${source.name}': ${r.stderr.split("\n")[0]}`);
}

/**
 * Reads the head of the source's `track` branch in a throwaway clone, so the source clone that
 * skill links point into is never moved. Every bundle skill the source provides at its pinned
 * commit has to resolve to one directory at the head.
 */
function readSource(source: Source, bundled: string[]): Reading {
  const from = source.commit as string;
  const tmp = mkdtempSync(join(tmpdir(), "fleet-update-"));
  try {
    const problem = cloneTrack(source, tmp);
    if (problem !== null) return { problems: [problem] };
    const clone = join(tmp, "repo");
    const to = runGit(clone, "rev-parse", "HEAD").stdout;
    if (to === from) return { moved: null };
    if (!runGit(clone, "cat-file", "-e", `${from}^{commit}`).ok) {
      return { problems: [`source '${source.name}': pinned commit ${from} is not in ${source.repo}, so its skills cannot be compared; set 'commit' by hand`] };
    }

    const skillsAt = (sha: string) => {
      const r = runGit(clone, "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", sha);
      if (!r.ok) throw new Error(`cannot check out ${sha} to read source '${source.name}': ${r.stderr.split("\n")[0]}`);
      return findSkillsIn(clone, source);
    };
    const before = skillsAt(from).dirs;
    const after = skillsAt(to);
    const problems = after.problem === null ? [] : [after.problem];
    const shown = (dir: string) => relative(clone, dir);

    const kept: string[] = [];
    for (const skill of bundled.filter((s) => before.has(s))) {
      const dirs = after.dirs.get(skill) ?? [];
      if (dirs.length === 1) kept.push(skill);
      else if (dirs.length === 0 && after.problem === null) problems.push(`skill '${skill}' no longer resolves in source '${source.name}' at ${short(to)}: no directory '${skill}/' with a SKILL.md under '${source.path}'`);
      else if (dirs.length > 1) problems.push(`skill '${skill}' would be more than one directory in source '${source.name}' at ${short(to)}: ${dirs.map(shown).join(", ")}`);
    }
    if (problems.length > 0) return { problems };

    const diff = runGit(clone, "diff", "--name-only", "--no-renames", "-z", from, to);
    if (!diff.ok) throw new Error(`cannot compare ${short(from)} and ${short(to)} in ${source.repo}: ${diff.stderr.split("\n")[0]}`);
    const touched = diff.stdout.split("\0").filter((p) => p !== "");
    const changed = kept.filter((skill) => {
      const prefixes = [before.get(skill)![0]!, after.dirs.get(skill)![0]!].map((dir) => `${shown(dir)}/`);
      return touched.some((path) => prefixes.some((prefix) => path.startsWith(prefix)));
    });
    return { moved: { source: source.name, from, to, skills: changed } };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * `fleet skills update [<source>]`: move each pinned source (or the one named) to the head of its
 * `track` branch, if every bundle skill it provides still resolves there. Only the `commit:` line
 * of `catalog/skills.yaml` changes, and only after every source passed. Nothing is committed or applied.
 */
export function skills(configDir: string, args: string[]): Result {
  const [subcommand, name] = args;
  if (subcommand !== "update") return invalid([USAGE]);

  const file = join(configDir, CATALOG);
  const problems: string[] = [];
  const catalog = parseCatalog(configDir, problems);
  if (problems.length > 0) return invalid(problems);

  const pinned = catalog.sources.filter((s) => s.commit !== null);
  const targets = name === undefined ? pinned : catalog.sources.filter((s) => s.name === name);
  if (name !== undefined) {
    const source = targets[0];
    if (source === undefined) return invalid([`no source '${name}' in ${CATALOG}`]);
    if (source.commit === null) return invalid([`'${name}' is followed (branch ${source.branch}), not pinned; only a pinned source has a commit to update`]);
  }
  if (targets.length === 0) return { code: "ok", text: "no pinned sources", fields: { updated: [], unchanged: [] } };

  const bundled = [...new Set([...catalog.bundles.values()].flat())];
  const moved: Moved[] = [];
  const unchanged: string[] = [];
  for (const source of targets) {
    let reading: Reading;
    try {
      reading = readSource(source, bundled);
    } catch (error) {
      const result = failure(error);
      if (result === null) throw error;
      return result;
    }
    if ("problems" in reading) problems.push(...reading.problems);
    else if (reading.moved === null) unchanged.push(source.name);
    else moved.push(reading.moved);
  }
  if (problems.length > 0) return invalid(problems);

  let text = readFileSync(file, "utf8");
  for (const m of moved) {
    const next = replaceCommit(text, "sources", m.source, m.from, m.to);
    if (next === null) return invalid([`source '${m.source}': cannot find its 'commit:' line in ${CATALOG}; change it by hand to ${m.to}`]);
    text = next;
  }
  if (moved.length > 0) writeFileSync(file, text);

  const shas = new Map(targets.map((s) => [s.name, s.commit as string]));
  const lines = targets.flatMap((s) => {
    const m = moved.find((x) => x.source === s.name);
    if (m === undefined) return [`${s.name}: up to date (${short(shas.get(s.name)!)})`];
    return [`${s.name}: ${short(m.from)} -> ${short(m.to)}`, ...(m.skills.length > 0 ? m.skills.map((k) => `  ${k}`) : ["  (no skill in a bundle changed)"])];
  });
  return {
    code: "ok",
    text: lines.join("\n"),
    messages: moved.length > 0 ? [`fleet: ${CATALOG} updated. Review it with 'git diff', then 'fleet push' publishes it and applies it everywhere. Nothing was committed or applied.`] : [],
    fields: { updated: moved, unchanged },
  };
}
