import type { ContextReport } from "../context.ts";
import { readHostName } from "../host.ts";
import { printable } from "../status.ts";
import type { StatusFields } from "../status.ts";
import { readCache, readContextCache, remember, rememberContext } from "../tui/cache.ts";
import { shown } from "../tui/contextshown.ts";
import { loadModel } from "../tui/model.ts";
import type { HostInfo } from "../tui/model.ts";
import type { HostResult, Probe, RemoteConflicts } from "../tui/probe.ts";
import type { Conflict } from "../plan.ts";

/**
 * The Fleet screen's data: every host's status and startup context, from the bridge's own questions (`Probe`) and the
 * bridge's own memory file (in `tui/cache.ts`), which this reads and writes
 * through the same functions, so the page and the bridge agree on what was last seen.
 *
 * `doc()` is what the page gets at once: the remembered state of each host, marked not live. `refresh()` asks every
 * host (an ssh call each, so it only ever runs as a job, never inside a request's own turn) and keeps what each
 * answered for this server's run: a host that answers is live and is remembered, one that does not keeps its
 * remembered state and says why it was not read.
 */

/** What a host answered to the startup context, or why it did not. */
export type ContextAnswer = "ok" | "old" | "unreachable" | "timer" | "error";

export type ConflictsDoc = { ok: true; items: Conflict[] } | { ok: false; reason: "old" | "error"; detail: string };

export type FleetHost = {
  name: string;
  self: boolean;
  ssh: string | null;
  /** `never`: not asked in this run of the server. `asking`: a question is out. `done`: it has answered, whatever it said. */
  asked: "never" | "asking" | "done";
  /** What the host said when asked, or null before. `timer` is a host with no ssh destination. */
  result: HostResult["result"] | null;
  detail: string | null;
  /** The status is an answer of this run, not a memory. */
  live: boolean;
  /** Seconds since the remembered status was seen. Null for a live one, and for a host never seen. */
  seenSeconds: number | null;
  /** Seconds since a live answer came, so the page can say `asked 40 s ago`. Null when not live. */
  answeredSeconds: number | null;
  status: StatusFields | null;
  context: { report: ContextReport; live: boolean; seenSeconds: number | null } | null;
  /** Why there is no live startup context: an older pin, no ssh, an error. Null when it answered, or was not asked. */
  contextResult: ContextAnswer | null;
  contextDetail: string | null;
  /** Every conflict in full, with its fix: only for a host that answered live and has some. */
  conflicts: ConflictsDoc | null;
};

export type FleetDoc = { running: boolean; hosts: FleetHost[]; problems: string[] };

type Answer = {
  result: HostResult["result"];
  detail: string | null;
  status: StatusFields | null;
  at: number;
  context: { result: ContextAnswer; report: ContextReport | null; detail: string | null; at: number } | null;
  conflicts: ConflictsDoc | null;
};

/** How long an answer of this server's own counts as live. After that the hosts are asked again, and the page shows what is remembered. */
export const LIVE_SECONDS = 120;

const seconds = (from: number, now: number): number => Math.max(0, Math.floor((now - from) / 1000));

const failed = (error: unknown): string => printable(error instanceof Error ? error.message : "")?.trim() || "the answer could not be read";

export class FleetWatch {
  #deps: { configDir: string; home: string; probe: Probe; changed: (doc: FleetDoc) => void; now: () => number };
  #answers = new Map<string, Answer>();
  /** The hosts a question is out to, in the run that is going. */
  #asking = new Set<string>();
  #run: Promise<FleetDoc> | null = null;

  constructor(deps: { configDir: string; home: string; probe: Probe; changed?: (doc: FleetDoc) => void; now?: () => number }) {
    this.#deps = { changed: () => {}, now: Date.now, ...deps };
  }

  get running(): boolean {
    return this.#run !== null || this.#asking.size > 0;
  }

