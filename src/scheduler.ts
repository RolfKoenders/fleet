import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * What runs `fleet apply` every 30 minutes on a host. Linux uses a systemd user timer, macOS a launchd
 * LaunchAgent. The scheduler is picked by the OS of the host being set up: `init` reads it from that
 * host (`uname -s` over ssh), never from the admin's own `process.platform`.
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

/** The exit codes an install script uses; `explain` maps them to a sentence. */
const NO_MANAGER = 40;
const MANAGER_FAILED = 41;
const NOT_ACTIVE = 42;
const NO_SESSION = 43;
const UNSAFE_HOME = 44;

// systemd

const SERVICE = "[Service]\nType=oneshot\nExecStart=%h/.local/bin/fleet apply";
const TIMER = "[Timer]\nOnBootSec=2min\nOnUnitActiveSec=30min\nPersistent=true\n[Install]\nWantedBy=timers.target";

const SYSTEMD_INSTALL = (q: (text: string) => string): string => `
d="$HOME/.config/systemd/user"
mkdir -p "$d"
wrote=0
put() {
  if [ -f "$d/$1" ] && [ "$(cat "$d/$1")" = "$2" ]; then return 0; fi
  printf '%s\\n' "$2" > "$d/$1.tmp" && mv "$d/$1.tmp" "$d/$1" && wrote=1 && echo "wrote $1"
}
put fleet.service ${q(SERVICE)} || exit 41
put fleet.timer ${q(TIMER)} || exit 41
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

// launchd

/**
 * The agent. `StartCalendarInterval` rather than `StartInterval`: launchd.plist(5) says an interval missed
 * while the Mac sleeps is dropped for `StartInterval`, but that a calendar job "will start the job the next
 * time the computer wakes up", which is what `Persistent=true` gives the systemd timer. `RunAtLoad` is the
 * counterpart of `OnBootSec`. `$HOME` is filled in by the shell that writes the file, because launchd does
 * not expand it. The PATH holds Homebrew, because a LaunchAgent starts with only /usr/bin:/bin:/usr/sbin:/sbin.
 */
const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
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
    <dict><key>Minute</key><integer>0</integer></dict>
    <dict><key>Minute</key><integer>30</integer></dict>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$HOME/.local/bin:$HOME/.opencode/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$HOME/${LAUNCHD_LOG}</string>
  <key>StandardErrorPath</key>
  <string>$HOME/${LAUNCHD_LOG}</string>
</dict>
</plist>`;

/**
 * Written with `bootstrap`, not the deprecated `load`, into the `gui/<uid>` domain, which exists only while
 * the user is logged in at the desktop. Over a plain ssh login with no desktop session it does not, and the
 * script says so (exit 43) instead of falling back to a domain it has not proven.
 */
const LAUNCHD_INSTALL = `
case "$HOME" in *[\\&\\<\\>\\"]*) echo "HOME contains a character that cannot go in a property list" >&2; exit ${UNSAFE_HOME};; esac
d="$HOME/Library/LaunchAgents"; p="$HOME/${LAUNCHD_PLIST}"
mkdir -p "$d" "$HOME/Library/Logs"
cat > "$p.tmp" <<PLIST_EOF
${PLIST}
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

export type Scheduler = {
  name: SchedulerName;
  /** The body of the `timer` init step, for `sh`. Prints `enabled` or `wrote ...` when it changed something. */
  install: (q: (text: string) => string) => string;
  /** The sentence for a failed install script, from its exit status and first stderr line. Null when it is not one of its codes. */
  explain: (host: string, status: number | null, stderr: string) => string | null;
  /** What `init` tells the user when it is done. */
  done: (host: string) => string;
};

const systemd: Scheduler = {
  name: "systemd",
  install: SYSTEMD_INSTALL,
  explain: (host, status, stderr) => {
    if (status === NO_MANAGER) return `fleet: ${host}: systemctl is not installed, so the timer could not be installed; run 'fleet apply' by hand or from cron`;
    if (status === MANAGER_FAILED) {
      return `fleet: ${host}: systemctl --user failed (${stderr || "no message"}); the units are in ~/.config/systemd/user. On a server the agent user needs a user session: sudo loginctl enable-linger <user>. Then run 'fleet init ${host}' again`;
    }
    if (status === NOT_ACTIVE) return `fleet: ${host}: fleet.timer is not active after enabling it; see systemctl --user status fleet.timer`;
    return null;
  },
  done: (host) => `${host} is on fleet: fleet.timer runs 'fleet apply' every 30 minutes (journalctl --user -u fleet).`,
};

const launchd: Scheduler = {
  name: "launchd",
  install: () => LAUNCHD_INSTALL,
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
  done: (host) => `${host} is on fleet: ${LAUNCHD_LABEL} runs 'fleet apply' at login and every 30 minutes (log: ~/${LAUNCHD_LOG}).`,
};

export const schedulerFor = (os: Os): Scheduler => (os === "darwin" ? launchd : systemd);

/** The OS this process runs on, for commands that run on the host itself. */
export const thisOs = (): Os => (process.platform === "darwin" ? "darwin" : "linux");

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
