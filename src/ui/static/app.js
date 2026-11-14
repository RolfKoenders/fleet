// The page: the shell, routing between screens, and drawing the state from state.js.
import { ApiError, createClient, openStream } from "./api.js";
import { changed, counts, lineDiff, splitLines, tokenize } from "./diff.js";
import { fill, h } from "./dom.js";
import { ADD, CATALOG_KINDS, closable, confirmLabel, fileOf, freshAdd, hostAsDraft, paneView } from "./adding.js";
import { bundleDraft, checkLines, cloneKey, confirmText, opWarnings, secretOf, secretsOf, serverDraft, skillChoices, sourceDraft, takeBack } from "./catalog.js";
import { blockers, cellState, clickCell, opLabel, suggestMessage, summaryLine, WORDS } from "./matrix.js";
import { confirmInit, heldProblem, hostDraft, idleInit, initEnd, initLine, SETUP_DOC, startInit } from "./hosts.js";
import { actionOf, afterSet, cellView, dialogTargets, heldNames, missingCount, valueProblem } from "./secrets.js";
import { heldFiles, idlePush, pushEnd, pushEvent, routeOf, statusView, tokenOf } from "./state.js";

/** @typedef {import("./state.js").Held} Held */
/** @typedef {import("./state.js").PushState} PushState */
/** @typedef {import("./matrix.js").Op} Op */

const main = /** @type {HTMLElement} */ (document.getElementById("main"));
const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

const token = tokenOf(location.hash);
// The token lives in memory only: it leaves the address bar, so it is not in the history or a bookmark.
if (token !== null) history.replaceState(null, "", location.pathname + "#/matrix");

$("local").textContent = `${location.host} · only this machine`;

/**
 * `base`: the matrix as the files on disk say. `ops`: the edits held here, replayed by the server on every preview.
 * `preview`: the server's answer for them (files, dropped edits, the matrix after, a check per host).
 * @type {{
 *   status: any, statusError: string | null, matrixError: string | null,
 *   base: any, ops: Op[], preview: any, held: Held, focus: string | null, expanded: Set<string>,
 *   plan: { key: string, doc: any, error: string | null } | null,
 *   message: string, messageEdited: boolean, secrets: any, secretsError: string | null,
 *   push: PushState, pushError: string | null, link: "connecting" | "live" | "reconnecting",
 *   skills: { name: string, source: string, bundle: string | null }[], stagedSkills: Record<string, string[]>,
 *   form: import("./adding.js").AddState | null, menu: boolean, init: import("./hosts.js").InitState, initError: string | null
 * }}
 */
const model = {
  status: null, statusError: null, matrixError: null,
  base: null, ops: [], preview: null, held: {}, focus: null, expanded: new Set(),
  plan: null, message: "", messageEdited: false, secrets: null, secretsError: null,
  push: idlePush(), pushError: null, link: "connecting",
  skills: [], stagedSkills: {}, form: null, menu: false,
  init: idleInit(), initError: null,
};

const client = token === null ? null : createClient(token);

/** @type {Record<string, [string, string]>} */
const SCREENS = {
  matrix: ["Matrix", "What each host gets: every skill bundle and MCP server against every host. Click a cell to give it to a host or take it away. Fleet writes the smallest change: an item the defaults give is taken away with exclude, not by editing the defaults."],
  catalog: ["Catalog", "The MCP servers, skill sources and skill bundles your hosts can pick from. Add one with the Add button: it gives it to no host yet, pick it in the Matrix. An addition is a change to push like any edit, and written when you push."],
  hosts: ["Hosts", "The hosts in this config, and how each is reached. Add a host and fleet sets it up over ssh: it writes its host file, then runs the real fleet init."],
  secrets: ["Secrets", "Names only. fleet ui never reads a value back, never shows one, and never writes one to disk unencrypted: a value you type goes straight to sops. Set a value and the encrypted file is a change to push like any edit, and written when you push."],
};

/** The screen drawn last: drawing the same one again keeps its scroll. */
let drawn = "";

function render() {
  const route = routeOf(location.hash);
  for (const a of document.querySelectorAll("#side a")) a.classList.toggle("on", /** @type {HTMLElement} */ (a).dataset.r === route);

  const n = model.ops.length;
  $("tray").className = "tray " + (n > 0 ? "has" : "none");
  $("trayn").textContent = String(n);
  $("sidecount").textContent = n > 0 ? String(n) : "";
  const missing = missingCount(shownSecrets());
  $("secretcount").textContent = missing > 0 ? `${missing} missing` : "";
  const link = $("link");
  link.textContent = model.link;
  link.className = "tag " + (model.link === "live" ? "ok" : model.link === "reconnecting" ? "warn" : "");
  const s = model.status ? statusView(model.status) : null;
  fill($("repo"), ...(s ? [h("b", {}, s.host), ...(model.status?.repos?.fleet ? [h("span", {}, `${model.status.repos.fleet.branch ?? "detached"}@${String(model.status.repos.fleet.sha).slice(0, 7)}`)] : [])] : []));

  if (client === null) return fill(main, noToken());
  // Typing in the commit message must survive the page being drawn again by a push event or an answer.
  const active = document.activeElement;
  const keep = active instanceof HTMLElement && main.contains(active) && active.id !== "" ? { id: active.id, at: active instanceof HTMLInputElement ? active.selectionStart : null } : null;
  const scroll = route === drawn ? main.scrollTop : 0;
  drawn = route;
  fill(main, screen(route));
  main.scrollTop = scroll;
  if (keep !== null && keep.id !== "") {
    const again = document.getElementById(keep.id);
    if (again instanceof HTMLElement && main.contains(again)) {
      again.focus();
      if (again instanceof HTMLInputElement && keep.at !== null) again.setSelectionRange(keep.at, keep.at);
    }
  }
  renderDialog();
  returnFocus();
}

/** @param {string} route */
function screen(route) {
  if (route === "status") return statusScreen();
  if (route === "review") return reviewScreen();
  if (route === "matrix") return matrixScreen();
  if (route === "catalog") return catalogScreen();
  if (route === "hosts") return hostsScreen();
  return secretsScreen();
}

function noToken() {
  return h(
    "div",
    {},
    h("h1", {}, "fleet ui"),
    h("div", { class: "notice bad" }, "This page cannot do anything without its token."),
    h("p", { class: "sub" }, "Open the URL that ", h("code", {}, "fleet ui"), " printed, including the part after #."),
  );
}

function statusScreen() {
  if (model.statusError !== null) return h("div", {}, h("h1", {}, "Status"), h("div", { class: "notice bad" }, model.statusError));
  if (model.status === null) return h("div", {}, h("h1", {}, "Status"), h("div", { class: "panel empty" }, "Reading this host..."));
  const v = statusView(model.status);
  return h(
    "div",
    {},
    h("h1", {}, v.host),
    h("p", { class: "sub" }, "This host, as ", h("code", {}, "fleet status"), " reads it. Nothing is fetched from the network."),
    ...v.messages.map((m) => h("div", { class: "notice" }, m)),
    h(
      "div",
      { class: "panel" },
      h("dl", { class: "facts" }, ...v.rows.flatMap((r) => [h("dt", {}, r.label), h("dd", { class: r.tone }, r.value)])),
    ),
    v.conflicts.length > 0 ? h("h2", {}, "Conflicts") : null,
    v.conflicts.length > 0 ? h("div", { class: "panel" }, h("pre", { class: "term" }, v.conflicts.join("\n"))) : null,
    h("h2", {}, "Tools"),
    h("div", { class: "panel" }, h("div", { class: "tools" }, ...v.tools.map((t) => h("span", { class: "tag " + (t.version ? "ok" : "") }, `${t.name} ${t.version ?? "not found"}`)))),
  );
}

const mono = (/** @type {string} */ t) => h("span", { class: "m" }, t);

/** The matrix as the page shows it: the server's answer for the held edits when there is one, else the files on disk. */
const shownMatrix = () => model.preview?.matrix ?? model.base;

/** @param {any} doc @param {string} host */
const hostOf = (doc, host) => doc.hosts.find((/** @type {any} */ x) => x.name === host);

function loadingOrError(/** @type {string} */ title, /** @type {string | null} */ error) {
  return h("div", {}, h("h1", {}, title), error !== null ? h("div", { class: "notice bad" }, error) : h("div", { class: "panel empty" }, "Reading the config..."));
}