  /** Every host in the config, this host first, with what is known now: the answers of this run, else what is remembered. */
  doc(): FleetDoc {
    const { configDir, home, now } = this.#deps;
    const model = loadModel(configDir, readHostName(home));
    const t = now();
    const cached = readCache(home, t);
    const contexts = readContextCache(home, t);
    const hosts = model.hosts.map((host): FleetHost => {
      const kept = this.#answers.get(host.name);
      // An answer of an earlier run is only as good as it is recent: past the window it is a memory like any other.
      const a = kept !== undefined && (this.running || seconds(kept.at, t) <= LIVE_SECONDS) ? kept : undefined;
      const live = a?.result === "ok" && a.status !== null;
      const remembered = cached[host.name];
      const status = live ? a.status : (remembered?.result.status ?? null);
      const c = a?.context;
      const freshContext = c?.report != null;
      const oldContext = contexts[host.name];
      const context = freshContext ? { report: c.report!, live: true, seenSeconds: null } : oldContext ? { report: oldContext.report, live: false, seenSeconds: oldContext.agoSeconds } : null;
      return {
        name: host.name,
        self: host.self,
        ssh: host.ssh,
        asked: this.#asking.has(host.name) && a === undefined ? "asking" : a === undefined ? "never" : "done",
        result: a?.result ?? null,
        detail: a?.detail ?? null,
        live,
        seenSeconds: live || remembered === undefined ? null : remembered.agoSeconds,
        answeredSeconds: live ? seconds(a.at, t) : null,
        status,
        context,
        contextResult: c === undefined || c === null || freshContext ? null : c.result,
        contextDetail: c?.detail ?? null,
        conflicts: live ? a.conflicts : null,
      };
    });
    return { running: this.running, hosts, problems: model.problems };
  }

  /** Asks every host and answers when each has. A second call while one is out waits for that one: the hosts are asked once. */
  refresh(signal?: AbortSignal): Promise<FleetDoc> {
    this.#run ??= this.#ask(signal).finally(() => {
      this.#run = null;
      this.#asking.clear();
      this.#deps.changed(this.doc());
    });
    return this.#run;
  }

  async #ask(signal: AbortSignal | undefined): Promise<FleetDoc> {
    const { configDir, home } = this.#deps;
    const model = loadModel(configDir, readHostName(home));
    // A new run starts from what the hosts say now: an old answer must not pass for one of this run, nor hide a failure.
    this.#answers.clear();
    this.#asking = new Set(model.hosts.map((h) => h.name));
    this.#deps.changed(this.doc());
    await Promise.all(model.hosts.map((host) => this.#askHost(host, signal ?? new AbortController().signal)));
    this.#asking.clear();
    return { ...this.doc(), running: false };
  }

  async #askHost(host: HostInfo, signal: AbortSignal): Promise<void> {
    const { probe, home, now } = this.#deps;
    const publish = (answer: Answer) => {
      this.#answers.set(host.name, answer);
      this.#deps.changed(this.doc());
    };
    let status: HostResult;
    try {
      status = await probe.host(host, signal);
    } catch (error) {
      status = { result: "error", status: null, detail: failed(error) };
    }
    const answer: Answer = { result: status.result, detail: status.detail ?? null, status: status.result === "ok" ? status.status : null, at: now(), context: null, conflicts: null };
    // This host is read in place and has no memory: only the others are remembered, as the bridge does.
    if (answer.status !== null && !host.self) remember(home, host.name, answer.status, answer.at);
    publish(answer);
    // A host that did not answer at all cannot answer a second question either, and would cost its ssh timeout again.
    if (status.result === "unreachable" || signal.aborted) return;
    const [context, conflicts] = await Promise.all([this.#askContext(host, signal), this.#askConflicts(host, answer.status, signal)]);
    publish({ ...answer, context, conflicts });
  }

  async #askContext(host: HostInfo, signal: AbortSignal): Promise<Answer["context"]> {
    const { probe, home, now } = this.#deps;
    if (probe.context === undefined) return null;
    try {
      const r = await probe.context(host, signal);
      const at = now();
      if (r.result === "ok" && r.context !== null) {
        const report = shown(r.context);
        if (!host.self) rememberContext(home, host.name, report, at);
        return { result: "ok", report, detail: null, at };
      }
      return { result: r.result === "ok" ? "error" : r.result, report: null, detail: r.detail ?? null, at };
    } catch (error) {
      return { result: "error", report: null, detail: failed(error), at: now() };
    }
  }

  /** A host that says it has conflicts is asked for them in full, as the bridge does: read-only there too. */
  async #askConflicts(host: HostInfo, status: StatusFields | null, signal: AbortSignal): Promise<ConflictsDoc | null> {
    const { probe } = this.#deps;
    if (status === null || (status.conflicts ?? 0) === 0) return null;
    try {
      if (host.self) {
        const r = await probe.conflicts(signal);
        return r.ok ? { ok: true, items: r.items } : { ok: false, reason: "error", detail: r.detail };
      }
      if (probe.hostConflicts === undefined) return null;
      const r: RemoteConflicts = await probe.hostConflicts(host, signal);
      return r.ok ? { ok: true, items: r.items } : { ok: false, reason: r.reason, detail: r.detail };
    } catch (error) {
      return { ok: false, reason: "error", detail: failed(error) };
    }
  }
}
