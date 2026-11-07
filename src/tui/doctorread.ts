import { count, printable } from "../status.ts";
import { formatTokens } from "../tokens.ts";
import { isObject } from "../yamlfile.ts";

/**
 * Reading what `fleet doctor --json` printed. The exit code is never read: an older and a newer doctor exit differently
 * (a newer one has a code for "unhealthy"), and the document says everything. Anything this reader does not know is
 * unknown, never a failure and never a pass. All of it is text from a process, and from other hosts through it, so it is
 * cut down to printable text and to the fields below.
 */

/** `neutral` is a server that cannot be judged until a person logs in: not a problem. */
export type Health = "ok" | "neutral" | "bad" | "unknown";

export type ServerHealth = {
  health: Health;
  /** What each tool's check said, as short words: `claude: ok, opencode: login`. */
  words: string;
  /** The first thing a failing or unknown check explained, or null. */
  detail: string | null;
  /** The protocol the server spoke, when doctor said. */
  protocol: string | null;
};

export type DoctorHost = {
  host: string;
  /** Why there is nothing for this host (unreachable, no ssh destination, ...), or null. */
  note: string | null;
  /** By server name. */
  servers: Record<string, ServerHealth>;
};

export type DoctorResult = { ok: true; hosts: Record<string, DoctorHost> } | { ok: false; detail: string };

const BAD = new Set(["unreachable", "missing-binary", "bad-response", "exited", "timeout", "error"]);
const ORDER: Record<Health, number> = { ok: 0, neutral: 1, unknown: 2, bad: 3 };
const MAX_HOSTS = 64;
const MAX_SERVERS = 200;

/** One check's result word as a health. `fails` is doctor's own word on whether the result counts as a problem. */
export function judge(result: unknown, fails: unknown): Health {
  if (result === "ok") return "ok";
  if (result === "login") return "neutral";
  // An older doctor said auth-needed for a server that merely wants a login, and marked it as not failing.
  if (result === "auth-needed") return fails === false ? "neutral" : "bad";
  if (typeof result === "string" && BAD.has(result)) return "bad";
  return "unknown";
}

function serversOf(list: unknown): Record<string, ServerHealth> {
  const out: Record<string, { health: Health; words: string[]; detail: string | null; protocol: string | null }> = {};
  if (!Array.isArray(list)) return {};
  for (const r of list.slice(0, MAX_SERVERS * 2)) {
    if (!isObject(r)) continue;
    const name = printable(r.server);
    if (name === null || name === "") continue;
    const entry = (out[name] ??= { health: "ok", words: [], detail: null, protocol: null });
    const health = judge(r.result, r.fails);
    const tool = printable(r.tool) ?? "?";
    const word = printable(r.result) ?? "unknown";
    const tokens = count(r.tokens);
    entry.words.push(`${tool}: ${word}${count(r.tools) !== null ? `, ${count(r.tools)} tools` : ""}${tokens !== null ? `, ${formatTokens(tokens)} tokens` : ""}`);
    if (ORDER[health] > ORDER[entry.health]) entry.health = health;
    if (health !== "ok" && entry.detail === null) entry.detail = printable(r.detail) ?? null;
    entry.protocol ??= printable(r.protocol) ?? null;
  }
  return Object.fromEntries(Object.entries(out).slice(0, MAX_SERVERS).map(([name, e]) => [name, { health: e.health, words: e.words.join(", "), detail: e.detail, protocol: e.protocol }]));
}

const firstMessage = (doc: Record<string, unknown>): string => {
  const first = Array.isArray(doc.messages) ? doc.messages.find((m) => typeof m === "string") : undefined;
  return printable(first)?.replace(/^fleet: /, "") ?? "no reason given";
};

/** The health of every server on every host the document covers. `self` names this host for a single-host document that does not. */
export function readDoctor(stdout: string, self: string | null): DoctorResult {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return { ok: false, detail: "doctor printed no JSON document" };
  }
  if (!isObject(doc)) return { ok: false, detail: "doctor printed no JSON document" };
  const hosts: Record<string, DoctorHost> = {};
  if (Array.isArray(doc.hosts)) {
    for (const h of doc.hosts.slice(0, MAX_HOSTS)) {
      const name = isObject(h) ? printable(h.host) : null;
      if (!isObject(h) || name === null || name === "") continue;
      const inner = isObject(h.doctor) ? h.doctor : null;
      const note = inner === null ? (printable(h.detail) ?? (printable(h.result) === "timer" ? "no ssh destination, so doctor cannot reach it" : `no answer (${printable(h.result) ?? "unknown"})`)) : null;
      hosts[name] = { host: name, note, servers: inner === null ? {} : serversOf(inner.servers) };
    }
    if (Object.keys(hosts).length > 0) return { ok: true, hosts };
  }
  if (Array.isArray(doc.servers)) {
    const name = printable(doc.host) ?? self;
    if (name === null) return { ok: false, detail: "doctor named no host" };
    return { ok: true, hosts: { [name]: { host: name, note: null, servers: serversOf(doc.servers) } } };
  }
  return { ok: false, detail: `doctor gave ${printable(doc.code) ?? "no code"}: ${firstMessage(doc)}` };
}