function matrixScreen() {
  const [title, about] = SCREENS.matrix;
  if (model.base === null || model.matrixError !== null) return loadingOrError(title, model.matrixError);
  const base = model.base;
  const view = shownMatrix();
  const hosts = view.hosts;
  if (hosts.length === 0) return h("div", {}, h("h1", {}, title), h("div", { class: "panel empty" }, "No hosts yet."));
  const focus = model.focus !== null && hostOf(view, model.focus) ? model.focus : hosts[0].name;

  /** @param {"bundles" | "mcp"} kind @param {any} row @param {string} small @param {boolean} [skill] */
  const rowOf = (kind, row, small, skill = false) => {
    const baseRow = (kind === "bundles" ? base.bundles : base.servers).find((/** @type {any} */ r) => r.name === row.name);
    const open = model.expanded.has(row.name);
    return h(
      "tr",
      {},
      h(
        "th",
        {},
        kind === "bundles"
          ? h("button", { class: "twist", "aria-expanded": String(open), title: open ? "Hide its skills" : "Show its skills", onclick: () => { open ? model.expanded.delete(row.name) : model.expanded.add(row.name); render(); } }, open ? "▾ " : "▸ ", row.name)
          : row.name,
        h("small", {}, baseRow === undefined ? `${small} · new, to push` : small),
      ),
      ...hosts.map((/** @type {any} */ host) => {
        const state = cellState(row.cells[host.name]);
        const staged = cellState(baseRow?.cells[host.name]) !== state;
        const [mark, word] = WORDS[state];
        return h(
          "td",
          {},
          h(
            "button",
            {
              class: `cell ${state} ${staged ? "staged" : ""} ${host.name === focus ? "focus" : ""}`,
              title: `${row.name} on ${host.name}: ${word}${staged ? " (to push)" : ""}`,
              "aria-label": `${row.name} on ${host.name}: ${word}${staged ? ", to push" : ""}`,
              onclick: () => click(host.name, kind, row.name),
            },
            h("span", { class: "mk" }, mark),
            h("span", { class: "w" }, word),
          ),
        );
      }),
    );
  };

  const head = h(
    "tr",
    {},
    h("th", {}),
    ...hosts.map((/** @type {any} */ host) =>
      h("th", { class: host.name === focus ? "focus" : "" }, h("button", { class: "hostbtn", onclick: () => focusHost(host.name) }, host.name), h("span", { class: "v" }, host.self ? "this host" : host.ssh ?? "timer only")),
    ),
  );
  const body = [];
  if (view.bundles.length > 0) body.push(h("tr", { class: "grp" }, h("th", { colspan: String(hosts.length + 1) }, "Skill bundles")));
  for (const b of view.bundles) {
    body.push(rowOf("bundles", b, `${b.skills.length} skill${b.skills.length === 1 ? "" : "s"}`));
    if (model.expanded.has(b.name)) for (const skill of b.skills) body.push(h("tr", { class: "skill" }, h("th", { colspan: String(hosts.length + 1) }, `└ ${skill}`)));
  }
  if (view.servers.length > 0) body.push(h("tr", { class: "grp" }, h("th", { colspan: String(hosts.length + 1) }, "MCP servers")));
  for (const sv of view.servers) body.push(rowOf("mcp", sv, serverLine(sv)));

  const shown = model.preview?.shown;
  const pane = shown
    ? diffPanel(shown.path, shown.before, shown.after)
    : h("div", { class: "panel" }, h("div", { class: "ph" }, `hosts/${focus}.yaml`), h("div", { class: "hint" }, "Reading the file..."));

  return h(
    "div",
    {},
    h("h1", {}, title),
    h("p", { class: "sub" }, about),
    outsideNotice(),
    model.base.problems.length > 0 ? h("div", { class: "notice" }, "Config problem: " + model.base.problems[0]) : null,
    h(
      "div",
      { class: "split" },
      h("div", { class: "panel scroll" }, h("table", { class: "matrix" }, h("thead", {}, head), h("tbody", {}, ...body))),
      h("div", { class: "pane" }, pane, h("div", { class: "hint" }, "The file as it will be written, comments and layout kept. Click a cell, or a host's name, to see its file.")),
    ),
    h(
      "div",
      { class: "legend" },
      ...(/** @type {const} */ (["defaults", "added", "excluded", "off"])).map((st) =>
        h("span", {}, h("b", { class: "mk " + st }, WORDS[st][0]), { defaults: "from _defaults.yaml", added: "added by the host", excluded: "excluded", off: "not on this host" }[st]),
      ),
      h("span", {}, h("b", { class: "mk staged" }, "▢"), "to push, not written yet"),
    ),
    model.ops.length > 0
      ? h("div", { class: "row heldbar" }, h("span", { class: "tag ok" }, `${model.ops.length} to push`), h("a", { class: "btn primary", href: "#/review" }, "Review & push"), h("button", { class: "btn ghost danger", onclick: discardAll }, "Discard all"))
      : null,
  );
}

/** @param {any} sv */
const serverLine = (sv) => (sv.server ? `${sv.server.kind}${sv.server.only.length === 1 ? ` · ${sv.server.only[0]} only` : ""}${sv.server.secrets > 0 ? ` · ${sv.server.secrets} secret${sv.server.secrets === 1 ? "" : "s"}` : ""}` : "");

/** The config repo has changes of its own: listed, and nothing is pushed until they are committed or discarded elsewhere. */
function outsideNotice() {
  const outside = model.preview?.outside ?? model.base?.outside ?? [];
  if (outside.length === 0) return null;
  return h(
    "div",
    { class: "notice" },
    h("b", {}, "The config repo has changes the page did not make."),
    " Commit or discard them outside the page; fleet ui will not push until then.",
    h("pre", { class: "outside" }, outside.join("\n")),
  );
}

// ---- Adding: the dialogs of the Catalog and the Hosts screen

/** The words after an error: the server's own, or the fallback. @param {unknown} e @param {string} fallback */
const said = (e, fallback) => (e instanceof ApiError ? e.messages.join("; ") || e.message : fallback);

const skillOptions = () => skillChoices(model.skills, model.ops, model.stagedSkills);
const hostNames = () => (model.base?.hosts ?? []).map((/** @type {any} */ x) => x.name);

/** What the open dialog would hold (a catalog edit, or a host request), or why it cannot yet. @param {import("./adding.js").AddState} f @returns {any} */
function draftOf(f) {
  const view = shownMatrix();
  if (f.kind === "server") return serverDraft(f.server, view.servers.map((/** @type {any} */ r) => r.name));
  if (f.kind === "source") return sourceDraft(f.source, (view.sources ?? []).map((/** @type {any} */ r) => r.name), f.clone.doc);
  if (f.kind === "host") return hostAsDraft(f.host, hostNames());
  return bundleDraft(f.bundle, view.bundles.map((/** @type {any} */ r) => r.name), skillOptions());
}

/** The dialog element while one is open, and the control that opened it (focus goes back there). @type {HTMLDialogElement | null} */
let dialogEl = null;
let openerId = "";

/**
 * Opens the dialog for one addition. It is built here and lives in the body, outside the screen that `render` draws again, so
 * a push event or a refresh cannot lose what is being typed. Everything it holds (the form, a clone, a check) is dropped
 * when it closes, however it closes.
 * @param {import("./adding.js").AddKind} kind @param {string} [opener] the id of what gets the focus back, when it is not what has it now
 */
function openAdd(kind, opener = "") {
  if (client === null || model.form !== null || model.base === null) return;
  openerId = opener !== "" ? opener : document.activeElement instanceof HTMLElement ? document.activeElement.id : "";
  if (kind === "host") {
    if (!model.init.running) model.init = idleInit();
    model.initError = null;
  }
  model.form = freshAdd(kind);
  const dialog = h("dialog", { class: "adlg", "aria-labelledby": "adlg-title" });
  dialogEl = dialog;
  // Esc: the browser closes the dialog. While a host is being set up it must not, the run goes on without the page.
  dialog.addEventListener("cancel", (e) => {
    if (!closable(kind, model.init)) e.preventDefault();
  });
  // Tab wraps inside the dialog: from its last control to its first, and back.
  dialog.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const controls = /** @type {HTMLElement[]} */ ([...dialog.querySelectorAll("input, select, button, a[href]")]).filter((el) => !(/** @type {HTMLInputElement} */ (el).disabled) && el.getClientRects().length > 0);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (first === undefined || last === undefined) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  dialog.addEventListener("close", () => {
    // A second Esc can slip past the cancel event; a dialog that may not close is shown again.
    if (model.form !== null && !closable(kind, model.init)) return void dialog.showModal();
    dropDialog(dialog);
  });
  document.body.append(dialog);
  document.documentElement.classList.add("modal");
  renderDialog();
  dialog.showModal();
  firstField();
  if (kind !== "host") {
    loadSkills();
    loadSecrets();
  }
  scheduleLive();
}

/** Focus goes to the first field. */
function firstField() {
  /** @type {HTMLElement | null | undefined} */
  const el = dialogEl?.querySelector(".adlg-body input:not([disabled]):not([type=checkbox]), .adlg-body select:not([disabled]), .adlg-body button:not([disabled]), .adlg-body a[href]");
  el?.focus();
}

