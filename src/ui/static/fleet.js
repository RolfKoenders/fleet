// What the Fleet screen shows, from the answer of `GET /api/fleet` and the `fleet` events: a card for each host and the startup
// context of every host and agent on one scale. Pure: nothing here touches the DOM, the network or the clock, so `node --test` runs it.
// The words follow the bridge's host cards (`src/tui/views/home.ts`) and `fleet context --all` (`src/contextall.ts`).

import { ago, plain } from "./state.js";

/**
 * @typedef {{ kind: string, path: string, detail: string, fix: string }} Conflict
 * @typedef {{ ok: true, items: Conflict[] } | { ok: false, reason: string, detail: string }} Conflicts
 * @typedef {"ok" | "conflicts" | "unreachable" | "error" | "timer" | "asking" | "unknown"} Health
 * @typedef {{ label: string, value: string, tone: "ok" | "warn" | "bad" | "" }} Row
 * @typedef {{
 *   name: string, self: boolean, health: Health, via: string,
 *   notLive: string | null, headline: string, detail: string | null,
 *   rows: Row[], agents: { id: string, version: string | null }[], missing: string[],
 *   conflicts: { count: number, first: string | null, items: Conflict[] | null, note: string | null }, context: string | null,
 * }} Card
 */

/** The agents' own words for how a host is reached. @param {any} host */
const viaOf = (host) => (host.self ? "this host" : host.ssh ? host.ssh : "timer");

/** `seen 2 h ago, not live`: how old what a card shows is. @param {number | null} seconds */
export const seenWords = (seconds) => (seconds === null ? "never seen" : `seen ${ago(seconds)}, not live`);

/** `just now`, `12 min ago`, from the age of an answer of this run. @param {number} seconds */
const askedWords = (seconds) => (seconds < 5 ? "just now" : seconds < 60 ? `${Math.floor(seconds)} s ago` : ago(seconds));

/** The conflicts a status names, as one line: `link ~/.claude/CLAUDE.md`, and how many more. @param {any} status */
function firstConflict(status) {
  const first = Array.isArray(status?.conflictList) ? status.conflictList[0] : undefined;
  return first === undefined ? null : `${first.kind} ${first.path}`;
}

/**
 * One host's card.
 * @param {any} host a host of the answer of `GET /api/fleet`
 * @returns {Card}
 */
export function cardOf(host) {
  const status = host.status ?? null;
  const count = typeof status?.conflicts === "number" ? status.conflicts : 0;
  const base = { name: host.name, self: host.self === true, via: viaOf(host) };
  const remembered = host.live ? null : status === null ? null : seenWords(host.seenSeconds);
  const gets = status === null ? [] : (status.agents === null || status.agents === undefined ? Object.keys(status.tools ?? {}).filter((id) => status.tools[id] !== undefined && !["sops", "node", "t3"].includes(id)).map((id) => ({ id, version: status.tools[id] ?? null })) : status.agents.filter((/** @type {any} */ a) => a.active).map((/** @type {any} */ a) => ({ id: a.id, version: a.version ?? null })));
  const missing = Array.isArray(status?.notInstalled) ? status.notInstalled : [];
  const none = { count: 0, first: null, items: null, note: null };
  /** @param {Health} health @param {string} headline @param {Partial<Card>} [over] @returns {Card} */
  const card = (health, headline, over = {}) => ({ ...base, health, headline, notLive: remembered, detail: null, rows: [], agents: gets, missing, conflicts: none, context: null, ...over });

  if (host.asked === "asking" && host.result === null) return card("asking", host.self ? "reading local state" : "asking over ssh", { rows: status === null ? [] : factsOf(status), notLive: remembered === null ? null : `${remembered}, asking again` });
  if (host.result === "timer") return card("timer", "timer", { detail: "No ssh destination, so it applies on its own schedule. Its status is unknown from here.", agents: [], missing: [] });
  if (host.result === "unreachable") return card("unreachable", "unreachable over ssh", { detail: host.detail ? plain(host.detail) : null, notLive: status === null ? "never seen" : `last ${seenWords(host.seenSeconds)}`, rows: status === null ? [] : factsOf(status) });
  if (host.result === "error") return card("error", "no usable answer", { detail: host.detail ? plain(host.detail) : null, notLive: status === null ? "never seen" : `last ${seenWords(host.seenSeconds)}`, rows: status === null ? [] : factsOf(status) });
  if (status === null) return card("unknown", host.self ? "not read yet" : "not asked yet", { notLive: null });
  const conflicts = { count, first: firstConflict(status), items: host.conflicts?.ok === true ? host.conflicts.items : null, note: host.conflicts?.ok === false ? (host.conflicts.reason === "old" ? "its detail needs a newer pin" : `the detail could not be read: ${plain(host.conflicts.detail)}`) : count > 0 && !host.live ? "ask again to read the detail" : null };
  return card(count > 0 ? "conflicts" : "ok", count > 0 ? `${count} conflict${count === 1 ? "" : "s"}` : "ok", { rows: factsOf(status), conflicts, notLive: remembered });
}

