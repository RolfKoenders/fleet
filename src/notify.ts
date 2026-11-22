import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { repoState } from "./git.ts";
import { readHostName } from "./host.ts";
import { channelsOf, readNotify } from "./notifyconfig.ts";
import type { Channel, NotifyConfig } from "./notifyconfig.ts";
import { outcomeText, realSenders } from "./notifysend.ts";
import type { Alert, Event, Outcome, Senders } from "./notifysend.ts";
import { paint } from "./output.ts";
import type { Relayed, Result } from "./output.ts";
import type { Conflict } from "./plan.ts";
import { hostOs } from "./scheduler.ts";
import type { Os } from "./scheduler.ts";
import { resolveSecrets } from "./secrets.ts";
import { stateDir, writePrivateJson } from "./state.ts";
import { fillSecrets, secretNames } from "./template.ts";
import { isObject } from "./yamlfile.ts";

/**
 * Alerts: after an apply that the timer started, a host tells whoever it is set up to tell when its state
 * changed: a new conflict, an apply that stopped with a real error, or back to ok after either. Each host
 * alerts about itself, from what it remembers of its last run in `notify.json`, so there is no repeat while
 * nothing changes. Nothing here can fail an apply: a delivery that fails is a line in the apply log and a mark
 * in `fleet status`, and the next change of state tries again.
 */

export const notifyStatePath = (home: string): string => join(stateDir(home), "notify.json");

/** What a host remembers: the state its last timer run was in, and what became of the last alert it sent. */
export type NotifyState = {
  version: 1;
  state: Event;
  /** `kind path` of each conflict the host is in, so a conflict is new only when it is not among them. */
  conflicts: string[];
  /** The result code of the stopped apply the host is in, so a different failure is a change. */
  failure: string | null;
  sent: { at: string; event: Event; channels: Partial<Record<Channel, string>> } | null;
};

const EVENTS: readonly string[] = ["conflict", "failed", "ok"];
const CHANNELS: readonly string[] = ["desktop", "ntfy", "webhook"];
const isEvent = (v: unknown): v is Event => typeof v === "string" && EVENTS.includes(v);

/** The remembered state, or null when there is none or it cannot be read: then nothing is known to conflict. */
export function readNotifyState(home: string): NotifyState | null {
  try {
    const doc: unknown = JSON.parse(readFileSync(notifyStatePath(home), "utf8"));
    if (!isObject(doc) || doc.version !== 1 || !isEvent(doc.state)) return null;
    const conflicts = Array.isArray(doc.conflicts) ? doc.conflicts.filter((c): c is string => typeof c === "string") : [];
    let sent: NotifyState["sent"] = null;
    if (isObject(doc.sent) && typeof doc.sent.at === "string" && isEvent(doc.sent.event) && isObject(doc.sent.channels)) {
      const channels: Partial<Record<Channel, string>> = {};
      for (const [name, text] of Object.entries(doc.sent.channels)) if (CHANNELS.includes(name) && typeof text === "string") channels[name as Channel] = text;
      sent = { at: doc.sent.at, event: doc.sent.event, channels };
    }
    return { version: 1, state: doc.state, conflicts, failure: typeof doc.failure === "string" ? doc.failure : null, sent };
  } catch {
    return null;
  }
}

/** What an apply came to, for alerting. Null for a run that says nothing about the host: another apply holds the lock, or the config repo cannot be reached. */
type Run = { state: Event; conflicts: Conflict[]; failure: string | null };

function classify(result: Result): Run | null {
  if (result.code === "ok") return { state: "ok", conflicts: [], failure: null };
  if (result.code === "conflict") return { state: "conflict", conflicts: ((result.fields?.conflicts ?? []) as Conflict[]), failure: null };
  if (result.code === "locked" || result.code === "unreachable") return null;
  return { state: "failed", conflicts: [], failure: result.code };
}

const conflictKey = (c: { kind: string; path: string }): string => `${c.kind} ${c.path}`;

/** The event this run is, or null when nothing changed since the last. A host that was never alerted is taken to have been fine. */
export function eventFor(run: Run, previous: NotifyState | null): Event | null {
  const was = previous?.state ?? "ok";
  if (run.state === "ok") return was === "ok" ? null : "ok";
  if (run.state === "failed") return was === "failed" && previous?.failure === run.failure ? null : "failed";
  const known = was === "conflict" ? (previous?.conflicts ?? []) : [];
  return run.conflicts.some((c) => !known.includes(conflictKey(c))) || (was !== "conflict" && run.conflicts.length === 0) ? "conflict" : null;
}

