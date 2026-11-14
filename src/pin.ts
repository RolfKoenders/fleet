import { join } from "node:path";
import { isObject, parseFile } from "./yamlfile.ts";
import type { Overlay } from "./yamlfile.ts";

/** The tool commit a config pins, from `fleet.yaml` at the config repo's root. */
export type Pin = {
  repo: string;
  commit: string;
  /** What `fleet update` follows: the branch of that name, or the tool's releases when it is `releases`. */
  track: string;
};

/** The `track` value that follows releases. Any other value is a branch. */
export const TRACK_RELEASES = "releases";

export const PIN_FILE = "fleet.yaml";
const COMMIT = /^[0-9a-f]{40}$/;

export function readPin(configDir: string, problems: string[], overlay?: Overlay): Pin | null {
  const path = join(configDir, PIN_FILE);
  const doc = parseFile(path, false, problems, overlay);
  if (doc === null) return null;

  const before = problems.length;
  for (const key of Object.keys(doc)) {
    if (key !== "tool") problems.push(`${path}: unknown key '${key}'`);
  }
  const { tool } = doc;
  if (!isObject(tool)) {
    problems.push(`${path}: 'tool' must be a map with 'repo', 'commit' and 'track'`);
    return null;
  }
  for (const key of Object.keys(tool)) {
    if (!["repo", "commit", "track"].includes(key)) problems.push(`${path}: unknown key 'tool.${key}'`);
  }
  const { repo, commit, track } = tool;
  if (typeof repo !== "string" || repo === "" || repo.startsWith("-")) problems.push(`${path}: 'tool.repo' must be a URL`);
  if (typeof commit !== "string" || !COMMIT.test(commit)) problems.push(`${path}: 'tool.commit' must be a full 40-character lowercase sha`);
  if (typeof track !== "string" || track === "") problems.push(`${path}: 'tool.track' must be the branch 'fleet update' reads, or '${TRACK_RELEASES}'`);
  if (problems.length > before) return null;
  return { repo: repo as string, commit: commit as string, track: track as string };
}

/** The URL of a remote that travels in another machine's argv, where `ps` shows it: no password, and not an option. */
export const urlProblem = (url: string): string | null =>
  /^[a-z][a-z0-9+.-]*:\/\/[^/@]*:[^/@]*@/i.test(url) || url.startsWith("-") ? "holds a password or looks like an option; use a plain URL and let git's credential helper or SSH key authenticate" : null;