/** @param {any} status @returns {Row[]} */
function factsOf(status) {
  const applied = status.applied ?? {};
  const timer = status.timer ?? null;
  const pending = status.pending ?? null;
  /** @type {Row[]} */
  const rows = [
    { label: "last applied", value: applied.at ? `${ago(applied.ageSeconds ?? 0)}` : "never", tone: applied.at ? "" : "warn" },
    { label: "timer", value: timer ?? "unknown", tone: timer === "active" ? "ok" : timer === null ? "" : "warn" },
    { label: "pending", value: pending === null ? "unknown" : String(pending), tone: pending ? "warn" : "" },
  ];
  const fleet = status.repos?.fleet;
  if (fleet) rows.push({ label: "clone", value: `${fleet.branch ?? "detached"}@${String(fleet.sha).slice(0, 7)}${fleet.clean ? "" : " dirty"}`, tone: fleet.clean ? "" : "warn" });
  return rows;
}

/**
 * The line under the title: how many hosts, how many are being asked, not live or unreachable, and what only a live answer adds up to.
 * @param {any} doc
 */
export function summaryOf(doc) {
  const hosts = Array.isArray(doc?.hosts) ? doc.hosts : [];
  const n = (/** @type {(h: any) => boolean} */ f) => hosts.filter(f).length;
  const asking = n((h) => h.asked === "asking" && h.result === null);
  const old = n((h) => h.status !== null && !h.live && h.result !== "timer");
  const down = n((h) => h.result === "unreachable" || h.result === "error");
  const timer = n((h) => h.result === "timer");
  const live = hosts.filter((/** @type {any} */ h) => h.live);
  const sum = (/** @type {"pending" | "conflicts"} */ key) => live.reduce((/** @type {number} */ a, /** @type {any} */ h) => a + (h.status?.[key] ?? 0), 0);
  /** @type {{ text: string, tone: "ok" | "warn" | "bad" | "" }[]} */
  const parts = [{ text: `${hosts.length} host${hosts.length === 1 ? "" : "s"}`, tone: "" }];
  if (asking > 0) parts.push({ text: `asking ${asking}`, tone: "" });
  if (old > 0) parts.push({ text: `${old} seen earlier, not live`, tone: "warn" });
  if (down > 0) parts.push({ text: `${down} unreachable`, tone: "bad" });
  if (timer > 0) parts.push({ text: `${timer} on a timer, status unknown`, tone: "" });
  // Only what a live answer said is added up: a total of nothing would read as none.
  if (live.length > 0) parts.push({ text: `pending ${sum("pending")}`, tone: sum("pending") > 0 ? "warn" : "ok" }, { text: `conflicts ${sum("conflicts")}`, tone: sum("conflicts") > 0 ? "bad" : "ok" });
  return parts;
}

// ---- startup context

/** An estimate for people, as `src/tokens.ts` writes it: `~850`, `~28.4k`. @param {number} tokens */
export const formatTokens = (tokens) => (tokens < 1000 ? `~${tokens}` : `~${(tokens / 1000).toFixed(1)}k`);

/** The parts of a bar, in the order `fleet context` draws them. */
export const PARTS = /** @type {const} */ (["instructions", "skills", "mcp"]);

/** What an agent's total says: with a `+` when a server is not measured and the total leaves it out. @param {any} agent */
export const totalOf = (agent) => `${formatTokens(agent.tokens)}${agent.complete ? "" : "+"}`;

