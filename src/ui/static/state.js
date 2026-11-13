// The page's state and the rules that move it. Pure: nothing here touches the DOM, the network or the clock, so
// `node --test` runs it. `app.js` draws it.

/** The screens. The first four are filled in by later work; `status` and `review` work now. */
export const ROUTES = ["status", "matrix", "catalog", "hosts", "secrets", "review"];

/** The screen a location hash names (`#/hosts`), `status` for none or an unknown one. @param {string} hash */
export function routeOf(hash) {
  const name = hash.replace(/^#\/?/, "");
  return ROUTES.find((r) => r === name) ?? "status";
}

/**
 * The token in a location hash (`#t=...`), or null. The page keeps it in memory and removes it from the address bar.
 * @param {string} hash
 */
export function tokenOf(hash) {
  const t = new URLSearchParams(hash.replace(/^#/, "")).get("t");
  return t === null || t === "" ? null : t;
}

/** Milliseconds to wait before reconnect attempt `attempt` (0 is the first): 0.5s, doubling, at most 10s. @param {number} attempt */
export const backoff = (attempt) => Math.min(10_000, 500 * 2 ** Math.max(0, attempt));

/**
 * @typedef {"connecting" | "live" | "reconnecting"} Link
 * @typedef {{ host: string, via: string, state: "waiting" | "running" | "done" | "skip", result: string | null, changes: number, stage: string | null, step: string | null, of: number | null }} Lane
 * @typedef {{
 *   running: boolean,
 *   stage: string | null,
 *   lanes: Lane[],
 *   log: string[],
 *   end: { ok: boolean, code: string, messages: string[] } | null,
 * }} PushState
 */

/** @returns {PushState} */
export const idlePush = () => ({ running: false, stage: null, lanes: [], log: [], end: null });

const LOG_LINES = 200;

/** @param {string[]} log @param {string} line */
const logged = (log, line) => [...log, line].slice(-LOG_LINES);

/**
 * Folds one `push` event (a fleet event, as `fleet push` sends it) into the push state. A first event starts a new run.
 * Anything it does not know is kept as a log line, never dropped and never trusted as HTML.
 * @param {PushState} state
 * @param {any} event
 * @returns {PushState}
 */
export function pushEvent(state, event) {
  const fresh = state.end !== null ? idlePush() : state;
  const base = { ...fresh, running: true };
  if (typeof event !== "object" || event === null) return base;
  switch (event.event) {
    case "hosts":
      return {
        ...base,
        lanes: (event.hosts ?? []).map((/** @type {{ host: string, via: string }} */ h) => ({ host: h.host, via: h.via, state: "waiting", result: null, changes: 0, stage: null, step: null, of: null })),
      };
    case "stage":
      return event.host ? withLane(base, event.host, (l) => ({ ...l, state: "running", stage: event.stage, of: event.of ?? null, step: null })) : { ...base, stage: String(event.stage) };
    case "step":
      return withLane({ ...base, log: logged(base.log, `${event.host ?? ""} ${event.step} ${event.target}`.trim()) }, event.host, (l) => ({ ...l, step: `${event.n}/${event.of} ${event.step} ${event.target}`, of: event.of }));
    case "host":
      return withLane(base, event.host, (l) => ({
        ...l,
        state: event.state === "start" ? "running" : event.state,
        result: event.result ?? l.result,
        changes: event.changes ?? l.changes,
      }));
    case "message":
      return { ...base, log: logged(base.log, event.host ? `${event.host}: ${event.text}` : String(event.text)) };
    default:
      return { ...base, log: logged(base.log, JSON.stringify(event)) };
  }
}

/** @param {PushState} state @param {string | null | undefined} host @param {(l: Lane) => Lane} change */
function withLane(state, host, change) {
  if (!host) return state;
  return { ...state, lanes: state.lanes.map((l) => (l.host === host ? change(l) : l)) };
}

/**
 * The end of a push (`pushend`, or the answer to `POST /api/push`).
 * @param {PushState} state
 * @param {{ ok: boolean, code: string, messages?: string[], hosts?: { host: string, result: string, changes: number }[] }} doc
 * @returns {PushState}
 */
export function pushEnd(state, doc) {
  const lanes = state.lanes.map((l) => {
    const h = doc.hosts?.find((x) => x.host === l.host);
    return h ? { ...l, state: /** @type {const} */ ("done"), result: h.result, changes: h.changes } : l;
  });
  return { ...state, running: false, lanes, end: { ok: doc.ok, code: doc.code, messages: doc.messages ?? [] } };
}

/**
 * @typedef {{ before: string, after: string }} Edit
 * @typedef {Record<string, Edit>} Held
 */

/**
 * Holds an edit of a file: what it was on disk and what the page would write. Holding the original again drops it, so a
 * change undone by hand leaves nothing held. Returns a new object.
 * @param {Held} held
 * @param {string} file
 * @param {string} before
 * @param {string} after
 * @returns {Held}
 */
export function hold(held, file, before, after) {
  const { [file]: previous, ...rest } = held;
  const from = previous?.before ?? before;
  return from === after ? rest : { ...rest, [file]: { before: from, after } };
}

/** Drops one held edit, or all of them with no file. @param {Held} held @param {string} [file] */
export function discard(held, file) {
  if (file === undefined) return {};
  const { [file]: _gone, ...rest } = held;
  return rest;
}

/** The held files, in name order. @param {Held} held */
export const heldFiles = (held) => Object.keys(held).sort();

/**
 * What the status view shows, from the answer of `GET /api/status`: label and value rows, each with a tone
 * (`ok`, `warn`, or none).
 * @param {any} doc
 * @returns {{ host: string, rows: { label: string, value: string, tone: "ok" | "warn" | "" }[], tools: { name: string, version: string | null }[], conflicts: string[], messages: string[] }}
 */
export function statusView(doc) {
  const fleet = doc?.repos?.fleet;
  const applied = doc?.applied;
  /** @type {{ label: string, value: string, tone: "ok" | "warn" | "" }[]} */
  const rows = [];
  if (fleet) {
    const parts = [fleet.branch ?? "detached", String(fleet.sha ?? "").slice(0, 7)];
    rows.push({ label: "fleet", value: parts.join("@"), tone: "" });
    rows.push({ label: "checkout", value: fleet.clean ? "clean" : "has local changes", tone: fleet.clean ? "ok" : "warn" });
    if (typeof fleet.behind === "number" && fleet.behind > 0) rows.push({ label: "behind", value: `${fleet.behind} commits`, tone: "warn" });
  }
  rows.push({ label: "applied", value: applied?.at ? `${ago(applied.ageSeconds ?? 0)} (${applied.at})` : "never", tone: applied?.at ? "ok" : "warn" });
  rows.push({ label: "timer", value: doc?.timer ?? "unknown", tone: doc?.timer === "active" ? "ok" : "warn" });
  rows.push({ label: "pending", value: doc?.pending == null ? "unknown" : String(doc.pending), tone: doc?.pending ? "warn" : "" });
  rows.push({ label: "conflicts", value: doc?.conflicts == null ? "unknown" : String(doc.conflicts), tone: doc?.conflicts ? "warn" : "ok" });
  const tools = Object.entries(doc?.tools ?? {}).map(([name, version]) => ({ name, version: typeof version === "string" ? version : null }));
  const conflicts = (doc?.conflictList ?? []).map((/** @type {{ kind: string, path: string }} */ c) => `${c.kind} ${c.path}`);
  return { host: typeof doc?.host === "string" ? doc.host : "unknown host", rows, tools, conflicts, messages: Array.isArray(doc?.messages) ? doc.messages : [] };
}

/** @param {number} seconds */
export function ago(seconds) {
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}