/** Ask the dialog to close; what it holds is dropped by `dropDialog`. */
function closeAdd() {
  dialogEl?.close();
}

/** The dialog is gone: nothing it held stays. @param {HTMLDialogElement} dialog */
function dropDialog(dialog) {
  if (dialogEl !== dialog) return;
  dropClone();
  clearTimeout(liveTimer);
  liveSeq++;
  const kind = model.form?.kind;
  model.form = null;
  dialogEl = null;
  if (kind === "host" && !model.init.running) {
    model.init = idleInit();
    model.initError = null;
  }
  dialog.remove();
  document.documentElement.classList.remove("modal");
  // Focus goes back to what opened it. The screen is drawn again when the edit is on To push, so `render` finishes the job.
  const back = document.getElementById(openerId);
  refocus = back !== null && back.offsetParent !== null ? openerId : "add-menu";
  returnFocus();
}

/** The id of the control that gets the focus back once the dialog is gone, until the person does something else. */
let refocus = "";
document.addEventListener("keydown", () => (refocus = ""), true);
document.addEventListener("pointerdown", () => (refocus = ""), true);

function returnFocus() {
  if (refocus === "" || (document.activeElement !== null && document.activeElement !== document.body)) return;
  document.getElementById(refocus)?.focus();
}

/** The temp clone on the server is deleted when the dialog is closed, replaced or the page goes away. */
function dropClone() {
  const id = model.form?.clone?.doc?.id;
  if (client !== null && id) client.discardClone(id).catch(() => {});
}
window.addEventListener("pagehide", dropClone);

/** Something in the form changed: draw the dialog again, and ask the server what the file would look like. */
function edited() {
  renderDialog();
  scheduleLive();
}

/** The addition goes onto To push, and the dialog is closed. @param {any} f @param {any} op */
function addToPush(f, op) {
  if (op.op === "addSource" && f.clone.doc) model.stagedSkills[op.name] = f.clone.doc.skills;
  model.ops = [...model.ops, op];
  model.messageEdited = false;
  closeAdd();
  refreshPreview();
}

/** Takes an addition back off To push, with the picks of it. @param {Op} op */
function removeFromPush(op) {
  model.ops = takeBack(model.ops, op);
  model.messageEdited = false;
  refreshPreview();
}

let liveTimer = 0;
let liveSeq = 0;

function scheduleLive() {
  clearTimeout(liveTimer);
  liveTimer = window.setTimeout(loadLive, 250);
}

/** What the file would be with the form's edit added to the held ones: the server's own replay, not a copy of its rules. */
async function loadLive() {
  const f = model.form;
  if (f === null || client === null) return;
  const d = draftOf(f);
  if (d.op === null) {
    f.live = null;
    return;
  }
  const key = JSON.stringify(d.op);
  const seq = ++liveSeq;
  try {
    const doc = await (f.kind === "host" ? client.previewHost(d.op) : client.preview([...model.ops, d.op]));
    if (seq !== liveSeq || model.form !== f) return;
    f.live = { key, doc, error: null };
  } catch (e) {
    if (seq !== liveSeq || model.form !== f) return;
    f.live = { key, doc: null, error: said(e, "the file could not be previewed") };
  }
  renderDialog();
}

async function loadSkills() {
  if (client === null) return;
  try {
    model.skills = (await client.skills()).skills;
  } catch {
    // the list is a help: a bundle can still be made from names typed in
  }
  render();
  renderDialog();
}

async function lookAtRepo() {
  const f = model.form;
  if (f === null || client === null) return;
  const s = f.source;
  if (s.repo.trim() === "" || f.clone.state === "running") return;
  const key = cloneKey(s);
  dropClone();
  f.clone = { state: "running", doc: null, error: null };
  renderDialog();
  try {
    const doc = await client.clone(s.repo.trim(), s.path.trim() || ".", s.branch.trim());
    if (model.form !== f) return void client.discardClone(doc.id).catch(() => {});
    f.clone = { state: "done", doc: { ...doc, key, headBranch: doc.branch }, error: null };
  } catch (e) {
    if (model.form !== f) return;
    f.clone = { state: "error", doc: null, error: said(e, "the repo could not be cloned") };
  }
  edited();
}

async function runCheck() {
  const f = model.form;
  const d = f === null ? null : draftOf(f);
  if (f === null || client === null || d === null || d.op === null || d.op.op !== "addServer") return;
  const key = JSON.stringify(d.op);
  f.confirm = false;
  f.check = { key, state: "running" };
  renderDialog();
  try {
    const doc = await client.probe(d.op.name, d.op.entry);
    if (f.check?.key === key) f.check = { key, state: "done", doc };
  } catch (e) {
    if (f.check?.key === key) f.check = { key, state: "error", error: said(e, "the check could not run") };
  }
  renderDialog();
}

/** Writes the host file and runs the real init. Its output comes on the stream while this call is open. */
async function runInit() {
  const f = model.form;
  const d = f === null || f.kind !== "host" ? null : hostDraft(f.host, hostNames());
  if (f === null || client === null || d === null || d.body === null || model.init.running) return;
  f.confirm = false;
  model.initError = null;
  model.init = startInit(d.body.name);
  renderDialog();
  try {
    const doc = await client.initHost(d.body);
    model.init = initEnd(model.init, doc);
  } catch (e) {
    model.init = { ...model.init, running: false };
    model.initError = said(e, "the host could not be set up");
  }
  renderDialog();
  loadStatus();
  loadMatrix();
  loadSecrets();
}

/** Enter in a field of the dialog does what its main button does (and look at the repo, for a source not yet looked at). */
function submitAdd() {
  const f = model.form;
  if (f === null) return;
  const d = draftOf(f);
  if (f.kind === "host") {
    const end = model.init.end;
    if (d.op !== null && !f.confirm && !model.init.running && !end?.ok && heldProblem(model.ops) === null && (model.base?.outside ?? []).length === 0) {
      f.confirm = true;
      renderDialog();
      /** @type {HTMLElement | null | undefined} */ (dialogEl?.querySelector("#host-run"))?.focus();
    }
    return;
  }
  if (f.kind === "source" && !(f.clone.doc !== null && f.clone.doc.key === cloneKey(f.source))) return void lookAtRepo();
  if (d.op !== null) addToPush(f, d.op);
}

// -- drawing the dialog

/** @param {string} id @param {string} label @param {Node} control @param {Node | string | (Node | string)[] | null} [help] */
const field = (id, label, control, help = null) => h("div", { class: "field" }, h("label", { for: id }, label), control, help === null ? null : h("div", { class: "help" }, ...[help].flat()));

/** A text input that changes the form as it is typed in. @param {string} id @param {string} value @param {(v: string) => void} set @param {Record<string, string | boolean>} [extra] */
const textInput = (id, value, set, extra = {}) =>
  h("input", { type: "text", id, value, autocomplete: "off", spellcheck: "false", maxlength: "500", ...extra, oninput: (e) => { set(/** @type {HTMLInputElement} */ (e.target).value); edited(); } });

/** @param {string} id @param {string[]} labels @param {string[]} values @param {string} current @param {(v: string) => void} set */
const seg = (id, labels, values, current, set) =>
  h("div", { class: "seg", role: "group" }, ...values.map((v, i) => h("button", { type: "button", id: `${id}-${v}`, class: v === current ? "on" : "", "aria-pressed": String(v === current), onclick: () => { set(v); edited(); } }, labels[i])));

/** @param {string} id @param {string} label @param {boolean} checked @param {(v: boolean) => void} set @param {boolean} [disabled] */
const check = (id, label, checked, set, disabled = false) =>
  h("label", { class: "check", for: id }, h("input", { type: "checkbox", id, checked, disabled, onchange: (e) => { set(/** @type {HTMLInputElement} */ (e.target).checked); edited(); } }), label);

/** Whether this host can read a secret: from the names the Secrets screen reads, never a value. @param {string} name */
function secretTag(name) {
  const entry = model.secrets?.entries?.find((/** @type {any} */ e) => e.name === name);
  if (model.secrets === null || name === "") return null;
  const here = entry && model.base?.self && entry.readers.includes(model.base.self);
  return h("span", { class: "tag " + (here ? "ok" : "warn") }, here ? "set on this host" : "not set here yet");
}