/** Printable text only: a path can hold anything, and the message goes to a terminal, a phone and a log. */
const printable = (text: string): string => text.replace(/[^\x20-\x7e]/g, "?").slice(0, 300);

const WHY: Record<string, string> = {
  invalid: "the config is invalid",
  "needs-secret": "a secret is missing",
  "missing-prerequisite": "a tool fleet needs is missing",
};

function describe(event: Event, run: Run, host: string, fleet: string, time: string): Alert {
  const first = run.conflicts[0];
  const conflict = first === undefined ? null : { kind: printable(first.kind), path: printable(first.path) };
  const more = run.conflicts.length - 1;
  const message =
    event === "ok"
      ? `${host} is ok again.`
      : event === "conflict"
        ? `${host} has ${run.conflicts.length === 1 ? "a conflict" : `${run.conflicts.length} conflicts`}${conflict === null ? "" : `: ${conflict.kind} ${conflict.path}${more > 0 ? ` and ${more} more` : ""}`}. Run: fleet status --conflicts`
        : `${host}: the apply stopped: ${WHY[run.failure ?? ""] ?? "it failed"}. Run: fleet apply`;
  return { event, host, message, conflict: event === "conflict" ? conflict : null, time, fleet };
}

export type NotifyContext = {
  configDir: string;
  /** The fleet clone, whose commit is the `fleet` field of a webhook. */
  toolDir: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  os?: Os;
  /** What really sends; a test puts its own here. */
  senders?: Senders;
  now?: () => Date;
};

function fleetVersion(toolDir: string): string {
  try {
    return repoState(toolDir).sha.slice(0, 7);
  } catch {
    return "unknown";
  }
}

/** Sends `alert` through every channel of `config`, each on its own, and reports each. A secret that cannot be read fails its channel only. */
async function deliver(config: NotifyConfig, alert: Alert, ctx: NotifyContext, host: string): Promise<Partial<Record<Channel, Outcome>>> {
  const home = ctx.home ?? homedir();
  const env = ctx.env ?? process.env;
  const senders = ctx.senders ?? realSenders(home, ctx.os ?? hostOs(home), env);
  // The value of a field with its secrets filled in, or null when one cannot be read. Never says why: an error from sops is not for a log.
  const filled = (text: string): string | null => {
    const names = secretNames(text);
    if (names.length === 0) return text;
    try {
      return fillSecrets(text, resolveSecrets(ctx.configDir, host, home, names)).value as string;
    } catch {
      return null;
    }
  };
  const unreadable: Outcome = { status: "failed", reason: "a secret it uses could not be read" };
  const through = async (channel: Channel): Promise<[Channel, Outcome]> => {
    try {
      if (channel === "desktop") return [channel, await senders.desktop(alert)];
      if (channel === "ntfy") {
        const url = filled(config.ntfy!);
        const token = config.ntfyToken === null ? null : filled(config.ntfyToken);
        return [channel, url === null || (config.ntfyToken !== null && token === null) ? unreadable : await senders.ntfy(url, token, alert)];
      }
      const url = filled(config.webhook!);
      return [channel, url === null ? unreadable : await senders.webhook(url, alert)];
    } catch {
      return [channel, { status: "failed", reason: "could not send" }];
    }
  };
  return Object.fromEntries(await Promise.all(channelsOf(config).map(through)));
}

/** Failed deliveries as the lines apply logs. */
const failures = (outcomes: Partial<Record<Channel, Outcome>>): string[] =>
  Object.entries(outcomes).flatMap(([channel, o]) => (o !== undefined && o.status === "failed" ? [`fleet: alert not delivered (${channel}: ${o.reason})`] : []));

/**
 * Alerts about the apply that just ran, when the timer started it and its state changed. Returns lines for the
 * apply log (a failed delivery); never throws. A host with no alerts set up forgets what it remembered, so alerts
 * turned on later begin from nothing, as a first run does.
 */
