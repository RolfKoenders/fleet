import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ACTIVE_SCHEDULES,
  calendarEntries,
  hostOs,
  LAUNCHD_LABEL,
  LAUNCHD_PLIST,
  parseSchedule,
  plistFor,
  scheduleWord,
  schedulerFor,
  SYSTEMD_SERVICE,
  SYSTEMD_TIMER,
} from "./scheduler.ts";
import type { ActiveSchedule, Os, Schedule } from "./scheduler.ts";
import { SHELL_PROBE_PATH } from "./tools.ts";

/**
 * The apply timer as `diff` and `apply` see it: one change, planned by reading the host's own unit files or
 * plist, run as the shell scripts `init` has always used. The scripts are the one part of apply that leaves
 * the home directory, by asking systemd or launchd, so their failures are warnings: the config is applied
 * either way, and `init`'s timer step is the one that stops on a scheduler it cannot reach.
 */

/** What `timer:` asks for and what is installed now. */
export type TimerChange =
  | { change: "create"; schedule: ActiveSchedule; from: null }
  | { change: "update"; schedule: ActiveSchedule; from: Schedule | null }
  | { change: "remove"; schedule: "off"; from: Schedule | null };

const q = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

const readFileOrNone = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

type Entry = { hour: number | null; minute: number | null };

/** The calendar entries of a plist's `StartCalendarInterval` array, as `{Hour, Minute}` pairs. */
function calendarPairs(text: string): Entry[] {
  const int = (dict: string, key: string): number | null => {
    const value = new RegExp(`<key>${key}</key><integer>(\\d+)</integer>`).exec(dict)?.[1];
    return value === undefined ? null : Number(value);
  };
  return [...text.matchAll(/<dict>(.*?)<\/dict>/g)].map((m) => ({ hour: int(m[1]!, "Hour"), minute: int(m[1]!, "Minute") }));
}

/**
 * The schedule whose calendar entries an installed plist holds, or null when it is none fleet writes. The
 * entries are compared against what fleet itself would write for every schedule, so a plist it did not make
 * is never mistaken for one.
 */
function calendarSchedule(text: string): Schedule | null {
  const pairs = calendarPairs(text);
  if (pairs.length === 0) return null;
  for (const schedule of ACTIVE_SCHEDULES) {
    if (JSON.stringify(calendarPairs(calendarEntries(schedule))) === JSON.stringify(pairs)) return schedule;
  }
  return null;
}

/** The schedule an installed `fleet.timer` asks for, from its `OnUnitActiveSec`: `30min` as `fleet init` wrote it, or `30m` and `6h`. */
function timerSchedule(text: string): Schedule | null {
  const interval = /^OnUnitActiveSec=(\S+)$/m.exec(text)?.[1] ?? null;
  if (interval === null) return null;
  return parseSchedule(interval.replace(/^(\d+)min$/, "$1m"));
}

/** The timer's difference from `schedule`, or null when the installed timer is already in step. Reads, writes nothing. */
export function planTimer(home: string, schedule: Schedule): TimerChange | null {
  if (hostOs(home) === "darwin") {
    const installed = readFileOrNone(join(home, LAUNCHD_PLIST));
    if (schedule === "off") return installed === null ? null : { change: "remove", schedule, from: calendarSchedule(installed) };
    if (installed === plistFor(schedule, home)) return null;
    return installed === null
      ? { change: "create", schedule, from: null }
      : { change: "update", schedule, from: calendarSchedule(installed) };
  }
  const dir = join(home, ".config/systemd/user");
  const service = readFileOrNone(join(dir, "fleet.service"));
  const timer = readFileOrNone(join(dir, "fleet.timer"));
  const installedSchedule = timer === null ? null : timerSchedule(timer);
  if (schedule === "off") return service === null && timer === null ? null : { change: "remove", schedule, from: installedSchedule };
  if (service === `${SYSTEMD_SERVICE}\n` && timer === `${SYSTEMD_TIMER(schedule)}\n`) return null;
  return service === null && timer === null
    ? { change: "create", schedule, from: null }
    : { change: "update", schedule, from: installedSchedule };
}

/** The one-line form of a timer change, after its verb: `timer: every 30 minutes -> every 10 minutes`. */
export function timerText(change: TimerChange): string {
  if (change.change === "remove") return "timer";
  const arrow = change.change === "update" && change.from !== null && change.from !== change.schedule ? `${scheduleWord(change.from)} -> ` : "";
  return `timer: ${arrow}${scheduleWord(change.schedule)}`;
}

/** The control groups this process is in, as the kernel lists them. Empty where there are none to read. */
const ownCgroups = (): string => {
  try {
    return readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    return "";
  }
};

/**
 * Whether this `fleet apply` was started by the timer itself. launchd gives a job its label as
 * `XPC_SERVICE_NAME`, which the agent's plist does not have to set, so the plist stays as it has always been.
 * systemd puts what a unit starts in that unit's control group, so a process in `fleet.service` was started by
 * the timer. Neither the unit nor an environment variable is changed for this, and `INVOCATION_ID` would not do:
 * a terminal launched as a service has it too.
 */
export const startedByTimer = (os: Os, env: NodeJS.ProcessEnv, cgroups: string = os === "darwin" ? "" : ownCgroups()): boolean =>
  os === "darwin" ? env.XPC_SERVICE_NAME === LAUNCHD_LABEL : /\/fleet\.service$/m.test(cgroups);

/**
 * Runs the change's script on this host, the way `init` runs it: `sh`, the home's own bin first on `PATH`.
 * Null when it worked; the sentence for the host when it did not, which apply reports as a warning.
 * An apply that the timer started must not stop the timer under itself: launchd would end this process
 * with the job, so the script hands the reload to a process that waits for this one to exit first.
 */
export function runTimer(change: TimerChange, host: string, home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string | null {
  const os = hostOs(home);
  const scheduler = schedulerFor(os);
  const afterPid = startedByTimer(os, env) ? process.pid : null;
  const body = change.change === "remove" ? scheduler.remove(afterPid) : scheduler.install(q, change.schedule, afterPid);
  const script = `PATH="${SHELL_PROBE_PATH}:$PATH"; export PATH\n${body}`;
  const r = spawnSync("sh", ["-c", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...env, HOME: home } });
  if (r.status === 0) return null;
  const first = (r.stderr ?? "").trim().split("\n")[0] ?? "";
  return (
    scheduler.explain(host, r.status, first) ??
    `fleet: ${host}: the timer could not be ${change.change === "remove" ? "removed" : "installed"} (exit ${r.status ?? "none"}): ${first || "no message"}`
  );
}
