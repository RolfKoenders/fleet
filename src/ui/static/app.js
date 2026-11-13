// The page: the shell, routing between screens, and drawing the state from state.js.
import { ApiError, createClient, openStream } from "./api.js";
import { changed, counts, lineDiff, splitLines, tokenize } from "./diff.js";
import { fill, h } from "./dom.js";
import { bundleDraft, checkLines, cloneKey, confirmText, opWarnings, secretOf, secretsOf, serverDraft, skillChoices, sourceDraft, takeBack } from "./catalog.js";
import { blockers, cellState, clickCell, opLabel, suggestMessage, summaryLine, WORDS } from "./matrix.js";
import { blankHost, confirmInit, fileLines, heldProblem, hostDraft, idleInit, initEnd, initLine, SETUP_DOC, startInit } from "./hosts.js";
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
 *   skills: { name: string, source: string, bundle: string | null }[], stagedSkills: Record<string, string[]>, form: any,
 *   hostForm: import("./hosts.js").HostForm, hostConfirm: boolean, init: import("./hosts.js").InitState, initError: string | null
 * }}
 */
const model = {
  status: null, statusError: null, matrixError: null,
  base: null, ops: [], preview: null, held: {}, focus: null, expanded: new Set(),
  plan: null, message: "", messageEdited: false, secrets: null, secretsError: null,
  push: idlePush(), pushError: null, link: "connecting",
  skills: [], stagedSkills: {}, form: null,
  hostForm: blankHost(), hostConfirm: false, init: idleInit(), initError: null,
};

const client = token === null ? null : createClient(token);

/** @type {Record<string, [string, string]>} */
const SCREENS = {
  matrix: ["Matrix", "What each host gets: every skill bundle and MCP server against every host. Click a cell to give it to a host or take it away. Fleet writes the smallest change: an item the defaults give is taken away with exclude, not by editing the defaults."],
  catalog: ["Catalog", "The MCP servers, skill sources and skill bundles your hosts can pick from. Adding one here gives it to no host yet: pick it in the Matrix. An addition is held like any edit, and written when you push."],
  hosts: ["Hosts", "The hosts in this config, and how each is reached. Add a host here and fleet sets it up over ssh: it writes its host file, then runs the real fleet init."],
  secrets: ["Secrets", "Which secrets exist and which hosts can read them. Names only: a value is never read or shown."],
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
  const link = $("link");
  link.textContent = model.link;
  link.className = "tag " + (model.link === "live" ? "ok" : model.link === "reconnecting" ? "warn" : "");
  const s = model.status ? statusView(model.status) : null;
  fill($("repo"), ...(s ? [h("b", {}, s.host), ...(model.status?.repos?.fleet ? [h("span", {}, `${model.status.repos.fleet.branch ?? "detached"}@${String(model.status.repos.fleet.sha).slice(0, 7)}`)] : [])] : []));

  if (client === null) return fill(main, noToken());
  // Typing in the commit message must survive the page being drawn again by a push event or an answer.
  const active = document.activeElement;
  const keep = active instanceof HTMLInputElement && main.contains(active) ? { id: active.id, at: active.selectionStart } : null;
  const scroll = route === drawn ? main.scrollTop : 0;
  drawn = route;
  fill(main, screen(route));
  main.scrollTop = scroll;
  if (keep !== null && keep.id !== "") {
    const again = document.getElementById(keep.id);
    if (again instanceof HTMLInputElement) {
      again.focus();
      if (keep.at !== null) again.setSelectionRange(keep.at, keep.at);
    }
  }
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
        h("small", {}, baseRow === undefined ? `${small} · new, held` : small),
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
              title: `${row.name} on ${host.name}: ${word}${staged ? " (held)" : ""}`,
              "aria-label": `${row.name} on ${host.name}: ${word}${staged ? ", held" : ""}`,
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
      h("span", {}, h("b", { class: "mk staged" }, "▢"), "held, not written yet"),
    ),
    model.ops.length > 0
      ? h("div", { class: "row heldbar" }, h("span", { class: "tag ok" }, `${model.ops.length} held`), h("a", { class: "btn primary", href: "#/review" }, "Review & push"), h("button", { class: "btn ghost", onclick: discardAll }, "Discard all"))
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

