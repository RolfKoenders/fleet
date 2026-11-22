import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { diff } from "../apply.ts";
import { applyOps, CATALOG_FILES, DEFAULTS_FILE, entryProblem, entryValue, hostFile, parseSopsText, reviewText, secretsOwner, validate } from "../edit/index.ts";
import type { Applied, EditKind, EditOp, Files, HostProblems, Value } from "../edit/index.ts";
import { runGit } from "../git.ts";
import { existsSync } from "node:fs";
import { parseCatalog } from "../catalog.ts";
import { findSkills, sourceDir } from "../sources.ts";
import { hostNames, readRules } from "../recipients.ts";
import { InvalidConfigError } from "../config.ts";
import { loadModel } from "../tui/model.ts";
import type { Model } from "../tui/model.ts";

/**
 * What the page's edits do to the config repo. The page holds operations; every preview, check and write here replays
 * them with `applyOps` on the files as they are on disk right now, so an operation that has become stale is dropped
 * and reported instead of being written over a change made elsewhere.
 */

/** The files an edit may touch, by repo-relative path: the defaults, each host's file, the catalog files and the secrets files (as text, never decrypted). */
export function readFiles(configDir: string): Files {
  const hosts = hostNames(configDir);
  const paths = [DEFAULTS_FILE, ...hosts.map((h) => `hosts/${h}.yaml`), ...new Set(Object.values(CATALOG_FILES)), ...["shared", ...hosts].map((f) => `secrets/${f}.enc.yaml`)];
  const files: Files = {};
  for (const path of paths) {
    try {
      files[path] = readFileSync(join(configDir, path), "utf8");
    } catch {
      // a file that is not there is not edited, and the engine makes a catalog file that is missing
    }
  }
  return files;
}

/**
 * What an item is as the files would have it after `ops`, for an Edit dialog to start from: the entry as written (`secret:NAME` stays a
 * name, no value is ever here), and whether the engine can change it in place. When it cannot, `reason` says why. `text` is the file the item
 * is in as it would be (for the page to show read-only, and to diff an edit against). `found` is false for an item that is not there.
 */
export function entryOf(configDir: string, ops: readonly EditOp[], kind: EditKind, name: string) {
  const edited = applyOps(readFiles(configDir), ops).files;
  const path = kind === "host" ? hostFile(name) : CATALOG_FILES[kind === "server" ? "servers" : kind === "source" ? "sources" : "bundles"];
  const value: Value | null = entryValue(edited, kind, name);
  const reason = value === null ? null : entryProblem(edited, kind, name);
  return { kind, name, path, found: value !== null, value, editable: value !== null && reason === null, reason, text: edited[path] ?? "" };
}

/** What one host gets more or less of, by name. */
export type PickChange = { skills: { added: string[]; removed: string[] }; servers: { added: string[]; removed: string[] } };

export type HostCheck = {
  host: string;
  self: boolean;
  loads: boolean;
  problems: string[];
  /** Only the host's pick changes worked out from the config, never a plan: other hosts cannot be planned without ssh. */
  changes: PickChange;
};

const skillsOn = (m: Model, host: string): Set<string> => new Set(m.bundles.filter((b) => b.cells[host]?.on).flatMap((b) => b.skills));
const serversOn = (m: Model, host: string): Set<string> => new Set(m.servers.filter((s) => s.cells[host]?.on).map((s) => s.name));
const minus = (a: Set<string>, b: Set<string>): string[] => [...a].filter((x) => !b.has(x)).sort();

/** What `host` gets after the edits that it did not get before, and what it no longer gets. */
export function pickChange(before: Model, after: Model, host: string): PickChange {
  const [s0, s1, v0, v1] = [skillsOn(before, host), skillsOn(after, host), serversOn(before, host), serversOn(after, host)];
  return { skills: { added: minus(s1, s0), removed: minus(s0, s1) }, servers: { added: minus(v1, v0), removed: minus(v0, v1) } };
}

export type Preview = {
  applied: EditOp[];
  dropped: Applied["dropped"];
  /** Every file the edits change. */
  files: { path: string; before: string; after: string }[];
  /** The file the page asked to see, changed or not. */
  shown: { path: string; before: string; after: string } | null;
  before: Model;
  after: Model;
  /** Every config file as it would be after the edits. */
  edited: Files;
  checks: HostCheck[];
};

/** What the page knows of the skills of sources that are not cloned here yet: the ones it looked at when it added them, by source. */
export type StagedSkills = Record<string, string[]>;

/**
 * Every skill the skill sources of `files` provide, from the clones this machine has (and `staged` for a source the page just added), or `null`
 * when some source has no known list, because then a skill that is missing may only be one nobody looked at.
 */
export function knownSkills(configDir: string, home: string, files: Files, staged: StagedSkills): Set<string> | null {
  const problems: string[] = [];
  const known = new Set<string>();
  const sources = parseCatalog(configDir, problems, { root: configDir, files }).sources;
  // A catalog with no source is a config still being set up: its bundles are not checked against nothing.
  if (sources.length === 0) return null;
  for (const source of sources) {
    const held = staged[source.name];
    if (held !== undefined) {
      held.forEach((s) => known.add(s));
      continue;
    }
    const found = existsSync(join(sourceDir(home, source.name), ".git")) ? findSkills(source, home) : null;
    if (found === null || found.problem !== null) return null;
    found.dirs.forEach((_, s) => known.add(s));
  }
  return known;
}

