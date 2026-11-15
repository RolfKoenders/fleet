// The search field of the Matrix and the Catalog, without the drawing: what the address keeps, which rows a filter shows
// and which edits to push it hides. Pure: `node --test` runs it.

/** @typedef {import("./matrix.js").Op} Op */
/** @typedef {{ kind: "bundles" | "mcp" | "source", name: string }} RowId */

/** The filter kept in a location hash (`#/matrix?q=git`), as typed, or "". @param {string} hash */
export function queryOf(hash) {
  const at = hash.indexOf("?");
  return at < 0 ? "" : (new URLSearchParams(hash.slice(at + 1)).get("q") ?? "");
}

/**
 * The hash with its filter set to `q` (and none for an empty or blank one), the screen part kept as it is.
 * @param {string} hash @param {string} q
 */
export function hashWithQuery(hash, q) {
  const at = hash.indexOf("?");
  const route = at < 0 ? hash : hash.slice(0, at);
  return q.trim() === "" ? route : `${route}?${new URLSearchParams({ q })}`;
}

/** What a filter looks for: trimmed and lower-cased, "" for none. @param {string} q */
export const needle = (q) => q.trim().toLowerCase();

/** Whether `name` holds the filter, without regard to case. A blank filter holds everything. @param {string} name @param {string} q */
export const nameMatches = (name, q) => name.toLowerCase().includes(needle(q));

/** The skills of a bundle (or source) that hold the filter. @param {string[]} skills @param {string} q */
export const skillHits = (skills, q) => (needle(q) === "" ? [] : skills.filter((s) => nameMatches(s, q)));

/**
 * The rows a filter shows: those whose name holds it, or one of whose skills does.
 * @template {{ name: string }} R
 * @param {R[]} rows
 * @param {string} q
 * @param {(row: R) => string[]} [skillsOf] a row's skills, none by default
 * @returns {R[]}
 */
export const filterRows = (rows, q, skillsOf = () => []) => rows.filter((r) => nameMatches(r.name, q) || skillHits(skillsOf(r), q).length > 0);

/** The row an edit to push is about, or null for one that is about no row (a secret). @param {Op} op @returns {RowId | null} */
export function rowOfOp(op) {
  if (op.op === "add" || op.op === "remove") return { kind: op.kind, name: op.name };
  if (op.op === "addServer") return { kind: "mcp", name: op.name };
  if (op.op === "addSource") return { kind: "source", name: op.name };
  if (op.op === "addBundle") return { kind: "bundles", name: op.name };
  return null;
}

/**
 * The names of the hidden rows that have an edit on To push, in the order the rows are given.
 * @param {RowId[]} hidden
 * @param {Op[]} ops
 * @returns {string[]}
 */
export function hiddenWithChanges(hidden, ops) {
  const touched = new Set(ops.flatMap((o) => rowOfOp(o) ?? []).map((r) => `${r.kind}:${r.name}`));
  return hidden.filter((r) => touched.has(`${r.kind}:${r.name}`)).map((r) => r.name);
}

/**
 * Whether a key press goes to the search field: a bare `/`, not one typed in another field or while a dialog is open.
 * @param {{ key: string, ctrlKey: boolean, metaKey: boolean, altKey: boolean, defaultPrevented: boolean }} e @param {boolean} inField @param {boolean} dialogOpen
 */
export const slashFocuses = (e, inField, dialogOpen) => e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.defaultPrevented && !inField && !dialogOpen;

/** What Esc does in the search field: clears a filter, and leaves the field when there is none. @param {string} value @returns {"clear" | "blur"} */
export const escapeAction = (value) => (value !== "" ? "clear" : "blur");
