// The page's API client: every call carries the token as a header, and nothing else is ever sent.

import { setBody } from "./secrets.js";
import { backoff, plain } from "./state.js";

/** A refused or failed call. `code` is fleet's (`unauthorized`, `forbidden`, `locked`, ...), or `network`. */
export class ApiError extends Error {
  /** @param {string} code @param {string[]} messages @param {number} status */
  constructor(code, messages, status) {
    const said = messages.map(plain);
    super(said.join("; ") || code);
    this.code = code;
    this.messages = said;
    this.status = status;
  }
}

/**
 * @param {string} token
 * @param {typeof fetch} [fetcher]
 * @param {{ onDenied?: () => void }} [hooks] `onDenied` runs when the server refuses the token (401 or 403)
 */
export function createClient(token, fetcher = (...args) => fetch(...args), hooks = {}) {
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
    if (res.status === 401 || res.status === 403) hooks.onDenied?.();
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
    /**
     * Encrypts one value into the secrets file of each of `files` (`shared` or a host). The value is in this request and nowhere
     * else: the answer is the held edits that carry the encrypted files.
     * @param {string} name @param {string} value @param {string[]} files @param {unknown[]} ops
     */
    setSecret: (name, value, files, ops) => send("/api/secrets/set", setBody(name, value, files, ops)),
    /** @param {unknown[]} ops @param {string} [show] a host file to show whether or not the edits change it */
    preview: (ops, show) => send("/api/preview", show ? { ops, show } : { ops }),
    /** The file an item is written in, as on disk: `{path, text}`. @param {"server" | "source" | "bundle" | "host"} kind @param {string} name */
    yaml: (kind, name) => send("/api/yaml", { kind, name }),
    /** @param {unknown[]} ops */
    plan: (ops) => send("/api/plan", { ops }),
    /** Writes the edited files, commits them and runs the push. @param {unknown[]} ops @param {string} message */
    write: (ops, message) => send("/api/write", { ops, message }),
    /** The host file that adding this host would write, as `{path, before, after}`. Nothing is written. @param {{ name: string, ssh: string, from: string | null }} body */
    previewHost: (body) => send("/api/hosts/preview", body),
    /** Writes hosts/<name>.yaml and runs the real fleet init, answering when it has ended; its output arrives on the stream. @param {{ name: string, ssh: string, from: string | null }} body */
    initHost: (body) => send("/api/hosts/init", { ...body, confirm: true }),
    /** @param {string} [message] */
    push: (message) =>
      call("/api/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(message ? { message } : {}) }),
  };
}

/**
 * The stream of live updates. `EventSource` cannot send a header, so the token goes in the query (only for this call).
 * The browser reconnects by itself after a dropped connection, but gives up after a refusal; this reopens in that case too,
 * except after a refusal of the token itself: a token that was refused never becomes valid, so it stops and says `invalid`.
 * `onLink` is told `live`, `down` (nothing answers: the server stopped, or this machine slept) or `invalid`.
 * @param {string} token
 * @param {{
 *   onHello(doc: any): void,
 *   onEvent(name: string, doc: any): void,
 *   onLink(link: "live" | "down" | "invalid"): void,
 * }} handlers
 * @param {{ open?: (url: string) => EventSource, later?: (fn: () => void, ms: number) => unknown, probe?: () => Promise<"denied" | "answering" | "down"> }} [deps]
 */
export function openStream(token, handlers, deps = {}) {
  const open = deps.open ?? ((url) => new EventSource(url));
  const later = deps.later ?? ((fn, ms) => setTimeout(fn, ms));
  // An EventSource does not say why it failed, so one that gave up is asked in a plain call: refused, or no answer.
  const probe =
    deps.probe ??
    (async () => {
      try {
        const res = await fetch("/api/status", { headers: { "X-Fleet-Token": token } });
        return res.status === 401 || res.status === 403 ? "denied" : "answering";
      } catch {
        return "down";
      }
    });
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
      handlers.onLink("live");
      handlers.onHello(parse(/** @type {MessageEvent} */ (e).data));
    });
    for (const name of ["push", "pushend", "init", "initend", "jobs"]) {
      stream.addEventListener(name, (e) => handlers.onEvent(name, parse(/** @type {MessageEvent} */ (e).data)));
    }
    stream.onerror = () => {
      // CONNECTING: the browser is retrying by itself. CLOSED: it gave up, so we find out why and start a new one.
      if (stream.readyState !== 2 /* CLOSED */) return void handlers.onLink("down");
      stream.close();
      void probe().then((seen) => {
        if (closed) return;
        if (seen === "denied") {
          closed = true;
          return void handlers.onLink("invalid");
        }
        handlers.onLink("down");
        later(connect, backoff(attempt++));
      });
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
