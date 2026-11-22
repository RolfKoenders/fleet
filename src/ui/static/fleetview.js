// The Fleet screen, drawn: a card for each host, then the startup context of every host and agent on one scale. The data and the
// words are fleet.js's; this only builds elements. Text always goes in as text (see dom.js), so nothing a host says can run.

import { h } from "./dom.js";
import { answeredWords, cardOf, contextOf, hasFix, legendOf, PARTS, summaryOf } from "./fleet.js";

export const FLEET_ABOUT = "Every host in this config: what it last said, and what it loads before the first prompt. What was last seen is shown at once and marked not live; the hosts are asked when this screen opens and on Refresh, an ssh call each.";

const DOT = { ok: "●", conflicts: "●", unreachable: "✕", error: "✕", timer: "◌", asking: "◌", unknown: "○" };
const TONE = { ok: "ok", conflicts: "bad", unreachable: "bad", error: "warn", timer: "", asking: "", unknown: "" };

/**
 * @param {{
 *   doc: any, error: string | null, asking: boolean, usable: boolean, open: ReadonlySet<string>,
 *   refresh(): void, toggle(host: string): void,
 * }} state
 */
export function fleetScreen(state) {
  // While the hosts are being asked, one with no answer yet is being asked, whether or not its question has left the server yet.
  const doc = state.doc !== null && state.asking ? { ...state.doc, hosts: state.doc.hosts.map((/** @type {any} */ h) => (h.asked === "never" ? { ...h, asked: "asking" } : h)) } : state.doc;
  const head = h("div", { class: "pagehead" },
    h("div", {}, h("h1", {}, "Fleet"), h("p", { class: "sub" }, FLEET_ABOUT)),
    h("div", { class: "pageact" }, h("button", { type: "button", id: "fleet-refresh", class: "btn primary", ...(state.asking || !state.usable ? { disabled: true, title: state.asking ? "the hosts are being asked" : "fleet ui is not answering" } : {}), onclick: state.refresh }, state.asking ? "Asking..." : "Refresh")),
  );
  if (doc === null) return h("div", {}, head, state.error === null ? h("div", { class: "panel empty" }, "Reading what was last seen...") : h("div", { class: "notice bad" }, state.error));
  const summary = h("div", { class: "row fleetsum", id: "fleet-summary" }, ...summaryOf(doc).map((p) => h("span", { class: "tag " + p.tone }, p.text)));
  return h("div", {}, head,
    state.error === null ? null : h("div", { class: "notice bad" }, state.error),
    ...(doc.problems ?? []).slice(0, 2).map((/** @type {string} */ p) => h("div", { class: "notice" }, p)),
    summary,
    h("div", { class: "cards fleetcards" }, ...doc.hosts.map((/** @type {any} */ host) => card(host, state))),
    h("h2", {}, "Startup context"),
    context(doc),
  );
}

/** @param {any} host @param {{ open: ReadonlySet<string>, toggle(host: string): void }} state */
function card(host, state) {
  const c = cardOf(host);
  const open = state.open.has(c.name) && hasFix(c);
  const asked = answeredWords(host);
  return h("div", { class: `panel card fleetcard ${c.health}${c.notLive === null ? "" : " stale"}`, id: `fleet-${c.name}`, "data-health": c.health },
    h("h3", {},
      h("span", { class: `dot ${TONE[c.health]}`, "aria-hidden": "true" }, DOT[c.health]),
      c.name,
      h("span", { class: "tag " + (c.self ? "ok" : "") }, c.via),
    ),
    h("div", { class: "row verdict" },
      h("span", { class: "tag " + (TONE[c.health] === "" ? "" : TONE[c.health]) }, c.headline),
      c.notLive === null ? null : h("span", { class: "tag warn notlive" }, c.notLive),
      asked === null ? null : h("span", { class: "muted small" }, asked),
    ),
    c.detail === null ? null : h("p", { class: "why" }, c.detail),
    c.conflicts.first === null || c.health !== "conflicts" ? null : h("p", { class: "firstconflict" }, "first: ", h("code", {}, c.conflicts.first), c.conflicts.count > 1 ? ` and ${c.conflicts.count - 1} more` : ""),
    c.rows.length === 0 ? null : h("dl", { class: "facts small" }, ...c.rows.flatMap((r) => [h("dt", {}, r.label), h("dd", { class: r.tone }, r.value)])),
    c.agents.length === 0 && c.missing.length === 0 ? null : h("div", { class: "row agents" },
      ...c.agents.map((a) => h("span", { class: "tag" }, `${a.id} ${a.version ?? "unknown"}`)),
      ...c.missing.map((id) => h("span", { class: "tag warn" }, `${id} not installed`))),
    c.conflicts.note !== null && c.conflicts.items === null ? h("p", { class: "muted small" }, c.conflicts.note) : null,
    hasFix(c) ? h("div", { class: "row" }, h("button", { type: "button", class: "btn small", id: `fleet-fix-${c.name}`, "aria-expanded": open ? "true" : "false", onclick: () => state.toggle(c.name) }, open ? "Hide the fix" : c.conflicts.items?.length === 1 ? "Show the fix" : "Show the fixes")) : null,
    open ? h("div", { class: "fixes" }, ...(c.conflicts.items ?? []).map((i) => h("div", { class: "fix" },
      h("div", {}, h("span", { class: "tag warn" }, i.kind), " ", h("code", {}, i.path)),
      i.detail === "" ? null : h("p", { class: "muted" }, i.detail),
      i.fix === "" ? null : h("div", { class: "fixline" }, h("span", { class: "brandword" }, "fix"), h("span", {}, i.fix))))) : null,
  );
}

/** Every host's agents as stacked bars on one scale, as `fleet context --all` draws them. @param {any} doc */
function context(doc) {
  const ctx = contextOf(doc);
  const legend = legendOf(ctx);
  return h("div", { class: "panel ctx", id: "fleet-context" },
    h("div", { class: "ctxkey row" }, ...PARTS.map((kind) => h("span", { class: "key" }, h("i", { class: `seg ${kind}` }), kind))),
    ...ctx.hosts.map((host) => h("div", { class: "ctxhost", id: `ctx-${host.name}` },
      h("div", { class: "row" }, h("b", {}, host.name), host.self ? h("span", { class: "tag ok" }, "this host") : null, host.notLive === null ? null : h("span", { class: "tag warn notlive" }, host.notLive), host.why === null ? null : h("span", { class: "muted small" }, host.why)),
      ...host.agents.map((a) => h("div", { class: "ctxagent" },
        h("span", { class: "aname" }, a.id),
        h("div", { class: "cbar", role: "img", "aria-label": `${a.id} on ${host.name}: ${a.total}${a.lower ? ", at least: a server is not measured" : ""}` },
          ...PARTS.map((kind) => h("i", { class: `seg ${kind}`, style: `width:${Math.max(a.widths[kind], a.widths[kind] > 0 ? 0.6 : 0).toFixed(2)}%` }))),
        h("span", { class: "total" + (a.lower ? " lower" : ""), title: a.lower ? "A lower bound: a server that is not measured is left out" : "" }, a.total),
        h("span", { class: "parts muted" }, PARTS.map((kind) => `${kind} ${a.texts[kind]}`).join(" · ")))),
    )),
    legend === null ? h("div", { class: "empty" }, "No startup context to show yet.") : h("p", { class: "ctxlegend muted small" }, legend, " A ", h("code", {}, "+"), " after a total means a server is not measured, so it is a lower bound, not zero."),
  );
}
