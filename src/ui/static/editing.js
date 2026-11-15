// What the Edit dialogs need that is not drawing: the form each kind starts from (an item as the file has it), the edit a form holds, how an
// edit joins the held ones (an unpushed addition is changed in place), and what the pane beside the form says. Pure: `node --test` runs it.
// An Edit dialog is the Add dialog of its kind, prefilled; `catalog.js` and `hosts.js` hold the rules both share.

import { lineDiff, splitLines } from "./diff.js";
import { freshAdd, nearChanges } from "./adding.js";
import { applyChanges } from "./catalog.js";
import { sshProblem } from "./hosts.js";
import { itemLines } from "./yamlview.js";

/** @typedef {import("./adding.js").AddKind} Kind */
/** @typedef {import("./matrix.js").Op} Op */
/** @typedef {import("./adding.js").Pane} Pane */

/** What each Edit dialog is called, and the button that keeps the edit. */
export const EDIT = {
  server: "Edit MCP server",
  source: "Edit skill source",
  bundle: "Edit skill bundle",
  host: "Edit host",
};

/** The confirm button: the edit goes to To push, or, when the form is back to what the file says, comes off it. */
export const EDIT_LABEL = "Save to push";
export const EDIT_DROP_LABEL = "Take off To push";

/** What an edit dialog holds besides the form: where it has got to with reading the item, and what it found. @typedef {{
 *   name: string, state: "loading" | "ready" | "readonly" | "error", error: string | null, reason: string | null, path: string, text: string, base: any,
 * }} EditState */

/**
 * The state of an Edit dialog of `kind` before the item has been read.
 * @param {Kind} kind @param {string} name
 */
export const freshEdit = (kind, name) => ({ ...freshAdd(kind), edit: /** @type {EditState} */ ({ name, state: "loading", error: null, reason: null, path: "", text: "", base: null }) });

const ADDS = { server: "addServer", source: "addSource", bundle: "addBundle" };
const EDITS = { server: "editServer", source: "editSource", bundle: "editBundle", host: "editHost" };

/**
 * The edit or unpushed addition that is on To push for an item, or undefined.
 * @param {Op[]} ops @param {Kind} kind @param {string} name
 * @returns {Op | undefined}
 */
export function ownOp(ops, kind, name) {
  return ops.find((o) => (o.op === EDITS[kind] && (o.op === "editHost" ? o.host === name : "name" in o && o.name === name)) || (kind !== "host" && o.op === ADDS[kind] && "name" in o && o.name === name));
}

/** An addition that has not been pushed yet. @param {Op | undefined} op */
export const isAddition = (op) => op !== undefined && (op.op === "addServer" || op.op === "addSource" || op.op === "addBundle");

/**
 * A command as the text of the form: the inverse of `splitCommand`, so that what is written in the file reads back the same.
 * @param {string[]} list
 */
export const joinCommand = (list) =>
  list
    .map((a) => (a === "" ? '""' : /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : !a.includes("'") ? `'${a}'` : `"${a.replace(/["\\]/g, "\\$&")}"`))
    .join(" ");

const SECRET_REF = /^secret:([A-Z][A-Z0-9_]*)$/;

/** The rows of a map of variables or headers: `secret:NAME` is a secret row with the name, anything else a plain value. @param {Record<string, string> | undefined} map */
const rowsOf = (map) =>
  Object.entries(map ?? {}).map(([key, value]) => {
    const m = SECRET_REF.exec(value);
    return m === null ? { key, mode: /** @type {const} */ ("plain"), value } : { key, mode: /** @type {const} */ ("secret"), value: /** @type {string} */ (m[1]) };
  });

/**
 * The server form for an entry as the file has it.
 * @param {string} name @param {Record<string, any>} e
 * @returns {import("./catalog.js").ServerForm}
 */
export function serverFormOf(name, e) {
  const net = e.transport !== undefined || e.url !== undefined;
  return {
    name,
    kind: net ? (e.transport === "sse" ? "sse" : "http") : "command",
    command: Array.isArray(e.command) ? joinCommand(e.command) : "",
    url: typeof e.url === "string" ? e.url : "",
    rows: rowsOf(net ? e.headers : e.env),
    claude: e.only === undefined || e.only.includes("claude"),
    opencode: e.only === undefined || e.only.includes("opencode"),
  };
}

