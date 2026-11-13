import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EVENT_VERSION } from "./events.ts";
import type { FleetEvent } from "./events.ts";
import { EXIT } from "./exit.ts";
import type { ExitName } from "./exit.ts";
import type { Result } from "./output.ts";
import { finish, reduce, readEnd, startRun } from "./pushrun.ts";
import type { PushRun } from "./pushrun.ts";
import { stateDir } from "./state.ts";

/**
 * The push journal: each push writes its events to `~/.local/state/fleet/pushes/<time>-<pid>.jsonl` on the host that
 * ran it, and the last `JOURNAL_KEPT` are kept. It is never shared with another host. The first line is a header, the
 * rest are the events as they arrived, each with `t`, the milliseconds since the push began. A `message` event is
 * text a child printed, so the file is private to its owner (0600, in a 0700 directory).
 */
export const JOURNAL_KEPT = 20;

export const journalDir = (home: string = homedir()): string => join(stateDir(home), "pushes");

/** The first line of a journal. */
export type JournalHeader = {
  journal: 1;
  /** The event version of the lines that follow. */
  v: number;
  /** When the push began, as an ISO time (UTC). */
  time: string;
  /** The config repo's HEAD after publish, or null when the push never published. */
  commit: string | null;
  /** The one host `--host` named, or null for a push to every host. Only pushes of the same scope are compared. */
  only: string | null;
  /** The hosts the push visited, in order. */
  hosts: string[];
  /** How long the push took, in ms. */
  ms: number;
  /** The push was cut short (ctrl-c or a terminate); `result` and `end` are then null. */
  interrupted: boolean;
  /** The code name `fleet push` ended with. */
  result: ExitName | null;
  /** What `fleet push --json` printed (code, messages, hosts, conflicts), so a replay can show how it ended. */
  end: Record<string, unknown> | null;
};

export type JournalEntry = { file: string; header: JournalHeader };

/** An event as stored: the event itself, and when it arrived. */
export type StoredEvent = { t: number; event: FleetEvent };

export type StoredJournal = { header: JournalHeader; events: StoredEvent[] };

const NAME = /^\d{8}T\d{6}\.\d{3}Z-\d+\.jsonl$/;

/** `20261113T094103.123Z`: sortable, no colons (macOS), and fine enough that two pushes of one process never share a name. */
const stamp = (date: Date): string => date.toISOString().replace(/[-:]/g, "");

/** Collects a push's events, and writes the file when the push is over. Writing never fails a push: it says why it could not. */
export class Journal {
  private readonly lines: string[] = [];
  private readonly began = performance.now();
  private readonly time = new Date();
  private hosts: string[] | null = null;
  private written = false;
  commit: string | null = null;

  private readonly home: string;
  private readonly only: string | null;

  constructor(home: string, only: string | null) {
    [this.home, this.only] = [home, only];
  }

  record(event: FleetEvent): void {
    if (event.event === "hosts") this.hosts = event.hosts.map((h) => h.host);
    this.lines.push(JSON.stringify({ v: EVENT_VERSION, ...event, t: Math.round(performance.now() - this.began) }));
  }

  /**
   * Writes the journal, once. Nothing is written for a push that was refused before it began (no host list yet).
   * `result` is how it ended, null when it was interrupted. Returns the reason it could not be written, or null.
   */
  write(result: Result | null): string | null {
    if (this.written || this.hosts === null) return null;
    this.written = true;
    const header: JournalHeader = {
      journal: 1,
      v: EVENT_VERSION,
      time: this.time.toISOString(),
      commit: this.commit,
      only: this.only,
      hosts: this.hosts,
      ms: Math.round(performance.now() - this.began),
      interrupted: result === null,
      result: result?.code ?? null,
      end: result === null ? null : { code: result.code, messages: result.messages ?? [], ...result.fields },
    };
    try {
      const dir = journalDir(this.home);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      writeFileSync(join(dir, `${stamp(this.time)}-${process.pid}.jsonl`), `${[JSON.stringify(header), ...this.lines].join("\n")}\n`, { mode: 0o600, flag: "wx" });
      for (const old of journalFiles(this.home).slice(JOURNAL_KEPT)) rmSync(join(dir, old), { force: true });
      return null;
    } catch (error) {
      return `fleet: could not write the push journal: ${(error as Error).message}`;
    }
  }
}

