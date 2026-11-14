// How an item is written in the config repo: its own lines in its file, and, when the item has an edit to push, the
// diff of those lines. Pure: `node --test` runs it. The files are block YAML, one entry per key under `servers:`,
// `sources:` or `bundles:`, so the lines are found by indentation, which keeps comments and layout exactly as written.

import { changed, counts, lineDiff, splitLines } from "./diff.js";
import { nearChanges } from "./adding.js";

/** @typedef {import("./adding.js").AddKind} Kind */
/** @typedef {import("./diff.js").DiffLine} DiffLine */

const SECTION = { server: "servers", source: "sources", bundle: "bundles" };

/** The repo file an item is written in. @param {Kind} kind @param {string} name */
export const yamlPath = (kind, name) => (kind === "host" ? `hosts/${name}.yaml` : kind === "server" ? "catalog/mcp.yaml" : "catalog/skills.yaml");

const indentOf = (/** @type {string} */ line) => line.length - line.trimStart().length;
const blank = (/** @type {string} */ line) => line.trim() === "";
const comment = (/** @type {string} */ line) => line.trimStart().startsWith("#");

/** The key a block line starts, unquoted, or null. @param {string} line */
function keyOf(line) {
  const m = /^\s*("[^"]*"|'[^']*'|[^\s#:"'][^#:]*?)\s*:(\s|$)/.exec(line);
  return m === null ? null : /** @type {string} */ (m[1]).replace(/^(["'])(.*)\1$/, "$2");
}

/**
 * The lines of one entry under a top-level section: the comments right above it, its key line and what is nested under
 * it. Comments that follow it at the entry's own indent belong to the next entry. Null when it is not there.
 * @param {string[]} lines @param {string} section @param {string} name
 * @returns {string[] | null}
 */
function entryLines(lines, section, name) {
  const top = lines.findIndex((l) => indentOf(l) === 0 && !comment(l) && keyOf(l) === section);
  if (top < 0) return null;
  let end = lines.findIndex((l, i) => i > top && !blank(l) && !comment(l) && indentOf(l) === 0);
  if (end < 0) end = lines.length;
  const inside = lines.slice(top + 1, end);
  const first = inside.find((l) => !blank(l) && !comment(l));
  if (first === undefined) return null;
  const column = indentOf(first);
  const at = inside.findIndex((l) => !blank(l) && !comment(l) && indentOf(l) === column && keyOf(l) === name);
  if (at < 0) return null;
  let from = at;
  while (from > 0 && comment(/** @type {string} */ (inside[from - 1])) && indentOf(/** @type {string} */ (inside[from - 1])) === column) from--;
  let to = inside.findIndex((l, i) => i > at && !blank(l) && !comment(l) && indentOf(l) <= column);
  if (to < 0) to = inside.length;
  while (to > at + 1 && (blank(/** @type {string} */ (inside[to - 1])) || (comment(/** @type {string} */ (inside[to - 1])) && indentOf(/** @type {string} */ (inside[to - 1])) <= column))) to--;
  return inside.slice(from, to);
}

/**
 * The lines an item has in its file's text: the whole file for a host, null when the item is not in it.
 * @param {string} text @param {Kind} kind @param {string} name
 * @returns {string[] | null}
 */
export function itemLines(text, kind, name) {
  const lines = splitLines(text);
  if (kind === "host") return lines.length > 0 ? lines : null;
  return entryLines(lines, SECTION[kind], name);
}

/**
 * What the YAML toggle of one item shows. `before` is the file on disk, `after` the file with the edits to push (the same
 * text when none touches it). `plain`: the lines as the file has them. `added`, `changed`, `removed`: the diff of the
 * item's lines against the repo, to push. `absent`: the item is in neither text.
 * @typedef {{ path: string, state: "plain" | "added" | "changed" | "removed" | "absent", lines: DiffLine[], added: number, removed: number }} ItemYaml
 * @param {Kind} kind @param {string} name @param {string} before @param {string} after
 * @returns {ItemYaml}
 */
export function itemYaml(kind, name, before, after) {
  const path = yamlPath(kind, name);
  const was = itemLines(before, kind, name);
  const now = itemLines(after, kind, name);
  if (was === null && now === null) return { path, state: "absent", lines: [], added: 0, removed: 0 };
  const d = lineDiff(was ?? [], now ?? []);
  const { added, removed } = counts(d);
  if (!changed(d)) return { path, state: "plain", lines: d, added, removed };
  const state = was === null ? "added" : now === null ? "removed" : "changed";
  // A host file is the whole file: show the changes with a little around them.
  return { path, state, lines: kind === "host" ? nearChanges(d, 3) : d, added, removed };
}

/** The words on the panel's tag. @param {ItemYaml} y */
export function yamlTag(y) {
  if (y.state === "plain") return "as in the repo";
  if (y.state === "absent") return "not in the file";
  return `to push: +${y.added} -${y.removed}`;
}