/**
 * The source form for an entry as the file has it. A followed source has no review in the file: the form offers it on, as Add does, for when
 * it is pinned.
 * @param {string} name @param {Record<string, any>} e
 * @returns {import("./catalog.js").SourceForm}
 */
export function sourceFormOf(name, e) {
  const pinned = e.commit !== undefined;
  return { name, repo: e.repo, path: e.path ?? ".", branch: (pinned ? e.track : e.branch) ?? "", mode: pinned ? "pin" : "follow", review: pinned ? e.review === true : true };
}

/**
 * The bundle form for a bundle's skills: those the page knows of are ticked, any other is in the free box.
 * @param {string} name @param {string[]} skills @param {{ name: string }[]} choices
 * @returns {import("./catalog.js").BundleForm}
 */
export const bundleFormOf = (name, skills, choices) => ({ name, picked: skills.filter((s) => choices.some((c) => c.name === s)), extra: skills.filter((s) => !choices.some((c) => c.name === s)).join(", ") });

/** @param {string} name @param {{ ssh?: string }} e @returns {import("./hosts.js").HostForm} */
export const hostFormOf = (name, e) => ({ name, ssh: e.ssh ?? "", from: "" });

/**
 * The host edit a form holds: the ssh destination, checked as Add checks it. Nothing else of a host is edited here.
 * @param {import("./hosts.js").HostForm} form @param {{ ssh?: string }} base
 * @returns {import("./catalog.js").Draft}
 */
export function hostEditDraft(form, base) {
  const ssh = form.ssh.trim();
  const bad = ssh === "" ? "say how to reach it over ssh, for example user@host: fleet init needs it" : sshProblem(ssh);
  if (bad !== null) return { op: null, problems: [bad], warnings: [] };
  const same = ssh === (base.ssh ?? "");
  return { op: same ? null : { op: "editHost", host: form.name, from: base.ssh ?? null, to: ssh }, problems: [], warnings: [], unchanged: same };
}

/**
 * What a dialog starts from, once the server has answered for the item (`POST /api/entry`, asked with the held edits but this item's own).
 * An unpushed addition is changed in place, so it starts from what was added; otherwise from the file. A held edit of the item is on top of that.
 * @param {Kind} kind
 * @param {string} name
 * @param {any} doc the server's answer
 * @param {Op | undefined} own the item's held addition or edit
 * @returns {{ state: EditState["state"], error: string | null, reason: string | null, base: any, value: any }}
 */
export function startOf(kind, name, doc, own) {
  const none = { state: /** @type {EditState["state"]} */ ("error"), error: null, reason: null, base: null, value: null };
  if (isAddition(own)) {
    const base = own?.op === "addBundle" ? own.skills : own?.op === "addServer" || own?.op === "addSource" ? own.entry : null;
    return { ...none, state: "ready", base, value: base };
  }
  if (!doc.found) return { ...none, error: `${name} is not in ${doc.path} any more: close this and look at the page again.` };
  if (!doc.editable) return { ...none, state: "readonly", reason: doc.reason };
  const base = doc.value;
  if (own === undefined) return { ...none, state: "ready", base, value: base };
  const value = own.op === "editBundle" ? own.to : own.op === "editHost" ? { ssh: own.to } : "changes" in own ? applyChanges(base, own.changes) : base;
  return { ...none, state: "ready", base, value };
}

/**
 * The held edits with this form's edit in them, and the op that went in. An unpushed addition is changed in place (its entry or skills become
 * what the form says); otherwise the item's own edit is replaced, or added, or taken away when the form holds what the file holds.
 * @param {Op[]} ops
 * @param {Op | undefined} own the item's held addition or edit
 * @param {Op | null} draft the form's edit against what is in the file (or in the held addition), null when there is no change
 * @param {Record<string, any> | string[] | null} base what the draft is an edit of
 * @returns {{ ops: Op[], sent: Op | null }}
 */
