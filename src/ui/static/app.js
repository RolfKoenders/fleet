// The page: the shell, routing between screens, and drawing the state from state.js.
import { ApiError, createClient, openStream } from "./api.js";
import { dropToken, loadCaptured, loadOps, pageToken, saveCaptured, saveOps, tabStore } from "./session.js";
import { linkBanner, linkUsable, linkWord } from "./link.js";
import { jobLabel, jobsOf, withJobs } from "./jobs.js";
import { changed, counts, lineDiff, splitLines, tokenize } from "./diff.js";
import { fill, h } from "./dom.js";
import { ADD, addable, CATALOG_KINDS, closable, confirmLabel, fileOf, freshAdd, hostAsDraft, nearChanges, paneView } from "./adding.js";
import { bundleDraft, checkLines, cloneKey, confirmText, needsLook, opWarnings, secretOf, secretsOf, serverDraft, shownAgents, skillChoices, sourceDraft, sourceEditDraft, sourceInputs, takeBack } from "./catalog.js";
import { bundleFormOf, EDIT, EDIT_DROP_LABEL, EDIT_LABEL, editPaneView, freshEdit, hostEditDraft, hostFormOf, isAddition, ownOp, readOnlyLines, removalOp, serverAsAdded, serverFormOf, sourceFormOf, startOf, withEdit } from "./editing.js";
import { bundleLosses, EMPTY_BUNDLE, goLabel, heldForHost, hostKeeps, hostRefusal, hostRuns, lossLine, NO_SKILLS_KNOWN, readableNames, removal, REMOVE, ROTATE, ROTATE_NOW, sourceSkills, touched } from "./removing.js";
import { blockers, cellAction, DROPPED_BLOCKER, cellState, clickCell, opLabel, suggestMessage, summaryLine, WORDS } from "./matrix.js";
import { confirmInit, elapsed, heldProblem, hostDraft, idleInit, initEnd, initLine, SETUP_DOC, startInit } from "./hosts.js";
import { actionOf, afterSet, cellView, dialogTargets, heldNames, missingCount, namesOf, retryText, rowsNamed, secretsHashFor, valueProblem } from "./secrets.js";
import { escapeAction, filterRows, hashWithQuery, hiddenWithChanges, nameMatches, queryOf, skillHits, slashFocuses } from "./filter.js";
import { canCopyImage, CARD_SIZE, clipboardProblem, discussionUrl, embedFonts, FONT_FILES, fileName, STYLES as CARD_STYLES, unseenNote } from "./card.js";
import { itemYaml, yamlPath, yamlTag } from "./yamlview.js";
import { withFleetDoc } from "./fleet.js";
import { fleetScreen } from "./fleetview.js";
import { captureScreen } from "./captureview.js";
import { decisionOf, doneWords, draftOf as captureDraft, idOf as captureId } from "./capture.js";
import { heldFiles, idlePush, plain, pushEnd, pushEvent, routeOf, statusView, tokenOf, writtenNotice } from "./state.js";

/** @typedef {import("./state.js").Held} Held */
/** @typedef {import("./state.js").PushState} PushState */
/** @typedef {import("./matrix.js").Op} Op */
/** What the Remove dialog holds: the item, what the server said of it, and what the removal would do to the held edits. @typedef {{
 *   kind: import("./adding.js").AddKind, name: string, state: "loading" | "ready" | "error", error: string | null,
 *   plan: ReturnType<typeof removal> | null, skills: string[], diffs: { path: string, before: string, after: string }[], dropped: any[], broken: string | null, host: any, confirm: boolean,
 * }} RemoveState */

const main = /** @type {HTMLElement} */ (document.getElementById("main"));
const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** This tab's storage: it survives a reload of the tab and is shared with no other tab. Null when the browser blocks it. */
const store = tabStore();
const fromAddress = tokenOf(location.hash);
// The token leaves the address bar at once, so it is not in the history or a bookmark. It is kept for a reload of this tab only.
const token = pageToken(store, fromAddress);
if (fromAddress !== null) history.replaceState(null, "", location.pathname + "#/fleet");

$("local").textContent = `${location.host} · only this machine`;

/**
 * `base`: the matrix as the files on disk say. `ops`: the edits held here, replayed by the server on every preview.
 * `preview`: the server's answer for them (files, dropped edits, the matrix after, a check per host).
 * @type {{
 *   status: any, statusError: string | null, matrixError: string | null,
 *   base: any, ops: Op[], preview: any, held: Held, focus: string | null, expanded: Set<string>,
 *   plan: { key: string, doc: any, error: string | null } | null,
 *   message: string, messageEdited: boolean, secrets: any, secretsError: string | null,
 *   push: PushState, pushError: string | null, pushNotice: string | null, link: import("./link.js").Link, jobs: import("./jobs.js").Job[],
 *   skills: { name: string, source: string, bundle: string | null }[], stagedSkills: Record<string, string[]>,
 *   form: import("./adding.js").AddState | null, menu: boolean, init: import("./hosts.js").InitState, initError: string | null,
 *   yaml: Record<string, string>, yamlErrors: Record<string, string>, yamlOpen: Set<string>,
 *   rm: RemoveState | null, removal: import("./hosts.js").InitState, removalError: string | null,
 *   card: { style: string, names: boolean, doc: any, svg: string | null, url: string | null, error: string | null, message: { text: string, tone: string } | null, busy: boolean }
 *   fleet: any, fleetError: string | null, fleetAsking: boolean, fleetOpen: Set<string>,
 *   capture: { doc: any, error: string | null, drafts: Record<string, import("./capture.js").Draft>, done: Record<string, string>, busy: string | null, notice: string | null },
 *   captured: { kind: string, name: string }[],
 * }}
 */
const model = {
  status: null, statusError: null, matrixError: null,
  base: null, ops: [], preview: null, held: {}, focus: null, expanded: new Set(),
  plan: null, message: "", messageEdited: false, secrets: null, secretsError: null,
  push: idlePush(), pushError: null, pushNotice: null, link: "connecting", jobs: [],
  skills: [], stagedSkills: {}, form: null, menu: false,
  init: idleInit(), initError: null,
  yaml: {}, yamlErrors: {}, yamlOpen: new Set(),
  rm: null, removal: idleInit(), removalError: null,
  card: { style: "machines", names: false, doc: null, svg: null, url: null, error: null, message: null, busy: false },
  fleet: null, fleetError: null, fleetAsking: false, fleetOpen: new Set(),
  capture: { doc: null, error: null, drafts: {}, done: {}, busy: null, notice: null },
  captured: [],
};

// The To push list is restored after a reload. See session.js: it holds edits only, never a plain secret value.
if (token !== null) model.ops = loadOps(store);
let savedOps = model.ops;
// What Capture answered and has not pushed is restored with it: the same tab, names only.
if (token !== null) {
  const kept = loadCaptured(store);
  model.captured = kept.captured;
  model.capture.done = kept.done;
}
let savedCaptured = model.captured;
let savedDone = model.capture.done;

/** The token will never be valid again: this page is talking to a server that was started again. */
function denied() {
  if (model.link === "invalid") return;
  model.link = "invalid";
  dropToken(store);
  render();
}

const client = token === null ? null : createClient(token, undefined, { onDenied: denied });

/** @type {Record<string, [string, string]>} */
const SCREENS = {
  matrix: ["Matrix", "What each host gets: every skill bundle and MCP server against every host. Click a cell to give it to a host or take it away. Fleet writes the smallest change: an item the defaults give is taken away with exclude, not by editing the defaults."],
  catalog: ["Catalog", "The MCP servers, skill sources and skill bundles your hosts can pick from. Add one with the Add button: it gives it to no host yet, pick it in the Matrix. An addition is a change to push like any edit, and written when you push."],
  hosts: ["Hosts", "The hosts in this config, and how each is reached. Add a host and fleet sets it up over ssh: it writes its host file, then runs the real fleet init."],
  card: ["Card", "An image of your fleet to share: its counts, each machine with its agents and OS, and a year of changes. It is made from what fleet last saw of each machine and asks none of them. Hosts are named host 1, host 2 unless you turn names on, and no server, skill, source or secret name is ever on it."],
  secrets: ["Secrets", "Names only. fleet ui never reads a value back, never shows one, and never writes one to disk unencrypted: a value you type goes straight to sops. Set a value and the encrypted file is a change to push like any edit, and written when you push."],
};

/** When the running `fleet init` was first seen running, in this page's time, for "running for 42 s". 0 while none runs. */
let initSince = 0;
/** @type {number} */
let initTick = 0;

/** Starts or stops the clock of the init pane. It only rewrites the text of one tag, so nothing else is drawn again every second. */
function syncInitClock() {
  if (model.init.running && initSince === 0) {
    initSince = Date.now();
    initTick = window.setInterval(() => {
      const clock = document.getElementById("initclock");
      if (clock !== null) clock.textContent = `running for ${elapsed(Date.now() - initSince)}`;
    }, 1000);
  } else if (!model.init.running && initSince !== 0) {
    initSince = 0;
    clearInterval(initTick);
  }
}

/** The screen drawn last: drawing the same one again keeps its scroll. */
let drawn = "";

function render() {
  syncInitClock();
  const route = routeOf(location.hash);
  for (const a of document.querySelectorAll("#side a")) a.classList.toggle("on", /** @type {HTMLElement} */ (a).dataset.r === route);

  const n = model.ops.length;
  $("tray").className = "tray " + (n > 0 ? "has" : "none");
  $("trayn").textContent = String(n);
  $("sidecount").textContent = n > 0 ? String(n) : "";
  const missing = missingCount(shownSecrets());
  $("secretcount").textContent = missing > 0 ? `${missing} missing` : "";
  const link = $("link");
  link.textContent = linkWord(model.link);
  link.className = "tag " + (model.link === "live" ? "ok" : model.link === "reconnecting" ? "warn" : model.link === "invalid" ? "bad" : "");
  const jobs = $("jobs");
  jobs.textContent = model.jobs.map(jobLabel).join("; ");
  jobs.hidden = model.jobs.length === 0;
  if (model.ops !== savedOps) {
    savedOps = model.ops;
    saveOps(store, model.ops);
  }
  if (model.captured !== savedCaptured || model.capture.done !== savedDone) {
    savedCaptured = model.captured;
    savedDone = model.capture.done;
    saveCaptured(store, { captured: model.captured, done: model.capture.done });
  }
  const loose = Number(model.status?.unmanaged ?? 0);
  $("capturecount").textContent = loose > 0 ? String(loose) : "";
  const s = model.status ? statusView(model.status) : null;
  fill($("repo"), ...(s ? [h("b", {}, s.host), ...(model.status?.repos?.fleet ? [h("span", {}, `${model.status.repos.fleet.branch ?? "detached"}@${String(model.status.repos.fleet.sha).slice(0, 7)}`)] : [])] : []));

  if (client === null) return fill(main, noToken());
  // Typing in the commit message must survive the page being drawn again by a push event or an answer.
  const active = document.activeElement;
  const keep = active instanceof HTMLElement && main.contains(active) && active.id !== "" ? { id: active.id, at: active instanceof HTMLInputElement ? active.selectionStart : null } : null;
  const scroll = route === drawn ? main.scrollTop : 0;
  drawn = route;
  // The push log stays on its newest line when it was there (or is new), and where the person scrolled it to otherwise.
  const log = document.getElementById("pushlog");
  const logAt = log === null ? null : { top: log.scrollTop, end: log.scrollTop + log.clientHeight >= log.scrollHeight - 4 };
  const banner = linkBanner(model.link, { held: model.ops.length, working: model.push.running || model.init.running });
  fill(main, ...(banner === null ? [] : [linkNotice(banner)]), screen(route));
  main.scrollTop = scroll;
  const again = document.getElementById("pushlog");
  if (again !== null) again.scrollTop = logAt === null || logAt.end ? again.scrollHeight : logAt.top;
  if (keep !== null && keep.id !== "") {
    const back = document.getElementById(keep.id);
    if (back instanceof HTMLElement && main.contains(back)) {
      back.focus();
      if (back instanceof HTMLInputElement && keep.at !== null) back.setSelectionRange(keep.at, keep.at);
    }
  }
  renderDialog();
  renderRemove();
  returnFocus();
}

