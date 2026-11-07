import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { failure } from "./apply.ts";
import { parseCatalog } from "./catalog.ts";
import type { Source } from "./catalog.ts";
import { runGit, UnreachableError } from "./git.ts";
import type { Result } from "./output.ts";
import { replaceCommit } from "./pinedit.ts";
import { askPin } from "./skillprompt.ts";
import type { PromptIO } from "./skillprompt.ts";
import { renderReview } from "./skillreport.ts";
import { reviewMove } from "./skillreview.ts";
import type { Review } from "./skillreview.ts";
import { findSkillsIn } from "./sources.ts";

const USAGE = "usage: fleet skills update [--review] [--yes] [<source>]";
const CATALOG = "catalog/skills.yaml";

const invalid = (messages: string[]): Result => ({ code: "invalid", messages: messages.map((m) => `fleet: ${m}`) });
const short = (sha: string) => sha.slice(0, 7);

type Moved = { source: string; from: string; to: string; skills: string[] };

/** What reading one source's track branch found: it did not move, it moved (with the review, if one was asked for), or why it cannot. */
type Reading = { moved: Moved | null; review?: Review } | { problems: string[] };

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
function readSource(source: Source, bundled: string[], review: boolean, color: boolean): Reading {
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
    const touches = (dirs: string[]) => {
      const prefixes = dirs.map((dir) => `${shown(dir)}/`);
      return touched.some((path) => prefixes.some((prefix) => path.startsWith(prefix)));
    };
    const changed = kept.filter((skill) => touches([before.get(skill)![0]!, after.dirs.get(skill)![0]!]));
    const moved = { source: source.name, from, to, skills: changed };
    if (!review) return { moved };

    const others = [...new Set([...before.keys(), ...after.dirs.keys()])].filter((skill) => !bundled.includes(skill) && touches([...(before.get(skill) ?? []), ...(after.dirs.get(skill) ?? [])])).length;
    const used = changed.map((skill) => ({ skill, before: shown(before.get(skill)![0]!), after: shown(after.dirs.get(skill)![0]!) }));
    return { moved, review: reviewMove(clone, from, to, used, kept.length, others, color) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export type SkillsOptions = {
  /** Read what the move brings in and report it, instead of moving the pin unseen. */
  review?: boolean;
  /** With a review, move the pin without asking. */
  yes?: boolean;
  color?: boolean;
  /** Where the prompt asks. Null when there is no terminal, or `--json` wants a document only. */
  terminal?: PromptIO | null;
};

/** One decision point: does this source's move get reviewed? */
const wantsReview = (source: Source, options: SkillsOptions): boolean => options.review === true || source.review;

const reviewJson = (m: Moved, review: Review, moved: boolean) => {
  const { diff: _diff, ...data } = review;
  return { source: m.source, from: m.from, to: m.to, ...data, moved };
};

/**
 * `fleet skills update [--review] [--yes] [<source>]`: move each pinned source (or the one named) to the head of its
 * `track` branch, if every bundle skill it provides still resolves there. Only the `commit:` line
 * of `catalog/skills.yaml` changes, and only after every source passed. Nothing is committed or applied.
 * A reviewed source reports what it brings in first, and its pin moves only when asked: on a terminal by
 * a key, otherwise by `--yes`.
 */
export async function skills(configDir: string, args: string[], options: SkillsOptions = {}): Promise<Result> {
  const [subcommand, name] = args;
  if (subcommand !== "update") return invalid([USAGE]);
  const color = options.color === true;

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
  const reviews = new Map<string, Review>();
  const unchanged: string[] = [];
  for (const source of targets) {
    let reading: Reading;
    try {
      reading = readSource(source, bundled, wantsReview(source, options), color);
    } catch (error) {
      const result = failure(error);
      if (result === null) throw error;
      return result;
    }
    if ("problems" in reading) problems.push(...reading.problems);
    else if (reading.moved === null) unchanged.push(source.name);
    else {
      moved.push(reading.moved);
      if (reading.review !== undefined) reviews.set(reading.moved.source, reading.review);
    }
  }
  if (problems.length > 0) return invalid(problems);

  // Every edit has to be possible before anyone is asked about one.
  const original = readFileSync(file, "utf8");
  const edit = (text: string, m: Moved) => replaceCommit(text, "sources", m.source, m.from, m.to);
  let probe = original;
  for (const m of moved) {
    const next = edit(probe, m);
    if (next === null) return invalid([`source '${m.source}': cannot find its 'commit:' line in ${CATALOG}; change it by hand to ${m.to}`]);
    probe = next;
  }

  // A pin that was not reviewed moves, as it always did. A reviewed one moves when it is asked to.
  const accepted = new Set<string>();
  const stopped = new Set<string>();
  const shown = new Set<string>();
  const terminal = options.terminal ?? null;
  let stop = false;
  for (const m of moved) {
    const review = reviews.get(m.source);
    if (review === undefined) {
      accepted.add(m.source);
      continue;
    }
    if (terminal !== null) {
      terminal.stdout.write(`${shown.size > 0 ? "\n" : ""}${renderReview(m.source, m.from, m.to, review, color)}\n`);
      shown.add(m.source);
    }
    if (options.yes === true) accepted.add(m.source);
    else if (stop) stopped.add(m.source);
    else if (terminal !== null) {
      const answer = await askPin(terminal, m.from, review);
      if (answer === "yes") accepted.add(m.source);
      else if (answer === "stop") {
        stop = true;
        stopped.add(m.source);
      }
    }
  }

  let text = original;
  for (const m of moved.filter((x) => accepted.has(x.source))) text = edit(text, m)!;
  if (accepted.size > 0) writeFileSync(file, text);

  const shas = new Map(targets.map((s) => [s.name, s.commit as string]));
  const blocks = targets.map((s) => {
    const m = moved.find((x) => x.source === s.name);
    if (m === undefined) return `${s.name}: up to date (${short(shas.get(s.name)!)})`;
    const review = reviews.get(s.name);
    if (review === undefined) return [`${s.name}: ${short(m.from)} -> ${short(m.to)}`, ...(m.skills.length > 0 ? m.skills.map((k) => `  ${k}`) : ["  (no skill in a bundle changed)"])].join("\n");
    const outcome = accepted.has(s.name)
      ? `${s.name}: moved ${short(m.from)} → ${short(m.to)}`
      : `${s.name}: kept at ${short(m.from)}${terminal === null ? " (no terminal to ask on; pass --yes to move it)" : stopped.has(s.name) ? " (review stopped)" : ""}`;
    return shown.has(s.name) ? outcome : `${renderReview(s.name, m.from, m.to, review, color)}\n\n${outcome}`;
  });
  const reviewed = moved.filter((m) => reviews.has(m.source));
  return {
    code: "ok",
    text: blocks.join(reviewed.length > 0 ? "\n\n" : "\n"),
    messages: accepted.size > 0 ? [`fleet: ${CATALOG} updated. Review it with 'git diff', then 'fleet push' publishes it and applies it everywhere. Nothing was committed or applied.`] : [],
    fields: {
      updated: moved.filter((m) => accepted.has(m.source)),
      unchanged,
      ...(options.review === true || reviews.size > 0 ? { reviews: reviewed.map((m) => reviewJson(m, reviews.get(m.source)!, accepted.has(m.source))) } : {}),
    },
  };
}
