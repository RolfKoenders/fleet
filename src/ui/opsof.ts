import type { Change, EditOp } from "../edit/index.ts";
import type { Value } from "../edit/index.ts";
import { parseCatalog } from "../catalog.ts";
import { parseMcpCatalog } from "../mcp.ts";
import { ciphertextProblem, parseSopsText, SECRET_NAME, SECRETS_PATH } from "../edit/index.ts";
import { REPO_CREDENTIALS, urlHoldsCredentials } from "../redact.ts";
import { BadRequest } from "./request.ts";
import { sshProblem } from "./hostinit.ts";

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
/** The longest name of a server, source, bundle or host. */
export const MAX_NAME = 64;
export const nameLength = (what: string, name: string): string | null => (name.length > MAX_NAME ? `the ${what} can be at most ${MAX_NAME} characters` : null);
const MAX_SKILLS = 200;

type Raw = Record<string, unknown>;
const isRaw = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
// A line break or any other control character in a value would be written into the catalog file.
const plain = (s: unknown): s is string => typeof s === "string" && !/[\u0000-\u001f\u007f]/.test(s);

export function opsOf(body: unknown): EditOp[] {
  if (!isRaw(body)) throw new BadRequest("the body must be a JSON object");
  const list = body.ops;
  if (!Array.isArray(list) || list.length > MAX_OPS) throw new BadRequest(`ops must be a list of at most ${MAX_OPS} edits`);
  const ops = list.map((raw, i) => opOf(raw, i));
  const seen = new Set<string>();
  for (const [i, op] of ops.entries()) {
    if (op.op !== "addServer" && op.op !== "addSource" && op.op !== "addBundle") continue;
    const key = `${op.op}:${op.name.toLowerCase()}`;
    if (seen.has(key)) throw new BadRequest(`ops[${i}]: ${alreadyHeld(op.name)}`);
    seen.add(key);
  }
  return ops;
}

/** What a second addition of a name already added to To push says. The page says the same (`static/catalog.js`). */
const alreadyHeld = (name: string): string => `'${name}' is already added to To push`;

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
    case "addEverywhere": {
      const ok = (o.kind === "bundles" || o.kind === "mcp") && typeof o.name === "string" && NAME.test(o.name);
      if (!ok) throw new BadRequest(`${at} is not an add of a bundle or server for every host`);
      return { op: "addEverywhere", kind: o.kind as "bundles" | "mcp", name: o.name as string };
    }
    case "addServer":
      return { op: "addServer", ...serverOf(at, o) };
    case "addSource":
      return { op: "addSource", ...sourceOf(at, o) };
    case "addBundle":
      return { op: "addBundle", ...bundleOf(at, o) };
    case "removeServer":
      return { op: "removeServer", name: removedName(at, o, SERVER_NAME, "server") };
    case "removeBundle":
      return { op: "removeBundle", name: removedName(at, o, NAME, "bundle") };
    case "removeSource":
      return { op: "removeSource", name: removedName(at, o, NAME, "source"), skills: removedSkills(at, o.skills) };
    case "editServer":
      return { op: "editServer", ...editedOf(at, o, SERVER_NAME, "server", serverTo) };
    case "editSource":
      return { op: "editSource", ...editedOf(at, o, NAME, "source", sourceTo) };
    case "editBundle":
      return { op: "editBundle", ...editedBundleOf(at, o) };
    case "editHost":
      return { op: "editHost", ...editedHostOf(at, o) };
    case "setSecret":
      return { op: "setSecret", ...setSecretOf(at, o) };
    case "ignore": {
      const ok = typeof o.host === "string" && NAME.test(o.host) && typeof o.item === "string" && /^(mcp|skill):[A-Za-z0-9][A-Za-z0-9._-]*$/.test(o.item) && o.item.length <= MAX_NAME + 6;
      if (!ok) throw new BadRequest(`${at} is not an ignore of mcp:<name> or skill:<name> for a host`);
      return { op: "ignore", host: o.host as string, item: o.item as string };
    }
    default:
      throw new BadRequest(`${at} is not an edit the page may make`);
  }
}

/**
 * A secrets file the page holds, encrypted. It is rebuilt from its own fields and checked as text: a path of a secrets file,
 * names the loader accepts, and a sops file that holds ciphertext and nothing else. Whether the recipients are the right ones
 * for that file needs the config, so `secretOpProblem` (edits.ts) checks that.
 */
