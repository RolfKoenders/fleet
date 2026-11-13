// The page: the shell, routing between screens, and drawing the state from state.js.
import { ApiError, createClient, openStream } from "./api.js";
import { changed, counts, lineDiff, splitLines, tokenize } from "./diff.js";
import { fill, h } from "./dom.js";
import { blockers, cellState, clickCell, opLabel, suggestMessage, summaryLine, WORDS } from "./matrix.js";
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
 *   push: PushState, pushError: string | null, link: "connecting" | "live" | "reconnecting"
 * }}
 */
const model = {
  status: null, statusError: null, matrixError: null,
  base: null, ops: [], preview: null, held: {}, focus: null, expanded: new Set(),
  plan: null, message: "", messageEdited: false, secrets: null, secretsError: null,
  push: idlePush(), pushError: null, link: "connecting",
};

const client = token === null ? null : createClient(token);

/** @type {Record<string, [string, string]>} */
const SCREENS = {
  matrix: ["Matrix", "What each host gets: every skill bundle and MCP server against every host. Click a cell to give it to a host or take it away. Fleet writes the smallest change: an item the defaults give is taken away with exclude, not by editing the defaults."],
  catalog: ["Catalog", "The MCP servers and skill bundles your hosts can pick from. Read-only for now: adding to the catalog comes later."],
  hosts: ["Hosts", "The hosts in this config, and how each is reached. Read-only for now."],
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
        h("small", {}, small),
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

function catalogScreen() {
  const [title, about] = SCREENS.catalog;
  if (model.base === null) return loadingOrError(title, model.matrixError);
  const hosts = model.base.hosts;
  const uses = (/** @type {any} */ row) => hosts.filter((/** @type {any} */ x) => row.cells[x.name]?.on).length;
  return h(
    "div",
    {},
    h("h1", {}, title),
    h("p", { class: "sub" }, about),
    h("h2", {}, "MCP servers"),
    model.base.servers.length === 0 ? h("div", { class: "panel empty" }, "No MCP servers in the catalog.") : h("div", { class: "cards" }, ...model.base.servers.map((/** @type {any} */ sv) =>
      h("div", { class: "panel card" }, h("h3", {}, sv.name, h("span", { class: "tag" }, sv.server?.kind ?? "")), h("p", {}, serverLine(sv)), h("span", { class: "tag " + (uses(sv) > 0 ? "ok" : "") }, `on ${uses(sv)} of ${hosts.length} host${hosts.length === 1 ? "" : "s"}`)),
    )),
    h("h2", {}, "Skill bundles"),
    model.base.bundles.length === 0 ? h("div", { class: "panel empty" }, "No skill bundles in the catalog.") : h("div", { class: "cards" }, ...model.base.bundles.map((/** @type {any} */ b) =>
      h("div", { class: "panel card" }, h("h3", {}, b.name), h("div", { class: "row" }, ...b.skills.map((/** @type {string} */ sk) => h("span", { class: "tag" }, sk))), h("p", {}, ""), h("span", { class: "tag " + (uses(b) > 0 ? "ok" : "") }, `on ${uses(b)} of ${hosts.length} host${hosts.length === 1 ? "" : "s"}`)),
    )),
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
  );
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
    !editing ? h("div", { class: "panel empty" }, "Nothing is held. Click a cell in the Matrix to give or take away a pick.") : h("h2", {}, "Checks"),
    editing ? h("div", { class: "checks" }, ...checks.map(checkCard)) : null,
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

/** @param {string} file @param {string} before @param {string} after */
export function diffPanel(file, before, after) {
  const d = lineDiff(splitLines(before), splitLines(after));
  const { added, removed } = counts(d);
  return h(
    "div",
    { class: "panel" },
    h("div", { class: "ph" }, file, h("span", { class: "spacer" }), h("span", { class: "tag " + (changed(d) ? "ok" : "") }, changed(d) ? `+${added} -${removed}` : "unchanged")),
    h(
      "pre",
      { class: "yaml" },
      ...d.map(([op, line]) =>
        h("span", { class: "line " + (op === "+" ? "add" : op === "-" ? "del" : "") }, `${op === " " ? " " : op} `, ...tokenize(line).map((t) => (t.cls === "" ? t.text : h("span", { class: t.cls }, t.text)))),
      ),
    ),
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
  if (client === null || routeOf(location.hash) !== "secrets") return;
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
      model.push = name === "push" ? pushEvent(model.push, doc) : pushEnd(model.push, doc);
      render();
    },
    onLink: (live) => {
      model.link = live ? "live" : "reconnecting";
      render();
    },
  });
}