// ---- Catalog

const CATALOG_FILE = { server: "catalog/mcp.yaml", source: "catalog/skills.yaml", bundle: "catalog/skills.yaml" };

/** The words after an error: the server's own, or the fallback. @param {unknown} e @param {string} fallback */
const said = (e, fallback) => (e instanceof ApiError ? e.messages.join("; ") || e.message : fallback);

const blankServer = () => ({ name: "", kind: "command", command: "", url: "", rows: [{ key: "", mode: "secret", value: "" }], claude: true, opencode: true });
const blankSource = () => ({ name: "", repo: "", path: ".", branch: "", mode: "pin", review: true });

/** @param {"server" | "source" | "bundle"} kind */
const freshForm = (kind) => ({ kind, server: blankServer(), source: blankSource(), bundle: { name: "", picked: [], extra: "" }, live: null, confirm: false, check: null, clone: { state: "idle", doc: null, error: null } });

const skillOptions = () => skillChoices(model.skills, model.ops, model.stagedSkills);

/** What the open form would hold, or why it cannot yet. @param {any} f */
function draftOf(f) {
  const view = shownMatrix();
  if (f.kind === "server") return serverDraft(f.server, view.servers.map((/** @type {any} */ r) => r.name));
  if (f.kind === "source") return sourceDraft(f.source, (view.sources ?? []).map((/** @type {any} */ r) => r.name), f.clone.doc);
  return bundleDraft(f.bundle, view.bundles.map((/** @type {any} */ r) => r.name), skillOptions());
}

/** @param {"server" | "source" | "bundle"} kind */
function openForm(kind) {
  dropClone();
  model.form = freshForm(kind);
  render();
  loadSkills();
  loadSecrets();
  scheduleLive();
}

function closeForm() {
  dropClone();
  clearTimeout(liveTimer);
  model.form = null;
  render();
}

/** The temp clone on the server is deleted when the form is closed, replaced or the page goes away. */
function dropClone() {
  const id = model.form?.clone?.doc?.id;
  if (client !== null && id) client.discardClone(id).catch(() => {});
}
window.addEventListener("pagehide", dropClone);

/** Something in the form changed: draw it again, and ask the server what the file would look like. */
function edited() {
  render();
  scheduleLive();
}

/** @param {any} f @param {any} op */
function stage(f, op) {
  if (op.op === "addSource" && f.clone.doc) model.stagedSkills[op.name] = f.clone.doc.skills;
  model.ops = [...model.ops, op];
  model.messageEdited = false;
  closeForm();
  refreshPreview();
}

/** @param {Op} op */
function unstage(op) {
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
    const doc = await client.preview([...model.ops, d.op]);
    if (seq !== liveSeq || model.form !== f) return;
    f.live = { key, doc, error: null };
  } catch (e) {
    if (seq !== liveSeq || model.form !== f) return;
    f.live = { key, doc: null, error: said(e, "the file could not be previewed") };
  }
  render();
}

async function loadSkills() {
  if (client === null) return;
  try {
    model.skills = (await client.skills()).skills;
  } catch {
    // the list is a help: a bundle can still be made from names typed in
  }
  render();
}

async function lookAtRepo() {
  const f = model.form;
  if (f === null || client === null) return;
  const s = f.source;
  const key = cloneKey(s);
  dropClone();
  f.clone = { state: "running", doc: null, error: null };
  render();
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
  render();
  try {
    const doc = await client.probe(d.op.name, d.op.entry);
    if (f.check?.key === key) f.check = { key, state: "done", doc };
  } catch (e) {
    if (f.check?.key === key) f.check = { key, state: "error", error: said(e, "the check could not run") };
  }
  render();
}

// -- drawing the forms