/** The journal files, newest first. */
function journalFiles(home: string): string[] {
  try {
    return readdirSync(journalDir(home)).filter((f) => NAME.test(f)).sort().reverse();
  } catch {
    return [];
  }
}

function parseHeader(line: string | undefined): JournalHeader | null {
  try {
    const h = JSON.parse(line ?? "") as Partial<JournalHeader> | null;
    if (h === null || typeof h !== "object" || h.journal !== 1 || typeof h.time !== "string" || typeof h.ms !== "number" || !Array.isArray(h.hosts)) return null;
    return { journal: 1, v: Number(h.v), time: h.time, commit: typeof h.commit === "string" ? h.commit : null, only: typeof h.only === "string" ? h.only : null, hosts: h.hosts.filter((x): x is string => typeof x === "string"), ms: h.ms, interrupted: h.interrupted === true, result: typeof h.result === "string" ? (h.result as ExitName) : null, end: typeof h.end === "object" ? h.end : null };
  } catch {
    return null;
  }
}

/** Every readable journal on this host, newest first. A file that is not one is left out. */
export function listJournals(home: string = homedir()): JournalEntry[] {
  const entries: JournalEntry[] = [];
  for (const file of journalFiles(home)) {
    try {
      const header = parseHeader(readFileSync(join(journalDir(home), file), "utf8").split("\n", 1)[0]);
      if (header !== null) entries.push({ file, header });
    } catch {
      // unreadable: not listed
    }
  }
  return entries;
}

/** One journal in full, or null when it cannot be read. A line that is not an event of this version is skipped. */
export function readJournal(file: string, home: string = homedir()): StoredJournal | null {
  if (!NAME.test(file)) return null;
  try {
    const [first, ...rest] = readFileSync(join(journalDir(home), file), "utf8").split("\n");
    const header = parseHeader(first);
    if (header === null) return null;
    const events: StoredEvent[] = [];
    for (const line of rest) {
      if (line.trim() === "") continue;
      try {
        const o = JSON.parse(line) as { v?: number; t?: number } & FleetEvent;
        if (o.v !== EVENT_VERSION || typeof o.t !== "number") continue;
        const { v: _v, t, ...event } = o;
        events.push({ t, event: event as FleetEvent });
      } catch {
        // a damaged line is skipped
      }
    }
    return { header, events };
  } catch {
    return null;
  }
}

/**
 * The push `current` is compared with: the most recent earlier one of the same scope (all hosts, or the same single
 * host) that ran to its end. A push is only compared when it ended ok itself, so the times are like for like. `entries`
 * is newest first.
 */
export function comparable(entries: JournalEntry[], current: JournalEntry): JournalEntry | null {
  if (current.header.result !== "ok") return null;
  const at = entries.findIndex((e) => e.file === current.file);
  return entries.slice(at + 1).find((e) => e.header.only === current.header.only && e.header.result === "ok") ?? null;
}

/** How a stored push ends in a replay: the same end document the bridge reads from a live `fleet push --json`. */
const endOf = (header: JournalHeader) => (header.end === null ? readEnd(130, "") : readEnd(EXIT[header.result ?? "error"], JSON.stringify(header.end)));

/** A replay of a stored push, on the clock of whoever shows it. */
export type Replay = { stored: StoredJournal; startedAt: number; next: number; run: PushRun; over: boolean };

export function startReplay(stored: StoredJournal, now: number): Replay {
  return { stored, startedAt: now, next: 0, run: startRun(stored.header.hosts.map((name) => ({ name, ssh: null, self: false })), now), over: false };
}

/** Plays every stored event whose time has come, through the same reducer a live push goes through, and the end once its time has. */
export function advanceReplay(replay: Replay, now: number): Replay {
  if (replay.over) return replay;
  const { events, header } = replay.stored;
  let { run, next } = replay;
  for (; next < events.length && replay.startedAt + events[next]!.t <= now; next++) run = reduce(run, events[next]!.event, replay.startedAt + events[next]!.t);
  if (next < events.length || now < replay.startedAt + header.ms) return { ...replay, run, next };
  return { ...replay, run: finish(run, endOf(header), replay.startedAt + header.ms), next, over: true };
}
