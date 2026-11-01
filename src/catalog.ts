import { join } from "node:path";
import { isObject, isStringList, parseFile } from "./yamlfile.ts";
import type { Obj } from "./yamlfile.ts";

export type Source = {
  name: string;
  repo: string;
  /** Directory inside the clone to search for skills. */
  path: string;
  /** Pinned: the commit to sit at. */
  commit: string | null;
  /** Pinned: the branch `skills update` reads. */
  track: string | null;
  /** Followed: the branch to sit on. */
  branch: string | null;
};

export type Catalog = {
  sources: Source[];
  /** Bundle name to its skill names. */
  bundles: Map<string, string[]>;
};

/** Names `fleet` itself owns or leaves alone in `~/.claude/skills`. */
export const RESERVED_SKILLS = ["fleet", "synced", ".trash"];

const SOURCE_KEYS = ["repo", "path", "commit", "track", "branch"];
const SOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMMIT = /^[0-9a-f]{40}$/;

const isPlainName = (name: string) => name !== "" && name !== "." && name !== ".." && !name.includes("/");

function parseSource(at: string, name: string, raw: unknown, problems: string[]): Source | null {
  if (!SOURCE_NAME.test(name)) {
    problems.push(`${at}: source name '${name}' must be letters, digits, '.', '_' or '-', and start with a letter or digit`);
    return null;
  }
  if (!isObject(raw)) {
    problems.push(`${at}: source '${name}' must be a map`);
    return null;
  }
  const where = `${at}: source '${name}'`;
  const before = problems.length;
  for (const key of Object.keys(raw)) {
    if (!SOURCE_KEYS.includes(key)) problems.push(`${where}: unknown key '${key}'`);
  }
  const { repo, path, commit, track, branch } = raw;
  if (typeof repo !== "string" || repo === "") problems.push(`${where}: 'repo' must be a URL`);
  if (typeof path !== "string" || path === "" || path.startsWith("/") || path.split("/").includes("..")) {
    problems.push(`${where}: 'path' must be a directory inside the repo, without '..'`);
  }
  if ((commit === undefined) === (branch === undefined)) {
    problems.push(`${where}: needs exactly one of 'commit' (pinned) or 'branch' (followed)`);
  }
  if (commit !== undefined && (typeof commit !== "string" || !COMMIT.test(commit))) {
    problems.push(`${where}: 'commit' must be a full 40-character lowercase sha`);
  }
  if (branch !== undefined && (typeof branch !== "string" || branch === "")) {
    problems.push(`${where}: 'branch' must be a branch name`);
  }
  if (commit !== undefined && (typeof track !== "string" || track === "")) {
    problems.push(`${where}: a pinned source needs 'track', the branch that 'skills update' reads`);
  }
  if (branch !== undefined && track !== undefined) problems.push(`${where}: only a pinned source has 'track'`);
  if (problems.length > before) return null;
  return {
    name,
    repo: repo as string,
    path: path as string,
    commit: (commit as string | undefined) ?? null,
    track: (track as string | undefined) ?? null,
    branch: (branch as string | undefined) ?? null,
  };
}

/**
 * Reads and checks `catalog/skills.yaml`. A missing file is an empty catalog. Checks that need
 * no clone: shapes, reserved names, and a skill listed in two bundles.
 */
export function parseCatalog(configDir: string, problems: string[]): Catalog {
  const path = join(configDir, "catalog/skills.yaml");
  const empty: Catalog = { sources: [], bundles: new Map() };
  const doc = parseFile(path, true, problems);
  if (doc === null) return empty;

  for (const key of Object.keys(doc)) {
    if (key !== "sources" && key !== "bundles") problems.push(`${path}: unknown key '${key}'`);
  }

  const sources: Source[] = [];
  const { sources: rawSources, bundles: rawBundles } = doc as Obj;
  if (rawSources !== undefined) {
    if (!isObject(rawSources)) problems.push(`${path}: 'sources' must be a map`);
    else {
      for (const [name, raw] of Object.entries(rawSources)) {
        const source = parseSource(path, name, raw, problems);
        if (source) sources.push(source);
      }
    }
  }

  const bundles = new Map<string, string[]>();
  if (rawBundles !== undefined) {
    if (!isObject(rawBundles)) problems.push(`${path}: 'bundles' must be a map`);
    else {
      const owner = new Map<string, string>();
      for (const [bundle, skills] of Object.entries(rawBundles)) {
        if (!isStringList(skills)) {
          problems.push(`${path}: bundle '${bundle}' must be a list of skill names`);
          continue;
        }
        for (const skill of skills) {
          if (!isPlainName(skill)) {
            problems.push(`${path}: bundle '${bundle}': '${skill}' is not a skill name`);
          } else if (RESERVED_SKILLS.includes(skill)) {
            problems.push(`${path}: bundle '${bundle}': '${skill}' is a reserved name, fleet never links it from a source`);
          } else if (owner.has(skill) && owner.get(skill) !== bundle) {
            problems.push(`${path}: skill '${skill}' is in both bundle '${owner.get(skill)}' and bundle '${bundle}'`);
          } else if (owner.get(skill) === bundle) {
            problems.push(`${path}: skill '${skill}' is listed twice in bundle '${bundle}'`);
          }
          owner.set(skill, owner.get(skill) ?? bundle);
        }
        bundles.set(bundle, skills);
      }
    }
  }
  return { sources, bundles };
}

/**
 * The bundles a host gets: every `bundles` list from the defaults and the host file, then every
 * `exclude` list taken off. Order is kept, first mention first.
 */
export function pickBundles(adds: string[][], excludes: string[][]): string[] {
  const removed = new Set(excludes.flat());
  return [...new Set(adds.flat())].filter((b) => !removed.has(b));
}
