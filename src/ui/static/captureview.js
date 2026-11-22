// The Capture screen, drawn. The data and the words are capture.js's; this only builds elements. Text always goes in as text (see dom.js).

import { h } from "./dom.js";
import { decisionOf, differsLine, doneWords, idOf, othersOf, problemOf, rowsOf, STATE_WORDS, withVariant } from "./capture.js";

export const CAPTURE_ABOUT = "What this machine has that is not from config: MCP servers an agent was told about, and skill folders copied in. Choose what to do with each; the choice goes on To push with its YAML, like any edit. Nothing is removed from this machine, and a value that becomes a secret goes to sops and is never shown here.";

/**
 * @param {{
 *   doc: any, error: string | null, usable: boolean, busy: string | null, drafts: Record<string, import("./capture.js").Draft>,
 *   done: Record<string, string>, agents: { id: string, used?: boolean }[], notice: string | null,
 *   change(id: string, draft: import("./capture.js").Draft): void, answer(item: any, action: "add" | "takeover" | "ignore"): void,
 * }} s
 */
export function captureScreen(s) {
  const head = h("div", { class: "pagehead" }, h("div", {}, h("h1", {}, "Capture"), h("p", { class: "sub" }, CAPTURE_ABOUT)));
  if (s.doc === null) return h("div", {}, head, s.error === null ? h("div", { class: "panel empty" }, "Reading this machine...") : h("div", { class: "notice bad" }, s.error));
  const items = s.doc.items;
  const differs = differsLine(s.doc.differs.length);
  return h("div", {}, head,
    s.error === null ? null : h("div", { class: "notice bad" }, s.error),
    s.notice === null ? null : h("div", { class: "notice" }, s.notice),
    ...s.doc.notes.slice(0, 3).map((/** @type {string} */ n) => h("div", { class: "notice" }, n)),
    h("p", { class: "muted small" }, s.doc.host === null ? "No host name is set on this machine." : `This is ${s.doc.host}: only the machine the page runs on is read.`),
    items.length === 0 ? h("div", { class: "panel empty", id: "capture-empty" }, "Nothing on this machine is missing from the config.") : h("div", { class: "capture" }, ...items.map((/** @type {any} */ item) => card(item, s))),
    differs === null ? null : h("p", { class: "muted", id: "capture-differs" }, differs, " ", h("a", { href: "#/status" }, "Status")),
  );
}

/** @param {any} item @param {Parameters<typeof captureScreen>[0]} s */
function card(item, s) {
  const id = idOf(item);
  const draft = s.drafts[id];
  const done = s.done[id];
  const off = !s.usable || s.busy !== null;
  const why = !s.usable ? "fleet ui is not answering" : s.busy !== null ? "another answer is being worked out" : "";
  const button = (/** @type {string} */ label, /** @type {"add" | "takeover" | "ignore"} */ action, /** @type {string} */ cls, /** @type {boolean} */ blocked = false) =>
    h("button", { type: "button", id: `cap-${action}-${id}`, class: `btn ${cls}`, ...(off || blocked ? { disabled: true, ...(why === "" ? {} : { title: why }) } : {}), onclick: () => s.answer(item, action) }, label);
  const where = item.kind === "mcp" ? item.agents.join(", ") : item.path;
  const problem = item.state !== "new" ? null : problemOf(item, draft);
  return h("div", { class: `panel card capture-item ${item.state}`, id: `cap-${id}` },
    h("h3", {}, h("span", { class: "tag" }, item.kind === "mcp" ? "MCP server" : "skill"), item.name, h("span", { class: "tag " + (item.state === "blocked" ? "warn" : item.state === "new" ? "info" : "ok") }, STATE_WORDS[/** @type {keyof typeof STATE_WORDS} */ (item.state)])),
    h("p", { class: "muted small" }, where),
    item.message === null ? null : h("div", { class: "notice inline" }, item.message),
    done !== undefined ? h("div", { class: "row" }, h("span", { class: "tag ok" }, `${done}, to push`), h("a", { class: "btn small", href: "#/review" }, "Review & push")) : null,
    done !== undefined || item.state === "blocked" || item.state === "takeover" ? null : item.state === "catalog" ? h("div", { class: "capture-form" }, h("p", { class: "muted small" }, "It matches what the catalog has. Picking it makes it this machine's own, as it stands."), scopeSeg(item, draft, s)) : item.kind === "mcp" ? mcpForm(item, draft, s) : skillForm(item, draft, s),
    done !== undefined ? null : h("div", { class: "row" },
      item.state === "blocked" ? null : item.state === "takeover" ? button("Take over", "takeover", "primary") : button("Add to To push", "add", "primary", problem !== null),
      button("Ignore on this host", "ignore", "ghost"),
      problem === null ? null : h("span", { class: "muted small" }, problem),
    ),
  );
}

