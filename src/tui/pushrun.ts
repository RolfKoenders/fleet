import type { FleetEvent } from "../events.ts";
import type { HostInfo } from "./model.ts";

/** One host's lane through a push. */
export type Lane = {
  host: string;
  via: "local" | "ssh" | "timer";
  state: "waiting" | "running" | "done" | "skipped";
  /** The host's result once it is done: `ok`, `conflict`, `unreachable`, `timer` or `error`. */
  result: string | null;
  changes: number;
  /** The apply stage the host is in (`sync`, `plan`, `write`), once it has reported one. */
  stage: string | null;
  /** The last write it finished, and how many of how many. */
  step: { name: string; target: string; n: number; of: number } | null;
  /** The writes to come, known once the host reaches its write stage. */
  of: number | null;
  /** The last line of text the host sent. */
  note: string | null;
};

export type Phase = "waiting" | "running" | "done" | "failed";

export type Conflicted = { path: string; detail: string; fix: string };

export type PushEnd = {
  /** The exit code of `fleet push`, or null when it could not be run or was killed. */
  exit: number | null;
  /** The code name in the document it printed, or null when there was none. */
  code: string | null;
  /** Conflicts per host, from the document. */
  conflicts: Record<string, Conflicted[]>;
  /** The push's own messages, from the document. */
  messages: string[];
  /** Each host's outcome, from the document. */
  hosts: { host: string; result: string; changes: number }[];
};

export type PushRun = {
  startedAt: number;
  phases: { validate: Phase; publish: Phase; apply: Phase };
  publish: { n: number; of: number; target: string | null };
  lanes: Lane[];
  /** The latest lines of text, newest last. */
  log: string[];
  end: PushEnd | null;
};

const LOG_LINES = 40;

const printable = (text: string): string => text.replace(/[^\x20-\x7e]/g, "?").slice(0, 300);

export const lane = (host: string, via: Lane["via"]): Lane => ({ host, via, state: "waiting", result: null, changes: 0, stage: null, step: null, of: null, note: null });

/** A run that has just been started, with a lane for each host the config names (this host first), before push has said more. */
export function startRun(hosts: HostInfo[], now: number): PushRun {
  return {
    startedAt: now,
    phases: { validate: "running", publish: "waiting", apply: "waiting" },
    publish: { n: 0, of: 0, target: null },
    lanes: hosts.map((h) => lane(h.name, h.self ? "local" : h.ssh === null ? "timer" : "ssh")),
    log: [],
    end: null,
  };
}

const withLane = (run: PushRun, host: string, change: (l: Lane) => Lane): PushRun => ({ ...run, lanes: run.lanes.map((l) => (l.host === host ? change(l) : l)) });

const logged = (run: PushRun, line: string): PushRun => ({ ...run, log: [...run.log, line].slice(-LOG_LINES) });

/** What one event changes. Pure: the same run and event give the same run. */
export function reduce(run: PushRun, event: FleetEvent): PushRun {
  switch (event.event) {
    case "hosts": {
      const known = new Map(run.lanes.map((l) => [l.host, l]));
      // push is the authority on the order and on how each host is reached.
      return { ...run, phases: { ...run.phases, validate: "done" }, lanes: event.hosts.map((h) => ({ ...(known.get(h.host) ?? lane(h.host, h.via)), via: h.via })) };
    }
    case "stage": {
      if (event.host === undefined || event.host === null) {
        if (event.stage === "validate") return { ...run, phases: { ...run.phases, validate: "running" } };
        if (event.stage === "publish") return { ...run, phases: { ...run.phases, validate: "done", publish: "running" }, publish: { n: 0, of: event.of ?? 0, target: null } };
        if (event.stage === "apply") return { ...run, phases: { ...run.phases, validate: "done", publish: "done", apply: "running" } };
        return run;
      }
      return withLane(run, event.host, (l) => ({ ...l, state: l.state === "waiting" ? "running" : l.state, stage: event.stage, ...(event.stage === "write" ? { of: event.of ?? null, step: null } : {}) }));
    }
    case "step": {
      if (event.host === undefined || event.host === null) return { ...run, publish: { n: event.n, of: event.of, target: event.target } };
      return withLane(run, event.host, (l) => ({ ...l, state: l.state === "waiting" ? "running" : l.state, step: { name: event.step, target: event.target, n: event.n, of: event.of }, of: event.of }));
    }
    case "host": {
      if (event.state === "start") return withLane(run, event.host, (l) => ({ ...l, state: "running" }));
      if (event.state === "skip") return withLane(run, event.host, (l) => ({ ...l, state: "skipped" }));
      return withLane(run, event.host, (l) => ({ ...l, state: "done", result: event.result ?? null, changes: event.changes ?? 0 }));
    }
    case "message": {
      const text = printable(event.text);
      const line = event.host ? `${event.host}: ${text.replace(/^fleet: (?:[^:]*: )?/, "")}` : text.replace(/^fleet: /, "");
      const next = logged(run, line);
      return event.host ? withLane(next, event.host, (l) => ({ ...l, note: text.replace(/^fleet: (?:[^:]*: )?/, "") })) : next;
    }
  }
}

