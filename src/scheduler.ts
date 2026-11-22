import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { binDirs } from "./agents/index.ts";
import { findTool } from "./tools.ts";

/**
 * What runs `fleet apply` on a host, on the schedule its config asks for (`timer:` in a host file or the
 * defaults, 30 minutes when nothing says otherwise). Linux uses a systemd user timer, macOS a launchd
 * LaunchAgent. The scheduler is picked by the OS of the host being set up: `init` reads it from that host
 * (`uname -s` over ssh), and apply and diff read it from the host they run on, never from the admin's own
 * `process.platform`.
 */

export type Os = "linux" | "darwin";
export type SchedulerName = "systemd" | "launchd";

/** Run on the host being set up; prints `Linux` or `Darwin`. */
export const OS_COMMAND = "uname -s";

export function parseOs(uname: string): Os | null {
  switch (uname.trim()) {
    case "Linux":
      return "linux";
    case "Darwin":
      return "darwin";
    default:
      return null;
  }
}

// ---- the schedule ----

/**
 * The schedules a `timer:` key accepts: the ones systemd's `OnUnitActiveSec` and launchd's
 * `StartCalendarInterval` can both express. Whole hours divide the day, so a run missed while a Mac slept
 * happens on wake; a schedule such as 45m does not divide it and is refused.
 */
export type Schedule = "off" | "5m" | "10m" | "15m" | "20m" | "30m" | `${number}h`;
/** A schedule with the timer on: everything but `off`. */
export type ActiveSchedule = Exclude<Schedule, "off">;

const MINUTE_SCHEDULES = ["5m", "10m", "15m", "20m", "30m"] as const;
const HOUR_SCHEDULE = /^(?:[1-9]|1\d|2[0-4])h$/;

/** What a host gets when no file says otherwise: today's schedule. */
export const DEFAULT_SCHEDULE: ActiveSchedule = "30m";

/** The valid values, as the error message and the docs list them. */
export const SCHEDULE_VALUES = "5m, 10m, 15m, 20m, 30m, a whole hour 1h to 24h, or off";

/** Every schedule a host can ask for with the timer on, shortest first. */
export const ACTIVE_SCHEDULES: readonly ActiveSchedule[] = [
  ...(MINUTE_SCHEDULES as readonly ActiveSchedule[]),
  ...Array.from({ length: 24 }, (_, i) => `${i + 1}h` as ActiveSchedule),
];

/** Parses a `timer:` value; null when it is not a schedule fleet can express. */
export function parseSchedule(value: unknown): Schedule | null {
  if (typeof value !== "string") return null;
  if (value === "off" || (MINUTE_SCHEDULES as readonly string[]).includes(value)) return value as Schedule;
  return HOUR_SCHEDULE.test(value) ? (value as Schedule) : null;
}

/** The schedule as a person reads it: `every 30 minutes`, `every hour`, `every 6 hours`, `off`. */
export function scheduleWord(schedule: Schedule): string {
  if (schedule === "off") return "off";
  const n = Number(schedule.slice(0, -1));
  if (schedule.endsWith("m")) return `every ${n} minutes`;
  return n === 1 ? "every hour" : `every ${n} hours`;
}

export const LAUNCHD_LABEL = "io.github.rolfkoenders.fleet.apply";
/** Relative to HOME. */
export const LAUNCHD_PLIST = `Library/LaunchAgents/${LAUNCHD_LABEL}.plist`;
export const LAUNCHD_LOG = "Library/Logs/fleet.log";

/** The oldest macOS fleet supports: the scripts use `readlink -f`, which macOS has from 12.3. */
export const MACOS_MINIMUM = [12, 3] as const;
/** Run on a macOS host; prints its version, such as `14.5`. */
export const MACOS_VERSION_COMMAND = "sw_vers -productVersion";

/** Why a macOS version, as `sw_vers -productVersion` prints it, is not supported. Null when it is. */
export function macosVersionProblem(raw: string): string | null {
  const m = /^(\d+)\.?(\d+)?(?:\.\d+)*$/.exec(raw.trim());
  const want = `${MACOS_MINIMUM[0]}.${MACOS_MINIMUM[1]}`;
  // Fixed text: what the host printed is not shown, since it is not a version.
  if (m === null) return `could not read the macOS version from ${MACOS_VERSION_COMMAND}; fleet needs ${want} or newer`;
  const major = Number(m[1]);
  const minor = Number(m[2] ?? 0);
  if (major > MACOS_MINIMUM[0] || (major === MACOS_MINIMUM[0] && minor >= MACOS_MINIMUM[1])) return null;
  return `this host runs macOS ${raw.trim()}, and fleet needs ${want} or newer`;
}