function setSecretOf(at: string, o: Raw): { file: string; names: string[]; base: string; content: string } {
  if (typeof o.file !== "string" || !SECRETS_PATH.test(o.file)) throw new BadRequest(`${at}: file must be a secrets file such as secrets/box.enc.yaml`);
  const names = o.names;
  if (!Array.isArray(names) || names.length === 0 || names.length > 100 || !names.every((n) => typeof n === "string" && SECRET_NAME.test(n))) {
    throw new BadRequest(`${at}: names must be a list of secret names such as TRACKER_API_KEY`);
  }
  if (typeof o.base !== "string" || !/^([0-9a-f]{64}|absent)$/.test(o.base)) throw new BadRequest(`${at}: base must be the digest of the file the value was encrypted into`);
  if (typeof o.content !== "string") throw new BadRequest(`${at}: content must be the encrypted file`);
  const problem = ciphertextProblem(o.content);
  if (problem !== null) throw new BadRequest(`${at}: ${problem}`);
  const entries = parseSopsText(o.content).entries;
  if (!(names as string[]).every((n) => entries.has(n))) throw new BadRequest(`${at}: the encrypted file does not hold every name`);
  return { file: o.file, names: [...new Set(names as string[])], base: o.base, content: o.content };
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
  const long = nameLength("name", name);
  if (long !== null) throw new BadRequest(`${at}: ${long}`);
  if (!isRaw(o.entry)) throw new BadRequest(`${at}: entry must be a map`);
  const e = o.entry;
  const entry: Record<string, Value> = {};
  for (const [key, v] of Object.entries(e)) {
    if (key === "command" || key === "only") entry[key] = strings(at, key, v);
    else if (key === "env" || key === "headers") entry[key] = stringMap(at, key, v);
    else if ((key === "transport" || key === "url") && plain(v)) entry[key] = v;
    else throw new BadRequest(`${at}: entry has no usable '${key}'`);
  }
  const problem = serverProblem(name, entry);
  if (problem !== null) throw new BadRequest(`${at}: ${problem}`);
  return { name, entry };
}

/** What the loader says of a server entry, without its file prefix, or null. */
function serverProblem(name: string, entry: Record<string, Value>): string | null {
  const problems: string[] = [];
  parseMcpCatalog(".", problems, { root: ".", files: { "catalog/mcp.yaml": JSON.stringify({ servers: { [name]: entry } }) } });
  return problems.length > 0 ? problems[0]!.replace(/^catalog\/mcp\.yaml: /, "") : null;
}

/**
 * Why `repo` may not be handed to `git clone`, or null. A URL, an scp-style address or an absolute path: never
 * something git would read as an option (a leading `-`) or as a helper (`ext::`, `fd::`), and no space or control character.
 */
export function repoProblem(repo: string): string | null {
  if (repo === "" || repo.length > 500) return "the repo must be a URL or a path";
  if (/[\u0000- \u007f]/.test(repo)) return "the repo must not hold a space or a control character";
  if (repo.startsWith("-")) return "the repo must not start with '-'";
  if (urlHoldsCredentials(repo)) return REPO_CREDENTIALS;
  if (repo.includes("::")) return "the repo must not use a remote helper (a '::' address)";
  if (/^(https?|ssh|git|file):\/\/[^/]/.test(repo)) return null;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^/].*/.test(repo) || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:\/.*/.test(repo)) return null;
  if (repo.startsWith("/")) return null;
  return "the repo must be an https, ssh, git or file URL, an scp-style address (user@host:path) or an absolute path";
}

/** The page says the same (`pathProblem` in `static/catalog.js`). */
export const PATH_PROBLEM = "the path must be a directory inside the repo, without '..'";

/** A branch name `git clone --branch` takes: no leading `-`, no `..`. */
export const branchProblem = (branch: string): string | null => (BRANCH.test(branch) && !branch.includes("..") ? null : "the branch name is not one fleet will pass to git");

function sourceOf(at: string, o: Raw): { name: string; entry: Record<string, Value> } {
  const name = o.name;
  if (typeof name !== "string" || !NAME.test(name)) throw new BadRequest(`${at}: source name must be letters, digits, '.', '_' or '-', and start with a letter or digit`);
  const long = nameLength("name", name);
  if (long !== null) throw new BadRequest(`${at}: ${long}`);
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
  if (typeof entry.path === "string" && (entry.path.startsWith("/") || entry.path.split("/").includes("..") || /[\u0000-\u001f\u007f]/.test(entry.path))) throw new BadRequest(`${at}: ${PATH_PROBLEM}`);
  const problem = sourceProblem(name, entry);
  if (problem !== null) throw new BadRequest(`${at}: ${problem}`);
  return { name, entry };
}