/** @param {any} item @param {import("./capture.js").Draft} draft @param {Parameters<typeof captureScreen>[0]} s */
function scopeSeg(item, draft, s) {
  const id = idOf(item);
  return h("div", { class: "field" }, h("label", {}, "For"), h("div", { class: "seg", role: "group" },
    ...(/** @type {const} */ (["host", "all"])).map((v) => h("button", { type: "button", id: `cap-scope-${v}-${id}`, class: v === draft.scope ? "on" : "", "aria-pressed": String(v === draft.scope), onclick: () => s.change(id, { ...draft, scope: v }) }, v === "host" ? "This host" : "Every host"))));
}

/** @param {any} item @param {import("./capture.js").Draft} draft @param {Parameters<typeof captureScreen>[0]} s */
function mcpForm(item, draft, s) {
  const id = idOf(item);
  const many = item.variants.length > 1;
  const rows = rowsOf(item, draft);
  const others = othersOf(item, s.agents);
  return h("div", { class: "capture-form" },
    h("div", { class: many ? "variants" : "" },
      ...item.variants.map((/** @type {any} */ v, /** @type {number} */ i) => h("div", { class: "variant" + (many && i === draft.variant ? " on" : "") },
        many ? h("label", { class: "check", for: `cap-variant-${i}-${id}` }, h("input", { type: "radio", name: `cap-variant-${id}`, id: `cap-variant-${i}-${id}`, checked: i === draft.variant, onchange: () => s.change(id, withVariant(item, draft, i)) }), `Take the one in ${v.agents.join(", ")}`) : null,
        h("code", {}, v.command !== null ? v.command.join(" ") : `${v.transport ?? "http"} ${v.url ?? ""}`),
        v.warning === null ? null : h("div", { class: "notice inline" }, v.warning),
      ))),
    many ? h("p", { class: "muted small" }, "The agents have it in different forms. The other agent gets the catalog's version at the next apply.") : null,
    rows.length === 0 ? null : h("div", { class: "keys" },
      ...rows.map((r) => h("div", { class: "keyrow" },
        h("span", { class: "m" }, `${r.where === "env" ? "env" : "header"} ${r.key}`),
        r.canBeSecret ? h("label", { class: "check", for: `cap-secret-${r.id}-${id}` }, h("input", { type: "checkbox", id: `cap-secret-${r.id}-${id}`, checked: r.secret, onchange: (e) => s.change(id, { ...draft, secrets: { ...draft.secrets, [r.id]: { secret: /** @type {HTMLInputElement} */ (e.target).checked, name: r.name } } }) }), "secret") : h("span", { class: "muted small" }, "empty"),
        r.secret ? h("input", { type: "text", id: `cap-name-${r.id}-${id}`, value: r.name, autocomplete: "off", spellcheck: "false", maxlength: "100", "aria-label": `Secret name for ${r.key}`, oninput: (e) => s.change(id, { ...draft, secrets: { ...draft.secrets, [r.id]: { secret: true, name: /** @type {HTMLInputElement} */ (e.target).value } } }) }) : null,
      ))),
    others.length === 0 ? null : h("label", { class: "check", for: `cap-only-${id}` }, h("input", { type: "checkbox", id: `cap-only-${id}`, checked: draft.onlyHad, onchange: (e) => s.change(id, { ...draft, onlyHad: /** @type {HTMLInputElement} */ (e.target).checked }) }), `Only the agents that had it (${item.agents.join(", ")}), not ${others.join(", ")}`),
    scopeSeg(item, draft, s),
  );
}

/** @param {any} item @param {import("./capture.js").Draft} draft @param {Parameters<typeof captureScreen>[0]} s */
function skillForm(item, draft, s) {
  const id = idOf(item);
  return h("div", { class: "capture-form" },
    item.repo === null ? null : h("p", { class: "muted small" }, `${item.repo.repo} at ${item.repo.commit.slice(0, 7)} (${item.repo.track})${item.repo.dirty ? ", with changes that are not committed: capture takes the committed state" : ""}`),
    item.state === "new" ? h("p", { class: "muted small" }, item.repo !== null && item.repo.source !== null ? `Its repo is the source ${item.repo.source} already.` : "Its repo becomes a pinned skill source with review on.") : null,
    item.state === "new" ? h("div", { class: "field" }, h("label", { for: `cap-bundle-${id}` }, "Bundle"), h("input", { type: "text", id: `cap-bundle-${id}`, value: draft.bundle, autocomplete: "off", spellcheck: "false", maxlength: "64", oninput: (e) => s.change(id, { ...draft, bundle: /** @type {HTMLInputElement} */ (e.target).value }) }), h("div", { class: "help" }, "An existing bundle, or a new one.")) : null,
    scopeSeg(item, draft, s),
  );
}

export { decisionOf, doneWords };