/** @param {string} route */
function screen(route) {
  if (route === "fleet") return fleetView();
  if (route === "status") return statusScreen();
  if (route === "review") return reviewScreen();
  if (route === "matrix") return matrixScreen();
  if (route === "catalog") return catalogScreen();
  if (route === "hosts") return hostsScreen();
  if (route === "card") return cardScreen();
  if (route === "capture") return captureView();
  return secretsScreen();
}

/** @param {{ title: string, lines: string[] }} banner */
const linkNotice = (banner) => h("div", { class: "notice bad banner", id: "linkbanner", role: "alert" }, h("b", {}, banner.title), ...banner.lines.map((l) => h("div", {}, l)));

function noToken() {
  return h(
    "div",
    {},
    h("h1", {}, "fleet ui"),
    h("div", { class: "notice bad" }, "This page cannot do anything without its token."),
    h("p", { class: "sub" }, "Open the URL that ", h("code", {}, "fleet ui"), " printed, including the part after #. If fleet ui is not running, run it again first. Edits that were on To push in a tab are kept in that tab only while it is open."),
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

/** The agents a server can be for, in the order the server lists them. */
const agentList = () => /** @type {{ id: string, name: string, used?: boolean }[]} */ (model.base?.agents ?? []);

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
  const q = query();
  const whole = shownMatrix();
  const view = { ...whole, bundles: filterRows(whole.bundles, q, (/** @type {any} */ b) => b.skills), servers: filterRows(whole.servers, q) };
  const hosts = view.hosts;
  if (hosts.length === 0) return h("div", {}, h("h1", {}, title), h("div", { class: "panel empty" }, "No hosts yet."));
  const focus = model.focus !== null && hostOf(view, model.focus) ? model.focus : hosts[0].name;

  /** @param {"bundles" | "mcp"} kind @param {any} row @param {string} small @param {string[] | null} [skill] the skills of a bundle that hold the filter, when its name does not */
  const rowOf = (kind, row, small, skill = null) => {
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
        h("small", {}, baseRow === undefined ? `${small} · new, to push` : small, skill ? ` · skill ${skillHits(skill, q).join(", ")}` : ""),
      ),
      ...hosts.map((/** @type {any} */ host) => {
        const state = cellState(row.cells[host.name]);
        const staged = cellState(baseRow?.cells[host.name]) !== state;
        const [mark, word] = WORDS[state];
        const act = cellAction(state, staged);
        return h(
          "td",
          {},
          h(
            "button",
            {
              class: `cell ${state} ${staged ? "staged" : ""} ${host.name === focus ? "focus" : ""}`,
              title: `${row.name} on ${host.name}: ${word}${staged ? " (to push)" : ""}. Click to ${act}.`,
              "aria-label": `${row.name} on ${host.name}: ${word}${staged ? ", to push" : ""}`,
              onclick: () => click(host.name, kind, row.name),
            },
            h("span", { class: "mk" }, mark),
            h("span", { class: "w" }, word),
            h("span", { class: "act", "aria-hidden": "true" }, act),
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
      h("th", { class: host.name === focus ? "focus" : "" }, h("button", { class: "hostbtn", title: `Show hosts/${host.name}.yaml`, "aria-pressed": String(host.name === focus), onclick: () => focusHost(host.name) }, fileIcon(), host.name), h("span", { class: "v" }, host.self ? "this host" : host.ssh ?? "timer only")),
    ),
  );
  const body = [];
  if (view.bundles.length > 0) body.push(h("tr", { class: "grp" }, h("th", { colspan: String(hosts.length + 1) }, "Skill bundles")));
  for (const b of view.bundles) {
    const viaSkill = nameMatches(b.name, q) || skillHits(b.skills, q).length === 0 ? null : b.skills;
    body.push(rowOf("bundles", b, `${b.skills.length} skill${b.skills.length === 1 ? "" : "s"}`, viaSkill));
    if (model.expanded.has(b.name)) for (const skill of b.skills) body.push(h("tr", { class: "skill" + (skillHits([skill], q).length > 0 ? " hit" : "") }, h("th", { colspan: String(hosts.length + 1) }, `└ ${skill}`)));
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
    pageHead(title, about, addMenu([...CATALOG_KINDS, "host"])),
    filterBar(rowIds(whole), rowIds(view), "Filter bundles, skills and servers by name"),
    outsideNotice(),
    model.base.problems.length > 0 ? h("div", { class: "notice" }, "Config problem: " + model.base.problems[0]) : null,
    h(
      "div",
      { class: "split" },
      body.length === 0 ? noMatch(q) : h("div", { class: "panel scroll" }, h("table", { class: "matrix" }, h("thead", {}, head), h("tbody", {}, ...body))),
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

/** A small file icon, from the page's template: the host's name opens its file in the pane. */
const fileIcon = () => /** @type {HTMLTemplateElement | null} */ (document.getElementById("ic-file"))?.content.firstElementChild?.cloneNode(true) ?? null;

/** @param {any} sv */
const serverLine = (sv) => (sv.server ? `${sv.server.kind}${sv.server.only.length === 1 ? ` · ${sv.server.only[0]} only` : ""}${sv.server.secrets > 0 ? ` · ${sv.server.secrets} secret${sv.server.secrets === 1 ? "" : "s"}` : ""}` : "");

/** The config repo has changes of its own: listed, and nothing is pushed until they are committed or discarded elsewhere. */
function outsideNotice() {
  const outside = model.preview?.outside ?? model.base?.outside ?? [];
  // While a host is being set up, its own files (the host file, .sops.yaml, secrets/) are the changes: they are not the person's.
  if (model.init.running) return h("div", { class: "notice" }, h("b", {}, `fleet init of ${model.init.name ?? "a host"} is running.`), " It is changing the config repo itself: wait for it to end before you commit, discard or push anything.");
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

/** Whether something may be changed now: not while the server cannot be reached. */
const usable = () => linkUsable(model.link);

const skillOptions = () => skillChoices(model.skills, model.ops, model.stagedSkills);
const hostNames = () => (model.base?.hosts ?? []).map((/** @type {any} */ x) => x.name);

/** What the open dialog would hold (a catalog edit, or a host request), or why it cannot yet. @param {import("./adding.js").AddState} f @returns {any} */
function draftOf(f) {
  if (f.edit !== null) return editDraftOf(f);
  const view = shownMatrix();
  const held = (/** @type {string} */ op) => model.ops.filter((/** @type {any} */ o) => o.op === op).map((/** @type {any} */ o) => o.name);
  if (f.kind === "server") return serverDraft(f.server, view.servers.map((/** @type {any} */ r) => r.name), held("addServer"));
  if (f.kind === "source") return sourceDraft(f.source, (view.sources ?? []).map((/** @type {any} */ r) => r.name), f.clone.doc, held("addSource"));
  if (f.kind === "host") return hostAsDraft(f.host, hostNames());
  return bundleDraft(f.bundle, view.bundles.map((/** @type {any} */ r) => r.name), skillOptions(), held("addBundle"));
}

/** What an Edit dialog holds: an edit of the item as it is in the file, or nothing while it is not read yet. @param {import("./adding.js").AddState} f @returns {any} */
function editDraftOf(f) {
  const e = /** @type {import("./editing.js").EditState} */ (f.edit);
  if (e.state !== "ready") return { op: null, problems: [], warnings: [] };
  if (f.kind === "server") return serverDraft(f.server, [], [], e.base);
  if (f.kind === "source") return sourceEditDraft(f.source, e.base, f.clone.doc);
  if (f.kind === "host") return hostEditDraft(f.host, e.base);
  return bundleDraft(f.bundle, [], skillOptions(), [], e.base);
}

/** The held edits as they would be with the open Edit dialog's edit in them, and the op that went in. @param {import("./adding.js").AddState} f @param {any} d */
const editedOps = (f, d) => withEdit(model.ops, ownOp(model.ops, f.kind, /** @type {import("./editing.js").EditState} */ (f.edit).name), d.op, /** @type {import("./editing.js").EditState} */ (f.edit).base);

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
  openForm(freshAdd(kind, agentList()), opener);
}

/**
 * Opens the dialog that edits an item that is there: the Add dialog of its kind, prefilled from the file once it is read. The name stays.
 * @param {import("./adding.js").AddKind} kind @param {string} name @param {string} [opener]
 */
function openEdit(kind, name, opener = "") {
  if (openForm(freshEdit(kind, name, agentList()), opener)) loadEdit();
}

/** Tab wraps inside the dialog: from its last control to its first, and back. @param {HTMLDialogElement} dialog */
function trapTab(dialog) {
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
}

/** @param {import("./adding.js").AddState} form @param {string} opener @returns {boolean} whether it opened */
function openForm(form, opener) {
  if (client === null || !usable() || model.form !== null || model.base === null) return false;
  const kind = form.kind;
  openerId = opener !== "" ? opener : document.activeElement instanceof HTMLElement ? document.activeElement.id : "";
  if (kind === "host" && form.edit === null) {
    if (!model.init.running) model.init = idleInit();
    model.initError = null;
  }
  model.form = form;
  const dialog = h("dialog", { class: "adlg", "aria-labelledby": "adlg-title" });
  dialogEl = dialog;
  // Esc: the browser closes the dialog. While a host is being set up it must not, the run goes on without the page.
  dialog.addEventListener("cancel", (e) => {
    if (!closable(kind, model.init, form.edit !== null)) e.preventDefault();
  });
  trapTab(dialog);
  dialog.addEventListener("close", () => {
    // A second Esc can slip past the cancel event; a dialog that may not close is shown again.
    if (model.form !== null && !closable(kind, model.init, form.edit !== null)) return void dialog.showModal();
    dropDialog(dialog);
  });
  document.body.append(dialog);
  document.documentElement.classList.add("modal");
  renderDialog();
  dialog.showModal();
  firstField();
  if (kind !== "host") {
    // An Edit dialog reads the skills itself: it needs them to tell the ticked skills from the typed ones.
    if (form.edit === null) loadSkills();
    loadSecrets();
  }
  scheduleLive();
  return true;
}

/** Reads the item the dialog edits and fills the form from it: the item as the file has it, with the held edit of it on top. */
async function loadEdit() {
  const f = model.form;
  if (f === null || f.edit === null || client === null) return;
  const name = f.edit.name;
  const own = ownOp(model.ops, f.kind, name);
  try {
    // The file is read as it would be without this item's own edit: the dialog's edit replaces it.
    const [doc] = await Promise.all([client.entry(model.ops.filter((o) => o !== own), f.kind, name), f.kind === "bundle" ? loadSkills() : null]);
    if (model.form !== f) return;
    const s = startOf(f.kind, name, doc, own);
    f.edit = { ...f.edit, state: s.state, error: s.error, reason: s.reason, path: doc.path, text: doc.text ?? "", base: s.base };
    if (s.state === "ready") {
      if (f.kind === "server") f.server = serverFormOf(name, s.value, agentList());
      else if (f.kind === "source") f.source = sourceFormOf(name, s.value);
      else if (f.kind === "host") f.host = hostFormOf(name, s.value);
      else f.bundle = bundleFormOf(name, s.value, skillOptions());
    }
  } catch (e) {
    if (model.form !== f) return;
    f.edit = { ...f.edit, state: "error", error: said(e, "the item could not be read") };
  }
  renderDialog();
  firstField();
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

/** The edit goes onto To push, in place of the item's own edit or unpushed addition, and the dialog is closed. @param {import("./adding.js").AddState} f @param {any} d */
function saveEdit(f, d) {
  const e = f.edit;
  if (e === null || e.state !== "ready") return;
  const own = ownOp(model.ops, f.kind, e.name);
  if (d.op === null && !(d.unchanged && own !== undefined && !isAddition(own))) return;
  const { ops, sent } = editedOps(f, d);
  if (sent !== null && (sent.op === "addSource" || sent.op === "editSource") && f.clone.doc) model.stagedSkills[sent.name] = f.clone.doc.skills;
  model.ops = ops;
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
    const doc = await (f.kind === "host" && f.edit === null ? client.previewHost(d.op) : client.preview(f.edit !== null ? editedOps(f, d).ops : [...model.ops, d.op], undefined, model.stagedSkills));
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
  if (s.repo.trim() === "" || f.clone.state === "running" || Object.values(sourceInputs(s)).some((p) => p !== null)) return;
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
  // The error is below the button, and may be past the end of what the dialog shows.
  setTimeout(() => dialogEl?.querySelector(".cloneerr")?.scrollIntoView({ block: "nearest" }), 0);
}

async function runCheck() {
  const f = model.form;
  const d = f === null ? null : draftOf(f);
  const full = f === null || d === null ? null : serverAsAdded(d, f.edit?.base ?? null, f.server.name.trim());
  if (f === null || client === null || full === null || full.op !== "addServer") return;
  const key = JSON.stringify(full);
  f.confirm = false;
  f.check = { key, state: "running" };
  renderDialog();
  try {
    const doc = await client.probe(full.name, full.entry);
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
  if (f.edit !== null) {
    if (f.edit.state !== "ready") return;
    if (f.kind === "source" && d.op === null && needsLook(f.source, f.edit.base) && !(f.clone.doc !== null && f.clone.doc.key === cloneKey(f.source))) return void lookAtRepo();
    return saveEdit(f, d);
  }
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
    field("f-name", "Name", textInput("f-name", s.name, (v) => (s.name = v), f.edit !== null ? { disabled: true } : {}), ["How host files pick it: ", h("code", {}, `mcp.include: [${s.name.trim() || "name"}]`), f.edit !== null ? ". The name stays: a rename would leave the host files that pick it pointing at nothing." : ""]),
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
    agentField(s),
  ];
}

/** The agents checkboxes of a server form: the agents in use, and the rest behind "Show all agents". @param {any} s */
function agentField(s) {
  const shown = shownAgents(agentList(), s);
  const hidden = agentList().filter((a) => !shown.includes(a));
  const unused = agentList().filter((a) => a.used === false);
  return h(
    "div",
    { class: "field" },
    h("label", {}, "Agents"),
    h("div", { class: "row" }, ...shown.map((/** @type {{ id: string, name: string }} */ a) => check(`f-agent-${a.id}`, a.name, s.agents[a.id] === true, (v) => (s.agents[a.id] = v)))),
    unused.length === 0
      ? null
      : h("button", { type: "button", id: "f-agents-all", class: "btn ghost small", "aria-pressed": String(s.showAll === true), onclick: () => { s.showAll = s.showAll !== true; edited(); } }, s.showAll === true ? "Hide agents no host has" : "Show all agents"),
    hidden.length === 0 ? null : h("div", { class: "help" }, `Also for ${hidden.map((a) => a.name).join(" and ")}: no host has ${hidden.length === 1 ? "it" : "them"} yet, so ${hidden.length === 1 ? "it is" : "they are"} not shown.`),
  );
}

/** @param {any} f */
function sourceFields(f) {
  const s = f.source;
  const c = f.clone;
  const fresh = c.doc !== null && c.doc.key === cloneKey(s);
  const typed = sourceInputs(s);
  const wrong = (/** @type {string | null} */ p, /** @type {any} */ help) => (p === null ? help : h("span", { class: "bad" }, p));
  const edit = f.edit !== null;
  const base = edit ? f.edit.base : null;
  const look = edit && needsLook(s, base);
  const moved = edit && fresh && c.doc.problem === null && (s.mode === "pin") && (look && (s.mode === "pin") !== (base.commit !== undefined) || (s.branch.trim() || c.doc.headBranch || "") !== (base.track ?? base.branch ?? ""));
  return [
    field("s-name", "Name", textInput("s-name", s.name, (v) => (s.name = v), edit ? { disabled: true } : {}), edit ? "What bundles and messages call it. It stays." : "What bundles and messages call it."),
    field("s-repo", "Repo", textInput("s-repo", s.repo, (v) => (s.repo = v), edit ? { disabled: true } : { placeholder: "the repo URL, or a path on this machine" }), edit ? "The repo stays: your machines keep each source's clone under its name, so a different repo would break them. For another repo, add another source." : wrong(typed.repo, "A URL, or a path on this machine. It is cloned shallowly into a temp directory to list its skills, and the clone is deleted when you close this dialog.")),
    field("s-path", "Path in the repo", textInput("s-path", s.path, (v) => (s.path = v), { placeholder: "." }), wrong(typed.path, "Where to look for skills: directories with a SKILL.md, at any depth. Use . for the whole repo.")),
    field("s-branch", "Branch", textInput("s-branch", s.branch, (v) => (s.branch = v), { placeholder: "the repo's default" }), typed.branch === null ? null : h("span", { class: "bad" }, typed.branch)),
    field("s-mode", "Keep it", seg("s-mode", ["pinned to a commit", "following the branch"], ["pin", "follow"], s.mode, (v) => (s.mode = v)), s.mode === "pin" ? "A pinned source moves only when you run fleet skills update, so a change upstream cannot reach your machines unreviewed." : "A followed source is on the newest commit of its branch at every apply. Use it for skills you write."),
    s.mode === "pin" ? h("div", { class: "field" }, check("s-review", "Review what a move brings in before the pin changes (review: true)", s.review, (v) => (s.review = v))) : null,
    h(
      "div",
      { class: "row" },
      h("button", { type: "button", id: "s-look", class: "btn", disabled: s.repo.trim() === "" || typed.repo !== null || typed.branch !== null || typed.path !== null || c.state === "running", onclick: lookAtRepo }, c.state === "running" ? "Cloning..." : fresh ? "Look again" : "Look at the repo"),
    ),
    c.state === "error" ? h("div", { class: "notice bad inline cloneerr", role: "alert" }, c.error) : null,
    fresh && c.doc.problem === null
      ? h("div", { class: "found" }, h("div", { class: "muted" }, `${c.doc.skills.length} skill${c.doc.skills.length === 1 ? "" : "s"} found at ${c.doc.path}; head ${c.doc.commit.slice(0, 7)}${c.doc.headBranch ? ` on ${c.doc.headBranch}` : ""}`), moved ? h("div", { class: "muted" }, `The pin moves to ${c.doc.commit.slice(0, 7)}, the head of ${s.branch.trim() || c.doc.headBranch}.`) : null, h("div", { class: "row" }, ...c.doc.skills.slice(0, 40).map((/** @type {string} */ sk) => h("span", { class: "tag" }, sk))))
      : edit && !look ? h("div", { class: "help" }, "The pin stays where it is. A different branch, or keeping it another way, needs a look at the repo first: the pin then moves to the head of the branch.") : null,
  ];
}

/** @param {any} f */
function bundleFields(f) {
  const b = f.bundle;
  const options = skillOptions();
  return [
    field("b-name", "Name", textInput("b-name", b.name, (v) => (b.name = v), f.edit !== null ? { disabled: true } : {}), ["How host files pick it: ", h("code", {}, `bundles: [${b.name.trim() || "name"}]`), f.edit !== null ? ". The name stays: a rename would leave the host files that pick it pointing at nothing." : ""]),
    h(
      "div",
      { class: "field" },
      h("label", {}, "Skills"),
      options.length === 0
        ? h("div", { class: "help" }, "No source has been cloned here yet, so no skill is listed. Add a skill source first, or type the names below.")
        : h("div", { class: "skills" }, ...options.map((k, i) => check(`b-s${i}`, `${k.name}${k.bundle ? ` (in ${k.bundle})` : ""}`, b.picked.includes(k.name), (v) => (b.picked = v ? [...b.picked, k.name] : b.picked.filter((/** @type {string} */ x) => x !== k.name)), k.bundle !== null && k.bundle !== b.name))),
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

/** The fields of the Edit-a-host dialog: the ssh destination, and nothing else of the host. @param {any} f */
function hostEditFields(f) {
  const d = hostEditDraft(f.host, f.edit.base);
  return [
    field("host-name", "Name", textInput("host-name", f.host.name, () => {}, { disabled: true }), "The name stays: it is the host's file, its secrets file and the name fleet init wrote on the machine."),
    field("host-ssh", "Reach it over ssh", textInput("host-ssh", f.host.ssh, (v) => (f.host.ssh = v), { placeholder: "me@mini.local" }), d.problems.length === 0 ? "How fleet reaches this host to apply a push. Its bundles and servers stay on the Matrix; admin, age, vars, settings and files stay hand-written in the host's file." : h("span", { class: "bad" }, d.problems[0])),
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

/** An Edit form that holds what the file holds while an edit of the item is on To push: saving it takes that edit off. @param {any} f @param {any} d */
function droppingEdit(f, d) {
  const own = f.edit === null ? undefined : ownOp(model.ops, f.kind, f.edit.name);
  return d.unchanged === true && own !== undefined && !isAddition(own);
}

/** What the pane beside the form shows for the form as it is now. @param {any} f @param {any} d */
const paneOf = (f, d) => (f.edit !== null ? editPaneView(d, f.live, f.edit.path, f.edit.text, d.op === null ? null : editedOps(f, d).sent, droppingEdit(f, d)) : paneView(f.kind, d, f.live, f.kind === "host" ? null : (model.held[fileOf(f.kind)]?.after ?? null), f.host.name));

/** The pane beside the form: the file as a diff, or what is missing. @param {any} f @param {any} d */
function filePane(f, d) {
  const pane = paneOf(f, d);
  const head = h("div", { class: "ph" }, h("span", { class: "path" }, pane.path), h("span", { class: "spacer" }), h("span", { class: "tag " + pane.tone }, pane.tag));
  if (pane.state === "missing") return h("div", { class: "pane-file", id: "pane" }, head, h("div", { class: "hint" }, f.edit !== null ? "To save it:" : "To add it:", h("ul", {}, ...pane.problems.map((p) => h("li", {}, p)))));
  if (pane.state === "reading") return h("div", { class: "pane-file", id: "pane" }, head, h("div", { class: "hint" }, "Reading the file..."));
  if (pane.state === "refused") return h("div", { class: "pane-file", id: "pane" }, head, h("div", { class: "notice bad inset" }, pane.message));
  return h("div", { class: "pane-file", id: "pane" }, head, diffBody(pane.lines), pane.broken === null ? null : h("div", { class: "notice bad inset" }, pane.broken));
}

/** What "Check it starts" says: first the question, then the answer. @param {any} f @param {any} d */
function probeBox(f, d) {
  if (f.kind !== "server") return null;
  const full = serverAsAdded(d, f.edit?.base ?? null, f.server.name.trim());
  if (f.confirm && full !== null) {
    return h(
      "div",
      { class: "probe confirm", role: "alertdialog", "aria-label": "Confirm the check" },
      h("div", {}, confirmText(full)),
      h("div", { class: "row" }, h("button", { type: "button", id: "probe-run", class: "btn primary", onclick: runCheck }, "Run the check"), h("button", { type: "button", id: "probe-cancel", class: "btn ghost", onclick: () => { f.confirm = false; renderDialog(); } }, "Cancel")),
    );
  }
  const c = f.check;
  if (c !== null && full !== null && c.key === JSON.stringify(full)) {
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
    h("div", { class: "ph" }, d.op ? `fleet init ${d.op.name}` : "fleet init", h("span", { class: "spacer" }), end ? h("span", { class: "tag " + (end.ok ? "ok" : "bad") }, end.code) : running ? h("span", { class: "tag", id: "initclock" }, `running for ${elapsed(Date.now() - initSince)}`) : null),
    model.initError !== null ? h("div", { class: "notice bad inset", role: "alert" }, model.initError) : null,
    h("pre", { class: "term", id: "initlog", "aria-live": "polite" }, model.init.lines.length > 0 ? model.init.lines.join("\n") : h("span", { class: "muted" }, "Then the real fleet init runs here, over ssh, with its output streamed in.")),
    end ? h("div", { class: "hint", id: "initdone" }, ...(end.ok ? [`${model.init.name} is set up. It is in the Matrix now; pick what it gets there.`] : end.messages.map((m) => h("div", {}, m)))) : null,
  );
}

/**
 * What fills the form of an Edit dialog: the item is being read, could not be read, cannot be changed by fleet (the reason, and where to edit it by
 * hand), or is the Add form of its kind with the values the file has.
 * @param {import("./adding.js").AddState} f
 */
function editFields(f) {
  const e = /** @type {import("./editing.js").EditState} */ (f.edit);
  if (e.state === "loading") return [h("div", { class: "hint" }, "Reading the file...")];
  if (e.state === "error") return [h("div", { class: "notice bad", role: "alert" }, e.error)];
  if (e.state === "readonly") {
    return [
      h("div", { class: "notice", id: "readonly" }, h("b", {}, `Fleet cannot change ${e.name} safely: ${e.reason}.`), h("div", { class: "help" }, "Nothing is guessed at, so Edit here would risk your comments and layout. Edit it by hand in the config repo, then push:"), h("div", { class: "row" }, h("code", { class: "m" }, e.path))),
    ];
  }
  return f.kind === "server" ? serverFields(f) : f.kind === "source" ? sourceFields(f) : f.kind === "bundle" ? bundleFields(f) : hostEditFields(f);
}

/** The item's lines, as they are in the file, for an item that cannot be edited here. @param {import("./adding.js").AddState} f */
function readOnlyPane(f) {
  const e = /** @type {import("./editing.js").EditState} */ (f.edit);
  const lines = /** @type {[string, string][]} */ (readOnlyLines(e.text, f.kind, e.name).map((l) => [" ", l]));
  return h("div", { class: "pane-file", id: "pane" }, h("div", { class: "ph" }, h("span", { class: "path" }, e.path), h("span", { class: "spacer" }), h("span", { class: "tag" }, "read-only")), diffBody(lines));
}

/** The whole content of the dialog. @param {import("./adding.js").AddState} f */
function dialogContent(f) {
  const d = draftOf(f);
  const edit = f.edit;
  const host = f.kind === "host" && edit === null;
  const blocked = host && heldProblem(model.ops) !== null;
  const running = host && model.init.running;
  const done = host && model.init.end?.ok === true;
  const fields = edit !== null ? editFields(f) : f.kind === "server" ? serverFields(f) : f.kind === "source" ? sourceFields(f) : f.kind === "bundle" ? bundleFields(f) : blocked ? [] : hostFields(f);
  const warnings = f.kind === "bundle" ? d.warnings.map((/** @type {string} */ w) => h("div", { class: "notice inline" }, w)) : [];
  const outside = (model.base?.outside ?? []).length > 0;
  const pane = paneOf(f, d);
  // Not while the pane says the server refuses it, it does not apply, or the config would not load with it.
  const ready = edit !== null ? edit.state === "ready" && addable(pane) && (d.op !== null || droppingEdit(f, d)) : d.op !== null && addable(pane) && (!host || (!outside && !running));
  const full = f.kind === "server" ? serverAsAdded(d, edit?.base ?? null, f.server.name.trim()) : null;
  const primary = done
    ? h("button", { type: "button", id: "add-done", class: "btn primary", onclick: closeAdd }, "Done")
    : h("button", { type: "submit", id: "add-confirm", class: "btn primary", disabled: !ready || !usable() || (host && f.confirm), "aria-describedby": "pane" }, running ? "Setting up..." : edit !== null ? (droppingEdit(f, d) ? EDIT_DROP_LABEL : EDIT_LABEL) : confirmLabel(f.kind));
  return h(
    "form",
    { class: "adlg-form", autocomplete: "off", novalidate: true, onsubmit: (e) => { e.preventDefault(); submitAdd(); }, onkeydown: (/** @type {any} */ e) => {
      const t = /** @type {HTMLElement} */ (e.target);
      if (e.key === "Enter" && t instanceof HTMLInputElement && t.type === "text" && !e.isComposing) {
        e.preventDefault();
        submitAdd();
      }
    } },
    h("div", { class: "adlg-head" }, h("h3", { id: "adlg-title" }, edit !== null ? `${EDIT[f.kind]}: ${edit.name}` : ADD[f.kind].title), h("span", { class: "muted" }, host ? "writes hosts/<name>.yaml, then runs fleet init from here" : edit !== null && edit.state === "readonly" ? "nothing to push: this one is edited by hand" : "goes to To push; written when you push")),
    h(
      "div",
      { class: "adlg-body" },
      blocked ? hostBlocked() : h("div", { class: "form" }, ...fields),
      h("div", { class: "formright" }, ...(edit !== null && edit.state !== "ready" ? [edit.state === "readonly" ? readOnlyPane(f) : null] : [blocked || done ? null : filePane(f, d), ...warnings, probeBox(f, d), host && !blocked ? initPane(d) : null])),
    ),
    h(
      "div",
      { class: "adlg-foot" },
      f.kind === "server" && (edit === null || edit.state === "ready") ? h("button", { type: "button", id: "add-check", class: "btn", disabled: full === null || !usable() || f.confirm || f.check?.state === "running" || (edit !== null && edit.state !== "ready"), onclick: () => { f.confirm = true; renderDialog(); /** @type {HTMLElement | null | undefined} */ (dialogEl?.querySelector("#probe-run"))?.focus(); } }, "Check it starts") : null,
      h("span", { class: "spacer" }),
      done ? null : h("button", { type: "button", id: "add-cancel", class: "btn ghost", disabled: !closable(f.kind, model.init, edit !== null), onclick: closeAdd }, edit !== null && edit.state !== "ready" ? "Close" : "Cancel"),
      blocked || (edit !== null && edit.state !== "ready") ? null : primary,
    ),
  );
}

/** Draws the dialog again, keeping what has the focus (and the caret in it) and how far each part is scrolled. */
function renderDialog() {
  const f = model.form;
  if (f === null || dialogEl === null) return;
  syncInitClock();
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
 * The Add button of the Catalog and the Matrix: a small menu of what can be added there (the Matrix also offers a host). Whether it is open is in the model, so
 * a screen drawn again (an answer arrives, a push event) keeps it open, and focus goes back to what had it (`render`).
 */
function addMenu(kinds = CATALOG_KINDS) {
  const items = kinds.map((k) => h("button", { type: "button", role: "menuitem", id: `add-${k}`, class: "menuitem", onclick: () => { setMenu(false); openAdd(k, "add-menu"); } }, ADD[k].menu));
  const list = h("div", { class: "menu", role: "menu", "aria-label": "Add to the catalog", ...(model.menu ? {} : { hidden: true }) }, ...items);
  const button = h("button", { type: "button", class: "btn primary", id: "add-menu", "aria-haspopup": "menu", "aria-expanded": String(model.menu), ...(usable() ? {} : { disabled: true, title: "fleet ui is not answering" }), onclick: () => (model.menu ? setMenu(false) : setMenu(true, true)) }, "+ Add");
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
const addCard = (kind, label) => h("button", { type: "button", id: `tile-${kind}`, class: "panel card add", ...(usable() ? {} : { disabled: true }), onclick: () => openAdd(kind) }, label);

/** The Edit button of a card, next to its YAML toggle. @param {import("./adding.js").AddKind} kind @param {string} name */
const editBtn = (kind, name) => h("button", { type: "button", id: `edit-${kind}-${name}`, class: "btn ghost small", ...(usable() ? {} : { disabled: true, title: "fleet ui is not answering" }), "aria-label": `Edit ${name}`, onclick: () => openEdit(kind, name, `edit-${kind}-${name}`) }, "Edit");

/** The button that takes an addition back off To push. @param {Op | undefined} op */
const heldTag = (op) => (op ? h("span", { class: "tag ok" }, "to push") : null);
const takeBackBtn = (/** @type {Op | undefined} */ op) => (op ? h("button", { type: "button", class: "btn ghost small", onclick: () => removeFromPush(op) }, "Remove from push") : null);

/**
 * The card of an item whose removal is on To push: it is gone from the page's view, so it is drawn from the files, dimmed, with the button that takes the removal back.
 * @param {import("./adding.js").AddKind} kind @param {any} row what the files on disk say of it
 */
function removedCard(kind, row) {
  const op = /** @type {Op} */ (removalOp(model.ops, /** @type {"server" | "source" | "bundle"} */ (kind), row.name));
  const y = yamlToggle({ kind, name: row.name });
  return h("div", { class: "panel card removing" + (y.panel ? " yamlopen" : ""), id: `removed-${kind}-${row.name}` }, h("h3", {}, row.name, h("span", { class: "tag bad" }, "removal to push")), h("div", { class: "row" }, takeBackBtn(op), y.button), y.panel);
}

/** The items of one kind on disk whose removal is held and that the page's view no longer shows. @param {"server" | "source" | "bundle"} kind @param {any[]} shown @param {any[]} disk */
const removedRows = (kind, shown, disk) => disk.filter((/** @type {any} */ row) => removalOp(model.ops, kind, row.name) !== undefined && !shown.some((/** @type {any} */ x) => x.name === row.name));

/** The addition or edit of an item that is on To push. @param {import("./adding.js").AddKind} kind @param {string} name @returns {Op | undefined} */
const heldOp = (kind, name) => ownOp(model.ops, kind, name);

/** A page title with the buttons that act on it on the right. @param {string} title @param {string} about @param {...Node} actions */
const pageHead = (title, about, ...actions) => h("div", { class: "pagehead" }, h("div", {}, h("h1", {}, title), h("p", { class: "sub" }, about)), h("div", { class: "pageact" }, ...actions));

// ---- Removing: the confirmation before anything is staged or run

/** The Remove button of a card, next to Edit. A host that may not be removed says why, as the button's title. @param {import("./adding.js").AddKind} kind @param {string} name @param {string | null} [refusal] */
const removeBtn = (kind, name, refusal = null) =>
  h("button", { type: "button", id: `remove-${kind}-${name}`, class: "btn ghost small danger", ...(!usable() ? { disabled: true, title: "fleet ui is not answering" } : refusal !== null ? { disabled: true, title: refusal } : {}), "aria-label": `Remove ${name}`, onclick: () => openRemove(kind, name, `remove-${kind}-${name}`) }, "Remove");

/** @type {HTMLDialogElement | null} */
let rmEl = null;
let rmOpener = "";

/** Esc and Cancel close the dialog, except while a host is being removed: the run goes on without the page, and its output is the only way to see how it ends. */
const rmClosable = () => !model.removal.running;

/**
 * Opens the dialog that asks before an item is removed. Nothing is staged or run until its button is pressed, and what it holds is dropped when it closes.
 * @param {import("./adding.js").AddKind} kind @param {string} name @param {string} opener
 */
function openRemove(kind, name, opener) {
  if (client === null || !usable() || model.rm !== null || model.form !== null || model.base === null) return;
  rmOpener = opener;
  if (kind === "host" && !model.removal.running) {
    model.removal = idleInit();
    model.removalError = null;
  }
  model.rm = { kind, name, state: "loading", error: null, plan: null, skills: [], diffs: [], dropped: [], broken: null, host: null, confirm: false };
  const dialog = h("dialog", { class: "adlg", "aria-labelledby": "rm-title" });
  rmEl = dialog;
  dialog.addEventListener("cancel", (e) => {
    if (!rmClosable()) e.preventDefault();
  });
  trapTab(dialog);
  dialog.addEventListener("close", () => {
    if (model.rm !== null && !rmClosable()) return void dialog.showModal();
    dropRemove(dialog);
  });
  document.body.append(dialog);
  document.documentElement.classList.add("modal");
  renderRemove();
  dialog.showModal();
  loadRemove();
}

function closeRemove() {
  rmEl?.close();
}

/** @param {HTMLDialogElement} dialog */
function dropRemove(dialog) {
  if (rmEl !== dialog) return;
  model.rm = null;
  rmEl = null;
  if (!model.removal.running) {
    model.removal = idleInit();
    model.removalError = null;
  }
  dialog.remove();
  document.documentElement.classList.remove("modal");
  const back = document.getElementById(rmOpener);
  refocus = back !== null && back.offsetParent !== null ? rmOpener : "";
  returnFocus();
}

/** The changes of a file between two texts, with a little around them. @param {string} before @param {string} after */
const changeLines = (before, after) => nearChanges(lineDiff(splitLines(before), splitLines(after)), 3);

/** Reads what the removal would do: from the server's own replay for an item of the catalog, and its preview for a host. */
async function loadRemove() {
  const r = model.rm;
  if (r === null || client === null) return;
  try {
    if (r.kind === "host") {
      r.host = await client.previewRemoveHost(r.name);
    } else {
      // The skills a source provides are those of its clone here, and those seen when it was added.
      if (r.kind === "source") await loadSkills();
      if (model.rm !== r) return;
      r.skills = r.kind === "source" ? sourceSkills(r.name, model.skills, model.stagedSkills) : [];
      r.plan = removal(model.ops, r.kind, r.name, r.skills);
      if (r.plan.mode === "stage") {
        // What it changes is its own diff: the files with it, against the files with the other edits held.
        const plan = r.plan;
        const [without, withIt] = await Promise.all([client.preview(model.ops.filter((o) => !plan.moot.includes(o)), undefined, model.stagedSkills), client.preview(plan.ops, undefined, model.stagedSkills)]);
        if (model.rm !== r) return;
        r.diffs = withIt.files.map((/** @type {any} */ f) => ({ path: f.path, before: without.files.find((/** @type {any} */ x) => x.path === f.path)?.after ?? f.before, after: f.after })).filter((/** @type {any} */ d) => d.before !== d.after);
        r.dropped = withIt.dropped;
        const was = new Set(without.checks.filter((/** @type {any} */ c) => !c.loads).map((/** @type {any} */ c) => c.host));
        const now = withIt.checks.filter((/** @type {any} */ c) => !c.loads && !was.has(c.host));
        r.broken = now.length > 0 ? `With this, the config does not load for ${now.map((/** @type {any} */ c) => c.host).join(", ")}: ${now[0].problems[0] ?? ""}` : null;
      }
    }
    r.state = "ready";
  } catch (e) {
    if (model.rm !== r) return;
    r.state = "error";
    r.error = said(e, "it could not be read");
  }
  renderRemove();
  /** @type {HTMLElement | null | undefined} */ (rmEl?.querySelector("#rm-go:not([disabled])"))?.focus();
}

/** The confirmed removal of an item of the catalog: it goes on To push (or the unpushed addition is dropped), and the dialog closes. @param {RemoveState} r */
function stageRemoval(r) {
  const plan = r.plan;
  if (plan === null || r.state !== "ready") return;
  if (r.kind === "source" && plan.mode === "forget") delete model.stagedSkills[r.name];
  model.ops = plan.ops;
  model.messageEdited = false;
  closeRemove();
  refreshPreview();
}

/** Deletes the host's files and runs the real rekey, commit and push. Its output comes on the stream while this call is open. @param {RemoveState} r */
async function runRemove(r) {
  if (client === null || r.kind !== "host" || model.removal.running || r.state !== "ready") return;
  r.confirm = false;
  model.removalError = null;
  model.removal = { ...startInit(r.name) };
  renderRemove();
  try {
    const doc = await client.removeHost(r.name);
    model.removal = initEnd(model.removal, doc);
    // The edits to push for the host go with it; those of other hosts stay. When nothing was removed they are all still good.
    if (doc.removed === true) {
      const gone = heldForHost(model.ops, r.name);
      model.ops = model.ops.filter((o) => !gone.includes(o));
    }
  } catch (e) {
    model.removal = { ...model.removal, running: false };
    model.removalError = said(e, "the host could not be removed");
  }
  renderRemove();
  loadStatus();
  loadMatrix();
  loadSecrets();
}

/** A file's changes as a panel of the dialog's right side. @param {string} path @param {string} before @param {string} after @param {string} [note] */
function changePanel(path, before, after, note = "") {
  const lines = changeLines(before, after);
  const { added, removed } = counts(lineDiff(splitLines(before), splitLines(after)));
  return h("div", { class: "pane-file" }, h("div", { class: "ph" }, h("span", { class: "path" }, path), h("span", { class: "spacer" }), note === "" ? null : h("span", { class: "tag warn" }, note), h("span", { class: "tag " + (added + removed > 0 ? "ok" : "") }, `+${added} -${removed}`)), diffBody(lines));
}

/** @param {string[]} lines */
const bullets = (lines) => h("ul", { class: "rmlist" }, ...lines.map((l) => h("li", {}, l)));

/** What the dialog says of an item of the catalog, as paragraphs. @param {RemoveState} r */
function catalogWords(r) {
  const plan = /** @type {ReturnType<typeof removal>} */ (r.plan);
  const kindWord = { server: "MCP server", source: "skill source", bundle: "skill bundle" }[/** @type {"server" | "source" | "bundle"} */ (r.kind)];
  if (plan.mode === "forget") {
    return [h("p", {}, `${r.name} was added here and is not pushed yet. Removing it drops that addition${plan.moot.length > 1 ? `, and ${plan.moot.length - 1} more edit${plan.moot.length === 2 ? "" : "s"} to push that name it` : ""}. Nothing is written.`)];
  }
  const { hosts } = touched(r.diffs);
  /** @type {Node[]} */
  const out = [h("p", {}, `Removes the ${kindWord} ${r.name} from the catalog${r.kind === "source" ? "" : ", and from every host that picks or excludes it"}. This is a change to push: nothing is written until you push.`)];
  if (r.kind !== "source") out.push(h("p", { id: "rm-hosts" }, hosts.length === 0 ? "No host picks or excludes it." : `It is also taken out of: ${hosts.join(", ")}.`));
  if (r.kind === "source") {
    const losses = bundleLosses(shownMatrix().bundles, r.skills);
    out.push(
      r.skills.length === 0 ? h("div", { class: "notice inline", id: "rm-noskills" }, NO_SKILLS_KNOWN) : h("p", { id: "rm-skills" }, losses.length === 0 ? "No bundle lists a skill of this source." : "Its skills are taken out of every bundle that lists them:"),
      ...(losses.length > 0 ? [bullets(losses.map(lossLine))] : []),
      ...losses.filter((l) => l.left === 0).map((l) => h("div", { class: "notice inline", id: `rm-empty-${l.bundle}` }, `${l.bundle} has ${EMPTY_BUNDLE}.`)),
      h("p", { class: "muted" }, "The clone of the source on each machine is left alone."),
    );
  }
  const others = plan.moot.filter((o) => o.op !== (r.kind === "server" ? "removeServer" : r.kind === "source" ? "removeSource" : "removeBundle"));
  if (others.length > 0) out.push(h("div", { class: "notice inline", id: "rm-moot" }, "Dropped from To push, because the item is going:", bullets(others.map((o) => opLabel(o)))));
  return out;
}

/** What the dialog says of a host, and what it asks. @param {RemoveState} r */
function hostWords(r) {
  const doc = r.host;
  const readable = [...doc.readable.shared.map((/** @type {string} */ n) => `${n} (shared)`), ...doc.readable.own.map((/** @type {string} */ n) => `${n} (its own file)`)];
  const dropping = heldForHost(model.ops, r.name);
  const outside = (model.base?.outside ?? []).length > 0;
  const out = [
    h("p", {}, hostRuns(r.name, doc).lead),
    ...(doc.rekeyed.length > 0 ? [h("p", { id: "rm-rekeyed" }, `Re-encrypted without its key: ${doc.rekeyed.join(", ")}.`)] : []),
    h("p", { id: "rm-keeps" }, hostKeeps(r.name)),
    readable.length > 0 ? h("div", { class: "notice inline", id: "rm-secrets" }, `${r.name} could read these secrets: ${readable.join(", ")}.`, h("div", {}, ROTATE)) : h("p", { class: "muted", id: "rm-secrets" }, `${r.name} has no key, so it could read no secret.`),
  ];
  if (dropping.length > 0) out.push(h("div", { class: "notice inline", id: "rm-held" }, `${dropping.length} edit${dropping.length === 1 ? "" : "s"} to push for ${r.name} will be dropped:`, bullets(dropping.map((o) => opLabel(o)))));
  if (outside) out.push(h("div", { class: "notice bad inline", id: "rm-outside" }, "The config repo has changes the page did not make: commit or discard them first."));
  return out;
}

/** The output of a host's removal, as it streams in, and how it ended. */
function removalPane() {
  const end = model.removal.end;
  return h(
    "div",
    { class: "initpane" },
    h("div", { class: "ph" }, `removing ${model.removal.name ?? ""}`, h("span", { class: "spacer" }), end ? h("span", { class: "tag " + (end.ok ? "ok" : "bad") }, end.code) : model.removal.running ? h("span", { class: "tag" }, "running") : null),
    model.removalError !== null ? h("div", { class: "notice bad inset", role: "alert" }, model.removalError) : null,
    h("pre", { class: "term", id: "rmlog", "aria-live": "polite" }, model.removal.lines.join("\n")),
    end ? h("div", { class: "hint", id: "rmdone" }, ...(end.ok ? [`${model.removal.name} is removed and pushed.`] : end.messages.map((m) => h("div", {}, m)))) : null,
  );
}

/** Closes the dialog of a finished removal and opens the Secrets screen on the secrets the host could read. @param {string[]} names */
function rotateNow(names) {
  closeRemove();
  location.hash = secretsHashFor(names);
}

function renderRemove() {
  const r = model.rm;
  if (r === null || rmEl === null) return;
  const host = r.kind === "host";
  const active = document.activeElement;
  const keep = active instanceof HTMLElement && rmEl.contains(active) && active.id !== "" ? active.id : null;
  const ran = host && (model.removal.running || model.removal.end !== null || model.removalError !== null);
  const done = host && model.removal.end?.ok === true;
  const plan = r.plan;
  const stale = r.dropped.length > 0;
  const outside = host && (model.base?.outside ?? []).length > 0;
  const ready = r.state === "ready" && usable() && !stale && r.broken === null && !outside && !model.removal.running && (host ? !r.confirm : plan !== null);
  /** @type {Node[]} */
  let words = [h("div", { class: "hint" }, "Reading the files...")];
  /** @type {Node[]} */
  let right = [];
  if (r.state === "error") words = [h("div", { class: "notice bad", role: "alert" }, r.error)];
  else if (r.state === "ready" && host) {
    words = hostWords(r);
    right = ran ? [removalPane()] : r.host.files.map((/** @type {any} */ f) => changePanel(f.path, f.before, f.after, f.path.startsWith("secrets/") ? "names only" : ""));
  } else if (r.state === "ready" && plan !== null) {
    words = catalogWords(r);
    right = plan.mode === "forget" ? [] : r.diffs.map((d) => changePanel(d.path, d.before, d.after));
    if (stale) words.push(h("div", { class: "notice bad inline", id: "rm-stale" }, r.dropped.map((/** @type {any} */ d) => d.reason).join("; ")));
    if (r.broken !== null) words.push(h("div", { class: "notice bad inline", id: "rm-broken" }, r.broken));
  }
  const rotatable = done && r.host !== null ? readableNames(r.host.readable) : [];
  const goText = host ? (model.removal.running ? "Removing..." : `Remove ${r.name} and push`) : goLabel(plan?.mode ?? "stage");
  const go = host
    ? h("button", { type: "button", id: "rm-go", class: "btn danger", disabled: !ready, onclick: () => runRemove(r) }, goText)
    : h("button", { type: "button", id: "rm-go", class: "btn danger", disabled: !ready, onclick: () => stageRemoval(r) }, goText);
  fill(
    rmEl,
    h(
      "form",
      { class: "adlg-form", autocomplete: "off", novalidate: true, onsubmit: (e) => e.preventDefault() },
      h("div", { class: "adlg-head" }, h("h3", { id: "rm-title" }, `${REMOVE[r.kind]}: ${r.name}`), h("span", { class: "muted" }, host ? (r.host === null ? "runs now" : hostRuns(r.name, r.host).head) : plan?.mode === "forget" ? "drops an addition: nothing is written" : "goes to To push; written when you push")),
      h("div", { class: "adlg-body" + (right.length === 0 ? " single" : "") }, h("div", { class: "form rmwords" }, ...words), ...(right.length === 0 ? [] : [h("div", { class: "formright" }, ...right)])),
      h("div", { class: "adlg-foot" }, h("span", { class: "spacer" }), done && rotatable.length > 0 ? h("button", { type: "button", id: "rm-rotate", class: "btn primary", onclick: () => rotateNow(rotatable) }, ROTATE_NOW) : null, done ? h("button", { type: "button", id: "rm-done", class: "btn ghost", onclick: closeRemove }, "Done") : h("button", { type: "button", id: "rm-cancel", class: "btn ghost", disabled: !rmClosable(), onclick: closeRemove }, ran && !model.removal.running ? "Close" : "Cancel"), done ? null : go),
    ),
  );
  const log = rmEl.querySelector("#rmlog");
  if (log !== null) log.scrollTop = log.scrollHeight;
  if (keep !== null) {
    const again = rmEl.querySelector(`[id="${keep}"]`);
    if (again instanceof HTMLElement && !(again instanceof HTMLButtonElement && again.disabled)) again.focus();
  }
}

// ---- Search: the field at the top of the Matrix and the Catalog. The filter lives in the address (`#/matrix?q=git`), so a reload keeps it.

/** The filter typed on this screen, as typed. */
const query = () => queryOf(location.hash);

/** @param {string} q */
function setQuery(q) {
  history.replaceState(null, "", location.pathname + location.search + hashWithQuery(location.hash, q));
  render();
}

/** @param {any} doc @returns {import("./filter.js").RowId[]} */
const rowIds = (doc) => [...doc.bundles.map((/** @type {any} */ b) => ({ kind: "bundles", name: b.name })), ...doc.servers.map((/** @type {any} */ s) => ({ kind: "mcp", name: s.name }))];
/** @param {any} doc @returns {import("./filter.js").RowId[]} */
const catalogIds = (doc) => [...rowIds(doc), ...(doc.sources ?? []).map((/** @type {any} */ s) => ({ kind: "source", name: s.name }))];

/**
 * The search field, and what the filter hides. Edits on To push are never filtered: when the filter hides rows that have one, it says so.
 * @param {import("./filter.js").RowId[]} all every row of the screen @param {import("./filter.js").RowId[]} kept the rows that are shown @param {string} label
 */
function filterBar(all, kept, label) {
  const q = query();
  const on = q.trim() !== "";
  const shown = new Set(kept.map((r) => `${r.kind}:${r.name}`));
  const hidden = all.filter((r) => !shown.has(`${r.kind}:${r.name}`));
  const changed = hiddenWithChanges(hidden, model.ops);
  const input = h("input", {
    type: "text", id: "filter", class: "filter", role: "searchbox", autocomplete: "off", spellcheck: "false", placeholder: "Filter by name (press / to search)", "aria-label": label, value: q,
    oninput: (/** @type {any} */ e) => setQuery(e.target.value),
    onkeydown: (/** @type {any} */ e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      const field = /** @type {HTMLInputElement} */ (e.target);
      if (escapeAction(field.value) === "clear") setQuery("");
      else field.blur();
    },
  });
  input.value = q;
  return h(
    "div",
    { class: "filterbar" },
    input,
    on ? h("span", { class: "muted", id: "filter-count" }, `${kept.length} of ${all.length} shown`) : null,
    changed.length > 0 ? h("span", { class: "tag warn", id: "filter-hidden", role: "status", title: `On To push, not shown: ${changed.join(", ")}` }, `${changed.length} hidden with changes`) : null,
    on ? h("button", { type: "button", class: "btn ghost small", id: "filter-clear", onclick: () => { setQuery(""); document.getElementById("filter")?.focus(); } }, "Clear") : null,
  );
}

/** What a filter that matches nothing shows. @param {string} q */
const noMatch = (q) => h("div", { class: "panel empty", id: "nomatch" }, h("div", {}, `Nothing is named like "${q.trim()}".`), h("div", { class: "row", style: "justify-content:center;margin-top:12px" }, h("button", { type: "button", class: "btn", id: "nomatch-clear", onclick: () => { setQuery(""); document.getElementById("filter")?.focus(); } }, "Clear the filter")));

// `/` goes to the search field, but never from another field or while a dialog is open.
document.addEventListener("keydown", (e) => {
  const t = /** @type {Element | null} */ (e.target);
  if (!slashFocuses(e, t?.closest("input, textarea, select, [contenteditable]") != null, document.querySelector("dialog[open]") !== null)) return;
  const field = document.getElementById("filter");
  if (field === null) return;
  e.preventDefault();
  field.focus();
});

// ---- YAML toggles: how an item is written in the config repo

/** @typedef {{ kind: import("./adding.js").AddKind, name: string }} Item */

const yamlKey = (/** @type {Item} */ i) => `${i.kind}:${i.name}`;

/** Reads the file of each of these items that this page has not read yet. One read per file. @param {Item[]} items */
async function readYaml(items) {
  if (client === null) return;
  const asked = new Set();
  for (const { kind, name } of items) {
    const path = yamlPath(kind, name);
    if (path in model.yaml || asked.has(path)) continue;
    asked.add(path);
    try {
      model.yaml[path] = (await client.yaml(kind, name)).text;
      delete model.yamlErrors[path];
    } catch (e) {
      model.yamlErrors[path] = said(e, "the file could not be read");
    }
  }
  render();
}

/** What is written is read again whenever a screen is opened, so it is never older than the file. */
function refreshYaml() {
  model.yaml = {};
  readYaml([...model.yamlOpen].map((k) => ({ kind: /** @type {Item["kind"]} */ (k.slice(0, k.indexOf(":"))), name: k.slice(k.indexOf(":") + 1) })));
}

/** @param {Item[]} items @param {boolean} on */
function setYaml(items, on) {
  for (const i of items) (on ? model.yamlOpen.add(yamlKey(i)) : model.yamlOpen.delete(yamlKey(i)));
  render();
  if (on) readYaml(items);
}

/** The toggle of one item: a button, and when it is on, the panel that goes in the card. @param {Item} item */
function yamlToggle(item) {
  const open = model.yamlOpen.has(yamlKey(item));
  const button = h("button", { type: "button", id: `yaml-${item.kind}-${item.name}`, class: "btn ghost small yamlbtn", "aria-pressed": String(open), title: open ? "Hide how it is written" : "Show how it is written in the config repo", onclick: () => setYaml([item], !open) }, "YAML");
  return { button, panel: open ? yamlPanel(item) : null };
}

/** The lines of the item in its repo file, or their diff when an edit to push touches them. @param {Item} item */
function yamlPanel(item) {
  const path = yamlPath(item.kind, item.name);
  const head = (/** @type {string} */ tag, tone = "") => h("div", { class: "ph" }, h("span", { class: "path" }, path), h("span", { class: "spacer" }), h("span", { class: "tag " + tone }, tag));
  const failed = model.yamlErrors[path];
  if (failed !== undefined) return h("div", { class: "yamlbox" }, head("not read", "bad"), h("div", { class: "notice bad inset" }, failed));
  const disk = model.yaml[path];
  if (disk === undefined) return h("div", { class: "yamlbox" }, head("reading"), h("div", { class: "hint" }, "Reading the file..."));
  const y = itemYaml(item.kind, item.name, disk, model.held[path]?.after ?? disk);
  if (y.state === "absent") return h("div", { class: "yamlbox" }, head(yamlTag(y)), h("div", { class: "hint" }, `${item.name} is not written in ${path}.`));
  return h("div", { class: "yamlbox" }, head(yamlTag(y), y.state === "plain" ? "" : "ok"), diffBody(y.lines));
}

/** The header button that opens or closes the YAML of every item on the screen. @param {Item[]} items */
function yamlAll(items) {
  const all = items.length > 0 && items.every((i) => model.yamlOpen.has(yamlKey(i)));
  return h("button", { type: "button", id: "yaml-all", class: "btn ghost yamlbtn", "aria-pressed": String(all), onclick: () => setYaml(items, !all) }, "Show all YAML");
}

const CATALOG_FILTER = "Filter servers, sources, bundles and skills by name";

function catalogScreen() {
  const [title, about] = SCREENS.catalog;
  if (model.base === null) return loadingOrError(title, model.matrixError);
  const q = query();
  const whole = shownMatrix();
  const skillsOf = (/** @type {string} */ name) => [...new Set([...model.skills.filter((k) => k.source === name).map((k) => k.name), ...(model.stagedSkills[name] ?? [])])];
  const view = { ...whole, servers: filterRows(whole.servers, q), sources: filterRows(whole.sources ?? [], q, (/** @type {any} */ src) => skillsOf(src.name)), bundles: filterRows(whole.bundles, q, (/** @type {any} */ b) => b.skills) };
  const hosts = view.hosts;
  const uses = (/** @type {any} */ row) => hosts.filter((/** @type {any} */ x) => row.cells[x.name]?.on).length;
  const onHosts = (/** @type {any} */ row) => h("span", { class: "tag " + (uses(row) > 0 ? "ok" : "") }, `on ${uses(row)} of ${hosts.length} host${hosts.length === 1 ? "" : "s"}`);
  const sources = view.sources ?? [];
  /** @type {Item[]} */
  const items = [...view.servers.map((/** @type {any} */ x) => ({ kind: "server", name: x.name })), ...sources.map((/** @type {any} */ x) => ({ kind: "source", name: x.name })), ...view.bundles.map((/** @type {any} */ x) => ({ kind: "bundle", name: x.name }))];
  if (items.length === 0 && q.trim() !== "") return h("div", {}, pageHead(title, about, addMenu()), filterBar(catalogIds(whole), [], CATALOG_FILTER), noMatch(q));
  return h(
    "div",
    {},
    pageHead(title, about, yamlAll(items), addMenu()),
    filterBar(catalogIds(whole), catalogIds(view), CATALOG_FILTER),
    h("h2", {}, "MCP servers"),
    h("div", { class: "cards" },
      ...view.servers.map((/** @type {any} */ sv) => {
        const op = heldOp("server", sv.name);
        const y = yamlToggle({ kind: "server", name: sv.name });
        return h("div", { class: "panel card" + (y.panel ? " yamlopen" : "") }, h("h3", {}, sv.name, h("span", { class: "tag" }, sv.server?.kind ?? ""), heldTag(op)), h("p", {}, serverLine(sv)), h("div", { class: "row" }, onHosts(sv), takeBackBtn(op), editBtn("server", sv.name), removeBtn("server", sv.name), y.button), y.panel);
      }),
      ...removedRows("server", view.servers, model.base.servers).map((/** @type {any} */ row) => removedCard("server", row)),
      addCard("server", "+ Add an MCP server"),
    ),
    h("h2", {}, "Skill sources"),
    h("div", { class: "cards" },
      ...sources.map((/** @type {any} */ src) => {
        const op = heldOp("source", src.name);
        const skills = skillsOf(src.name);
        const y = yamlToggle({ kind: "source", name: src.name });
        return h(
          "div",
          { class: "panel card" + (y.panel ? " yamlopen" : "") },
          h("h3", {}, src.name, h("span", { class: "tag " + (src.commit ? "info" : "ok") }, src.commit ? "pinned" : "followed"), src.review ? h("span", { class: "tag warn" }, "review") : null, heldTag(op)),
          h("p", {}, [src.repo, src.commit ? src.commit.slice(0, 7) : null, src.commit ? `tracks ${src.track}` : src.branch].filter((x) => x).join(" · ")),
          skills.length > 0 ? h("div", { class: "row" }, ...skills.slice(0, 12).map((/** @type {string} */ sk) => h("span", { class: "tag" }, sk)), skills.length > 12 ? h("span", { class: "muted" }, `+${skills.length - 12}`) : null) : null,
          h("div", { class: "row" }, takeBackBtn(op), editBtn("source", src.name), removeBtn("source", src.name), y.button),
          y.panel,
        );
      }),
      ...removedRows("source", sources, model.base.sources ?? []).map((/** @type {any} */ row) => removedCard("source", row)),
      addCard("source", "+ Add a skill source"),
    ),
    h("h2", {}, "Skill bundles"),
    h("div", { class: "cards" },
      ...view.bundles.map((/** @type {any} */ b) => {
        const op = heldOp("bundle", b.name);
        const y = yamlToggle({ kind: "bundle", name: b.name });
        return h("div", { class: "panel card" + (y.panel ? " yamlopen" : "") }, h("h3", {}, b.name, b.skills.length === 0 ? h("span", { class: "tag warn", title: EMPTY_BUNDLE }, "no skills") : null, heldTag(op)), h("div", { class: "row" }, ...b.skills.map((/** @type {string} */ sk) => h("span", { class: "tag" }, sk))), h("p", {}, ""), h("div", { class: "row" }, onHosts(b), takeBackBtn(op), editBtn("bundle", b.name), removeBtn("bundle", b.name), y.button), y.panel);
      }),
      ...removedRows("bundle", view.bundles, model.base.bundles).map((/** @type {any} */ row) => removedCard("bundle", row)),
      addCard("bundle", "+ Add a skill bundle"),
    ),
    model.ops.length > 0 ? h("div", { class: "row heldbar" }, h("span", { class: "tag ok" }, `${model.ops.length} to push`), h("a", { class: "btn primary", href: "#/review" }, "Review & push")) : null,
  );
}

function hostsScreen() {
  const [title, about] = SCREENS.hosts;
  if (model.base === null) return loadingOrError(title, model.matrixError);
  // The hosts as they would be after the edits to push: an edited ssh destination shows at once.
  const hosts = shownMatrix().hosts;
  /** @type {Item[]} */
  const items = hosts.map((/** @type {any} */ x) => ({ kind: "host", name: x.name }));
  return h(
    "div",
    {},
    pageHead(title, about, yamlAll(items), h("button", { type: "button", class: "btn primary", id: "add-host", ...(usable() ? {} : { disabled: true, title: "fleet ui is not answering" }), onclick: () => openAdd("host") }, "+ Add host")),
    h("div", { class: "cards" },
      ...hosts.map((/** @type {any} */ host) => {
        const bundles = model.base.bundles.filter((/** @type {any} */ b) => b.cells[host.name]?.on).map((/** @type {any} */ b) => b.name);
        const servers = model.base.servers.filter((/** @type {any} */ sv) => sv.cells[host.name]?.on).map((/** @type {any} */ sv) => sv.name);
        const y = yamlToggle({ kind: "host", name: host.name });
        const op = heldOp("host", host.name);
        return h(
          "div",
          { class: "panel card" + (y.panel ? " yamlopen" : "") },
          h("h3", {}, host.name, host.self ? h("span", { class: "tag ok" }, "this host") : null, heldTag(op)),
          h("dl", { class: "facts small" }, h("dt", {}, "reached"), h("dd", {}, host.self ? "local" : host.ssh ? `ssh ${host.ssh}` : "on its own timer"), h("dt", {}, "bundles"), h("dd", {}, bundles.join(", ") || "none"), h("dt", {}, "servers"), h("dd", {}, servers.join(", ") || "none")),
          h("div", { class: "row" }, takeBackBtn(op), editBtn("host", host.name), removeBtn("host", host.name, hostRefusal(host, hosts)), y.button),
          y.panel,
        );
      }),
      addCard("host", "+ Add a host"),
    ),
  );
}

// ---- Card: the server draws the SVG, this page only shows it and turns it into a PNG.

/** @type {Promise<{ regular: string, bold: string }> | null} */
let cardFontsLoaded = null;

/** @param {string} path */
async function base64Of(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The bundled JetBrains Mono, read once from this server, so the picture and the PNG use the card's font and fetch nothing from elsewhere. */
function cardFonts() {
  cardFontsLoaded ??= Promise.all([base64Of("/" + FONT_FILES.regular), base64Of("/" + FONT_FILES.bold)]).then(([regular, bold]) => ({ regular, bold }));
  cardFontsLoaded.catch(() => { cardFontsLoaded = null; });
  return cardFontsLoaded;
}

async function loadCard() {
  if (client === null) return;
  const { style, names } = model.card;
  try {
    const doc = await client.card(style, names);
    // A switch pressed meanwhile asked again: this answer is for the old one.
    if (style !== model.card.style || names !== model.card.names) return;
    const fonts = await cardFonts().catch(() => null);
    const svg = fonts === null ? doc.svg : embedFonts(doc.svg, fonts);
    if (model.card.url !== null) URL.revokeObjectURL(model.card.url);
    model.card = { ...model.card, doc, svg, url: URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })), error: null };
  } catch (e) {
    model.card = { ...model.card, error: e instanceof ApiError ? e.messages.join("; ") || e.message : "the card could not be made" };
  }
  render();
}

/** The card as a PNG at twice its size, drawn from the SVG on a canvas. @returns {Promise<Blob>} */
async function cardPng() {
  if (model.card.url === null) throw new Error("no card");
  const img = new Image();
  img.src = model.card.url;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = CARD_SIZE.width * CARD_SIZE.scale;
  canvas.height = CARD_SIZE.height * CARD_SIZE.scale;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("no canvas");
  context.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob === null ? reject(new Error("no image")) : resolve(blob)), "image/png"));
}

/** @param {string} text @param {string} [tone] */
function cardSays(text, tone = "ok") {
  model.card = { ...model.card, message: { text, tone } };
  render();
}

/** @param {Blob} blob @param {string} name */
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = h("a", { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function savePng() {
  try {
    const name = fileName(model.card.style, "png");
    download(await cardPng(), name);
    cardSays(`Saved ${name}. Attach it to your post.`);
  } catch {
    cardSays("The image could not be drawn in this browser. Save SVG instead.", "bad");
  }
}

function saveSvg() {
  if (model.card.doc === null) return;
  download(new Blob([model.card.doc.svg], { type: "image/svg+xml" }), fileName(model.card.style, "svg"));
  cardSays("Saved fleet-card.svg, the same file fleet card writes.");
}

async function copyImage() {
  if (!canCopyImage(navigator, window.ClipboardItem)) return cardSays(clipboardProblem(null), "warn");
  try {
    // The blob is passed as a promise, so a browser that wants the click's permission has it before the image is drawn.
    await navigator.clipboard.write([new ClipboardItem({ "image/png": cardPng() })]);
    cardSays("Copied the image. Paste it into your post.");
  } catch (e) {
    cardSays(clipboardProblem(e), "warn");
  }
}

/** @param {{ style?: string, names?: boolean }} change */
function setCard(change) {
  model.card = { ...model.card, ...change, message: null };
  render();
  loadCard();
}

function cardScreen() {
  const [title, about] = SCREENS.card;
  const c = model.card;
  const ready = c.doc !== null && c.url !== null;
  const share = ready ? discussionUrl(c.doc.share) : null;
  const note = ready ? unseenNote(c.doc.unseen) : null;
  const can = ready && usable();
  return h(
    "div",
    {},
    h("h1", {}, title),
    h("p", { class: "sub" }, about),
    c.error !== null ? h("div", { class: "notice bad" }, c.error) : null,
    h(
      "div",
      { class: "row" },
      h("div", { class: "seg", role: "group", "aria-label": "Style" }, ...CARD_STYLES.map(([id, label]) => h("button", { type: "button", id: `card-style-${id}`, class: id === c.style ? "on" : "", "aria-pressed": String(id === c.style), onclick: () => setCard({ style: id }) }, label))),
      h("label", { class: "check", for: "card-names" }, h("input", { type: "checkbox", id: "card-names", checked: c.names, onchange: (e) => setCard({ names: /** @type {HTMLInputElement} */ (e.target).checked }) }), "Show hostnames"),
    ),
    c.names ? h("div", { class: "notice", id: "card-names-note" }, "The real hostnames are on the card. Only hostnames: never a server, skill, source or secret name.") : null,
    ready
      ? h("div", { class: "panel cardframe" }, h("img", { id: "card-image", class: "cardimg", src: /** @type {string} */ (c.url), width: String(CARD_SIZE.width), height: String(CARD_SIZE.height), alt: c.doc.text.split("\n")[0].trim() || "your fleet card" }))
      : h("div", { class: "panel empty" }, "Drawing the card..."),
    note === null ? null : h("div", { class: "notice", id: "card-unseen" }, note),
    h(
      "div",
      { class: "row", style: "margin: 14px 0" },
      h("button", { type: "button", id: "card-save-png", class: "btn primary", ...(can ? {} : { disabled: true }), onclick: savePng }, "Save PNG"),
      h("button", { type: "button", id: "card-copy", class: "btn", ...(can ? {} : { disabled: true }), onclick: copyImage }, "Copy image"),
      share === null
        ? h("button", { type: "button", id: "card-post", class: "btn", disabled: true }, "Post to Show and tell")
        : h("a", { id: "card-post", class: "btn", href: share, target: "_blank", rel: "noopener noreferrer", title: "Opens a new GitHub discussion with a short text. You attach the image." }, "Post to Show and tell"),
      h("button", { type: "button", id: "card-save-svg", class: "btn ghost", ...(ready ? {} : { disabled: true }), onclick: saveSvg }, "Save SVG"),
    ),
    h("div", { id: "card-message", role: "status", class: c.message === null ? "" : `notice ${c.message.tone === "ok" ? "okmsg" : c.message.tone === "bad" ? "bad" : ""}` }, c.message === null ? "" : c.message.text),
    ready ? h("h2", {}, "In the terminal") : null,
    ready ? h("div", { class: "panel" }, h("pre", { class: "term", id: "card-text" }, c.doc.text)) : null,
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
  const only = namesOf(location.hash);
  const shown = rowsNamed(table.names, only);
  return h(
    "div",
    {},
    h("h1", {}, title),
    h("p", { class: "sub" }, about),
    only.length > 0
      ? h("div", { class: "notice", id: "sec-only" }, `Showing the secrets a removed host could read: ${only.join(", ")}.${shown.length < only.length ? ` ${only.length - shown.length} of them no catalog server uses, so they are not listed here.` : ""} Replace each value, then revoke the old token wherever it was issued: fleet cannot. `, h("a", { href: "#/secrets", id: "sec-all" }, "Show all secrets"))
      : null,
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
            h("tbody", {}, ...shown.map((/** @type {import("./secrets.js").SecretRow} */ row) => {
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
                h("td", { class: "act" }, h("button", { type: "button", class: "btn" + (action.missing.length > 0 ? "" : " ghost") + " small", ...(usable() ? {} : { disabled: true, title: "fleet ui is not answering" }), onclick: () => openSecretDialog(row, table) }, action.label)),
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
    autocomplete: "new-password", autocapitalize: "off", autocorrect: "off", spellcheck: "false",
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
    const problem = files.length === 0 ? "Tick at least one file to set it in." : !usable() ? "fleet ui is not answering, so the value cannot be encrypted. Run fleet ui again and open its new URL." : valueProblem(input.value);
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
      err.textContent = retryText(said(error, "the value could not be encrypted"));
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
  const stop = [
    ...blockers({ outside: model.init.running || model.removal.running ? [] : (p?.outside ?? model.base?.outside ?? []), dropped, checks, running: model.push.running }),
    ...(model.init.running ? [`fleet init of ${model.init.name ?? "a host"} is running`] : []),
    ...(model.removal.running ? [`removing ${model.removal.name ?? "a host"} is running`] : []),
  ];
  const editing = model.ops.length > 0;
  const message = h("input", { type: "text", id: "msg", placeholder: editing ? "commit message" : "commit message (optional, for what is already in the repo)", maxlength: "1000", "aria-label": "commit message", value: model.message, oninput: (e) => { model.message = /** @type {HTMLInputElement} */ (e.target).value; model.messageEdited = true; } });
  const go = h("button", { class: "btn primary", disabled: !usable() || stop.length > 0 || (editing && model.message.trim() === ""), onclick: writeAndPush }, model.push.running ? "Pushing..." : editing ? "Write and push" : "Push");
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
      stop.filter((t) => t !== DROPPED_BLOCKER).length > 0 && !model.push.running ? h("div", { class: "notice bad inset" }, stop.filter((t) => t !== DROPPED_BLOCKER).join("; ")) : null,
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
  const text = plan === null || plan.doc === null ? (plan?.error ?? "Planning...") : plan.doc.text.trim() === "" ? (plan.doc.messages.map(plain).join("\n") || "Nothing would change on this host.") : plan.doc.text.trimEnd();
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
    // What the push itself said about how it ended (a host that is unreachable, a conflict), under the tag.
    p.end !== null && p.end.messages.length > 0 ? h("div", { class: "notice inset" + (p.end.ok ? "" : " bad"), id: "pushmessages" }, ...p.end.messages.map((m) => h("div", {}, m))) : null,
    model.pushNotice !== null ? h("div", { class: "notice inset", id: "pushnotice" }, model.pushNotice) : null,
    model.pushError !== null ? h("div", { class: "notice bad inset" }, model.pushError) : null,
    lanes.length > 0 ? h("div", { class: "lanes" }, ...lanes) : null,
    h("pre", { class: "term", id: "pushlog", "aria-live": "polite" }, p.log.length > 0 ? p.log.join("\n") : h("span", { class: "muted" }, "Live push output shows here.")),
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
    const doc = await client.preview(model.ops, focus === null ? undefined : `hosts/${focus}.yaml`, model.stagedSkills);
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
  refreshYaml();
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
  model.captured = [];
  model.capture = { ...model.capture, done: {} };
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
  model.pushNotice = null;
  model.push = { ...idlePush(), running: true };
  render();
  try {
    // The events arrive on the stream while this call is open; its own answer is the end.
    if (model.ops.length === 0) {
      const end = await client.push(message === "" ? undefined : message);
      // Read the state after the answer: the stream has been filling it (lanes, log) while the call was open.
      model.push = pushEnd(model.push, end);
    } else {
      const done = await client.write(model.ops, message, model.stagedSkills, model.captured);
      model.push = pushEnd(model.push, done.push);
      // The files are committed whether or not the push went through, so the edits are no longer held either way.
      model.pushNotice = writtenNotice(done.written, done.code);
      model.ops = [];
      model.captured = [];
      model.capture = { ...model.capture, done: {} };
      model.plan = null;
      model.messageEdited = false;
    }
  } catch (e) {
    model.push = { ...model.push, running: false };
    model.pushError = e instanceof ApiError ? e.messages.join("; ") || e.message : "the push ended in a way the page did not understand. Look at fleet status in a terminal to see what was pushed.";
  }
  loadStatus();
  loadMatrix();
  loadSecrets();
  if (routeOf(location.hash) === "capture") loadCapture();
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

// ---- Fleet: what each host last said at once, then every host asked, with no polling

/** The Fleet screen: the document the server last sent, and what the buttons do. */
const fleetView = () =>
  fleetScreen({
    doc: model.fleet,
    error: model.fleetError,
    asking: model.fleetAsking || model.jobs.some((j) => j.kind === "fleet"),
    usable: usable(),
    open: model.fleetOpen,
    refresh: () => void askFleet(),
    toggle: (host) => {
      if (!model.fleetOpen.delete(host)) model.fleetOpen.add(host);
      render();
    },
  });

/** What the hosts last said, from the server's memory: no host is asked. */
async function loadFleet() {
  if (client === null) return;
  try {
    model.fleet = withFleetDoc(model.fleet, await client.fleet());
    model.fleetError = null;
  } catch (e) {
    model.fleetError = e instanceof ApiError ? `${e.messages.join("; ") || e.message} (${e.code})` : "the hosts could not be read";
  }
  render();
}

/** Asks every host. The answers arrive on the stream one by one; the call's own answer is the last word. */
async function askFleet() {
  if (client === null || model.fleetAsking) return;
  model.fleetAsking = true;
  render();
  try {
    model.fleet = withFleetDoc(model.fleet, await client.refreshFleet());
    model.fleetError = null;
  } catch (e) {
    model.fleetError = e instanceof ApiError ? `${e.messages.join("; ") || e.message} (${e.code})` : "the hosts could not be asked";
  }
  model.fleetAsking = false;
  render();
}

/** What the screen shows at once, then every host asked. */
async function openFleet() {
  await loadFleet();
  askFleet();
}

// ---- Capture: what this machine has that is not from config

const captureView = () =>
  captureScreen({
    doc: model.capture.doc,
    error: model.capture.error,
    usable: usable(),
    busy: model.capture.busy,
    drafts: model.capture.drafts,
    done: model.capture.done,
    agents: agentList(),
    notice: model.capture.notice,
    change: (id, draft) => {
      model.capture = { ...model.capture, drafts: { ...model.capture.drafts, [id]: draft } };
      render();
    },
    answer: (item, action) => void answerCapture(item, action),
  });

/** What this machine has now. Each item starts from the answer its defaults give, and keeps one the person already changed. */
async function loadCapture() {
  if (client === null) return;
  try {
    const doc = await client.capture();
    const drafts = Object.fromEntries(doc.items.map((/** @type {any} */ item) => [captureId(item), model.capture.drafts[captureId(item)] ?? captureDraft(item)]));
    model.capture = { ...model.capture, doc, drafts, error: null };
  } catch (e) {
    model.capture = { ...model.capture, error: e instanceof ApiError ? `${e.messages.join("; ") || e.message} (${e.code})` : "this machine could not be read" };
  }
  render();
}

/**
 * One answer about one item. Taking over what already matches is done at once (it changes nothing in the config); the rest is
 * worked out by the server into held edits, which go on To push with the ones already there.
 * @param {any} item @param {"add" | "takeover" | "ignore"} action
 */
async function answerCapture(item, action) {
  if (client === null || model.capture.busy !== null) return;
  const id = captureId(item);
  const draft = model.capture.drafts[id] ?? captureDraft(item);
  model.capture = { ...model.capture, busy: id, error: null, notice: null };
  render();
  try {
    if (action === "takeover") {
      const out = await client.captureTakeover([{ kind: item.kind, name: item.name }]);
      model.capture = { ...model.capture, notice: out.problems.length > 0 ? out.problems.map(plain).join("; ") : out.rewrites.length > 0 ? `Taken over. ${out.rewrites.length} of its entries differ and the next apply rewrites them.` : null };
      await loadStatus();
    } else {
      const out = await client.captureBuild(model.ops, model.stagedSkills, decisionOf(item, action, draft));
      model.ops = out.ops;
      model.stagedSkills = out.staged;
      if (out.takeover) model.captured = [...model.captured.filter((c) => c.kind !== item.kind || c.name !== item.name), { kind: item.kind, name: item.name }];
      model.capture = { ...model.capture, done: { ...model.capture.done, [id]: doneWords(action, draft.scope) } };
      refreshPreview();
    }
  } catch (e) {
    model.capture = { ...model.capture, error: said(e, "that could not be worked out") };
  }
  model.capture = { ...model.capture, busy: null };
  render();
  if (action === "takeover") loadCapture();
}

/** Each screen reads what it shows when it is opened, so it is never older than the click that opened it. */
function opened() {
  const route = routeOf(location.hash);
  model.menu = false;
  render();
  if (route === "fleet") openFleet();
  if (route === "secrets") loadSecrets();
  if (route === "capture") loadCapture();
  if (route === "card") loadCard();
  if (route === "review") loadPlan();
  if (route === "matrix" || route === "catalog" || route === "hosts") loadMatrix();
}

// A new `fleet ui` URL opened in this tab changes only the fragment when the port is the same, so the page is not loaded
// again by itself: take the new token and load it, which restores the To push list kept for this tab.
window.addEventListener("hashchange", () => {
  const fresh = tokenOf(location.hash);
  if (fresh === null) return;
  pageToken(store, fresh);
  history.replaceState(null, "", location.pathname + "#/fleet");
  location.reload();
});
window.addEventListener("hashchange", opened);
render();
if (token !== null) {
  loadStatus();
  loadMatrix();
  loadSecrets();
  if (routeOf(location.hash) === "fleet") openFleet();
  openStream(token, {
    onHello: (doc) => {
      // The server's list of running jobs is the truth for a connection that just opened. A push or init that runs starts afresh
      // here, and its events so far are replayed right after this.
      model.jobs = jobsOf(doc);
      Object.assign(model, withJobs(model, model.jobs, null));
      render();
      loadStatus();
    },
    onEvent: (name, doc) => {
      if (name === "jobs") {
        const now = jobsOf(doc);
        Object.assign(model, withJobs(model, now, model.jobs));
        model.jobs = now;
      } else if (name === "fleet") {
        // A host answered: the document so far. The call that asked has the last word when it returns.
        model.fleet = withFleetDoc(model.fleet, doc);
      } else if (name === "init") model.init = initLine(model.init, doc);
      else if (name === "initend") model.init = initEnd(model.init, doc);
      else if (name === "remove") model.removal = initLine(model.removal, doc);
      else if (name === "removeend") model.removal = initEnd(model.removal, doc);
      else model.push = name === "push" ? pushEvent(model.push, doc) : pushEnd(model.push, doc);
      render();
      // Another tab's push or init changed the repo and this host: read them again, so nothing here is older than its end.
      if (name === "initend" || name === "pushend" || name === "removeend") {
        loadStatus();
        loadMatrix();
        loadSecrets();
      }
    },
    onLink: (link) => {
      if (link === "invalid") return denied();
      model.link = link === "live" ? "live" : "reconnecting";
      render();
    },
  });
  // Leaving the page does not stop a push or a host set-up, but the page is the only place their output is seen live.
  window.addEventListener("beforeunload", (e) => {
    if (!model.push.running && !model.init.running && !model.removal.running) return;
    e.preventDefault();
    e.returnValue = "";
  });
}