/** @param {any} f */
function serverFields(f) {
  const s = f.server;
  const net = s.kind !== "command";
  const d = draftOf(f);
  const commandProblem = !net && d.problems.find((/** @type {string} */ p) => p.includes("'command'"));
  return [
    field("f-name", "Name", textInput("f-name", s.name, (v) => (s.name = v)), ["How host files pick it: ", h("code", {}, `mcp.include: [${s.name.trim() || "name"}]`)]),
    field("f-kind", "It runs", seg("f-kind", ["on the machine (command)", "at a URL (http)", "at a URL (sse)"], ["command", "http", "sse"], s.kind, (v) => (s.kind = v))),
    net
      ? field("f-url", "URL", textInput("f-url", s.url, (v) => (s.url = v), { placeholder: "where the server listens: https, then the address" }))
      : field("f-cmd", "Command", textInput("f-cmd", s.command, (v) => (s.command = v), { placeholder: "npx -y @example/server@1.2.3" }), commandProblem ? h("span", { class: "bad" }, commandProblem) : "Pin the version. A secret can never go here: the process list shows command lines."),
    ...d.warnings.map((/** @type {string} */ w) => h("div", { class: "notice inline" }, w)),
    h(
      "div",
      { class: "field" },
      h("label", {}, net ? "Headers" : "Environment"),
      ...s.rows.map((/** @type {any} */ r, /** @type {number} */ i) =>
        h(
          "div",
          { class: "envrow" },
          textInput(`f-ek${i}`, r.key, (v) => (r.key = v), { placeholder: net ? "Authorization" : "API_KEY", "aria-label": net ? "header name" : "variable name" }),
          h("select", { id: `f-em${i}`, "aria-label": "kind of value", onchange: (e) => { r.mode = /** @type {HTMLSelectElement} */ (e.target).value; edited(); } }, h("option", { value: "secret", selected: r.mode === "secret" }, "a secret"), h("option", { value: "plain", selected: r.mode === "plain" }, "a plain value")),
          textInput(`f-ev${i}`, r.value, (v) => (r.value = v), { placeholder: r.mode === "secret" ? (net ? "SECRET_NAME" : `${r.key.trim() || "SECRET_NAME"} (this variable's own name)`) : "value", "aria-label": r.mode === "secret" ? "secret name" : "value" }),
          h("div", { class: "row tail" }, r.mode === "secret" ? secretTag(secretOf(r)) : null, h("button", { type: "button", id: `f-ex${i}`, class: "btn ghost x", title: "Remove this row", "aria-label": "remove this row", onclick: () => { s.rows.splice(i, 1); edited(); } }, "✕")),
        ),
      ),
      h("button", { type: "button", id: "f-addrow", class: "btn ghost small", onclick: () => { s.rows.push({ key: "", mode: "secret", value: "" }); edited(); } }, net ? "+ Add a header" : "+ Add a variable"),
      h("div", { class: "help" }, "A secret is stored encrypted, by name. This form never sees its value: set it under Secrets."),
    ),
    h("div", { class: "field" }, h("label", {}, "Agents"), h("div", { class: "row" }, check("f-c", "Claude Code", s.claude, (v) => (s.claude = v)), check("f-o", "opencode", s.opencode, (v) => (s.opencode = v)))),
  ];
}

/** @param {any} f */
function sourceFields(f) {
  const s = f.source;
  const c = f.clone;
  const fresh = c.doc !== null && c.doc.key === cloneKey(s);
  return [
    field("s-name", "Name", textInput("s-name", s.name, (v) => (s.name = v)), "What bundles and messages call it."),
    field("s-repo", "Repo", textInput("s-repo", s.repo, (v) => (s.repo = v), { placeholder: "the repo URL, or a path on this machine" }), "A URL, or a path on this machine. It is cloned shallowly into a temp directory to list its skills, and the clone is deleted when you close this dialog."),
    field("s-path", "Path in the repo", textInput("s-path", s.path, (v) => (s.path = v), { placeholder: "." }), "Where to look for skills: directories with a SKILL.md, at any depth. Use . for the whole repo."),
    field("s-branch", "Branch", textInput("s-branch", s.branch, (v) => (s.branch = v), { placeholder: "the repo's default" })),
    field("s-mode", "Keep it", seg("s-mode", ["pinned to a commit", "following the branch"], ["pin", "follow"], s.mode, (v) => (s.mode = v)), s.mode === "pin" ? "A pinned source moves only when you run fleet skills update, so a change upstream cannot reach your machines unreviewed." : "A followed source is on the newest commit of its branch at every apply. Use it for skills you write."),
    s.mode === "pin" ? h("div", { class: "field" }, check("s-review", "Review what a move brings in before the pin changes (review: true)", s.review, (v) => (s.review = v))) : null,
    h(
      "div",
      { class: "row" },
      h("button", { type: "button", id: "s-look", class: "btn", disabled: s.repo.trim() === "" || c.state === "running", onclick: lookAtRepo }, c.state === "running" ? "Cloning..." : fresh ? "Look again" : "Look at the repo"),
      c.state === "error" ? h("span", { class: "bad", role: "alert" }, c.error) : null,
    ),
    fresh && c.doc.problem === null
      ? h("div", { class: "found" }, h("div", { class: "muted" }, `${c.doc.skills.length} skill${c.doc.skills.length === 1 ? "" : "s"} found at ${c.doc.path}; head ${c.doc.commit.slice(0, 7)}${c.doc.headBranch ? ` on ${c.doc.headBranch}` : ""}`), h("div", { class: "row" }, ...c.doc.skills.slice(0, 40).map((/** @type {string} */ sk) => h("span", { class: "tag" }, sk))))
      : null,
  ];
}

/** @param {any} f */
function bundleFields(f) {
  const b = f.bundle;
  const options = skillOptions();
  return [
    field("b-name", "Name", textInput("b-name", b.name, (v) => (b.name = v)), ["How host files pick it: ", h("code", {}, `bundles: [${b.name.trim() || "name"}]`)]),
    h(
      "div",
      { class: "field" },
      h("label", {}, "Skills"),
      options.length === 0
        ? h("div", { class: "help" }, "No source has been cloned here yet, so no skill is listed. Add a skill source first, or type the names below.")
        : h("div", { class: "skills" }, ...options.map((k, i) => check(`b-s${i}`, `${k.name}${k.bundle ? ` (in ${k.bundle})` : ""}`, b.picked.includes(k.name), (v) => (b.picked = v ? [...b.picked, k.name] : b.picked.filter((/** @type {string} */ x) => x !== k.name)), k.bundle !== null))),
    ),
    field("b-extra", "Other skill names", textInput("b-extra", b.extra, (v) => (b.extra = v), { placeholder: "names, separated by commas" }), "For a skill in a source that is not cloned here."),
  ];
}

/** @param {any} f */
function hostFields(f) {
  const names = hostNames();
  const h0 = f.host;
  const done = model.init.end?.ok === true;
  // Once it is set up the name is a host: that is no reason to complain about it.
  const d = done ? { ...hostDraft(h0, names), name: null, ssh: null } : hostDraft(h0, names);
  const running = model.init.running;
  const locked = running || done;
  const outside = model.base?.outside ?? [];
  const text = (/** @type {string} */ id, /** @type {"name" | "ssh"} */ key, /** @type {Record<string, string | boolean>} */ extra) => textInput(id, h0[key], (v) => { h0[key] = v; f.confirm = false; }, { ...extra, ...(locked ? { disabled: true } : {}) });
  const sel = h(
    "select",
    { id: "host-from", ...(locked ? { disabled: true } : {}), onchange: (e) => { h0.from = /** @type {HTMLSelectElement} */ (e.target).value; f.confirm = false; edited(); } },
    h("option", { value: "" }, "the defaults only"),
    ...names.map((/** @type {string} */ n) => h("option", { value: n, ...(h0.from === n ? { selected: true } : {}) }, `a copy of ${n}`)),
  );
  return [
    field("host-name", "Name", text("host-name", "name", { placeholder: "mini" }), d.name === null ? "The host's file is hosts/<name>.yaml, and the name fleet init writes on the machine." : h("span", { class: "bad" }, d.name)),
    field("host-ssh", "Reach it over ssh", text("host-ssh", "ssh", { placeholder: "me@mini.local" }), d.ssh === null ? ["Required: fleet init reaches the host over ssh. A machine fleet cannot reach this way is set up by hand: ", h("a", { href: SETUP_DOC, target: "_blank", rel: "noopener noreferrer", class: "link" }, "setting up machines"), "."] : h("span", { class: "bad" }, d.ssh)),
    field("host-from", "Start from", sel, h0.from === "" ? "Nothing is picked: the host gets the defaults." : `Copies bundles, exclude, mcp, settings and vars of ${h0.from}. Not its ssh, age key or files.`),
    outside.length > 0 ? h("div", { class: "notice inline" }, "The config repo has changes the page did not make: commit or discard them first.") : null,
    f.confirm && d.body !== null
      ? h("div", { class: "notice inline", id: "hostconfirm", role: "alertdialog", "aria-label": "Confirm setting up the host" }, confirmInit(d.body), h("div", { class: "row inset" }, h("button", { type: "button", id: "host-run", class: "btn primary", disabled: running, onclick: runInit }, `Run fleet init ${d.body.name}`), h("button", { type: "button", id: "host-back", class: "btn ghost", onclick: () => { f.confirm = false; renderDialog(); } }, "Back")))
      : null,
  ];
}

