// The page's API client: every call carries the token as a header, and nothing else is ever sent.

import { backoff } from "./state.js";

/** A refused or failed call. `code` is fleet's (`unauthorized`, `forbidden`, `locked`, ...), or `network`. */
export class ApiError extends Error {
  /** @param {string} code @param {string[]} messages @param {number} status */
  constructor(code, messages, status) {
    super(messages.join("; ") || code);
    this.code = code;
    this.messages = messages;
    this.status = status;
  }
}

/**
 * @param {string} token
 * @param {typeof fetch} [fetcher]
 */
export function createClient(token, fetcher = (...args) => fetch(...args)) {
  /** @param {string} path @param {RequestInit} [init] @returns {Promise<any>} */
  async function call(path, init = {}) {
    /** @type {Response} */
    let res;
    try {
      res = await fetcher(path, { ...init, headers: { ...init.headers, "X-Fleet-Token": token } });
    } catch {
      throw new ApiError("network", ["fleet ui is not answering"], 0);
    }
    /** @type {any} */
    let doc = null;
    try {
      doc = await res.json();
    } catch {
      // not JSON: handled by the status below
    }
    if (!res.ok) throw new ApiError(doc?.code ?? "error", doc?.messages ?? [`the server answered ${res.status}`], res.status);
    return doc;
  }
  /** @param {string} path @param {unknown} body */
  const send = (path, body) => call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return {
    status: () => call("/api/status"),
    matrix: () => call("/api/matrix"),
    secrets: () => call("/api/secrets"),
    /** The skills in the source clones fleet already has. */
    skills: () => call("/api/skills"),
    /** Shallow-clones a repo to a temp directory on the server and lists its skills. @param {string} repo @param {string} path @param {string} branch */
    clone: (repo, path, branch) => send("/api/catalog/clone", branch === "" ? { repo, path } : { repo, path, branch }),
    /** Deletes a temp clone. `keepalive` lets it finish while the page is closing. @param {string} id */
    discardClone: (id) => call("/api/catalog/discard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }), keepalive: true }),
    /** Runs the server on this machine, with real credentials: only after the person has confirmed. @param {string} name @param {unknown} entry */
    probe: (name, entry) => send("/api/catalog/probe", { name, entry, confirm: true }),
    /** @param {unknown[]} ops @param {string} [show] a host file to show whether or not the edits change it */
    preview: (ops, show) => send("/api/preview", show ? { ops, show } : { ops }),
    /** @param {unknown[]} ops */
    plan: (ops) => send("/api/plan", { ops }),
    /** Writes the edited files, commits them and runs the push. @param {unknown[]} ops @param {string} message */
    write: (ops, message) => send("/api/write", { ops, message }),
    /** @param {string} [message] */
    push: (message) =>
      call("/api/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(message ? { message } : {}) }),
  };
}

/**
 * The stream of live updates. `EventSource` cannot send a header, so the token goes in the query (only for this call).
 * The browser reconnects by itself after a dropped connection, but gives up after a refusal; this reopens in that case too.
 * @param {string} token
 * @param {{
 *   onHello(doc: any): void,
 *   onEvent(name: string, doc: any): void,
 *   onLink(live: boolean): void,
 * }} handlers
 * @param {{ open?: (url: string) => EventSource, later?: (fn: () => void, ms: number) => unknown }} [deps]
 */
export function openStream(token, handlers, deps = {}) {
  const open = deps.open ?? ((url) => new EventSource(url));
  const later = deps.later ?? ((fn, ms) => setTimeout(fn, ms));
  let attempt = 0;
  let closed = false;
  /** @type {EventSource | null} */
  let source = null;

  function connect() {
    if (closed) return;
    const stream = open("/api/events?token=" + encodeURIComponent(token));
    source = stream;
    stream.addEventListener("hello", (e) => {
      attempt = 0;
      handlers.onLink(true);
      handlers.onHello(parse(/** @type {MessageEvent} */ (e).data));
    });
    for (const name of ["push", "pushend"]) {
      stream.addEventListener(name, (e) => handlers.onEvent(name, parse(/** @type {MessageEvent} */ (e).data)));
    }
    stream.onerror = () => {
      handlers.onLink(false);
      // CONNECTING: the browser is retrying by itself. CLOSED: it gave up, so we start a new one.
      if (stream.readyState === 2 /* CLOSED */) {
        stream.close();
        later(connect, backoff(attempt++));
      }
    };
  }
  connect();
  return {
    close() {
      closed = true;
      source?.close();
    },
  };
}

/** @param {string} data */
function parse(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