/** @param {string} id @param {string} label @param {Node} control @param {Node | string | (Node | string)[] | null} [help] */
const field = (id, label, control, help = null) => h("div", { class: "field" }, h("label", { for: id }, label), control, help === null ? null : h("div", { class: "help" }, ...[help].flat()));

/** A text input that changes the form as it is typed in. @param {string} id @param {string} value @param {(v: string) => void} set @param {Record<string, string>} [extra] */
const textInput = (id, value, set, extra = {}) =>
  h("input", { type: "text", id, value, autocomplete: "off", spellcheck: "false", maxlength: "500", ...extra, oninput: (e) => { set(/** @type {HTMLInputElement} */ (e.target).value); edited(); } });

/** @param {string[]} labels @param {string[]} values @param {string} current @param {(v: string) => void} set */
const seg = (labels, values, current, set) =>
  h("div", { class: "seg", role: "group" }, ...values.map((v, i) => h("button", { type: "button", class: v === current ? "on" : "", "aria-pressed": String(v === current), onclick: () => { set(v); edited(); } }, labels[i])));

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
    field("f-kind", "It runs", seg(["on the machine (command)", "at a URL (http)", "at a URL (sse)"], ["command", "http", "sse"], s.kind, (v) => (s.kind = v))),
    net
      ? field("f-url", "URL", textInput("f-url", s.url, (v) => (s.url = v), { placeholder: "where the server listens: https, then the address" }))
      : field("f-cmd", "Command", textInput("f-cmd", s.command, (v) => (s.command = v), { placeholder: "npx -y @example/server@1.2.3" }), commandProblem ? h("span", { class: "bad" }, commandProblem) : "Pin the version. A secret can never go here: the process list shows command lines."),
    ...d.warnings.map((w) => h("div", { class: "notice inline" }, w)),
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
          h("div", { class: "row tail" }, r.mode === "secret" ? secretTag(secretOf(r)) : null, h("button", { type: "button", class: "btn ghost x", title: "Remove this row", "aria-label": "remove this row", onclick: () => { s.rows.splice(i, 1); edited(); } }, "✕")),
        ),
      ),
      h("button", { type: "button", class: "btn ghost small", onclick: () => { s.rows.push({ key: "", mode: "secret", value: "" }); edited(); } }, net ? "+ Add a header" : "+ Add a variable"),
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
    field("s-repo", "Repo", textInput("s-repo", s.repo, (v) => (s.repo = v), { placeholder: "the repo URL, or a path on this machine" }), "A URL, or a path on this machine. It is cloned shallowly into a temp directory to list its skills, and the clone is deleted when you close this form."),
    field("s-path", "Path in the repo", textInput("s-path", s.path, (v) => (s.path = v), { placeholder: "." }), "Where to look for skills: directories with a SKILL.md, at any depth. Use . for the whole repo."),
    field("s-branch", "Branch", textInput("s-branch", s.branch, (v) => (s.branch = v), { placeholder: "the repo's default" })),
    field("s-mode", "Keep it", seg(["pinned to a commit", "following the branch"], ["pin", "follow"], s.mode, (v) => (s.mode = v)), s.mode === "pin" ? "A pinned source moves only when you run fleet skills update, so a change upstream cannot reach your machines unreviewed." : "A followed source is on the newest commit of its branch at every apply. Use it for skills you write."),
    s.mode === "pin" ? h("div", { class: "field" }, check("s-review", "Review what a move brings in before the pin changes (review: true)", s.review, (v) => (s.review = v))) : null,
    h(
      "div",
      { class: "row" },
      h("button", { type: "button", class: "btn", disabled: s.repo.trim() === "" || c.state === "running", onclick: lookAtRepo }, c.state === "running" ? "Cloning..." : fresh ? "Look again" : "Look at the repo"),
      c.state === "error" ? h("span", { class: "bad" }, c.error) : null,
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

/** The part of a diff around its changes, for a file too long to show whole. @param {[string, string][]} d @param {number} context */
function nearChanges(d, context) {
  /** @type {[string, string][]} */
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

/** The YAML this form would add, as the server splices it into the file, or why it cannot yet. @param {any} f @param {any} d */
function yamlPane(f, d) {
  const path = CATALOG_FILE[/** @type {"server" | "source" | "bundle"} */ (f.kind)];
  const head = (/** @type {Node | string} */ tag) => h("div", { class: "ph" }, path, h("span", { class: "spacer" }), tag);
  if (d.op === null) return h("div", {}, head(h("span", { class: "tag" }, "not ready")), h("div", { class: "hint" }, "To add it:", h("ul", {}, ...d.problems.map((/** @type {string} */ p) => h("li", {}, p)))));
  const live = f.live;
  if (live === null || live.key !== JSON.stringify(d.op)) return h("div", {}, head(h("span", { class: "tag" }, "reading")), h("div", { class: "hint" }, "Reading the file..."));
  if (live.error !== null) return h("div", {}, head(h("span", { class: "tag bad" }, "refused")), h("div", { class: "notice bad inset" }, live.error));
  const doc = live.doc;
  const dropped = doc.dropped.find((/** @type {any} */ x) => JSON.stringify(x.op) === live.key);
  if (dropped) return h("div", {}, head(h("span", { class: "tag bad" }, "does not apply")), h("div", { class: "notice bad inset" }, dropped.reason));
  const file = doc.files.find((/** @type {any} */ x) => x.path === path);
  const broken = doc.checks.filter((/** @type {any} */ c) => !c.loads);
  const before = model.held[path]?.after ?? file?.before ?? "";
  const lines = nearChanges(lineDiff(splitLines(before), splitLines(file?.after ?? "")), 2);
  return h(
    "div",
    {},
    head(h("span", { class: "tag ok" }, f.kind === "bundle" || f.kind === "source" ? `+ added at the end of ${f.kind === "bundle" ? "bundles" : "sources"}` : "+ added at the end of servers")),
    diffBody(lines),
    broken.length > 0 ? h("div", { class: "notice bad inset" }, `With this, the config does not load for ${broken.map((/** @type {any} */ c) => c.host).join(", ")}: ${broken[0].problems[0] ?? ""}`) : null,
  );
}

/** What "Check it starts" says: first the question, then the answer. @param {any} f @param {any} d */
function probeBox(f, d) {
  if (f.kind !== "server") return null;
  if (f.confirm && d.op !== null) {
    return h(
      "div",
      { class: "probe confirm", role: "alertdialog", "aria-label": "Confirm the check" },
      h("div", {}, confirmText(d.op)),
      h("div", { class: "row" }, h("button", { type: "button", class: "btn primary", onclick: runCheck }, "Run the check"), h("button", { type: "button", class: "btn ghost", onclick: () => { f.confirm = false; render(); } }, "Cancel")),
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

function addForm() {
  const f = model.form;
  const d = draftOf(f);
  const title = { server: "Add an MCP server", source: "Add a skill source", bundle: "Add a bundle" }[/** @type {"server" | "source" | "bundle"} */ (f.kind)];
  const fields = f.kind === "server" ? serverFields(f) : f.kind === "source" ? sourceFields(f) : bundleFields(f);
  const warnings = f.kind === "bundle" ? d.warnings.map((/** @type {string} */ w) => h("div", { class: "notice inline" }, w)) : [];
  return h(
    "div",
    { class: "panel addform", id: "addform" },
    h("div", { class: "ph" }, title, h("span", { class: "spacer" }), h("button", { type: "button", class: "btn ghost", onclick: closeForm }, "Cancel")),
    h(
      "div",
      { class: "split flush" },
      h("div", { class: "form" }, ...fields),
      h(
        "div",
        { class: "formright" },
        yamlPane(f, d),
        ...warnings,
        probeBox(f, d),
        h(
          "div",
          { class: "ph foot" },
          f.kind === "server" ? h("button", { type: "button", class: "btn", disabled: d.op === null || f.confirm || f.check?.state === "running", onclick: () => { f.confirm = true; render(); } }, "Check it starts") : null,
          h("span", { class: "spacer" }),
          h("button", { type: "button", class: "btn primary", disabled: d.op === null, onclick: () => d.op && stage(f, d.op) }, "Stage it"),
        ),
      ),
    ),
  );
}

/** @param {"server" | "source" | "bundle"} kind @param {string} label */
const addCard = (kind, label) => h("button", { type: "button", class: "panel card add", onclick: () => openForm(kind) }, label);

/** The button that takes back a held addition. @param {Op | undefined} op */
const heldTag = (op) => (op ? h("span", { class: "tag ok" }, "held") : null);
const takeBackBtn = (/** @type {Op | undefined} */ op) => (op ? h("button", { type: "button", class: "btn ghost small", onclick: () => unstage(op) }, "Take back") : null);

/** @param {string} kind @param {string} name @returns {Op | undefined} */
const heldOp = (kind, name) => model.ops.find((o) => o.op === kind && o.name === name);

function catalogScreen() {
  const [title, about] = SCREENS.catalog;
  if (model.base === null) return loadingOrError(title, model.matrixError);
  const view = shownMatrix();
  const hosts = view.hosts;
  const uses = (/** @type {any} */ row) => hosts.filter((/** @type {any} */ x) => row.cells[x.name]?.on).length;
  const onHosts = (/** @type {any} */ row) => h("span", { class: "tag " + (uses(row) > 0 ? "ok" : "") }, `on ${uses(row)} of ${hosts.length} host${hosts.length === 1 ? "" : "s"}`);
  const form = model.form;
  const where = (/** @type {string} */ kind) => (form !== null && form.kind === kind ? addForm() : null);
  const sources = view.sources ?? [];
  const skillsOf = (/** @type {string} */ name) => [...new Set([...model.skills.filter((k) => k.source === name).map((k) => k.name), ...(model.stagedSkills[name] ?? [])])];
  return h(
    "div",
    {},
    h("h1", {}, title),
    h("p", { class: "sub" }, about),
    h("h2", {}, "MCP servers"),
    h("div", { class: "cards" },
      ...view.servers.map((/** @type {any} */ sv) => {
        const op = heldOp("addServer", sv.name);
        return h("div", { class: "panel card" }, h("h3", {}, sv.name, h("span", { class: "tag" }, sv.server?.kind ?? ""), heldTag(op)), h("p", {}, serverLine(sv)), h("div", { class: "row" }, onHosts(sv), takeBackBtn(op)));
      }),
      addCard("server", "+ Add an MCP server"),
    ),
    where("server"),
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
    where("source"),
    h("h2", {}, "Skill bundles"),
    h("div", { class: "cards" },
      ...view.bundles.map((/** @type {any} */ b) => {
        const op = heldOp("addBundle", b.name);
        return h("div", { class: "panel card" }, h("h3", {}, b.name, heldTag(op)), h("div", { class: "row" }, ...b.skills.map((/** @type {string} */ sk) => h("span", { class: "tag" }, sk))), h("p", {}, ""), h("div", { class: "row" }, onHosts(b), takeBackBtn(op)));
      }),
      addCard("bundle", "+ Add a bundle"),
    ),
    where("bundle"),
    model.ops.length > 0 ? h("div", { class: "row heldbar" }, h("span", { class: "tag ok" }, `${model.ops.length} held`), h("a", { class: "btn primary", href: "#/review" }, "Review & push")) : null,
  );
}

function hostsScreen() {
  const [title, about] = SCREENS.hosts;
  if (model.base === null) return loadingOrError(title, model.matrixError);
  return h(
    "div",
    {},
    h("h1", {}, title),
    h("p", { class: "sub" }, about),
    h("div", { class: "cards" }, ...model.base.hosts.map((/** @type {any} */ host) => {
      const bundles = model.base.bundles.filter((/** @type {any} */ b) => b.cells[host.name]?.on).map((/** @type {any} */ b) => b.name);
      const servers = model.base.servers.filter((/** @type {any} */ sv) => sv.cells[host.name]?.on).map((/** @type {any} */ sv) => sv.name);
      return h(
        "div",
        { class: "panel card" },
        h("h3", {}, host.name, host.self ? h("span", { class: "tag ok" }, "this host") : null),
        h("dl", { class: "facts small" }, h("dt", {}, "reached"), h("dd", {}, host.self ? "local" : host.ssh ? `ssh ${host.ssh}` : "on its own timer"), h("dt", {}, "bundles"), h("dd", {}, bundles.join(", ") || "none"), h("dt", {}, "servers"), h("dd", {}, servers.join(", ") || "none")),
      );
    })),
    h("h2", {}, "Add a host"),
    addHostPanel(),
  );
}

/** The Add-a-host form, or why it cannot be used right now. */
function addHostPanel() {
  const held = heldProblem(model.ops);
  const outside = model.base?.outside ?? [];
  if (held !== null) {
    return h("div", { class: "notice", id: "hostheld" }, h("b", {}, held), h("div", { class: "row", style: "margin-top:10px" }, h("a", { class: "btn primary", href: "#/review" }, "Review & push"), h("button", { type: "button", class: "btn", onclick: discardAll }, "Discard held edits")));
  }
  const names = model.base.hosts.map((/** @type {any} */ x) => x.name);
  const f = model.hostForm;
  const d = hostDraft(f, names);
  const running = model.init.running;
  const text = (/** @type {string} */ id, /** @type {"name" | "ssh"} */ key, /** @type {Record<string, string>} */ extra) => textInput(id, f[key], (v) => { f[key] = v; model.hostConfirm = false; }, extra);
  const sel = h(
    "select",
    { id: "host-from", onchange: (e) => { f.from = /** @type {HTMLSelectElement} */ (e.target).value; model.hostConfirm = false; render(); } },
    h("option", { value: "" }, "the defaults only"),
    ...names.map((/** @type {string} */ n) => h("option", { value: n, ...(f.from === n ? { selected: true } : {}) }, `a copy of ${n}`)),
  );
  const end = model.init.end;
  return h(
    "div",
    { class: "panel addform", id: "addhost" },
    h("div", { class: "ph" }, "Add a host", h("span", { class: "spacer" }), h("span", { class: "tag" }, "writes hosts/<name>.yaml, then runs fleet init from here")),
    h(
      "div",
      { class: "split flush" },
      h(
        "div",
        { class: "form" },
        field("host-name", "Name", text("host-name", "name", { placeholder: "mini" }), d.name === null ? "The host's file is hosts/<name>.yaml, and the name fleet init writes on the machine." : h("span", { class: "bad" }, d.name)),
        field("host-ssh", "Reach it over ssh", text("host-ssh", "ssh", { placeholder: "me@mini.local" }), d.ssh === null ? ["Required: fleet init reaches the host over ssh. A machine fleet cannot reach this way is set up by hand: ", h("a", { href: SETUP_DOC, target: "_blank", rel: "noopener noreferrer", class: "link" }, "setting up machines"), "."] : h("span", { class: "bad" }, d.ssh)),
        field("host-from", "Start from", sel, f.from === "" ? "Nothing is picked: the host gets the defaults." : `Copies bundles, exclude, mcp, settings and vars of ${f.from}. Not its ssh, age key or files.`),
        outside.length > 0 ? h("div", { class: "notice inline" }, "The config repo has changes the page did not make: commit or discard them first.") : null,
        model.hostConfirm && d.body !== null
          ? h("div", { class: "notice inline", id: "hostconfirm" }, confirmInit(d.body), h("div", { class: "row inset" }, h("button", { type: "button", class: "btn primary", disabled: running, onclick: runInit }, `Run fleet init ${d.body.name}`), h("button", { type: "button", class: "btn ghost", onclick: () => { model.hostConfirm = false; render(); } }, "Cancel")))
          : h("div", { class: "row" }, h("button", { type: "button", class: "btn primary", id: "host-go", disabled: d.body === null || running || outside.length > 0, onclick: () => { model.hostConfirm = true; render(); } }, "Add and set it up"), h("span", { class: "muted" }, "Asks before running anything.")),
      ),
      h(
        "div",
        { class: "formright" },
        h("div", { class: "ph" }, d.body ? `fleet init ${d.body.name}` : "fleet init", h("span", { class: "spacer" }), end ? h("span", { class: "tag " + (end.ok ? "ok" : "bad") }, end.code) : running ? h("span", { class: "tag" }, "running") : null),
        model.initError !== null ? h("div", { class: "notice bad inset" }, model.initError) : null,
        h("pre", { class: "term", id: "initlog", "aria-live": "polite" }, model.init.lines.length > 0 ? model.init.lines.join("\n") : h("span", { class: "muted" }, d.body ? `Will write:\n${fileLines(d.body).join("\n")}` : "The real fleet init runs here, over ssh, with its output streamed in.")),
        end ? h("div", { class: "hint" }, ...(end.ok ? [`${model.init.name} is set up. It is in the Matrix now; pick what it gets there.`] : end.messages.map((m) => h("div", {}, m)))) : null,
      ),
    ),
  );
}

/** Writes the host file and runs the real init. Its output comes on the stream while this call is open. */
async function runInit() {
  const d = hostDraft(model.hostForm, model.base.hosts.map((/** @type {any} */ x) => x.name));
  if (client === null || d.body === null) return;
  model.hostConfirm = false;
  model.initError = null;
  model.init = startInit(d.body.name);
  render();
  try {
    const doc = await client.initHost(d.body);
    model.init = initEnd(model.init, doc);
    if (doc.ok) model.hostForm = blankHost();
  } catch (e) {
    model.init = { ...model.init, running: false };
    model.initError = said(e, "the host could not be set up");
  }
  loadStatus();
  loadMatrix();
  loadSecrets();
}

function secretsScreen() {
  const [title, about] = SCREENS.secrets;
  if (model.secrets === null) return loadingOrError(title, model.secretsError);
  const { entries, hosts } = model.secrets;
  return h(
    "div",
    {},
    h("h1", {}, title),
    h("p", { class: "sub" }, about),
    model.secrets.problems.slice(0, 2).map((/** @type {string} */ p) => h("div", { class: "notice" }, p)),
    entries.length === 0
      ? h("div", { class: "panel empty" }, "No secrets yet.")
      : h(
          "div",
          { class: "panel scroll" },
          h(
            "table",
            { class: "sec" },
            h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Used by"), ...hosts.map((/** @type {string} */ x) => h("th", {}, x)))),
            h("tbody", {}, ...entries.map((/** @type {any} */ e) =>
              h("tr", {}, h("td", {}, e.name), h("td", { class: "muted" }, e.servers.join(", ") || "-"), ...hosts.map((/** @type {string} */ x) => h("td", { class: e.readers.includes(x) ? "have" : "na" }, e.readers.includes(x) ? "✓ can read" : "·"))),
            )),
          ),
        ),
  );
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
    !editing ? h("div", { class: "panel empty" }, "Nothing is held. Click a cell in the Matrix to give or take away a pick, or add to the Catalog.") : h("h2", {}, "Checks"),
    editing ? h("div", { class: "checks" }, ...checks.map(checkCard)) : null,
    model.ops.flatMap(opWarnings).length > 0 ? h("div", { class: "notice inline" }, h("b", {}, "Worth a look before you push:"), h("ul", {}, ...model.ops.flatMap(opWarnings).map((w) => h("li", {}, w)))) : null,
    editing ? planPanel() : null,
    editing ? h("h2", {}, "Files") : null,
    editing ? h("div", { class: "files" }, ...files.map((file) => diffPanel(file, model.held[file].before, model.held[file].after))) : null,
    h("h2", {}, "Push"),
    h(
      "div",
      { class: "panel" },
      h("div", { class: "pushbox" }, message, go, editing ? h("button", { class: "btn ghost", disabled: model.push.running, onclick: discardAll }, "Discard all") : null),
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
    h("div", { class: "ph" }, file, h("span", { class: "spacer" }), h("span", { class: "tag " + (changed(d) ? "ok" : "") }, changed(d) ? `+${added} -${removed}` : "unchanged")),
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
