import type { EditOp } from "../edit/index.ts";
import type { Value } from "../edit/index.ts";
import { parseCatalog } from "../catalog.ts";
import { parseMcpCatalog } from "../mcp.ts";
import { BadRequest } from "./request.ts";

/**
 * The edits in a request body, checked strictly: every op is rebuilt from the fields it may have, so nothing else a
 * page sends reaches the engine. A pick (`add`, `remove`) names a host and a bundle or server. A catalog addition
 * (`addServer`, `addSource`, `addBundle`) carries an entry that the loader itself must accept: it is parsed with the
 * loader's own code, so a refusal has the loader's message, and what the page may add is never wider than what loads.
 */

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
export const MAX_OPS = 200;
const MAX_SKILLS = 200;

type Raw = Record<string, unknown>;
const isRaw = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
// A line break or any other control character in a value would be written into the catalog file.
const plain = (s: unknown): s is string => typeof s === "string" && !/[\u0000-\u001f\u007f]/.test(s);

export function opsOf(body: unknown): EditOp[] {
  if (!isRaw(body)) throw new BadRequest("the body must be a JSON object");
  const list = body.ops;
  if (!Array.isArray(list) || list.length > MAX_OPS) throw new BadRequest(`ops must be a list of at most ${MAX_OPS} edits`);
  return list.map((raw, i) => opOf(raw, i));
}

function opOf(raw: unknown, i: number): EditOp {
  const o: Raw = isRaw(raw) ? raw : {};
  const at = `ops[${i}]`;
  switch (o.op) {
    case "add":
    case "remove": {
      const ok = (o.kind === "bundles" || o.kind === "mcp") && typeof o.host === "string" && NAME.test(o.host) && typeof o.name === "string" && NAME.test(o.name);
      if (!ok) throw new BadRequest(`${at} is not an add or remove of a bundle or server for a host`);
      return { op: o.op, host: o.host as string, kind: o.kind as "bundles" | "mcp", name: o.name as string };
    }
    case "addServer":
      return { op: "addServer", ...serverOf(at, o) };
    case "addSource":
      return { op: "addSource", ...sourceOf(at, o) };
    case "addBundle":
      return { op: "addBundle", ...bundleOf(at, o) };
    default:
      throw new BadRequest(`${at} is not an edit the page may make`);
  }
}

const strings = (at: string, key: string, v: unknown, max = 100): string[] => {
  if (!Array.isArray(v) || v.length > max || !v.every(plain)) throw new BadRequest(`${at}: '${key}' must be a list of at most ${max} strings`);
  return v as string[];
};

const stringMap = (at: string, key: string, v: unknown): Record<string, string> => {
  if (!isRaw(v) || Object.keys(v).length > 50) throw new BadRequest(`${at}: '${key}' must be a map of at most 50 strings`);
  for (const [k, x] of Object.entries(v)) {
    if (!ENV_NAME.test(k) && key === "env") throw new BadRequest(`${at}: '${key}' name '${k}' must be letters, digits and '_'`);
    if (!plain(k) || !plain(x)) throw new BadRequest(`${at}: '${key}' must be a map of strings`);
  }
  return v as Record<string, string>;
};

function serverOf(at: string, o: Raw): { name: string; entry: Record<string, Value> } {
  const name = o.name;
  if (typeof name !== "string" || !SERVER_NAME.test(name)) throw new BadRequest(`${at}: server name must be letters, digits, '_' or '-', and start with a letter or digit`);
  if (!isRaw(o.entry)) throw new BadRequest(`${at}: entry must be a map`);
  const e = o.entry;
  const entry: Record<string, Value> = {};
  for (const [key, v] of Object.entries(e)) {
    if (key === "command" || key === "only") entry[key] = strings(at, key, v);
    else if (key === "env" || key === "headers") entry[key] = stringMap(at, key, v);
    else if ((key === "transport" || key === "url") && plain(v)) entry[key] = v;
    else throw new BadRequest(`${at}: entry has no usable '${key}'`);
  }
  const problems: string[] = [];
  parseMcpCatalog(".", problems, { root: ".", files: { "catalog/mcp.yaml": JSON.stringify({ servers: { [name]: entry } }) } });
  if (problems.length > 0) throw new BadRequest(`${at}: ${problems[0]!.replace(/^catalog\/mcp\.yaml: /, "")}`);
  return { name, entry };
}