export function withEdit(ops, own, draft, base) {
  /** @type {Op | null} */
  let sent = draft;
  if (isAddition(own) && own !== undefined) {
    if (draft === null) return { ops, sent: own };
    if (own.op === "addBundle" && draft.op === "editBundle") sent = { op: "addBundle", name: own.name, skills: draft.to };
    else if ((own.op === "addServer" || own.op === "addSource") && "changes" in draft) sent = { op: own.op, name: own.name, entry: applyChanges(/** @type {Record<string, any>} */ (base), draft.changes) };
    return { ops: ops.map((o) => (o === own ? /** @type {Op} */ (sent) : o)), sent };
  }
  const rest = ops.filter((o) => o !== own);
  if (draft === null) return { ops: rest, sent: null };
  // An edit stays where the earlier one was, so the order of To push is the order things were done in.
  const at = own === undefined ? -1 : ops.indexOf(own);
  return { ops: at < 0 ? [...rest, draft] : [...ops.slice(0, at), draft, ...ops.slice(at + 1)], sent };
}

/**
 * The server entry a draft would leave in the file, as an addition (the shape the check and its confirmation take), or null.
 * @param {import("./catalog.js").Draft} d @param {Record<string, any> | null} base @param {string} name
 * @returns {Op | null}
 */
export function serverAsAdded(d, base, name) {
  if (d.op === null) return d.unchanged && base !== null ? { op: "addServer", name, entry: base } : null;
  if (d.op.op === "addServer") return d.op;
  if (d.op.op === "editServer" && base !== null) return { op: "addServer", name, entry: applyChanges(base, d.op.changes) };
  return null;
}

/**
 * What the pane beside an Edit form shows: the changed file as a diff against the file with the other edits to push, or why there is none yet.
 * `sent` is the op the server was asked about (`withEdit`).
 * @param {{ op: Op | null, problems: string[], unchanged?: boolean }} d
 * @param {{ key: string, doc: any, error: string | null } | null} live
 * @param {string} path the file the item is in
 * @param {string} baseText that file with the edits to push but this item's own
 * @param {Op | null} sent
 * @param {boolean} [dropping] the form holds what the file holds, and an edit of this item is on To push: saving takes it off
 * @returns {Pane}
 */
export function editPaneView(d, live, path, baseText, sent, dropping = false) {
  const none = { problems: /** @type {string[]} */ ([]), message: /** @type {string | null} */ (null), lines: /** @type {import("./diff.js").DiffLine[]} */ ([]), broken: /** @type {string | null} */ (null) };
  if (d.op === null) {
    return d.unchanged
      ? { ...none, path, tag: "no change", tone: "", state: "missing", problems: [dropping ? "this is what the file says now: saving takes the edit off To push" : "change something: this is what the file says now"] } : { ...none, path, tag: "not ready", tone: "", state: "missing", problems: d.problems };
  }
  const key = JSON.stringify(sent);
  if (live === null || live.key !== JSON.stringify(d.op)) return { ...none, path, tag: "reading", tone: "", state: "reading" };
  if (live.error !== null) return { ...none, path, tag: "refused", tone: "bad", state: "refused", message: live.error };
  const doc = live.doc;
  const dropped = doc.dropped.find((/** @type {any} */ x) => JSON.stringify(x.op) === key);
  if (dropped) return { ...none, path, tag: "does not apply", tone: "bad", state: "refused", message: dropped.reason };
  const file = doc.files.find((/** @type {any} */ x) => x.path === path);
  const broken = doc.checks.filter((/** @type {any} */ c) => !c.loads);
  const lines = nearChanges(lineDiff(splitLines(baseText), splitLines(file?.after ?? baseText)), 2);
  return {
    ...none, path, tag: "changed in place", tone: "ok", state: "diff", lines,
    broken: broken.length > 0 ? `With this, the config does not load for ${broken.map((/** @type {any} */ c) => c.host).join(", ")}: ${broken[0].problems[0] ?? ""}` : null,
  };
}

/**
 * The lines to show read-only for an item an edit cannot change: the item's own lines in its file, or the whole host file.
 * @param {string} text @param {Kind} kind @param {string} name
 * @returns {string[]}
 */
export const readOnlyLines = (text, kind, name) => itemLines(text, kind, name) ?? splitLines(text);