/** The exit codes an install or removal script uses; `explain` maps them to a sentence. */
const NO_MANAGER = 40;
const MANAGER_FAILED = 41;
const NOT_ACTIVE = 42;
const NO_SESSION = 43;
const UNSAFE_HOME = 44;

// systemd

/** The unit bodies, without the newline the install script's `printf` adds. */
export const SYSTEMD_SERVICE = "[Service]\nType=oneshot\nExecStart=%h/.local/bin/fleet apply";
export const SYSTEMD_TIMER = (schedule: ActiveSchedule): string =>
  `[Timer]\nOnBootSec=2min\nOnUnitActiveSec=${schedule}\nPersistent=true\n[Install]\nWantedBy=timers.target`;

const SYSTEMD_INSTALL = (q: (text: string) => string, schedule: ActiveSchedule): string => `
d="$HOME/.config/systemd/user"
mkdir -p "$d"
wrote=0
put() {
  if [ -f "$d/$1" ] && [ "$(cat "$d/$1")" = "$2" ]; then return 0; fi
  printf '%s\\n' "$2" > "$d/$1.tmp" && mv "$d/$1.tmp" "$d/$1" && wrote=1 && echo "wrote $1"
}
put fleet.service ${q(SYSTEMD_SERVICE)} || exit 41
put fleet.timer ${q(SYSTEMD_TIMER(schedule))} || exit 41
command -v systemctl >/dev/null 2>&1 || { echo "systemctl is not installed" >&2; exit 40; }
was=0
systemctl --user is-active --quiet fleet.timer && was=1
if [ "$was" = 1 ] && [ "$wrote" = 0 ]; then exit 0; fi
systemctl --user daemon-reload || exit 41
systemctl --user enable --now fleet.timer || exit 41
if [ "$was" = 1 ]; then systemctl --user restart fleet.timer || exit 41; fi
systemctl --user is-active --quiet fleet.timer || exit 42
echo enabled
`;

const SYSTEMD_REMOVE = `
d="$HOME/.config/systemd/user"
if [ -f "$d/fleet.timer" ] || [ -f "$d/fleet.service" ]; then
  command -v systemctl >/dev/null 2>&1 || { echo "systemctl is not installed" >&2; exit 40; }
  if systemctl --user is-active --quiet fleet.timer; then systemctl --user disable --now fleet.timer || exit 41; fi
  rm -f "$d/fleet.timer" "$d/fleet.service"
  systemctl --user daemon-reload || exit 41
  echo removed
fi
`;

// launchd

/**
 * The agent. `StartCalendarInterval` rather than `StartInterval`: launchd.plist(5) says an interval missed
 * while the Mac sleeps is dropped for `StartInterval`, but that a calendar job "will start the job the next
 * time the computer wakes up", which is what `Persistent=true` gives the systemd timer. `RunAtLoad` is the
 * counterpart of `OnBootSec`. `$HOME` is filled in by the shell that writes the file, because launchd does
 * not expand it. The PATH holds Homebrew, because a LaunchAgent starts with only /usr/bin:/bin:/usr/sbin:/sbin.
 */