/**
 * Why `repo` may not be handed to `git clone`, or null. A URL, an scp-style address or an absolute path: never
 * something git would read as an option (a leading `-`) or as a helper (`ext::`, `fd::`), and no space or control character.
 */
export function repoProblem(repo: string): string | null {
  if (repo === "" || repo.length > 500) return "the repo must be a URL or a path";
  if (/[\u0000- \u007f]/.test(repo)) return "the repo must not hold a space or a control character";
  if (repo.startsWith("-")) return "the repo must not start with '-'";
  if (repo.includes("::")) return "the repo must not use a remote helper (a '::' address)";
  if (/^(https?|ssh|git|file):\/\/[^/]/.test(repo)) return null;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^/].*/.test(repo) || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:\/.*/.test(repo)) return null;
  if (repo.startsWith("/")) return null;
  return "the repo must be an https, ssh, git or file URL, an scp-style address (user@host:path) or an absolute path";
}

/** A branch name `git clone --branch` takes: no leading `-`, no `..`. */
export const branchProblem = (branch: string): string | null => (BRANCH.test(branch) && !branch.includes("..") ? null : "the branch name is not one fleet will pass to git");

function sourceOf(at: string, o: Raw): { name: string; entry: Record<string, Value> } {
  const name = o.name;
  if (typeof name !== "string" || !NAME.test(name)) throw new BadRequest(`${at}: source name must be letters, digits, '.', '_' or '-', and start with a letter or digit`);
  if (!isRaw(o.entry)) throw new BadRequest(`${at}: entry must be a map`);
  const entry: Record<string, Value> = {};
  for (const [key, v] of Object.entries(o.entry)) {
    if (key === "review") {
      if (typeof v !== "boolean") throw new BadRequest(`${at}: 'review' must be true or false`);
      entry[key] = v;
    } else if (["repo", "path", "commit", "track", "branch"].includes(key) && plain(v)) entry[key] = v;
    else throw new BadRequest(`${at}: entry has no usable '${key}'`);
  }
  const repo = typeof entry.repo === "string" ? repoProblem(entry.repo) : "the source needs a 'repo'";
  if (repo !== null) throw new BadRequest(`${at}: ${repo}`);
  for (const key of ["track", "branch"]) {
    const problem = typeof entry[key] === "string" ? branchProblem(entry[key] as string) : null;
    if (problem !== null) throw new BadRequest(`${at}: ${problem}`);
  }
  const problems: string[] = [];
  parseCatalog(".", problems, { root: ".", files: { "catalog/skills.yaml": JSON.stringify({ sources: { [name]: entry } }) } });
  if (problems.length > 0) throw new BadRequest(`${at}: ${problems[0]!.replace(/^catalog\/skills\.yaml: /, "")}`);
  return { name, entry };
}

function bundleOf(at: string, o: Raw): { name: string; skills: string[] } {
  const name = o.name;
  if (typeof name !== "string" || !NAME.test(name)) throw new BadRequest(`${at}: bundle name must be letters, digits, '.', '_' or '-', and start with a letter or digit`);
  const skills = strings(at, "skills", o.skills, MAX_SKILLS);
  if (skills.length === 0) throw new BadRequest(`${at}: a bundle needs at least one skill`);
  if (!skills.every((s) => SKILL_NAME.test(s))) throw new BadRequest(`${at}: a skill name must be letters, digits, '.', '_' or '-'`);
  const problems: string[] = [];
  parseCatalog(".", problems, { root: ".", files: { "catalog/skills.yaml": JSON.stringify({ bundles: { [name]: skills } }) } });
  if (problems.length > 0) throw new BadRequest(`${at}: ${problems[0]!.replace(/^catalog\/skills\.yaml: /, "")}`);
  return { name, skills };
}
