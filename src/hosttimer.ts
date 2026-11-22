import { spawnSync } from "node:child_process";
import { LAUNCHD_LABEL, LAUNCHD_PLIST, schedulerFor } from "./scheduler.ts";
import { printable } from "./status.ts";
import { findTool, SHELL_PROBE_PATH } from "./tools.ts";

/**
 * Stopping the apply timer on a machine that has just left the fleet, over ssh. This is the one step of removing a host that reaches
 * the machine, so it asks first, says what it leaves alone, and never fails the removal: the answer is a state and a sentence.
 *
 * It runs the same remove script that `timer: off` runs on a host, for the scheduler the machine has. The agent config, the skills
 * and the links stay where they are.
 */

export type TimerState =
  /** The timer was stopped and its files deleted. */
  | "stopped"
  /** The machine answered and has no fleet timer. */
  | "none"
  /** The machine answered and the person said no. */
  | "declined"
  | "unreachable"
  /** The host file has no ssh destination, so nothing was tried. */
  | "no-destination"
  | "failed";

export type TimerStep = { state: TimerState; message: string };

const q = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

/** Exits 0 and prints `timer` or `none`, from the files either scheduler would have written. */
const PROBE = `if [ -f "$HOME/.config/systemd/user/fleet.timer" ] || [ -f "$HOME/.config/systemd/user/fleet.service" ] || [ -f "$HOME/${LAUNCHD_PLIST}" ]; then echo timer; else echo none; fi`;

/** The remove script of the machine's own scheduler: `uname -s` says which, as `init` asks it. Prints `removed` when it took something off. */
const REMOVE = `PATH="${SHELL_PROBE_PATH}:$PATH"; export PATH
if [ "$(uname -s)" = Darwin ]; then
${schedulerFor("darwin").remove(null)}
else
${schedulerFor("linux").remove(null)}
fi`;

/** How to stop the timer by hand, for a machine fleet could not reach. */
const BY_HAND = `to stop its timer yourself, run 'systemctl --user disable --now fleet.timer' there (Linux) or 'launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}' (macOS)`;

export type TimerStepOptions = {
  host: string;
  /** The `ssh` destination of the host file, or null. */
  ssh: string | null;
  home: string;
  /** Asked once, when the machine answers and has a timer. */
  ask: (question: string) => Promise<boolean>;
};

export async function stopTimerThere({ host, ssh, home, ask }: TimerStepOptions): Promise<TimerStep> {
  if (ssh === null) return { state: "no-destination", message: `fleet: ${host} has no ssh destination, so fleet did not touch it; ${BY_HAND}` };
  const tool = findTool("ssh", process.env, home);
  if (tool === null) return { state: "failed", message: `fleet: ssh is not installed, so fleet did not touch ${host}; ${BY_HAND}` };
  const over = (script: string) => spawnSync(tool, [...SSH_OPTIONS, ssh, `sh -c ${q(script)}`], { encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 60_000 });

  const probe = over(PROBE);
  if (probe.error !== undefined || probe.status === 255 || probe.status === null) {
    return { state: "unreachable", message: `fleet: ${host} did not answer over ssh, so it was told nothing and its timer keeps running; ${BY_HAND}` };
  }
  if (probe.status !== 0) return { state: "failed", message: `fleet: ${host} answered over ssh but could not be asked about its timer (exit ${probe.status}); ${BY_HAND}` };
  if (probe.stdout.trim() !== "timer") return { state: "none", message: `fleet: ${host} has no fleet timer, so there was nothing to stop there` };

  if (!(await ask(`${host} answers over ssh and has a fleet timer. Stop and remove it there? Its agent config, skills and links stay.`))) {
    return { state: "declined", message: `fleet: ${host}'s timer was left running; ${BY_HAND}` };
  }
  const done = over(REMOVE);
  if (done.status === 0) return { state: "stopped", message: `fleet: stopped and removed the timer on ${host}; its agent config, skills and links are as they were` };
  const first = printable((done.stderr ?? "").trim().split("\n")[0] ?? "") ?? "";
  return { state: "failed", message: `fleet: the timer on ${host} could not be removed (exit ${done.status ?? "none"}${first === "" ? "" : `: ${first}`}); ${BY_HAND}` };
}
