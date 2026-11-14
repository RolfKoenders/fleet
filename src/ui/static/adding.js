// What the Add dialogs need that is not drawing: which file each one writes, the words on its buttons, what the pane
// beside the form says (what is missing, or the YAML as a diff against the file), and when the dialog may be closed.
// Pure: `node --test` runs it.

import { lineDiff, splitLines } from "./diff.js";
import { blankHost, hostDraft } from "./hosts.js";

/** @typedef {"server" | "source" | "bundle" | "host"} AddKind */
/** @typedef {import("./diff.js").DiffLine} DiffLine */
/**
 * What the pane shows: the file it is about, a tag, and one of: what is missing, a wait, a refusal, or the diff.
 * @typedef {{ path: string, tag: string, tone: "" | "ok" | "bad", state: "missing" | "reading" | "refused" | "diff", problems: string[], message: string | null, lines: DiffLine[], broken: string | null }} Pane
 */

/** What each dialog is called, the file it writes, and where in it the addition goes. */
export const ADD = {
  server: { title: "Add an MCP server", menu: "MCP server", file: "catalog/mcp.yaml", where: "servers" },
  source: { title: "Add a skill source", menu: "Skill source", file: "catalog/skills.yaml", where: "sources" },
  bundle: { title: "Add a skill bundle", menu: "Skill bundle", file: "catalog/skills.yaml", where: "bundles" },
  host: { title: "Add a host", menu: "Host", file: "hosts/<name>.yaml", where: "" },
};

/** The kinds the Catalog's Add menu offers, in order. @type {AddKind[]} */
export const CATALOG_KINDS = ["server", "source", "bundle"];

/** The confirm button: what happens. The three catalog additions go to To push; a host is set up at once, over ssh. */
export const confirmLabel = (/** @type {AddKind} */ kind) => (kind === "host" ? "Add and set it up" : "Add to push");

/** The file a dialog writes; a host's has the name typed so far. @param {AddKind} kind @param {string} [name] */
export const fileOf = (kind, name = "") => (kind === "host" ? `hosts/${name.trim() || "<name>"}.yaml` : ADD[kind].file);

/**
 * The part of a diff around its changes, for a file too long to show whole.
 * @param {DiffLine[]} d @param {number} context
 * @returns {DiffLine[]}
 */
export function nearChanges(d, context) {
  /** @type {DiffLine[]} */
  const out = [];
  let gap = false;
  d.forEach(([op, line], i) => {
    const near = d.slice(Math.max(0, i - context), i + context + 1).some(([o]) => o !== " ");
    if (near) {
      if (gap) out.push([" ", "..."]);
      out.push([op, line]);
      gap = false;
    } else gap = true;
  });
  return out;
}

/**
 * What the host dialog still needs, as lines, in the form's order: a field left empty and a field that is wrong. The form
 * itself only says something about a field once it has been typed in.
 * @param {import("./hosts.js").HostForm} form @param {string[]} existing
 * @returns {string[]}
 */
export function hostMissing(form, existing) {
  const d = hostDraft(form, existing);
  /** @type {string[]} */
  const out = [];
  if (form.name.trim() === "") out.push("give it a name");
  else if (d.name !== null) out.push(d.name);
  if (form.ssh.trim() === "") out.push("say how to reach it over ssh, for example user@host: fleet init needs it");
  else if (d.ssh !== null) out.push(d.ssh);
  if (form.from !== "" && !existing.includes(form.from)) out.push(`there is no host '${form.from}' to copy from`);
  return out;
}

/**
 * The host dialog's draft in the shape of the others: the request it would make, or what is missing.
 * @param {import("./hosts.js").HostForm} form @param {string[]} existing
 * @returns {{ op: import("./hosts.js").HostBody | null, problems: string[], warnings: string[] }}
 */
export function hostAsDraft(form, existing) {
  const body = hostDraft(form, existing).body;
  return { op: body, problems: body === null ? hostMissing(form, existing) : [], warnings: [] };
}