/** What fills the dialog for a host while edits are to push: the reason, and the way out. */
function hostBlocked() {
  return h(
    "div",
    { class: "form" },
    h("div", { class: "notice", id: "hostheld" }, h("b", {}, heldProblem(model.ops)), h("div", { class: "row", style: "margin-top:10px" }, h("a", { class: "btn primary", id: "host-review", href: "#/review", onclick: closeAdd }, "Review & push"), h("button", { type: "button", id: "host-discard", class: "btn danger", onclick: () => { discardAll(); renderDialog(); } }, "Discard changes to push"))),
  );
}

/** The pane beside the form: the file as a diff, or what is missing. @param {any} f @param {any} d */
function filePane(f, d) {
  const held = f.kind === "host" ? null : (model.held[fileOf(f.kind)]?.after ?? null);
  const pane = paneView(f.kind, d, f.live, held, f.host.name);
  const head = h("div", { class: "ph" }, h("span", { class: "path" }, pane.path), h("span", { class: "spacer" }), h("span", { class: "tag " + pane.tone }, pane.tag));
  if (pane.state === "missing") return h("div", { class: "pane-file", id: "pane" }, head, h("div", { class: "hint" }, "To add it:", h("ul", {}, ...pane.problems.map((p) => h("li", {}, p)))));
  if (pane.state === "reading") return h("div", { class: "pane-file", id: "pane" }, head, h("div", { class: "hint" }, "Reading the file..."));
  if (pane.state === "refused") return h("div", { class: "pane-file", id: "pane" }, head, h("div", { class: "notice bad inset" }, pane.message));
  return h("div", { class: "pane-file", id: "pane" }, head, diffBody(pane.lines), pane.broken === null ? null : h("div", { class: "notice bad inset" }, pane.broken));
}

/** What "Check it starts" says: first the question, then the answer. @param {any} f @param {any} d */
function probeBox(f, d) {
  if (f.kind !== "server") return null;
  if (f.confirm && d.op !== null) {
    return h(
      "div",
      { class: "probe confirm", role: "alertdialog", "aria-label": "Confirm the check" },
      h("div", {}, confirmText(d.op)),
      h("div", { class: "row" }, h("button", { type: "button", id: "probe-run", class: "btn primary", onclick: runCheck }, "Run the check"), h("button", { type: "button", id: "probe-cancel", class: "btn ghost", onclick: () => { f.confirm = false; renderDialog(); } }, "Cancel")),
    );
  }
  const c = f.check;
  if (c !== null && d.op !== null && c.key === JSON.stringify(d.op)) {
    if (c.state === "running") return h("div", { class: "probe" }, h("span", { class: "muted" }, "Starting it and asking for its tools..."));
    if (c.state === "error") return h("div", { class: "probe" }, h("span", { class: "bad" }, c.error));
    const r = checkLines(c.doc);
    return h("div", { class: "probe" }, ...r.lines.map((l, i) => h("div", { class: i === 0 ? r.tone : "muted" }, l)));
  }
  return h("div", { class: "probe" }, h("span", { class: "muted" }, "Check it starts: runs fleet doctor's probe on this one server, here, before anything is pushed. It asks first."));
}

/** The output of fleet init, as it streams in, and how it ended. @param {any} d */
function initPane(d) {
  const end = model.init.end;
  const running = model.init.running;
  return h(
    "div",
    { class: "initpane" },
    h("div", { class: "ph" }, d.op ? `fleet init ${d.op.name}` : "fleet init", h("span", { class: "spacer" }), end ? h("span", { class: "tag " + (end.ok ? "ok" : "bad") }, end.code) : running ? h("span", { class: "tag" }, "running") : null),
    model.initError !== null ? h("div", { class: "notice bad inset", role: "alert" }, model.initError) : null,
    h("pre", { class: "term", id: "initlog", "aria-live": "polite" }, model.init.lines.length > 0 ? model.init.lines.join("\n") : h("span", { class: "muted" }, "Then the real fleet init runs here, over ssh, with its output streamed in.")),
    end ? h("div", { class: "hint", id: "initdone" }, ...(end.ok ? [`${model.init.name} is set up. It is in the Matrix now; pick what it gets there.`] : end.messages.map((m) => h("div", {}, m)))) : null,
  );
}

/** The whole content of the dialog. @param {import("./adding.js").AddState} f */
function dialogContent(f) {
  const d = draftOf(f);
  const host = f.kind === "host";
  const blocked = host && heldProblem(model.ops) !== null;
  const running = host && model.init.running;
  const done = host && model.init.end?.ok === true;
  const fields = f.kind === "server" ? serverFields(f) : f.kind === "source" ? sourceFields(f) : f.kind === "bundle" ? bundleFields(f) : blocked ? [] : hostFields(f);
  const warnings = f.kind === "bundle" ? d.warnings.map((/** @type {string} */ w) => h("div", { class: "notice inline" }, w)) : [];
  const outside = (model.base?.outside ?? []).length > 0;
  const ready = d.op !== null && (!host || (!outside && !running));
  const primary = done
    ? h("button", { type: "button", id: "add-done", class: "btn primary", onclick: closeAdd }, "Done")
    : h("button", { type: "submit", id: "add-confirm", class: "btn primary", disabled: !ready || (host && f.confirm), "aria-describedby": "pane" }, running ? "Setting up..." : confirmLabel(f.kind));
  return h(
    "form",
    { class: "adlg-form", autocomplete: "off", novalidate: true, onsubmit: (e) => { e.preventDefault(); submitAdd(); }, onkeydown: (/** @type {any} */ e) => {
      const t = /** @type {HTMLElement} */ (e.target);
      if (e.key === "Enter" && t instanceof HTMLInputElement && t.type === "text" && !e.isComposing) {
        e.preventDefault();
        submitAdd();
      }
    } },
    h("div", { class: "adlg-head" }, h("h3", { id: "adlg-title" }, ADD[f.kind].title), h("span", { class: "muted" }, host ? "writes hosts/<name>.yaml, then runs fleet init from here" : "goes to To push; written when you push")),
    h(
      "div",
      { class: "adlg-body" },
      blocked ? hostBlocked() : h("div", { class: "form" }, ...fields),
      h("div", { class: "formright" }, blocked || done ? null : filePane(f, d), ...warnings, probeBox(f, d), host && !blocked ? initPane(d) : null),
    ),
    h(
      "div",
      { class: "adlg-foot" },
      f.kind === "server" ? h("button", { type: "button", id: "add-check", class: "btn", disabled: d.op === null || f.confirm || f.check?.state === "running", onclick: () => { f.confirm = true; renderDialog(); /** @type {HTMLElement | null | undefined} */ (dialogEl?.querySelector("#probe-run"))?.focus(); } }, "Check it starts") : null,
      h("span", { class: "spacer" }),
      done ? null : h("button", { type: "button", id: "add-cancel", class: "btn ghost", disabled: !closable(f.kind, model.init), onclick: closeAdd }, "Cancel"),
      blocked ? null : primary,
    ),
  );
}

/** Draws the dialog again, keeping what has the focus (and the caret in it) and how far each part is scrolled. */
function renderDialog() {
  const f = model.form;
  if (f === null || dialogEl === null) return;
  const active = document.activeElement;
  const keep = active instanceof HTMLElement && dialogEl.contains(active) && active.id !== "" ? { id: active.id, from: /** @type {HTMLInputElement} */ (active).selectionStart, to: /** @type {HTMLInputElement} */ (active).selectionEnd } : null;
  const scrolls = [".adlg-body", ".form", ".formright", "#initlog"].map((sel) => dialogEl?.querySelector(sel)?.scrollTop ?? 0);
  const stick = dialogEl.querySelector("#initlog");
  const atEnd = stick !== null && stick.scrollTop + stick.clientHeight >= stick.scrollHeight - 4;
  fill(dialogEl, dialogContent(f));
  [".adlg-body", ".form", ".formright", "#initlog"].forEach((sel, i) => {
    const el = dialogEl?.querySelector(sel);
    if (el) el.scrollTop = sel === "#initlog" && atEnd ? el.scrollHeight : (scrolls[i] ?? 0);
  });
  if (keep !== null) {
    const again = dialogEl.querySelector(`[id="${keep.id}"]`);
    if (again instanceof HTMLElement && !(again instanceof HTMLButtonElement && again.disabled)) {
      again.focus();
      if (again instanceof HTMLInputElement && again.type === "text" && keep.from !== null) again.setSelectionRange(keep.from, keep.to);
    }
  }
}