/** What the timer finds programs on: the agents' own install directories first, since it has no shell profile. */
const LAUNCHD_PATH = ["$HOME/.local/bin", ...binDirs().map((dir) => `$HOME/${dir}`), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");

/** One entry of a `StartCalendarInterval` array. An omitted `Hour` matches every hour, as today's minute entries do. */
const calendarEntry = (hour: number | null, minute: number): string => `    <dict>${hour === null ? "" : `<key>Hour</key><integer>${hour}</integer>`}<key>Minute</key><integer>${minute}</integer></dict>`;

/**
 * The `StartCalendarInterval` entries for a schedule: minutes of every hour for the short ones, and for a
 * whole number of hours the hours it divides the day into, each at minute 0. `1h` leaves `Hour` out, which
 * matches every hour; `24h` is hour 0, once a day.
 */
export function calendarEntries(schedule: ActiveSchedule): string {
  const n = Number(schedule.slice(0, -1));
  if (schedule.endsWith("m")) return Array.from({ length: 60 / n }, (_, i) => calendarEntry(null, i * n)).join("\n");
  if (n === 1) return calendarEntry(null, 0);
  return Array.from({ length: 24 / n }, (_, i) => calendarEntry(i * n, 0)).join("\n");
}

/** The plist body, `$HOME` still to fill in, as the shell that writes the file does. */
const plist = (schedule: ActiveSchedule): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HOME/.local/bin/fleet</string>
    <string>apply</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartCalendarInterval</key>
  <array>
${calendarEntries(schedule)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${LAUNCHD_PATH}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$HOME/${LAUNCHD_LOG}</string>
  <key>StandardErrorPath</key>
  <string>$HOME/${LAUNCHD_LOG}</string>
</dict>
</plist>`;

/** The plist as it sits on a host: `$HOME` filled in and one newline at the end, the way the script writes it. */
export function plistFor(schedule: ActiveSchedule, home: string): string {
  return `${plist(schedule).replaceAll("$HOME", home)}\n`;
}

/**
 * Written with `bootstrap`, not the deprecated `load`, into the `gui/<uid>` domain, which exists only while
 * the user is logged in at the desktop. Over a plain ssh login with no desktop session it does not, and the
 * script says so (exit 43) instead of falling back to a domain it has not proven.
 */
const LAUNCHD_INSTALL = (schedule: ActiveSchedule): string => `
case "$HOME" in *[\\&\\<\\>\\"]*) echo "HOME contains a character that cannot go in a property list" >&2; exit ${UNSAFE_HOME};; esac
d="$HOME/Library/LaunchAgents"; p="$HOME/${LAUNCHD_PLIST}"
mkdir -p "$d" "$HOME/Library/Logs"
cat > "$p.tmp" <<PLIST_EOF
${plist(schedule)}
PLIST_EOF
wrote=0
if [ -f "$p" ] && cmp -s "$p" "$p.tmp"; then rm -f "$p.tmp"; else mv "$p.tmp" "$p" && wrote=1 && echo "wrote ${LAUNCHD_LABEL}.plist" || exit 41; fi
command -v launchctl >/dev/null 2>&1 || { echo "launchctl is not installed" >&2; exit 40; }
dom="gui/$(id -u)"; svc="$dom/${LAUNCHD_LABEL}"
launchctl print "$dom" >/dev/null 2>&1 || { echo "there is no $dom login session" >&2; exit ${NO_SESSION}; }
was=0
launchctl print "$svc" >/dev/null 2>&1 && was=1
if [ "$was" = 1 ] && [ "$wrote" = 0 ]; then exit 0; fi
if [ "$was" = 1 ]; then launchctl bootout "$svc" || exit 41; fi
launchctl bootstrap "$dom" "$p" || exit 41
launchctl print "$svc" >/dev/null 2>&1 || exit 42
echo enabled
`;

/** Boots the agent out and deletes its plist; with no session to ask, there is nothing loaded, so only the file goes. */
const LAUNCHD_REMOVE = `
p="$HOME/${LAUNCHD_PLIST}"
if [ -f "$p" ]; then
  command -v launchctl >/dev/null 2>&1 || { echo "launchctl is not installed" >&2; exit 40; }
  dom="gui/$(id -u)"; svc="$dom/${LAUNCHD_LABEL}"
  if launchctl print "$dom" >/dev/null 2>&1; then
    if launchctl print "$svc" >/dev/null 2>&1; then launchctl bootout "$svc" || exit 41; fi
  fi
  rm -f "$p"
  echo removed
fi
`;

export type Scheduler = {
  name: SchedulerName;
  /** The body of the `timer` init step and of apply's timer change, for `sh`. Prints `enabled` or `wrote ...` when it changed something. */
  install: (q: (text: string) => string, schedule: ActiveSchedule) => string;
  /** The body that stops the timer and deletes its files, for `sh`. Prints `removed` when there was something to take off. */
  remove: () => string;
  /** The sentence for a failed script, from its exit status and first stderr line. Null when it is not one of its codes. */
  explain: (host: string, status: number | null, stderr: string) => string | null;
  /** What `init` tells the user when it is done. */
  done: (host: string, schedule: Schedule) => string;
};

const timerOff = (host: string): string =>
  `${host} is on fleet without a timer: 'fleet apply' runs when you run it, and 'fleet push' still reaches ${host} over ssh. Set 'timer:' in its host file to turn the timer back on.`;

const systemd: Scheduler = {
  name: "systemd",
  install: SYSTEMD_INSTALL,
  remove: () => SYSTEMD_REMOVE,
  explain: (host, status, stderr) => {
    if (status === NO_MANAGER) return `fleet: ${host}: systemctl is not installed, so the timer could not be installed; run 'fleet apply' by hand or from cron`;
    if (status === MANAGER_FAILED) {
      return `fleet: ${host}: systemctl --user failed (${stderr || "no message"}); the units are in ~/.config/systemd/user. On a server the agent user needs a user session: sudo loginctl enable-linger <user>. Then run 'fleet init ${host}' again`;
    }
    if (status === NOT_ACTIVE) return `fleet: ${host}: fleet.timer is not active after enabling it; see systemctl --user status fleet.timer`;
    return null;
  },
  done: (host, schedule) =>
    schedule === "off" ? timerOff(host) : `${host} is on fleet: fleet.timer runs 'fleet apply' ${scheduleWord(schedule)} (journalctl --user -u fleet).`,
};

const launchd: Scheduler = {
  name: "launchd",
  install: (_q, schedule) => LAUNCHD_INSTALL(schedule),
  remove: () => LAUNCHD_REMOVE,
  explain: (host, status, stderr) => {
    if (status === NO_MANAGER) return `fleet: ${host}: launchctl is not installed, so the timer could not be installed`;
    if (status === MANAGER_FAILED) return `fleet: ${host}: launchctl failed (${stderr || "no message"}); the agent is ~/${LAUNCHD_PLIST}. Then run 'fleet init ${host}' again`;
    if (status === NOT_ACTIVE) return `fleet: ${host}: ${LAUNCHD_LABEL} is not loaded after bootstrapping it; see launchctl print gui/$(id -u)/${LAUNCHD_LABEL}`;
    if (status === NO_SESSION) {
      return `fleet: ${host}: the agent is written to ~/${LAUNCHD_PLIST} but cannot be loaded, because ${host} has no desktop login session. A LaunchAgent runs only while its user is logged in: log in at ${host} once (auto-login keeps it across reboots), then run 'fleet init ${host}' again`;
    }
    if (status === UNSAFE_HOME) return `fleet: ${host}: ${stderr || "the home directory cannot go in a property list"}`;
    return null;
  },
  done: (host, schedule) =>
    schedule === "off" ? timerOff(host) : `${host} is on fleet: ${LAUNCHD_LABEL} runs 'fleet apply' at login and ${scheduleWord(schedule)} (log: ~/${LAUNCHD_LOG}).`,
};

export const schedulerFor = (os: Os): Scheduler => (os === "darwin" ? launchd : systemd);

/** The OS this process runs on, for commands that run on the host itself. */
export const thisOs = (): Os => (process.platform === "darwin" ? "darwin" : "linux");

/**
 * The OS of the host fleet runs on, as that host's own `uname -s` reports it (the same source `init` reads
 * over ssh), so a host that reports itself a Mac is managed as one. `process.platform` when uname cannot be
 * asked, which on a real host agrees with it.
 */
export function hostOs(home: string = homedir()): Os {
  const uname = findTool("uname", process.env, home);
  if (uname !== null) {
    const r = spawnSync(uname, ["-s"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    const os = r.error ? null : parseOs(r.stdout ?? "");
    if (os !== null) return os;
  }
  return thisOs();
}

/**
 * Which scheduler `fleet status` asks on this host. A LaunchAgent that is installed is asked about whatever
 * the OS reports, so the answer follows the host's own files.
 */
export const statusOs = (home: string = homedir()): Os => (thisOs() === "darwin" || existsSync(join(home, LAUNCHD_PLIST)) ? "darwin" : "linux");

/** Whether the scheduler's agent is loaded, as the word `status` shows. Null when it cannot be asked. */
export type Ask = (path: string, args: string[]) => { status: number | null; stdout: string } | null;

export function timerWord(os: Os, run: Ask, find: (name: string) => string | null): string | null {
  if (os === "darwin") {
    const path = find("launchctl");
    const uid = process.getuid?.();
    if (path === null || uid === undefined) return null;
    const r = run(path, ["print", `gui/${uid}/${LAUNCHD_LABEL}`]);
    if (r === null) return null;
    return r.status === 0 ? "active" : "inactive";
  }
  const path = find("systemctl");
  if (path === null) return null;
  const r = run(path, ["--user", "is-active", "fleet.timer"]);
  if (r === null) return null;
  const word = r.stdout.trim().split("\n")[0] ?? "";
  return /^[a-z-]+$/.test(word) ? word : null;
}