/** Reads what `fleet push --json` printed. Anything that is not that document leaves `code` null. */
export function readEnd(exit: number | null, stdout: string): PushEnd {
  const end: PushEnd = { exit, code: null, conflicts: {}, messages: [], hosts: [] };
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return end;
  }
  if (typeof doc !== "object" || doc === null) return end;
  const d = doc as Record<string, unknown>;
  if (typeof d.code === "string") end.code = printable(d.code);
  if (Array.isArray(d.messages)) end.messages = d.messages.filter((m): m is string => typeof m === "string").map(printable);
  const str = (v: unknown) => (typeof v === "string" ? printable(v) : "");
  const list = (v: unknown): Conflicted[] => (Array.isArray(v) ? v.map((c: Record<string, unknown>) => ({ path: str(c?.path), detail: str(c?.detail), fix: str(c?.fix) })) : []);
  if (Array.isArray(d.hosts)) {
    for (const h of d.hosts as Record<string, unknown>[]) {
      if (typeof h?.host !== "string") continue;
      end.conflicts[h.host] = list(h.conflicts);
      end.hosts.push({ host: printable(h.host), result: str(h.result), changes: typeof h.changes === "number" ? h.changes : 0 });
    }
  }
  // A repo conflict stops before any host: it is listed under no host.
  if (!Array.isArray(d.hosts) || (d.hosts as unknown[]).length === 0) end.conflicts[""] = list(d.conflicts);
  return end;
}

/** The run after `fleet push` ended: the phase that was running failed unless the push was ok, and hosts it never reached are skipped. */
export function finish(run: PushRun, end: PushEnd): PushRun {
  const ok = end.code === "ok" || (end.exit === 0 && end.code === null);
  const phases = { ...run.phases };
  for (const key of ["validate", "publish", "apply"] as const) {
    if (phases[key] === "running") phases[key] = ok || (key === "apply" && end.code !== null) ? "done" : "failed";
  }
  // A push that stopped before the apply stage left it waiting.
  const lanes = run.lanes.map((l): Lane => {
    const doc = end.hosts.find((r) => r.host === l.host);
    if (l.state === "done") return l;
    if (doc) return { ...l, state: "done", result: doc.result, changes: doc.changes };
    return { ...l, state: "skipped" };
  });
  return { ...run, phases, lanes, end };
}

/** Which lane the push is in now, for the line a warning about quitting shows. */
export function describeRunning(run: PushRun): string {
  const running = run.lanes.find((l) => l.state === "running");
  if (run.phases.validate === "running") return "checking the config";
  if (run.phases.publish === "running") return `publishing${run.publish.target ? ` (${run.publish.n} of ${run.publish.of} repos done)` : ""}`;
  if (running) return `applying on ${running.host}${running.step ? ` (${running.step.n} of ${running.step.of} writes)` : running.stage ? ` (${running.stage})` : ""}`;
  const waiting = run.lanes.filter((l) => l.state === "waiting").map((l) => l.host);
  return waiting.length > 0 ? `waiting to reach ${waiting.join(", ")}` : "finishing";
}

/** The hosts still to be applied, in order, for the same warning. */
export const remaining = (run: PushRun): string[] => run.lanes.filter((l) => l.state === "waiting" || l.state === "running").map((l) => l.host);