/** What the loader says of a source entry, without its file prefix, or null. */
function sourceProblem(name: string, entry: Record<string, Value>): string | null {
  const problems: string[] = [];
  parseCatalog(".", problems, { root: ".", files: { "catalog/skills.yaml": JSON.stringify({ sources: { [name]: entry } }) } });
  return problems.length > 0 ? problems[0]!.replace(/^catalog\/skills\.yaml: /, "") : null;
}

function bundleOf(at: string, o: Raw): { name: string; skills: string[] } {
  const name = o.name;
  if (typeof name !== "string" || !NAME.test(name)) throw new BadRequest(`${at}: bundle name must be letters, digits, '.', '_' or '-', and start with a letter or digit`);
  const long = nameLength("name", name);
  if (long !== null) throw new BadRequest(`${at}: ${long}`);
  const skills = strings(at, "skills", o.skills, MAX_SKILLS);
  if (skills.length === 0) throw new BadRequest(`${at}: a bundle needs at least one skill`);
  if (!skills.every((s) => SKILL_NAME.test(s))) throw new BadRequest(`${at}: a skill name must be letters, digits, '.', '_' or '-'`);
  const problems: string[] = [];
  parseCatalog(".", problems, { root: ".", files: { "catalog/skills.yaml": JSON.stringify({ bundles: { [name]: skills } }) } });
  if (problems.length > 0) throw new BadRequest(`${at}: ${problems[0]!.replace(/^catalog\/skills\.yaml: /, "")}`);
  return { name, skills };
}

/** The name of a catalog entry a removal names: one fleet could have in the catalog. */
function removedName(at: string, o: Raw, nameRe: RegExp, what: string): string {
  const name = o.name;
  if (typeof name !== "string" || !nameRe.test(name) || name.length > MAX_NAME) throw new BadRequest(`${at}: ${what} name is not one fleet knows`);
  return name;
}

/** The skills a removed source provided, as the page knew them: names a bundle could list. */
function removedSkills(at: string, v: unknown): string[] {
  const skills = strings(at, "skills", v, MAX_SKILLS);
  if (!skills.every((s) => SKILL_NAME.test(s))) throw new BadRequest(`${at}: a skill name must be letters, digits, '.', '_' or '-'`);
  return [...new Set(skills)];
}

// ---- Edits of what is already in the config

const MAX_CHANGES = 12;

/**
 * What a file held, for an edit to compare with: any text, list or map of them of a sensible size. It is never written, only compared,
 * so it is not held to the rules of a new value.
 */
function heldValue(at: string, key: string, v: unknown, depth = 0): Value | null {
  if (v === null) return null;
  if (typeof v === "string" && v.length <= 2000) return v;
  if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return v;
  if (depth < 3 && Array.isArray(v) && v.length <= 200) return v.map((x) => heldValue(at, key, x, depth + 1) ?? bad(at, key));
  if (depth < 3 && isRaw(v) && Object.keys(v).length <= 100) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, heldValue(at, key, x, depth + 1) ?? bad(at, key)]));
  return bad(at, key);
}

const bad = (at: string, key: string): never => {
  throw new BadRequest(`${at}: '${key}' holds something an edit cannot compare with`);
};

/**
 * The name and field changes of an edit of a server or source. Each change names a key the page may change, what the file held (`from`) and
 * what it should hold (`to`, checked by `to` as a new value is, or null to take the key out). A key may be named once.
 */
function editedOf(at: string, o: Raw, nameRe: RegExp, what: string, to: (at: string, key: string, v: unknown) => Value): { name: string; changes: Change[] } {
  const name = o.name;
  if (typeof name !== "string" || !nameRe.test(name) || name.length > MAX_NAME) throw new BadRequest(`${at}: ${what} name is not one fleet knows`);
  const list = o.changes;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_CHANGES) throw new BadRequest(`${at}: changes must be a list of 1 to ${MAX_CHANGES} field changes`);
  const seen = new Set<string>();
  const changes = list.map((raw): Change => {
    const c: Raw = isRaw(raw) ? raw : {};
    const key = c.key;
    if (typeof key !== "string" || !(what === "server" ? SERVER_FIELDS : SOURCE_FIELDS).includes(key)) throw new BadRequest(`${at}: a ${what} has no field '${String(key)}' that can be changed here`);
    if (seen.has(key)) throw new BadRequest(`${at}: '${key}' is changed twice`);
    seen.add(key);
    if (!("from" in c) || !("to" in c)) throw new BadRequest(`${at}: a change needs 'from' and 'to'`);
    return { key, from: heldValue(at, key, c.from), to: c.to === null ? null : to(at, key, c.to) };
  });
  return { name, changes };
}

