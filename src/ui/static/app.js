// The page: the shell, routing between screens, and drawing the state from state.js.
import { ApiError, createClient, openStream } from "./api.js";
import { changed, counts, lineDiff, splitLines, tokenize } from "./diff.js";
import { fill, h } from "./dom.js";
import { discard, heldFiles, idlePush, pushEnd, pushEvent, routeOf, statusView, tokenOf } from "./state.js";

/** @typedef {import("./state.js").Held} Held */
/** @typedef {import("./state.js").PushState} PushState */

const main = /** @type {HTMLElement} */ (document.getElementById("main"));
const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

const token = tokenOf(location.hash);
// The token lives in memory only: it leaves the address bar, so it is not in the history or a bookmark.
if (token !== null) history.replaceState(null, "", location.pathname + "#/status");

$("local").textContent = `${location.host} · only this machine`;

/** @type {{ status: any, statusError: string | null, held: Held, push: PushState, pushError: string | null, link: "connecting" | "live" | "reconnecting" }} */
const model = { status: null, statusError: null, held: {}, push: idlePush(), pushError: null, link: "connecting" };

const client = token === null ? null : createClient(token);

/** @type {Record<string, [string, string]>} */
const SCREENS = {
  matrix: ["Matrix", "What each host gets: every skill bundle and MCP server against every host."],
  catalog: ["Catalog", "The MCP servers and skill sources your hosts can pick from."],
  hosts: ["Hosts", "The hosts in this config, and how each is reached."],
  secrets: ["Secrets", "Which secrets exist and which host has them. Values are never shown."],
};

function render() {
  const route = routeOf(location.hash);
  for (const a of document.querySelectorAll("#side a")) a.classList.toggle("on", /** @type {HTMLElement} */ (a).dataset.r === route);

  const n = heldFiles(model.held).length;
  $("tray").className = "tray " + (n > 0 ? "has" : "none");
  $("trayn").textContent = String(n);
  $("sidecount").textContent = n > 0 ? String(n) : "";
  const link = $("link");
  link.textContent = model.link;
  link.className = "tag " + (model.link === "live" ? "ok" : model.link === "reconnecting" ? "warn" : "");
  const s = model.status ? statusView(model.status) : null;
  fill($("repo"), ...(s ? [h("b", {}, s.host), ...(model.status?.repos?.fleet ? [h("span", {}, `${model.status.repos.fleet.branch ?? "detached"}@${String(model.status.repos.fleet.sha).slice(0, 7)}`)] : [])] : []));

  if (client === null) return fill(main, noToken());
  if (route === "status") return fill(main, statusScreen());
  if (route === "review") return fill(main, reviewScreen());
  const [title, about] = SCREENS[route];
  fill(main, h("h1", {}, title), h("p", { class: "sub" }, about), h("div", { class: "panel empty" }, "Not built yet."));
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

function reviewScreen() {
  const files = heldFiles(model.held);
  return h(
    "div",
    {},
    h("h1", {}, "Review & push"),
    h("p", { class: "sub" }, "The edits held here are written to disk when you push, not before."),
    h("h2", {}, "Held edits"),
    files.length === 0
      ? h("div", { class: "panel empty" }, "Nothing is held. Edits made on the other screens show up here as a diff.")
      : h(
          "div",
          { class: "files" },
          ...files.map((file) => diffPanel(file, model.held[file].before, model.held[file].after)),
          h("div", { class: "row" }, h("button", { class: "btn ghost", onclick: () => { model.held = discard(model.held); render(); } }, "Discard all")),
        ),
    h("h2", {}, "Push"),
    pushPanel(),
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

function pushPanel() {
  const p = model.push;
  const message = h("input", { type: "text", placeholder: "commit message (optional)", maxlength: "1000", "aria-label": "commit message" });
  const go = h("button", { class: "btn primary", disabled: p.running, onclick: () => startPush(message.value) }, p.running ? "Pushing..." : "Push");
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
    { class: "panel" },
    h("div", { class: "pushbox" }, message, go, p.end ? h("span", { class: "tag " + (p.end.ok ? "ok" : "bad") }, p.end.code) : null, p.stage ? h("span", { class: "tag" }, p.stage) : null),
    model.pushError !== null ? h("div", { class: "notice bad", style: "margin:0 16px 14px" }, model.pushError) : null,
    lanes.length > 0 ? h("div", { class: "lanes" }, ...lanes) : null,
    h("pre", { class: "term", "aria-live": "polite" }, p.log.length > 0 ? p.log.join("\n") : h("span", { class: "muted" }, "Live push output shows here.")),
  );
}

/** @param {string} message */
async function startPush(message) {
  if (client === null) return;
  model.pushError = null;
  model.push = { ...idlePush(), running: true };
  render();
  try {
    // The events arrive on the stream while this call is open; its own answer is the end.
    const end = await client.push(message.trim() === "" ? undefined : message.trim());
    model.push = pushEnd(model.push, end);
  } catch (e) {
    model.push = { ...model.push, running: false };
    if (e instanceof ApiError) model.pushError = e.messages.join("; ") || e.message;
    else throw e;
  }
  render();
  loadStatus();
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

window.addEventListener("hashchange", render);
render();
if (token !== null) {
  loadStatus();
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