/**
 * The Add button of the Catalog: a small menu of the three things that can be added. Whether it is open is in the model, so
 * a screen drawn again (an answer arrives, a push event) keeps it open, and focus goes back to what had it (`render`).
 */
function addMenu() {
  const items = CATALOG_KINDS.map((k) => h("button", { type: "button", role: "menuitem", id: `add-${k}`, class: "menuitem", onclick: () => { setMenu(false); openAdd(k, "add-menu"); } }, ADD[k].menu));
  const list = h("div", { class: "menu", role: "menu", "aria-label": "Add to the catalog", ...(model.menu ? {} : { hidden: true }) }, ...items);
  const button = h("button", { type: "button", class: "btn primary", id: "add-menu", "aria-haspopup": "menu", "aria-expanded": String(model.menu), onclick: () => (model.menu ? setMenu(false) : setMenu(true, true)) }, "+ Add");
  const wrap = h("div", { class: "menuwrap" }, button, list);
  wrap.addEventListener("keydown", (e) => {
    const ids = items.map((i) => i.id);
    const at = ids.indexOf(document.activeElement?.id ?? "");
    if (e.key === "Escape" && model.menu) {
      e.preventDefault();
      e.stopPropagation();
      setMenu(false, true);
    } else if (e.key === "ArrowDown" && !model.menu && document.activeElement === button) {
      e.preventDefault();
      setMenu(true, true);
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && model.menu) {
      e.preventDefault();
      document.getElementById(ids[(Math.max(at, 0) + (e.key === "ArrowDown" ? 1 : ids.length - 1)) % ids.length] ?? "")?.focus();
    }
  });
  return wrap;
}

/** Opens or closes the Add menu. @param {boolean} open @param {boolean} [focus] focus goes into the menu, or back to its button */
function setMenu(open, focus = false) {
  model.menu = open;
  render();
  if (focus) document.getElementById(open ? `add-${CATALOG_KINDS[0]}` : "add-menu")?.focus();
}
// A click or focus outside the menu closes it.
for (const type of ["click", "focusin"]) document.addEventListener(type, (e) => { if (model.menu && !(/** @type {Element} */ (e.target)).closest?.(".menuwrap")) setMenu(false); });

/** @param {import("./adding.js").AddKind} kind @param {string} label */
const addCard = (kind, label) => h("button", { type: "button", id: `tile-${kind}`, class: "panel card add", onclick: () => openAdd(kind) }, label);

/** The button that takes an addition back off To push. @param {Op | undefined} op */
const heldTag = (op) => (op ? h("span", { class: "tag ok" }, "to push") : null);
const takeBackBtn = (/** @type {Op | undefined} */ op) => (op ? h("button", { type: "button", class: "btn ghost small", onclick: () => removeFromPush(op) }, "Remove from push") : null);

/** @param {string} kind @param {string} name @returns {Op | undefined} */
const heldOp = (kind, name) => model.ops.find((o) => o.op === kind && "name" in o && o.name === name);

/** A page title with the button that adds to it on the right. @param {string} title @param {string} about @param {Node} action */
const pageHead = (title, about, action) => h("div", { class: "pagehead" }, h("div", {}, h("h1", {}, title), h("p", { class: "sub" }, about)), h("div", { class: "pageact" }, action));

function catalogScreen() {
  const [title, about] = SCREENS.catalog;
  if (model.base === null) return loadingOrError(title, model.matrixError);
  const view = shownMatrix();
  const hosts = view.hosts;
  const uses = (/** @type {any} */ row) => hosts.filter((/** @type {any} */ x) => row.cells[x.name]?.on).length;
  const onHosts = (/** @type {any} */ row) => h("span", { class: "tag " + (uses(row) > 0 ? "ok" : "") }, `on ${uses(row)} of ${hosts.length} host${hosts.length === 1 ? "" : "s"}`);
  const sources = view.sources ?? [];
  const skillsOf = (/** @type {string} */ name) => [...new Set([...model.skills.filter((k) => k.source === name).map((k) => k.name), ...(model.stagedSkills[name] ?? [])])];
  return h(
    "div",
    {},
    pageHead(title, about, addMenu()),
    h("h2", {}, "MCP servers"),
    h("div", { class: "cards" },
      ...view.servers.map((/** @type {any} */ sv) => {
        const op = heldOp("addServer", sv.name);
        return h("div", { class: "panel card" }, h("h3", {}, sv.name, h("span", { class: "tag" }, sv.server?.kind ?? ""), heldTag(op)), h("p", {}, serverLine(sv)), h("div", { class: "row" }, onHosts(sv), takeBackBtn(op)));
      }),
      addCard("server", "+ Add an MCP server"),
    ),
    h("h2", {}, "Skill sources"),
    h("div", { class: "cards" },
      ...sources.map((/** @type {any} */ src) => {
        const op = heldOp("addSource", src.name);
        const skills = skillsOf(src.name);
        return h(
          "div",
          { class: "panel card" },
          h("h3", {}, src.name, h("span", { class: "tag " + (src.commit ? "info" : "ok") }, src.commit ? "pinned" : "followed"), src.review ? h("span", { class: "tag warn" }, "review") : null, heldTag(op)),
          h("p", {}, [src.repo, src.commit ? src.commit.slice(0, 7) : null, src.commit ? `tracks ${src.track}` : src.branch].filter((x) => x).join(" · ")),
          skills.length > 0 ? h("div", { class: "row" }, ...skills.slice(0, 12).map((/** @type {string} */ sk) => h("span", { class: "tag" }, sk)), skills.length > 12 ? h("span", { class: "muted" }, `+${skills.length - 12}`) : null) : null,
          takeBackBtn(op),
        );
      }),
      addCard("source", "+ Add a skill source"),
    ),
    h("h2", {}, "Skill bundles"),
    h("div", { class: "cards" },
      ...view.bundles.map((/** @type {any} */ b) => {
        const op = heldOp("addBundle", b.name);
        return h("div", { class: "panel card" }, h("h3", {}, b.name, heldTag(op)), h("div", { class: "row" }, ...b.skills.map((/** @type {string} */ sk) => h("span", { class: "tag" }, sk))), h("p", {}, ""), h("div", { class: "row" }, onHosts(b), takeBackBtn(op)));
      }),
      addCard("bundle", "+ Add a skill bundle"),
    ),
    model.ops.length > 0 ? h("div", { class: "row heldbar" }, h("span", { class: "tag ok" }, `${model.ops.length} to push`), h("a", { class: "btn primary", href: "#/review" }, "Review & push")) : null,
  );
}

function hostsScreen() {
  const [title, about] = SCREENS.hosts;
  if (model.base === null) return loadingOrError(title, model.matrixError);
  return h(
    "div",
    {},
    pageHead(title, about, h("button", { type: "button", class: "btn primary", id: "add-host", onclick: () => openAdd("host") }, "+ Add host")),
    h("div", { class: "cards" },
      ...model.base.hosts.map((/** @type {any} */ host) => {
        const bundles = model.base.bundles.filter((/** @type {any} */ b) => b.cells[host.name]?.on).map((/** @type {any} */ b) => b.name);
        const servers = model.base.servers.filter((/** @type {any} */ sv) => sv.cells[host.name]?.on).map((/** @type {any} */ sv) => sv.name);
        return h(
          "div",
          { class: "panel card" },
          h("h3", {}, host.name, host.self ? h("span", { class: "tag ok" }, "this host") : null),
          h("dl", { class: "facts small" }, h("dt", {}, "reached"), h("dd", {}, host.self ? "local" : host.ssh ? `ssh ${host.ssh}` : "on its own timer"), h("dt", {}, "bundles"), h("dd", {}, bundles.join(", ") || "none"), h("dt", {}, "servers"), h("dd", {}, servers.join(", ") || "none")),
        );
      }),
      addCard("host", "+ Add a host"),
    ),
  );
}

/** The secrets table as it will be after the held edits (the server's answer for them), else as the files on disk say. */
const shownSecrets = () => model.preview?.secrets ?? model.secrets?.table ?? null;