export async function alertAfterApply(result: Result | Relayed, byTimer: boolean, ctx: NotifyContext): Promise<string[]> {
  // The run `relaunch` started alerts for itself.
  if ("relayed" in result || !byTimer) return [];
  const home = ctx.home ?? homedir();
  try {
    const host = readHostName(home);
    if (host === null) return [];
    const problems: string[] = [];
    const config = readNotify(ctx.configDir, host, problems);
    // A config that cannot be read is the apply's to report, and it says nothing about alerts being off.
    if (problems.length > 0) return [];
    if (channelsOf(config).length === 0) {
      rmSync(notifyStatePath(home), { force: true });
      return [];
    }
    const run = classify(result);
    if (run === null) return [];
    const previous = readNotifyState(home);
    const event = eventFor(run, previous);
    const now = (ctx.now ?? (() => new Date()))().toISOString().replace(/\.\d+Z$/, "Z");
    let sent = previous?.sent ?? null;
    let lines: string[] = [];
    if (event !== null) {
      const outcomes = await deliver(config!, describe(event, run, host, fleetVersion(ctx.toolDir), now), ctx, host);
      sent = { at: now, event, channels: Object.fromEntries(Object.entries(outcomes).map(([c, o]) => [c, outcomeText(o)])) };
      lines = failures(outcomes);
    }
    writePrivateJson(notifyStatePath(home), { version: 1, state: run.state, conflicts: run.conflicts.map(conflictKey), failure: run.failure, sent } satisfies NotifyState);
    return lines;
  } catch (error) {
    return [`fleet: alerts could not be sent${(error as NodeJS.ErrnoException).code === undefined ? "" : ` (${(error as NodeJS.ErrnoException).code})`}`];
  }
}

/** `fleet notify --test`: a test alert through every channel this host has, and what became of each. Not remembered, so it changes nothing. */
export async function notifyTest(color: boolean, ctx: NotifyContext): Promise<Result> {
  const home = ctx.home ?? homedir();
  const host = readHostName(home);
  if (host === null) return { code: "invalid", messages: ["fleet: no host name set; `fleet init <host>` writes one"] };
  const problems: string[] = [];
  const config = readNotify(ctx.configDir, host, problems);
  if (problems.length > 0) return { code: "invalid", messages: problems.map((p) => `fleet: ${p}`) };
  if (channelsOf(config).length === 0) return { code: "invalid", messages: ["fleet: this host has no alerts set up; add `notify:` to its host file or to hosts/_defaults.yaml (docs/setting-up-machines.md#alerts)"] };
  const time = (ctx.now ?? (() => new Date()))().toISOString().replace(/\.\d+Z$/, "Z");
  const alert: Alert = { event: "ok", host, message: `Test alert from fleet on ${host}.`, conflict: null, time, fleet: fleetVersion(ctx.toolDir), test: true };
  const outcomes = await deliver(config!, alert, ctx, host);
  const rows = Object.entries(outcomes) as [Channel, Outcome][];
  const paintOf = (o: Outcome) => paint(color, o.status === "sent" ? "green" : "yellow", outcomeText(o));
  return {
    code: rows.some(([, o]) => o.status === "failed") ? "error" : "ok",
    text: rows.map(([channel, o]) => `${channel}: ${paintOf(o)}`).join("\n"),
    fields: { channels: rows.map(([channel, o]) => ({ channel, result: o.status, ...(o.status === "sent" ? {} : { reason: o.reason }) })) },
  };
}

/** What `fleet status` shows about alerts. Reasons are the ones fleet wrote, never a URL. */
export type AlertsStatus = {
  channels: Channel[];
  last: { event: Event; at: string; ageSeconds: number } | null;
  failures: { channel: Channel; reason: string }[];
};

/** The host's alerts as `status` reports them, or null when none are set up. Reads files only. */
export function alertsStatus(configDir: string, host: string, home: string, now: number = Date.now()): AlertsStatus | null {
  const config = readNotify(configDir, host, []);
  const channels = channelsOf(config);
  if (channels.length === 0) return null;
  const sent = readNotifyState(home)?.sent ?? null;
  const time = sent === null ? Number.NaN : Date.parse(sent.at);
  const last = sent === null || Number.isNaN(time) ? null : { event: sent.event, at: sent.at, ageSeconds: Math.max(0, Math.floor((now - time) / 1000)) };
  const bad = Object.entries(sent?.channels ?? {}).flatMap(([channel, text]) => (channels.includes(channel as Channel) && text.startsWith("failed: ") ? [{ channel: channel as Channel, reason: text.slice("failed: ".length) }] : []));
  return { channels, last, failures: bad };
}