/** What each part of an agent weighs, in words, as `fleet context` says it. @param {any} agent @returns {Record<"instructions" | "skills" | "mcp", string>} */
export function partTexts(agent) {
  const { instructions, skills, mcp } = agent;
  return {
    instructions: instructions.count === 0 ? "none" : formatTokens(instructions.tokens),
    skills: skills.count === 0 ? "none" : `${formatTokens(skills.tokens)} (${skills.count})`,
    mcp: mcp.count === 0 ? "none" : mcp.unmeasured === mcp.count ? `not measured (${mcp.count})` : `up to ${formatTokens(mcp.tokens)} (${mcp.count}${mcp.unmeasured > 0 ? `, ${mcp.unmeasured} not measured` : ""})`,
  };
}

/**
 * The startup context of every host, with the bars on one scale: a full bar is the heaviest agent of any host.
 * @param {any} doc
 * @returns {{
 *   scale: number, biggest: { host: string, agent: string, tokens: number } | null,
 *   hosts: { name: string, self: boolean, notLive: string | null, why: string | null, agents: { id: string, total: string, lower: boolean, widths: Record<"instructions" | "skills" | "mcp", number>, fill: number, texts: Record<"instructions" | "skills" | "mcp", string> }[] }[]
 * }}
 */
export function contextOf(doc) {
  const hosts = Array.isArray(doc?.hosts) ? doc.hosts : [];
  const all = hosts.flatMap((/** @type {any} */ h) => (h.context?.report?.agents ?? []).map((/** @type {any} */ a) => ({ host: h.name, agent: a.agent, tokens: a.tokens })));
  const biggest = all.reduce((/** @type {any} */ best, /** @type {any} */ a) => (best === null || a.tokens > best.tokens ? a : best), null);
  const scale = biggest === null ? 0 : biggest.tokens;
  return {
    scale,
    biggest: scale === 0 ? null : biggest,
    hosts: hosts.map((/** @type {any} */ h) => ({
      name: h.name,
      self: h.self === true,
      notLive: h.context && !h.context.live ? seenWords(h.context.seenSeconds) : null,
      why: h.context?.live ? null : contextWhy(h),
      agents: (h.context?.report?.agents ?? []).map((/** @type {any} */ a) => {
        const width = (/** @type {number} */ tokens) => (scale === 0 ? 0 : (tokens / scale) * 100);
        return {
          id: a.agent,
          total: totalOf(a),
          lower: !a.complete,
          widths: { instructions: width(a.instructions.tokens), skills: width(a.skills.tokens), mcp: width(a.mcp.tokens) },
          fill: width(a.tokens),
          texts: partTexts(a),
        };
      }),
    })),
  };
}

/** Why a host has no live startup context, or null when there is nothing to say. @param {any} host */
function contextWhy(host) {
  if (host.contextResult === "old") return "needs a newer pin: its fleet has no context command yet";
  if (host.contextResult === "timer" || host.result === "timer") return "no ssh destination";
  if (host.contextResult === "unreachable" || host.result === "unreachable") return "unreachable over ssh";
  if (host.contextResult === "error") return host.contextDetail ? plain(host.contextDetail) : "no usable answer";
  if (host.context !== null) return null;
  return host.asked === "never" ? "not asked yet" : host.asked === "asking" ? "asking" : null;
}

/** The legend under the bars. @param {{ scale: number, biggest: { host: string, agent: string } | null }} context */
export const legendOf = (context) => (context.biggest === null ? null : `All bars share one scale: a full bar is ${formatTokens(context.scale)}, ${context.biggest.agent} on ${context.biggest.host}.`);

/** How a host's answer of this run reads in the card's corner. @param {any} host */
export const answeredWords = (host) => (host.live && typeof host.answeredSeconds === "number" ? `asked ${askedWords(host.answeredSeconds)}` : null);

// ---- keeping the document

/** A document of the stream or of a call, or null when it is not one. @param {any} doc */
export const fleetDoc = (doc) => (doc !== null && typeof doc === "object" && Array.isArray(doc.hosts) ? doc : null);

/**
 * The document after a new one arrived. A document from the stream is older than the answer of the call that is open, never newer, so
 * the newest one received is kept as it comes; a malformed one changes nothing.
 * @param {any} current @param {any} next
 */
export const withFleetDoc = (current, next) => fleetDoc(next) ?? current;

/** Whether a host's card lets the person open its fix: it has conflicts and the server read them. @param {Card} card */
export const hasFix = (card) => card.conflicts.items !== null && card.conflicts.items.length > 0;