function secretsScreen() {
  const [title, about] = SCREENS.secrets;
  /** @type {import("./secrets.js").SecretsTable | null} */
  const table = shownSecrets();
  if (model.secrets === null || table === null) return loadingOrError(title, model.secretsError);
  const held = heldNames(model.ops);
  return h(
    "div",
    {},
    h("h1", {}, title),
    h("p", { class: "sub" }, about),
    ...[...model.secrets.problems, ...table.problems].slice(0, 2).map((/** @type {string} */ p) => h("div", { class: "notice" }, p)),
    table.names.length === 0
      ? h("div", { class: "panel empty" }, "No secrets yet. A secret appears here once a catalog server refers to it as secret:NAME.")
      : h(
          "div",
          { class: "panel scroll" },
          h(
            "table",
            { class: "sec" },
            h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Used by"), ...table.hosts.map((x) => h("th", {}, x.name, x.age ? null : h("small", {}, "no age key"))), h("th", {}, ""))),
            h("tbody", {}, ...table.names.map((/** @type {import("./secrets.js").SecretRow} */ row) => {
              const action = actionOf(row);
              return h(
                "tr",
                {},
                h("td", {}, row.name),
                h("td", { class: "muted" }, row.usedBy.join(", ") || "-"),
                ...table.hosts.map((x) => {
                  const v = cellView(row.cells[x.name], row.name, x.name, model.ops);
                  return h("td", { class: v.tone, title: `${row.name} on ${x.name}: ${v.word}${v.held ? " (to push)" : ""}` }, v.mark === "" ? v.word : `${v.mark} ${v.word}`, v.held ? h("span", { class: "held" }, "to push") : null);
                }),
                h("td", { class: "act" }, h("button", { type: "button", class: "btn" + (action.missing.length > 0 ? "" : " ghost") + " small", onclick: () => openSecretDialog(row, table) }, action.label)),
              );
            })),
          ),
        ),
    held.length > 0
      ? h("div", { class: "row heldbar" }, h("span", { class: "tag ok" }, `${held.length} secret${held.length === 1 ? "" : "s"} to push, encrypted`), h("a", { class: "btn primary", href: "#/review" }, "Review & push"), h("button", { class: "btn ghost danger", onclick: discardAll }, "Discard all"))
      : null,
  );
}

/**
 * The dialog that takes a value. It is built here and removed on close, outside the page that `render` draws again, so a
 * redraw cannot lose what is being typed, and so no state of the page ever holds the value: it is read from the field when the
 * button is pressed, the field is emptied before the request goes, and what is left is a local that ends with the call.
 * @param {import("./secrets.js").SecretRow} row @param {import("./secrets.js").SecretsTable} table
 */
function openSecretDialog(row, table) {
  if (client === null || document.querySelector("dialog.sdlg") !== null) return;
  const targets = dialogTargets(table, row);
  const input = h("input", {
    type: "password", id: "secret-value", "aria-label": `value of ${row.name}`,
    autocomplete: "new-password", autocapitalize: "off", autocorrect: "off", spellcheck: "false", maxlength: "8192",
    "data-lpignore": "true", "data-1p-ignore": "true", "data-form-type": "other",
  });
  const boxes = targets.map((t) => h("input", { type: "checkbox", id: `st-${t.file}`, checked: t.checked, disabled: t.disabled }));
  const err = h("div", { class: "err", role: "alert" });
  const encrypt = h("button", { type: "submit", class: "btn primary" }, "Encrypt for push");
  const cancel = h("button", { type: "button", class: "btn ghost" }, "Cancel");
  const dialog = h(
    "dialog",
    { class: "sdlg", "aria-labelledby": "sdlg-title" },
    h(
      "form",
      { autocomplete: "off", novalidate: true },
      h("h3", { id: "sdlg-title" }, `Set ${row.name}`),
      h("p", {}, "Encrypted with sops for the hosts that read the file, then forgotten: the page keeps no copy and the value is never sent back. Same as ", h("code", {}, "fleet secrets set"), "."),
      h("div", { class: "field" }, h("label", { for: "secret-value" }, "Value"), input),
      h("div", { class: "field", style: "margin-top:14px" }, h("label", {}, "Set it for"), h("div", { class: "targets" }, ...targets.map((t, i) => h("label", { class: t.disabled ? "off" : "" }, /** @type {Node} */ (boxes[i]), t.label, h("small", {}, t.note))))),
      err,
      h("div", { class: "actions" }, cancel, encrypt),
    ),
  );
  const close = () => {
    input.value = "";
    dialog.close();
    dialog.remove();
  };
  cancel.addEventListener("click", close);
  dialog.addEventListener("cancel", () => {
    input.value = "";
  });
  dialog.addEventListener("close", () => {
    input.value = "";
    dialog.remove();
  });
  dialog.querySelector("form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const files = targets.filter((_, i) => /** @type {HTMLInputElement} */ (boxes[i]).checked).map((t) => t.file);
    const problem = files.length === 0 ? "Tick at least one file to set it in." : valueProblem(input.value);
    if (problem !== null) return void (err.textContent = problem);
    // The field is emptied before the request goes: from here the value is only the argument of the call.
    let value = input.value;
    input.value = "";
    err.textContent = "";
    for (const el of [encrypt, cancel, input, ...boxes]) /** @type {HTMLButtonElement | HTMLInputElement} */ (el).disabled = true;
    encrypt.textContent = "Encrypting...";
    try {
      const doc = await /** @type {NonNullable<typeof client>} */ (client).setSecret(row.name, value, files, model.ops);
      value = "";
      model.ops = afterSet(model.ops, doc);
      model.messageEdited = false;
      close();
      refreshPreview();
    } catch (error) {
      value = "";
      for (const el of [encrypt, cancel, input, ...boxes]) /** @type {HTMLButtonElement | HTMLInputElement} */ (el).disabled = false;
      encrypt.textContent = "Encrypt for push";
      err.textContent = `${said(error, "the value could not be encrypted")} Type the value again.`;
      input.focus();
    }
  });
  document.body.append(dialog);
  dialog.showModal();
  input.focus();
}

function reviewScreen() {
  const p = model.preview;
  const files = heldFiles(model.held);
  const dropped = p?.dropped ?? [];
  const checks = p?.checks ?? [];
  const stop = blockers({ outside: p?.outside ?? model.base?.outside ?? [], dropped, checks, running: model.push.running });
  const editing = model.ops.length > 0;
  const message = h("input", { type: "text", id: "msg", placeholder: editing ? "commit message" : "commit message (optional, for what is already in the repo)", maxlength: "1000", "aria-label": "commit message", value: model.message, oninput: (e) => { model.message = /** @type {HTMLInputElement} */ (e.target).value; model.messageEdited = true; } });
  const go = h("button", { class: "btn primary", disabled: stop.length > 0 || (editing && model.message.trim() === ""), onclick: writeAndPush }, model.push.running ? "Pushing..." : editing ? "Write and push" : "Push");
  return h(
    "div",
    {},
    h("h1", {}, "Review & push"),
    h("p", { class: "sub" }, "The real diff of what will be written. Fleet loads the edited config for every host before it lets you push, the same check ", h("code", {}, "fleet push"), " starts with. Nothing is written until you push."),
    outsideNotice(),
    dropped.length > 0
      ? h("div", { class: "notice" }, h("b", {}, "Some edits no longer apply to the files on disk:"), h("ul", {}, ...dropped.map((/** @type {any} */ d) => h("li", {}, `${opLabel(d.op)}: ${d.reason}`))), h("button", { class: "btn", onclick: forgetDropped }, "Forget them"))
      : null,
    !editing ? h("div", { class: "panel empty" }, "Nothing to push. Click a cell in the Matrix to give or take away a pick, or add to the Catalog.") : h("h2", {}, "Checks"),
    editing ? h("div", { class: "checks" }, ...checks.map(checkCard)) : null,
    model.ops.flatMap(opWarnings).length > 0 ? h("div", { class: "notice inline" }, h("b", {}, "Worth a look before you push:"), h("ul", {}, ...model.ops.flatMap(opWarnings).map((w) => h("li", {}, w)))) : null,
    editing ? planPanel() : null,
    editing ? h("h2", {}, "Files") : null,
    editing ? h("div", { class: "files" }, ...files.map((file) => diffPanel(file, model.held[file].before, model.held[file].after))) : null,
    h("h2", {}, "Push"),
    h(
      "div",
      { class: "panel" },
      h("div", { class: "pushbox" }, message, go, editing ? h("button", { class: "btn ghost danger", disabled: model.push.running, onclick: discardAll }, "Discard all") : null),
      stop.length > 0 && !model.push.running ? h("div", { class: "notice bad inset" }, stop.join("; ")) : null,
      pushPanel(),
    ),
  );
}

/** @param {any} c one host's check */
function checkCard(c) {
  const line = summaryLine(c.changes);
  return h(
    "div",
    { class: "panel chk" },
    h("b", {}, c.host, c.self ? h("span", { class: "tag" }, "this host") : null),
    c.loads ? h("span", { class: "ok" }, "✓ config loads") : h("span", { class: "bad" }, "✕ config does not load"),
    ...c.problems.slice(0, 4).map((/** @type {string} */ t) => h("div", { class: "problem" }, t)),
    h("div", { class: "muted" }, line ?? "no pick changes"),
  );
}