/**
 * What the pane beside a form shows. `d.op` is what the form would hold; `live` is the server's answer for exactly that
 * (`key` is the JSON of the edit it answered), `held` is what the file would be with the other edits already to push, which
 * is what the diff is against: only this addition shows. A host has no edits to push, so its file is new.
 * @param {AddKind} kind
 * @param {{ op: unknown, problems: string[] }} d
 * @param {{ key: string, doc: any, error: string | null } | null} live
 * @param {string | null} held the file with the edits already to push, or null when none touches it
 * @param {string} [name] the host name typed so far
 * @returns {Pane}
 */
export function paneView(kind, d, live, held, name = "") {
  const none = { problems: /** @type {string[]} */ ([]), message: /** @type {string | null} */ (null), lines: /** @type {DiffLine[]} */ ([]), broken: /** @type {string | null} */ (null) };
  if (d.op === null) return { ...none, path: fileOf(kind, name), tag: "not ready", tone: "", state: "missing", problems: d.problems };
  const key = JSON.stringify(d.op);
  const path = kind === "host" ? fileOf(kind, /** @type {{ name: string }} */ (d.op).name) : fileOf(kind);
  if (live === null || live.key !== key) return { ...none, path, tag: "reading", tone: "", state: "reading" };
  if (live.error !== null) return { ...none, path, tag: "refused", tone: "bad", state: "refused", message: live.error };
  const doc = live.doc;
  if (kind === "host") return { ...none, path, tag: "+ new file", tone: "ok", state: "diff", lines: lineDiff([], splitLines(doc.after)) };
  const dropped = doc.dropped.find((/** @type {any} */ x) => JSON.stringify(x.op) === key);
  if (dropped) return { ...none, path, tag: "does not apply", tone: "bad", state: "refused", message: dropped.reason };
  const file = doc.files.find((/** @type {any} */ x) => x.path === path);
  const broken = doc.checks.filter((/** @type {any} */ c) => !c.loads);
  const lines = nearChanges(lineDiff(splitLines(held ?? file?.before ?? ""), splitLines(file?.after ?? "")), 2);
  return {
    ...none, path, tag: `+ added at the end of ${ADD[kind].where}`, tone: "ok", state: "diff", lines,
    broken: broken.length > 0 ? `With this, the config does not load for ${broken.map((/** @type {any} */ c) => c.host).join(", ")}: ${broken[0].problems[0] ?? ""}` : null,
  };
}

/**
 * Whether Esc and Cancel may close the dialog. Not while a host is being set up: the run goes on without the page, and its
 * output is the only way to see how it ends.
 * @param {AddKind} kind @param {{ running: boolean }} init
 */
export const closable = (kind, init) => !(kind === "host" && init.running);

/**
 * What a dialog holds while it is open: the form of its kind, the server's answer for the file (`live`), the check that
 * asks first (`confirm`, `check`) and the clone of a source. Everything is dropped with the dialog.
 * @typedef {{
 *   kind: AddKind, server: import("./catalog.js").ServerForm, source: import("./catalog.js").SourceForm, bundle: import("./catalog.js").BundleForm,
 *   host: import("./hosts.js").HostForm, live: { key: string, doc: any, error: string | null } | null, confirm: boolean, check: any,
 *   clone: { state: string, doc: any, error: string | null },
 * }} AddState
 */

/** @param {AddKind} kind @returns {AddState} */
export const freshAdd = (kind) => ({
  kind,
  server: { name: "", kind: "command", command: "", url: "", rows: [{ key: "", mode: "secret", value: "" }], claude: true, opencode: true },
  source: { name: "", repo: "", path: ".", branch: "", mode: "pin", review: true },
  bundle: { name: "", picked: [], extra: "" },
  host: blankHost(),
  live: null,
  confirm: false,
  check: null,
  clone: { state: "idle", doc: null, error: null },
});