export function preview(configDir: string, self: string | null, ops: readonly EditOp[], show: string | null, skills: { home: string; staged: StagedSkills } | null = null): Preview {
  const files = readFiles(configDir);
  const result = applyOps(files, ops);
  const before = loadModel(configDir, self);
  const after = loadModel(configDir, self, result.files);
  const known = skills === null ? null : knownSkills(configDir, skills.home, result.files, skills.staged);
  const failed = new Map<string, HostProblems>(validate(configDir, result.files, { skills: known }).map((f) => [f.host, f]));
  const checks = after.hosts.map((h): HostCheck => ({
    host: h.name,
    self: h.self,
    loads: !failed.has(h.name),
    problems: failed.get(h.name)?.problems ?? [],
    changes: pickChange(before, after, h.name),
  }));
  // A secrets file is shown by its names, each with a short mark of its ciphertext: the review never carries the ciphertext.
  const text = (f: Files, path: string) => (secretsOwner(path) !== null ? reviewText(f[path] ?? "") : (f[path] ?? ""));
  return {
    applied: result.applied,
    dropped: result.dropped,
    files: result.changed.map((path) => ({ path, before: text(files, path), after: text(result.files, path) })).sort((a, b) => a.path.localeCompare(b.path)),
    shown: show !== null && show in result.files ? { path: show, before: text(files, show), after: text(result.files, show) } : null,
    before,
    after,
    edited: result.files,
    checks,
  };
}

/**
 * Why a held secrets file may not be written, or null. The text of the file was checked when it came in (`opsOf`); this is
 * what needs the config: it must be the file of `shared` or of a host with an age recipient, encrypted for exactly the
 * recipients that file has in `.sops.yaml` (what `fleet secrets rekey` would make of it).
 */
export function secretOpProblem(configDir: string, ops: readonly EditOp[]): string | null {
  const held = ops.filter((o) => o.op === "setSecret");
  if (held.length === 0) return null;
  let rules: ReturnType<typeof readRules>;
  try {
    rules = readRules(configDir);
  } catch (error) {
    if (error instanceof InvalidConfigError) return `the age recipients of the hosts cannot be read: ${error.problems[0] ?? "invalid config"}`;
    throw error;
  }
  for (const op of held) {
    const owner = secretsOwner(op.file);
    const rule = rules.find((r) => r.file === owner);
    if (rule === undefined) return `${op.file} is not the secrets file of a host with an age recipient`;
    if (parseSopsText(op.content).recipients.join() !== rule.recipients.join()) return `${op.file} is not encrypted for the recipients .sops.yaml names for it: run fleet secrets rekey and set the value again`;
  }
  return null;
}

/** This host's full plan against the edited config: `fleet diff`, with the files held in memory. Nothing is written. */
export function plan(configDir: string, home: string, ops: readonly EditOp[]) {
  const result = applyOps(readFiles(configDir), ops);
  const out = diff(configDir, false, home, result.files);
  return { code: out.code, text: out.text ?? "", messages: out.messages ?? [] };
}

export class WriteRefused extends Error {
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

/**
 * Replays `ops` on the files on disk, checks every host loads, writes the changed files and commits them with `message`.
 * Nothing is written when anything is wrong; a commit that fails puts the files back as they were.
 * The caller holds the push lock and has checked for outside changes.
 */
export function writeAndCommit(configDir: string, ops: readonly EditOp[], message: string, skills: { home: string; staged: StagedSkills } | null = null): { files: string[]; commit: string } {
  const unfit = secretOpProblem(configDir, ops);
  if (unfit !== null) throw new WriteRefused("invalid", unfit);
  const before = readFiles(configDir);
  const result = applyOps(before, ops);
  if (result.dropped.length > 0) throw new WriteRefused("stale", result.dropped.length === 1 ? "1 edit no longer applies to the files on disk" : `${result.dropped.length} edits no longer apply to the files on disk`, { dropped: result.dropped });
  if (result.changed.length === 0) throw new WriteRefused("nothing", "there is nothing to write");
  // The same check as the preview's, so a bundle that names a skill no known source provides is refused here too.
  const known = skills === null ? null : knownSkills(configDir, skills.home, result.files, skills.staged);
  const failed = validate(configDir, result.files, { skills: known });
  if (failed.length > 0) throw new WriteRefused("invalid", `the edited config does not load for ${failed.map((f) => f.host).join(", ")}`, { problems: failed });

  const done: string[] = [];
  const restore = () => {
    for (const path of done) {
      if (path in before) writeFileSync(join(configDir, path), before[path]!);
      else rmSync(join(configDir, path), { force: true });
    }
    runGit(configDir, "reset", "--quiet", "--", ...result.changed);
  };
  try {
    for (const path of result.changed) {
      mkdirSync(dirname(join(configDir, path)), { recursive: true });
      writeFileSync(join(configDir, path), result.files[path]!);
      done.push(path);
    }
    const add = runGit(configDir, "add", "--", ...result.changed);
    if (!add.ok) throw new Error(`cannot stage: ${add.stderr.split("\n")[0]}`);
    const commit = runGit(configDir, "commit", "--quiet", "-m", message, "--", ...result.changed);
    if (!commit.ok) throw new Error(`cannot commit: ${(commit.stderr || commit.stdout).split("\n")[0]}`);
  } catch (error) {
    restore();
    throw new WriteRefused("failed", (error as Error).message);
  }
  return { files: result.changed, commit: runGit(configDir, "rev-parse", "--short", "HEAD").stdout };
}