/** This host's full plan, from `fleet diff` on the edited config. Other hosts would need ssh, so they get the summary above. */
function planPanel() {
  const host = model.base?.self;
  const plan = model.plan;
  const text = plan === null || plan.doc === null ? (plan?.error ?? "Planning...") : plan.doc.text.trim() === "" ? (plan.doc.messages.join("\n") || "Nothing would change on this host.") : plan.doc.text.trimEnd();
  return h(
    "div",
    { class: "panel plan" },
    h("div", { class: "ph" }, `Plan for ${host ?? "this host"}`, h("span", { class: "spacer" }), h("span", { class: "tag" }, "fleet diff, on the edited config")),
    h("pre", { class: "term" }, text),
    h("div", { class: "hint" }, "Other hosts are planned when they are pushed: that needs ssh. Their pick changes are above."),
  );
}

/** The lines of a diff, each as the YAML highlighter draws it. @param {[string, string][]} d */
function diffBody(d) {
  return h(
    "pre",
    { class: "yaml" },
    ...d.map(([op, line]) =>
      h("span", { class: "line " + (op === "+" ? "add" : op === "-" ? "del" : "") }, `${op === " " ? " " : op} `, ...tokenize(line).map((t) => (t.cls === "" ? t.text : h("span", { class: t.cls }, t.text)))),
    ),
  );
}

/** @param {string} file @param {string} before @param {string} after */
export function diffPanel(file, before, after) {
  const d = lineDiff(splitLines(before), splitLines(after));
  const { added, removed } = counts(d);
  return h(
    "div",
    { class: "panel" },
    h("div", { class: "ph" }, file, h("span", { class: "spacer" }), file.startsWith("secrets/") ? h("span", { class: "tag warn" }, "encrypted, value not shown") : null, h("span", { class: "tag " + (changed(d) ? "ok" : "") }, changed(d) ? `+${added} -${removed}` : "unchanged")),
    diffBody(d),
  );
}

/** The live push: each host's lane and the output so far. */
function pushPanel() {
  const p = model.push;
  const lanes = p.lanes.map((l) =>
    h(
      "div",
      { class: "lane" },
      h("span", {}, l.state === "done" ? (l.result === "ok" ? "✓" : "!") : l.state === "skip" ? "·" : l.state === "running" ? "▸" : "·"),
      h("span", {}, l.host),
      h("span", { class: "tag" }, l.via),
      h("div", { class: "bar2" }, h("i", { style: `width:${l.state === "done" ? 100 : l.of ? Math.round(((Number(l.step?.split("/")[0]) || 0) / l.of) * 100) : l.state === "running" ? 8 : 0}%` })),
      h("span", { class: "t" }, l.state === "done" ? `${l.result ?? ""} ${l.changes}` : l.state),
      l.step || l.stage ? h("span", { class: "what" }, l.step ?? l.stage) : null,
    ),
  );
  return h(
    "div",
    {},
    p.end || p.stage ? h("div", { class: "row inset" }, p.end ? h("span", { class: "tag " + (p.end.ok ? "ok" : "bad") }, p.end.code) : null, p.stage ? h("span", { class: "tag" }, p.stage) : null) : null,
    model.pushError !== null ? h("div", { class: "notice bad inset" }, model.pushError) : null,
    lanes.length > 0 ? h("div", { class: "lanes" }, ...lanes) : null,
    h("pre", { class: "term", "aria-live": "polite" }, p.log.length > 0 ? p.log.join("\n") : h("span", { class: "muted" }, "Live push output shows here.")),
  );
}

// ---- Actions

let previewSeq = 0;

/** Asks the server what the held edits do now, and keeps the answer. Answers that arrive late are ignored. */
async function refreshPreview() {
  if (client === null) return;
  const seq = ++previewSeq;
  const focus = model.focus ?? model.base?.hosts?.[0]?.name ?? null;
  try {
    const doc = await client.preview(model.ops, focus === null ? undefined : `hosts/${focus}.yaml`);
    if (seq !== previewSeq) return;
    model.preview = doc;
    model.matrixError = null;
    model.held = Object.fromEntries(doc.files.map((/** @type {any} */ f) => [f.path, { before: f.before, after: f.after }]));
    if (!model.messageEdited) model.message = suggestMessage(doc.applied);
  } catch (e) {
    if (seq !== previewSeq) return;
    model.matrixError = e instanceof ApiError ? `${e.messages.join("; ") || e.message} (${e.code})` : "the preview could not be read";
  }
  render();
  if (routeOf(location.hash) === "review") loadPlan();
}

async function loadMatrix() {
  if (client === null) return;
  try {
    model.base = await client.matrix();
    model.matrixError = null;
  } catch (e) {
    model.matrixError = e instanceof ApiError ? `${e.messages.join("; ") || e.message} (${e.code})` : "the config could not be read";
  }
  render();
  refreshPreview();
}

/** This host's plan for the held edits, once per set of edits. */
async function loadPlan() {
  if (client === null || model.ops.length === 0) return;
  const key = JSON.stringify(model.ops);
  if (model.plan?.key === key) return;
  model.plan = { key, doc: null, error: null };
  render();
  try {
    const doc = await client.plan(model.ops);
    if (model.plan?.key === key) model.plan = { key, doc, error: null };
  } catch (e) {
    if (model.plan?.key === key) model.plan = { key, doc: null, error: e instanceof ApiError ? e.messages.join("; ") || e.message : "the plan could not be read" };
  }
  render();
}

/** @param {string} host @param {"bundles" | "mcp"} kind @param {string} name */
function click(host, kind, name) {
  const baseRow = (kind === "bundles" ? model.base.bundles : model.base.servers).find((/** @type {any} */ r) => r.name === name);
  model.ops = clickCell(model.ops, host, kind, name, baseRow?.cells[host]);
  model.messageEdited = false;
  model.focus = host;
  refreshPreview();
}

/** @param {string} host */
function focusHost(host) {
  model.focus = host;
  refreshPreview();
}

function discardAll() {
  model.ops = [];
  model.held = {};
  model.plan = null;
  model.messageEdited = false;
  model.pushError = null;
  refreshPreview();
}

function forgetDropped() {
  model.ops = model.preview?.applied ?? [];
  refreshPreview();
}

/** Writes the held edits, commits them with the message and pushes, or just pushes when nothing is held. */
async function writeAndPush() {
  if (client === null) return;
  const message = model.message.trim();
  model.pushError = null;
  model.push = { ...idlePush(), running: true };
  render();
  try {
    // The events arrive on the stream while this call is open; its own answer is the end.
    if (model.ops.length === 0) {
      model.push = pushEnd(model.push, await client.push(message === "" ? undefined : message));
    } else {
      const done = await client.write(model.ops, message);
      model.push = pushEnd(model.push, done.push);
      model.ops = [];
      model.plan = null;
      model.messageEdited = false;
    }
  } catch (e) {
    model.push = { ...model.push, running: false };
    if (e instanceof ApiError) model.pushError = e.messages.join("; ") || e.message;
    else throw e;
  }
  loadStatus();
  loadMatrix();
  loadSecrets();
}

async function loadStatus() {
  if (client === null) return;
  try {
    model.status = await client.status();
    model.statusError = null;
  } catch (e) {
    model.statusError = e instanceof ApiError ? `${e.messages.join("; ") || e.message} (${e.code})` : "the status could not be read";
  }
  render();
}

async function loadSecrets() {
  if (client === null) return;
  try {
    model.secrets = await client.secrets();
    model.secretsError = null;
  } catch (e) {
    model.secretsError = e instanceof ApiError ? e.messages.join("; ") || e.message : "the secret names could not be read";
  }
  render();
}

/** Each screen reads what it shows when it is opened, so it is never older than the click that opened it. */
function opened() {
  const route = routeOf(location.hash);
  model.menu = false;
  render();
  if (route === "secrets") loadSecrets();
  if (route === "review") loadPlan();
  if (route === "matrix" || route === "catalog" || route === "hosts") loadMatrix();
}

window.addEventListener("hashchange", opened);
render();
if (token !== null) {
  loadStatus();
  loadMatrix();
  loadSecrets();
  openStream(token, {
    onHello: (doc) => {
      if (doc?.pushing && !model.push.running) model.push = { ...model.push, running: true };
      loadStatus();
    },
    onEvent: (name, doc) => {
      if (name === "init") model.init = initLine(model.init, doc);
      else if (name === "initend") model.init = initEnd(model.init, doc);
      else model.push = name === "push" ? pushEvent(model.push, doc) : pushEnd(model.push, doc);
      render();
    },
    onLink: (live) => {
      model.link = live ? "live" : "reconnecting";
      render();
    },
  });
}
