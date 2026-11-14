// What the matrix and the review need that is not drawing: a cell's state, the smallest edit for a click, the
// summary of a host's pick changes and the suggested commit message. Pure: `node --test` runs it.

import { heldNames } from "./secrets.js";

/**
 * @typedef {{ on: boolean, picked: "defaults" | "host" | "both" | null, excluded: "defaults" | "host" | "both" | null }} Cell
 * @typedef {{ op: "add" | "remove", host: string, kind: "bundles" | "mcp", name: string }} PickOp
 * @typedef {{ op: "addServer" | "addSource", name: string, entry: Record<string, any> }} EntryOp
 * @typedef {{ op: "addBundle", name: string, skills: string[] }} BundleOp
 * @typedef {{ op: "setSecret", file: string, names: string[], base: string, content: string }} SecretOp
 * @typedef {PickOp | EntryOp | BundleOp | SecretOp} Op
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

/**
 * What a click on a cell will do, shown on hover: a cell with an edit to push takes it back, an item the host has is taken away,
 * and one it does not have is given. @param {CellState} state @param {boolean} staged
 */
export const cellAction = (state, staged) => (staged ? "undo" : state === "defaults" || state === "added" ? "take away" : "give");

/** @param {Op} o @returns {o is PickOp} */
export const isPick = (o) => o.op === "add" || o.op === "remove";

const same = (/** @type {Op} */ a, /** @type {PickOp} */ b) => isPick(a) && a.host === b.host && a.kind === b.kind && a.name === b.name;

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
  /** @type {PickOp} */
  const target = { op: base?.on ? "remove" : "add", host, kind, name };
  if (ops.some((o) => same(o, target))) return ops.filter((o) => !same(o, target));
  return [...ops, target];
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
export function opLabel(op) {
  if (isPick(op)) return `${op.op === "add" ? "give" : "take"} ${op.kind === "bundles" ? "bundle" : "server"} ${op.name} ${op.op === "add" ? "to" : "from"} ${op.host}`;
  if (op.op === "addServer") return `add server ${op.name} to the catalog`;
  if (op.op === "addSource") return `add skill source ${op.name} to the catalog`;
  if (op.op === "setSecret") return `set ${op.names.join(", ")} in ${op.file}`;
  return `add bundle ${op.name} to the catalog`;
}

const list = (/** @type {string[]} */ names) => (names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/**
 * A commit message from the edits: `Add server linear; give box linear`, `Give box extra and tracker; take docs from server`.
 * A long one falls back to a count.
 * @param {Op[]} ops
 */
export function suggestMessage(ops) {
  if (ops.length === 0) return "";
  /** @type {string[]} */
  const parts = [];
  for (const [op, word] of /** @type {const} */ ([["addServer", "server"], ["addSource", "skill source"], ["addBundle", "bundle"]])) {
    const names = ops.flatMap((o) => (o.op === op && "name" in o ? [o.name] : []));
    if (names.length > 0) parts.push(`add ${word}${names.length === 1 ? "" : "s"} ${list(names)}`);
  }
  const secrets = ops.filter((o) => o.op === "setSecret");
  for (const { name, files } of heldNames(ops)) parts.push(`set ${name} for ${list(files.map((f) => (f === "shared" ? "every host" : f)))}`);
  const picks = ops.filter(isPick);
  const hosts = [...new Set(picks.map((o) => o.host))];
  for (const host of hosts) {
    const mine = picks.filter((o) => o.host === host);
    const gives = mine.filter((o) => o.op === "add").map((o) => o.name);
    const takes = mine.filter((o) => o.op === "remove").map((o) => o.name);
    if (gives.length > 0) parts.push(`give ${host} ${list(gives)}`);
    if (takes.length > 0) parts.push(`take ${list(takes)} from ${host}`);
  }
  const text = parts.join("; ");
  const message = text.charAt(0).toUpperCase() + text.slice(1);
  if (message.length <= 72) return message;
  const added = ops.length - picks.length - secrets.length;
  const catalog = added === 0 ? "" : `Add ${added} catalog entr${added === 1 ? "y" : "ies"}`;
  const changed = hosts.length === 0 ? "" : `change what ${hosts.length} host${hosts.length === 1 ? "" : "s"} get${hosts.length === 1 ? "s" : ""}`;
  return catalog === "" ? `Change${changed.slice("change".length)}` : changed === "" ? catalog : `${catalog}; ${changed}`;
}

/** What stops a push while an edit no longer applies. The Review screen lists those edits itself, so it leaves this out of its stop notice. */
export const DROPPED_BLOCKER = "some edits no longer apply: forget them first";

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
    ...(s.dropped.length > 0 ? [DROPPED_BLOCKER] : []),
    ...(failing.length > 0 ? [`the config does not load for ${failing.join(", ")}`] : []),
  ];
}
