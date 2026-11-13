// What the matrix and the review need that is not drawing: a cell's state, the smallest edit for a click, the
// summary of a host's pick changes and the suggested commit message. Pure: `node --test` runs it.

/**
 * @typedef {{ on: boolean, picked: "defaults" | "host" | "both" | null, excluded: "defaults" | "host" | "both" | null }} Cell
 * @typedef {{ op: "add" | "remove", host: string, kind: "bundles" | "mcp", name: string }} Op
 * @typedef {{ skills: { added: string[], removed: string[] }, servers: { added: string[], removed: string[] } }} PickChange
 */

/**
 * @typedef {"defaults" | "added" | "excluded" | "off"} CellState
 * Where a cell comes from: the defaults give it, the host adds it, the host (or the defaults) excludes it, or it is off.
 */

/** @param {Cell | undefined} cell @returns {CellState} */
export function cellState(cell) {
  if (!cell) return "off";
  if (cell.excluded !== null) return "excluded";
  if (!cell.on) return "off";
  return cell.picked === "host" ? "added" : "defaults";
}

/** The mark and the word a cell shows. @type {Record<CellState, [string, string]>} */
export const WORDS = { defaults: ["✓", "default"], added: ["+", "added"], excluded: ["✕", "excluded"], off: ["·", "off"] };

const same = (/** @type {Op} */ a, /** @type {Op} */ b) => a.host === b.host && a.kind === b.kind && a.name === b.name;

/**
 * What a click on a cell does to the held edits. A cell with an edit held has it taken back; otherwise the smallest edit
 * is held: take away what the host gets, give what it does not (the engine writes `exclude` for an item the defaults give).
 * @param {Op[]} ops
 * @param {string} host
 * @param {"bundles" | "mcp"} kind
 * @param {string} name
 * @param {Cell | undefined} base the cell as it is on disk, not as it would be after the held edits
 * @returns {Op[]}
 */
export function clickCell(ops, host, kind, name, base) {
  const target = { host, kind, name };
  if (ops.some((o) => same(o, /** @type {Op} */ (target)))) return ops.filter((o) => !same(o, /** @type {Op} */ (target)));
  return [...ops, { op: base?.on ? "remove" : "add", ...target }];
}

/** @param {string[]} names @param {string} one @param {string} many */
const noun = (names, one, many) => (names.length === 1 ? one : many);

/**
 * A host's pick changes in a line, such as `+ skills notes, deploy; − server docs`, or null when nothing changes.
 * @param {PickChange} c
 * @returns {string | null}
 */
export function summaryLine(c) {
  const parts = [
    c.skills.added.length > 0 ? `+ ${noun(c.skills.added, "skill", "skills")} ${c.skills.added.join(", ")}` : null,
    c.servers.added.length > 0 ? `+ ${noun(c.servers.added, "server", "servers")} ${c.servers.added.join(", ")}` : null,
    c.skills.removed.length > 0 ? `− ${noun(c.skills.removed, "skill", "skills")} ${c.skills.removed.join(", ")}` : null,
    c.servers.removed.length > 0 ? `− ${noun(c.servers.removed, "server", "servers")} ${c.servers.removed.join(", ")}` : null,
  ].filter((p) => p !== null);
  return parts.length === 0 ? null : parts.join("; ");
}

/** An edit in words, for the list of edits that no longer apply. @param {Op} op */
export const opLabel = (op) => `${op.op === "add" ? "give" : "take"} ${op.kind === "bundles" ? "bundle" : "server"} ${op.name} ${op.op === "add" ? "to" : "from"} ${op.host}`;

const list = (/** @type {string[]} */ names) => (names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/**
 * A commit message from the edits: `Give box extra and tracker; take docs from server`. A long one falls back to a count.
 * @param {Op[]} ops
 */
export function suggestMessage(ops) {
  if (ops.length === 0) return "";
  /** @type {string[]} */
  const parts = [];
  const hosts = [...new Set(ops.map((o) => o.host))];
  for (const host of hosts) {
    const mine = ops.filter((o) => o.host === host);
    const gives = mine.filter((o) => o.op === "add").map((o) => o.name);
    const takes = mine.filter((o) => o.op === "remove").map((o) => o.name);
    if (gives.length > 0) parts.push(`give ${host} ${list(gives)}`);
    if (takes.length > 0) parts.push(`take ${list(takes)} from ${host}`);
  }
  const text = parts.join("; ");
  const message = text.charAt(0).toUpperCase() + text.slice(1);
  return message.length <= 72 ? message : `Change what ${hosts.length} host${hosts.length === 1 ? "" : "s"} get${hosts.length === 1 ? "s" : ""}`;
}

/**
 * What stops the page from writing and pushing now, as sentences. Empty when nothing does.
 * @param {{ outside: string[], dropped: unknown[], checks: { host: string, loads: boolean }[], running: boolean }} s
 * @returns {string[]}
 */
export function blockers(s) {
  const failing = s.checks.filter((c) => !c.loads).map((c) => c.host);
  return [
    ...(s.running ? ["a push is running"] : []),
    ...(s.outside.length > 0 ? ["the config repo has changes the page did not make: commit or discard them outside the page first"] : []),
    ...(s.dropped.length > 0 ? ["some edits no longer apply: forget them first"] : []),
    ...(failing.length > 0 ? [`the config does not load for ${failing.join(", ")}`] : []),
  ];
}