const SERVER_FIELDS = ["command", "transport", "url", "env", "headers", "only"];
// The repo is not here on purpose: a changed repo breaks the clones that machines already have, which are kept by the source's name.
const SOURCE_FIELDS = ["commit", "track", "branch", "path", "review"];

/** A new value of one field of a server, checked as the loader checks it on a server that holds just that field. */
function serverTo(at: string, key: string, v: unknown): Value {
  const stdio = { command: ["x"] };
  const network = { transport: "http", url: "https://x.example" };
  let entry: Record<string, Value>;
  let value: Value;
  if (key === "command" || key === "only") value = strings(at, key, v);
  else if (key === "env" || key === "headers") value = stringMap(at, key, v);
  else if (plain(v)) value = v;
  else throw new BadRequest(`${at}: '${key}' must be text`);
  if (key === "command") entry = { command: value };
  else if (key === "only") entry = { ...stdio, only: value };
  else if (key === "env") entry = { ...stdio, env: value };
  else if (key === "headers") entry = { ...network, headers: value };
  else if (key === "transport") entry = { ...network, transport: value };
  else entry = { ...network, url: value };
  const problem = serverProblem("x", entry);
  if (problem !== null) throw new BadRequest(`${at}: ${problem.replace(/^server 'x': /, "")}`);
  return value;
}

/** A new value of one field of a source, checked as the loader and `addSource` check it. */
function sourceTo(at: string, key: string, v: unknown): Value {
  const pinned = { repo: "https://example.com/r.git", path: ".", commit: "a".repeat(40), track: "main" };
  const followed = { repo: "https://example.com/r.git", path: ".", branch: "main" };
  if (key === "review") {
    if (typeof v !== "boolean") throw new BadRequest(`${at}: 'review' must be true or false`);
    return v;
  }
  if (!plain(v)) throw new BadRequest(`${at}: '${key}' must be text`);
  if (key === "track" || key === "branch") {
    const problem = branchProblem(v);
    if (problem !== null) throw new BadRequest(`${at}: ${problem}`);
  }
  if (key === "path" && (v.startsWith("/") || v.split("/").includes(".."))) throw new BadRequest(`${at}: ${PATH_PROBLEM}`);
  const problem = sourceProblem("x", key === "commit" ? { ...pinned, commit: v } : key === "path" ? { ...followed, path: v } : key === "track" ? { ...pinned, track: v } : { ...followed, branch: v });
  if (problem !== null) throw new BadRequest(`${at}: ${problem.replace(/^source 'x': /, "")}`);
  return v;
}

function editedBundleOf(at: string, o: Raw): { name: string; from: string[]; to: string[] } {
  const name = o.name;
  if (typeof name !== "string" || !NAME.test(name) || name.length > MAX_NAME) throw new BadRequest(`${at}: bundle name is not one fleet knows`);
  const from = heldValue(at, "from", o.from);
  if (!Array.isArray(from) || !from.every((s) => typeof s === "string")) throw new BadRequest(`${at}: 'from' must be the list of skills the bundle had`);
  const to = bundleOf(at, { name, skills: o.to }).skills;
  return { name, from: from as string[], to };
}

function editedHostOf(at: string, o: Raw): { host: string; from: string | null; to: string } {
  const { host, from, to } = o;
  if (typeof host !== "string" || !NAME.test(host) || host.length > MAX_NAME) throw new BadRequest(`${at}: host name is not one fleet knows`);
  if (from !== null && (typeof from !== "string" || from.length > 2000)) throw new BadRequest(`${at}: 'from' must be the ssh destination the host had, or null`);
  const problem = typeof to === "string" ? sshProblem(to) : "the ssh destination must be text";
  if (problem !== null) throw new BadRequest(`${at}: ${problem}`);
  return { host, from: from as string | null, to: to as string };
}
