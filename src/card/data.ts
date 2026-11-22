import { AGENTS } from "../agents/index.ts";
import { agentsOnHost } from "../hostagents.ts";
import { readHostName } from "../host.ts";
import { runGit } from "../git.ts";
import { JOURNAL_KEPT, listJournals } from "../journal.ts";
import { statusOs } from "../scheduler.ts";
import { readState } from "../state.ts";
import type { HostOs } from "../status.ts";
import { loadModel } from "../tui/model.ts";
import { readCache } from "../tui/cache.ts";

/** The activity grid is shown only from this many commits in the last 12 months: an empty grid looks like a dead setup. */
export const GRID_MINIMUM = 20;

/** One host as the card shows it. Everything but `name` is what was last seen, so a card needs no ssh. */
export type CardHost = {
  name: string;
  /** The program names of its agents (`claude`, `agy`), or null when nothing has been seen and the host file names none. */
  agents: string[] | null;
  os: HostOs | null;
  /** Seconds since it last applied, as last seen. */
  appliedAgo: number | null;
  conflicts: number | null;
  /** The bridge has a status of this host (or it is this host). */
  seen: boolean;
};

/** Weeks of seven days, oldest week first, Sunday first. A day outside the 12 months is null. */
export type Grid = (number | null)[][];

export type CardData = {
  hosts: CardHost[];
  /** The agents, skills and MCP servers some host gets, each counted once. */
  agents: number;
  skills: number;
  servers: number;
  /** Commits to the config repo in the last 12 months. */
  changes: number;
  /** Commits per day, only when there are `GRID_MINIMUM` of them. */
  activity: Grid | null;
  /** Pushes in the push journal; `atLeast` when it is full, because it keeps only the last few. */
  pushes: { count: number; atLeast: boolean };
  /** The month of the config repo's first commit, such as `March 2026`. */
  since: string | null;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const pad = (n: number): string => String(n).padStart(2, "0");
const dayKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Commit days (`2026-11-18`, local time) of the last 12 months, and the first commit's month. Git being absent or the folder not a repo gives none. */
function readHistory(configDir: string, from: Date): { days: string[]; first: string | null } {
  try {
    const log = runGit(configDir, "log", `--since=${dayKey(from)} 00:00`, "--format=%cd", "--date=format-local:%Y-%m-%d");
    const roots = runGit(configDir, "log", "--max-parents=0", "--format=%cd", "--date=format-local:%Y-%m");
    return { days: log.ok ? log.stdout.split("\n").filter((l) => /^\d{4}-\d{2}-\d{2}$/.test(l)) : [], first: roots.ok ? (roots.stdout.split("\n").filter((l) => /^\d{4}-\d{2}$/.test(l)).sort()[0] ?? null) : null };
  } catch {
    return { days: [], first: null };
  }
}

/** The 12 months up to and including `now`, as weeks that start on Sunday. */
export function gridOf(days: readonly string[], now: Date): Grid {
  const perDay = new Map<string, number>();
  for (const d of days) perDay.set(d, (perDay.get(d) ?? 0) + 1);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 364);
  const first = new Date(start.getFullYear(), start.getMonth(), start.getDate() - start.getDay());
  const weeks: Grid = [];
  for (let cursor = first; cursor <= end; ) {
    const week: (number | null)[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(cursor < start || cursor > end ? null : (perDay.get(dayKey(cursor)) ?? 0));
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/** How dark a day is, 0 (nothing) to 4, against the busiest day of the year. */
export function levelOf(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || max <= 0) return 0;
  const r = count / max;
  return r > 0.75 ? 4 : r > 0.5 ? 3 : r > 0.25 ? 2 : 1;
}

export const gridMax = (grid: Grid): number => Math.max(0, ...grid.flat().map((c) => c ?? 0));

function cachedHosts(home: string, now: number) {
  try {
    return readCache(home, now);
  } catch {
    return {};
  }
}

/**
 * What the card shows, read locally: the config for the hosts and what they get, the bridge's last answer from each host
 * for its agents, OS and last apply, this host live, and the config repo's git log and this host's push journal for
 * the bottom line. Nothing asks another host, so a host the bridge never saw is shown without them.
 */
export function readCard(configDir: string, home: string, now: Date = new Date()): CardData {
  const self = readHostName(home);
  const model = loadModel(configDir, self);
  const cache = cachedHosts(home, now.getTime());
  const binaryOf = (id: string): string => AGENTS.find((a) => a.id === id)?.binary ?? id;
  const hosts = model.hosts
    .map((h): CardHost => {
      if (h.self) {
        let appliedAgo: number | null = null;
        try {
          const at = Date.parse(readState(home)?.appliedAt ?? "");
          appliedAgo = Number.isNaN(at) ? null : Math.max(0, Math.floor((now.getTime() - at) / 1000));
        } catch {
          // an applied state that cannot be read is a host that has not applied
        }
        return { name: h.name, agents: agentsOnHost(configDir, h.name, home).map((a) => a.binary), os: statusOs(home) === "darwin" ? "macos" : "linux", appliedAgo, conflicts: null, seen: true };
      }
      const status = cache[h.name]?.result.status ?? null;
      if (status === null) return { name: h.name, agents: h.agents === undefined ? null : h.agents.map(binaryOf), os: null, appliedAgo: null, conflicts: null, seen: false };
      return { name: h.name, agents: (status.agents ?? []).filter((a) => a.active).map((a) => binaryOf(a.id)), os: status.os, appliedAgo: status.applied.ageSeconds, conflicts: status.conflicts, seen: true };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const on = (cells: Record<string, { on: boolean }>) => Object.values(cells).some((c) => c.on);
  const skills = new Set(model.bundles.filter((b) => on(b.cells)).flatMap((b) => b.skills));
  const servers = model.servers.filter((s) => on(s.cells));

  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 364);
  const { days, first } = readHistory(configDir, from);
  const journal = listJournals(home);
  return {
    hosts,
    agents: new Set(hosts.flatMap((h) => h.agents ?? [])).size,
    skills: skills.size,
    servers: servers.length,
    changes: days.length,
    activity: days.length >= GRID_MINIMUM ? gridOf(days, now) : null,
    pushes: { count: journal.filter((e) => e.header.commit !== null).length, atLeast: journal.length >= JOURNAL_KEPT },
    since: first === null ? null : `${MONTHS[Number(first.slice(5)) - 1]} ${first.slice(0, 4)}`,
  };
}
