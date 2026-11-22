import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { gitEnv, installFakeTool, makeClone, makeHome, NODE, publish, runFleet, toolCalls, writeExecutable } from "./helpers.ts";
import { binDirs } from "../src/agents/index.ts";
import { EXIT } from "../src/exit.ts";
import {
  ACTIVE_SCHEDULES,
  calendarEntries,
  DEFAULT_SCHEDULE,
  LAUNCHD_LABEL,
  LAUNCHD_PLIST,
  parseSchedule,
  plistFor,
  SCHEDULE_VALUES,
  scheduleWord,
  SYSTEMD_SERVICE,
  SYSTEMD_TIMER,
  systemdInterval,
} from "../src/scheduler.ts";
import type { ActiveSchedule } from "../src/scheduler.ts";
import { planTimer, timerText } from "../src/timerplan.ts";

/*
 * The timer's schedule, end to end: the `timer:` key in the defaults and a host file, the plan diff and
 * apply make of it, and the systemd and launchd scripts the change runs. The schedulers are the fakes every
 * test home has (`systemctl` answers the way the unit files say, `launchctl` keeps its state in a file), and
 * a Mac is a home whose `uname` says Darwin, the way `init` reads it from a host.
 */

function world(o: { defaults?: string; host?: string } = {}) {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(clone, rel)), { recursive: true });
    writeFileSync(join(clone, rel), text);
    publish(clone, rel);
  };
  write("hosts/_defaults.yaml", o.defaults ?? "{}\n");
  write("hosts/laptop.yaml", o.host ?? "{}\n");
  const run = (...args: string[]) => runFleet(clone, args, { home });
  return { clone, home, write, run };
}

const units = (home: string) => join(home, ".config/systemd/user");
const plistPath = (home: string) => join(home, LAUNCHD_PLIST);
const lines = (home: string, name: string) => toolCalls(home, name);

/** Makes the home report itself as a Mac, the way a host's own `uname -s` does. */
function makeMac(home: string): void {
  writeExecutable(join(home, ".local/bin/uname"), `#!/bin/sh\nif [ "$1" = "-s" ]; then echo Darwin; else exec /usr/bin/uname "$@"; fi\n`);
}

test("the valid schedules are the short minutes, whole hours and off, and nothing else", () => {
  for (const value of ["5m", "10m", "15m", "20m", "30m", "1h", "7h", "24h", "off"]) assert.notEqual(parseSchedule(value), null, value);
  for (const value of ["45m", "35m", "1.5h", "0h", "25h", "60m", "5M", "sometimes", "", 5, true, null]) assert.equal(parseSchedule(value), null, String(value));
  assert.equal((ACTIVE_SCHEDULES as readonly string[]).includes("24h"), true);
  assert.equal((ACTIVE_SCHEDULES as readonly string[]).includes("off"), false);
});

test("a schedule reads as a person reads it", () => {
  assert.equal(scheduleWord("5m"), "every 5 minutes");
  assert.equal(scheduleWord("30m"), "every 30 minutes");
  assert.equal(scheduleWord("1h"), "every hour");
  assert.equal(scheduleWord("6h"), "every 6 hours");
  assert.equal(scheduleWord("24h"), "every 24 hours");
  assert.equal(scheduleWord("off"), "off");
});

test("systemd gets the schedule as its OnUnitActiveSec, with the boot delay and persistence as they were", () => {
  assert.equal(SYSTEMD_TIMER("10m"), `[Timer]\nOnBootSec=2min\nOnUnitActiveSec=10min\nPersistent=true\n[Install]\nWantedBy=timers.target`);
  assert.equal(systemdInterval("30m"), "30min");
  assert.equal(SYSTEMD_TIMER("6h"), `[Timer]\nOnBootSec=2min\nOnUnitActiveSec=6h\nPersistent=true\n[Install]\nWantedBy=timers.target`);
  assert.equal(SYSTEMD_SERVICE, "[Service]\nType=oneshot\nExecStart=%h/.local/bin/fleet apply");
});

/** The `{Hour, Minute}` pairs of a schedule's calendar entries. */
function pairs(schedule: ActiveSchedule): [number | null, number][] {
  const hour = (line: string): number | null => {
    const found = /<key>Hour<\/key><integer>(\d+)<\/integer>/.exec(line)?.[1];
    return found === undefined ? null : Number(found);
  };
  return calendarEntries(schedule).split("\n").map((line) => [hour(line), Number(/<key>Minute<\/key><integer>(\d+)<\/integer>/.exec(line)![1])]);
}

test("launchd gets calendar entries: minutes of every hour for the short ones, whole hours as the day they divide it into", () => {
  assert.deepEqual(pairs("5m"), Array.from({ length: 12 }, (_, i) => [null, i * 5]));
  assert.deepEqual(pairs("10m"), Array.from({ length: 6 }, (_, i) => [null, i * 10]));
  assert.deepEqual(pairs("15m"), [[null, 0], [null, 15], [null, 30], [null, 45]]);
  assert.deepEqual(pairs("20m"), [[null, 0], [null, 20], [null, 40]]);
  assert.deepEqual(pairs("30m"), [[null, 0], [null, 30]]);
  // No Hour key matches every hour, so 1h is one entry.
  assert.deepEqual(pairs("1h"), [[null, 0]]);
  assert.deepEqual(pairs("6h"), [[0, 0], [6, 0], [12, 0], [18, 0]]);
  assert.deepEqual(pairs("12h"), [[0, 0], [12, 0]]);
  assert.deepEqual(pairs("24h"), [[0, 0]]);
  const plist = plistFor("6h", "/Users/alice");
  assert.ok(plist.includes("<string>/Users/alice/.local/bin/fleet</string>"), "the paths are real, since launchd expands nothing");
  assert.ok(!plist.includes("$HOME"));
});

test("the loader takes timer: in the defaults and in a host file, the host file winning as shared keys do", () => {
  const layered = world({ defaults: "timer: 30m\n", host: "timer: 10m\n" });
  const r = layered.run("diff", "--json");
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(JSON.parse(r.stdout).timer.schedule, "10m", "the host file's value wins");

  const fromDefaults = world({ defaults: "timer: 15m\n" });
  assert.equal(JSON.parse(fromDefaults.run("diff", "--json").stdout).timer.schedule, "15m");
});

test("a timer: value that neither system can express is refused with the valid ones", () => {
  for (const value of ["45m", "25h", "0h", "sometimes"]) {
    const w = world({ host: `timer: ${value}\n` });
    const r = w.run("diff");
    assert.equal(r.code, EXIT.invalid, value);
    assert.match(r.stderr, new RegExp(`'timer' must be ${SCHEDULE_VALUES}`), value);
    assert.equal(existsSync(join(w.home, ".config/systemd")), false, "nothing was written");
  }
});

test("a host with nothing installed and a config that asks for a timer gets one from apply, and a second apply is a no-op", () => {
  const w = world({ host: "timer: 10m\n" });
  const diff = w.run("diff");
  assert.match(diff.stdout, /^create timer: every 10 minutes$/m);
  const apply = w.run("apply");
  assert.equal(apply.code, EXIT.ok, apply.stderr);
  assert.match(apply.stdout, /^created timer: every 10 minutes$/m);
  assert.equal(readFileSync(join(units(w.home), "fleet.timer"), "utf8"), `${SYSTEMD_TIMER("10m")}\n`);
  assert.equal(readFileSync(join(units(w.home), "fleet.service"), "utf8"), `${SYSTEMD_SERVICE}\n`);
  assert.deepEqual(lines(w.home, "systemctl").slice(0, 4), [
    ["--user", "is-active", "--quiet", "fleet.timer"],
    ["--user", "daemon-reload"],
    ["--user", "enable", "--now", "fleet.timer"],
    ["--user", "is-active", "--quiet", "fleet.timer"],
  ]);
  const again = w.run("diff");
  assert.match(again.stdout, /^nothing to do$/m);
  assert.equal(JSON.parse(w.run("diff", "--json").stdout).timer, null);
});

test("a changed schedule is rewritten and the timer restarted, and diff shows the change", () => {
  const w = world({ host: "timer: 10m\n" });
  assert.equal(w.run("apply").code, EXIT.ok);
  w.write("hosts/laptop.yaml", "timer: 30m\n");
  const diff = w.run("diff");
  assert.match(diff.stdout, /^update timer: every 10 minutes -> every 30 minutes$/m);
  assert.equal(w.run("apply").code, EXIT.ok);
  assert.equal(readFileSync(join(units(w.home), "fleet.timer"), "utf8"), `${SYSTEMD_TIMER("30m")}\n`);
  assert.deepEqual(lines(w.home, "systemctl").slice(-4), [
    ["--user", "daemon-reload"],
    ["--user", "enable", "--now", "fleet.timer"],
    ["--user", "restart", "fleet.timer"],
    ["--user", "is-active", "--quiet", "fleet.timer"],
  ], "an already running timer is restarted, not just enabled");
});

test("units someone has edited are put back to the schedule the config asks for", () => {
  const w = world({ host: "timer: 10m\n" });
  assert.equal(w.run("apply").code, EXIT.ok);
  writeFileSync(join(units(w.home), "fleet.timer"), "[Timer]\nOnUnitActiveSec=17min\n");
  const diff = w.run("diff");
  assert.match(diff.stdout, /^update timer: every 10 minutes$/m, "an unreadable schedule has no arrow, only the target");
  assert.equal(w.run("apply").code, EXIT.ok);
  assert.equal(readFileSync(join(units(w.home), "fleet.timer"), "utf8"), `${SYSTEMD_TIMER("10m")}\n`);
});

test("timer: off stops the timer, deletes the units, and a value set again installs them", () => {
  const w = world({ host: "timer: 10m\n" });
  assert.equal(w.run("apply").code, EXIT.ok);
  w.write("hosts/laptop.yaml", "timer: off\n");
  const diff = w.run("diff");
  assert.match(diff.stdout, /^remove timer$/m);
  assert.equal(JSON.parse(w.run("diff", "--json").stdout).timer.schedule, "off");
  const apply = w.run("apply");
  assert.equal(apply.code, EXIT.ok, apply.stderr);
  assert.match(apply.stdout, /^removed timer$/m);
  assert.equal(existsSync(join(units(w.home), "fleet.timer")), false, "the unit is gone");
  assert.equal(existsSync(join(units(w.home), "fleet.service")), false, "the service is gone with it");
  assert.ok(lines(w.home, "systemctl").some((c) => c.join(" ") === "--user disable --now fleet.timer"), "the timer was disabled, not only deleted");
  assert.equal(w.run("diff").stdout.trim(), "nothing to do");

  w.write("hosts/laptop.yaml", "timer: 20m\n");
  assert.match(w.run("diff").stdout, /^create timer: every 20 minutes$/m);
  assert.equal(w.run("apply").code, EXIT.ok);
  assert.equal(readFileSync(join(units(w.home), "fleet.timer"), "utf8"), `${SYSTEMD_TIMER("20m")}\n`);
});

test("a scheduler apply cannot reach is a warning, and the config is still applied", () => {
  const w = world({ host: "timer: 10m\n" });
  installFakeTool(w.home, "systemctl", { exit: 1, only: ["--user", "is-active", "--quiet", "fleet.timer"] });
  const r = w.run("apply");
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stdout, /^warning fleet: laptop: systemctl --user failed \(fake systemctl: unexpected arguments\)/m);
  assert.match(r.stdout, /the units are in ~\/.config\/systemd\/user/m);
  assert.equal(readFileSync(join(units(w.home), "fleet.timer"), "utf8"), `${SYSTEMD_TIMER("10m")}\n`, "the files are written even when systemd could not be asked");
  assert.ok(existsSync(join(w.home, ".local/state/fleet/applied.json")), "and the apply is recorded, so the warning does not make the next apply start over");
});

test("a Mac home gets its LaunchAgent from apply, on the schedule the config asks for", () => {
  const w = world({ host: "timer: 6h\n" });
  makeMac(w.home);
  assert.match(w.run("diff").stdout, /^create timer: every 6 hours$/m);
  assert.equal(w.run("apply").code, EXIT.ok);
  assert.equal(readFileSync(plistPath(w.home), "utf8"), plistFor("6h", w.home));
  assert.deepEqual(lines(w.home, "systemctl"), [], "systemctl is not called on a Mac");
  assert.ok(lines(w.home, "launchctl").some((c) => c[0] === "bootstrap"), "the agent is loaded");
});

test("a Mac's changed schedule boots the old agent out and the new one in, and off removes the agent", () => {
  const w = world({ host: "timer: 30m\n" });
  makeMac(w.home);
  assert.equal(w.run("apply").code, EXIT.ok);
  w.write("hosts/laptop.yaml", "timer: 10m\n");
  const diff = w.run("diff");
  assert.match(diff.stdout, /^update timer: every 30 minutes -> every 10 minutes$/m);
  assert.equal(w.run("apply").code, EXIT.ok);
  assert.equal(readFileSync(plistPath(w.home), "utf8"), plistFor("10m", w.home));
  assert.ok(lines(w.home, "launchctl").some((c) => c.join(" ").startsWith("bootout")), "the old agent was booted out first");

  w.write("hosts/laptop.yaml", "timer: off\n");
  assert.match(w.run("diff").stdout, /^remove timer$/m);
  assert.equal(w.run("apply").code, EXIT.ok);
  assert.equal(existsSync(plistPath(w.home)), false, "the plist is deleted");
  assert.equal(existsSync(join(w.home, ".fake-agent-loaded")), false, "and the agent is unloaded");
  assert.equal(lines(w.home, "launchctl").filter((c) => c[0] === "bootout").length, 2, "one bootout per change");

  w.write("hosts/laptop.yaml", "timer: 1h\n");
  assert.equal(w.run("apply").code, EXIT.ok);
  assert.equal(readFileSync(plistPath(w.home), "utf8"), plistFor("1h", w.home), "setting a value again installs it again");
});

test("planTimer reads the host: matching files are a no-op, missing ones a create, and off a remove", () => {
  const home = makeHome("laptop");
  assert.deepEqual(planTimer(home, "30m"), { change: "create", schedule: "30m", from: null });
  mkdirSync(units(home), { recursive: true });
  writeFileSync(join(units(home), "fleet.service"), `${SYSTEMD_SERVICE}\n`);
  writeFileSync(join(units(home), "fleet.timer"), `${SYSTEMD_TIMER("30m")}\n`);
  assert.equal(planTimer(home, "30m"), null);
  assert.deepEqual(planTimer(home, "10m"), { change: "update", schedule: "10m", from: "30m" });
  assert.deepEqual(planTimer(home, "off"), { change: "remove", schedule: "off", from: "30m" });
  assert.deepEqual(planTimer(home, DEFAULT_SCHEDULE), null, "the default schedule is what a host init'd today already has");
});

test("the timer line names the schedule it goes to, and off names nothing but the timer", () => {
  assert.equal(timerText({ change: "create", schedule: "10m", from: null }), "timer: every 10 minutes");
  assert.equal(timerText({ change: "update", schedule: "10m", from: "30m" }), "timer: every 30 minutes -> every 10 minutes");
  assert.equal(timerText({ change: "update", schedule: "10m", from: null }), "timer: every 10 minutes");
  assert.equal(timerText({ change: "remove", schedule: "off", from: "30m" }), "timer");
});

test("status shows the schedule next to the timer's state, in text and in --json", () => {
  const w = world({ host: "timer: 1h\n" });
  assert.equal(w.run("apply").code, EXIT.ok);
  const doc = JSON.parse(w.run("status", "--json").stdout);
  assert.equal(doc.schedule, "1h");
  assert.match(w.run("status").stdout, /^timer: active, every hour$/m);

  const off = world({ host: "timer: off\n" });
  off.run("apply");
  assert.equal(JSON.parse(off.run("status", "--json").stdout).schedule, "off");
  assert.match(off.run("status").stdout, /^timer: inactive, off$/m, "the word for the timer is what the fake systemd said: nothing is installed");
});

test("the label the LaunchAgent uses is the one it has always had", () => {
  assert.equal(LAUNCHD_LABEL, "io.github.rolfkoenders.fleet.apply");
  assert.equal(LAUNCHD_PLIST, `Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
});

// ---- a host that was set up before schedules were configurable ----

/** What `fleet init` wrote on a Linux host before the schedule was configurable, byte for byte. */
const OLD_SERVICE = "[Service]\nType=oneshot\nExecStart=%h/.local/bin/fleet apply\n";
const OLD_TIMER = "[Timer]\nOnBootSec=2min\nOnUnitActiveSec=30min\nPersistent=true\n[Install]\nWantedBy=timers.target\n";

/** What it wrote on a Mac: every 30 minutes as the minutes 0 and 30 of every hour. */
function oldPlist(home: string): string {
  const path = ["$HOME/.local/bin", ...binDirs().map((dir) => `$HOME/${dir}`), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
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
    <string>${path}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/fleet.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/fleet.log</string>
</dict>
</plist>
`.replaceAll("$HOME", home);
}

test("the default schedule writes the bytes fleet init has always written", () => {
  assert.equal(`${SYSTEMD_SERVICE}\n`, OLD_SERVICE);
  assert.equal(`${SYSTEMD_TIMER(DEFAULT_SCHEDULE)}\n`, OLD_TIMER);
  assert.equal(plistFor(DEFAULT_SCHEDULE, "/Users/alice"), oldPlist("/Users/alice"));
});

test("units written by fleet init before this change, and an apply with no timer: key, change nothing and ask no scheduler", () => {
  const w = world();
  mkdirSync(units(w.home), { recursive: true });
  writeFileSync(join(units(w.home), "fleet.service"), OLD_SERVICE);
  writeFileSync(join(units(w.home), "fleet.timer"), OLD_TIMER);
  assert.equal(JSON.parse(w.run("diff", "--json").stdout).timer, null);
  const r = w.run("apply");
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.doesNotMatch(r.stdout, /timer/);
  assert.equal(readFileSync(join(units(w.home), "fleet.timer"), "utf8"), OLD_TIMER);
  assert.deepEqual(lines(w.home, "systemctl"), [], "systemctl is not called");
  assert.deepEqual(lines(w.home, "launchctl"), [], "launchctl is not called");
});

test("the LaunchAgent fleet init wrote before this change, and an apply with no timer: key, change nothing and ask no scheduler", () => {
  const w = world();
  makeMac(w.home);
  mkdirSync(dirname(plistPath(w.home)), { recursive: true });
  writeFileSync(plistPath(w.home), oldPlist(w.home));
  assert.equal(JSON.parse(w.run("diff", "--json").stdout).timer, null);
  const r = w.run("apply");
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.doesNotMatch(r.stdout, /timer/);
  assert.equal(readFileSync(plistPath(w.home), "utf8"), oldPlist(w.home));
  assert.deepEqual(lines(w.home, "launchctl"), [], "launchctl is not called");
  assert.deepEqual(lines(w.home, "systemctl"), [], "systemctl is not called");
});

test("an installed timer is read in systemd's own spelling and in fleet's: 30min, 30m, 6h", () => {
  const home = makeHome("laptop");
  mkdirSync(units(home), { recursive: true });
  writeFileSync(join(units(home), "fleet.service"), OLD_SERVICE);
  for (const [text, schedule] of [["30min", "30m"], ["30m", "30m"], ["10min", "10m"], ["6h", "6h"], ["1h", "1h"]] as const) {
    writeFileSync(join(units(home), "fleet.timer"), OLD_TIMER.replace("30min", text));
    assert.deepEqual(planTimer(home, "off"), { change: "remove", schedule: "off", from: schedule }, text);
  }
});

// ---- an apply that the timer itself started ----

/**
 * A launchctl that behaves as launchd does when a running job is booted out: the job's processes are ended.
 * `job-pid` names the apply that counts as the job; `bootout-saw` records whether it was still running.
 */
function launchdKillsTheJob(home: string): void {
  writeExecutable(
    join(home, ".local/bin/launchctl"),
    `#!/bin/sh
if [ "$1" = bootout ] && [ -f "$HOME/job-pid" ]; then
  pid=$(cat "$HOME/job-pid")
  if kill -0 "$pid" 2>/dev/null; then echo alive >> "$HOME/bootout-saw"; kill -9 "$PPID" "$pid"; else echo gone >> "$HOME/bootout-saw"; fi
fi
exec ${NODE} "$HOME/.fake-launchctl.js" "$@"
`,
  );
}

/** Runs `fleet apply` as the job: marked the way launchd marks it, and its pid written down for the fake launchd. */
function applyAsJob(w: ReturnType<typeof world>, marked: boolean): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(join(w.clone, "bin/fleet"), ["apply"], {
      env: { PATH: "/usr/bin:/bin", HOME: w.home, FLEET_NODE: NODE, ...gitEnv, FLEET_CONFIG: w.clone, ...(marked ? { XPC_SERVICE_NAME: LAUNCHD_LABEL } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    writeFileSync(join(w.home, "job-pid"), String(child.pid));
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

async function until(what: string, done: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (done()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const loadedPlist = (home: string): string | null => (existsSync(join(home, ".fake-agent-loaded")) ? readFileSync(join(home, ".fake-agent-loaded"), "utf8") : null);
const sawAtBootout = (home: string): string[] => (existsSync(join(home, "bootout-saw")) ? readFileSync(join(home, "bootout-saw"), "utf8").trim().split("\n") : []);

async function loadedMac(schedule: string) {
  const w = world({ host: `timer: ${schedule}\n` });
  makeMac(w.home);
  assert.equal(w.run("apply").code, EXIT.ok);
  assert.ok(loadedPlist(w.home), "the agent is loaded");
  launchdKillsTheJob(w.home);
  return w;
}

test("the harness: an apply that boots its own agent out is ended by launchd and leaves no agent", async () => {
  const w = await loadedMac("30m");
  w.write("hosts/laptop.yaml", "timer: 10m\n");
  const job = await applyAsJob(w, false);
  assert.notEqual(job.code, 0, "the apply was killed under itself");
  await until("the agent to be booted out", () => loadedPlist(w.home) === null);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(loadedPlist(w.home), null, "and nothing loaded the agent again");
  assert.deepEqual(sawAtBootout(w.home), ["alive"]);
});

test("a changed schedule applied by the LaunchAgent's own run reloads the agent after that run has exited, and ends with it loaded", async () => {
  const w = await loadedMac("30m");
  w.write("hosts/laptop.yaml", "timer: 10m\n");
  const job = await applyAsJob(w, true);
  assert.equal(job.code, 0);
  assert.match(job.stdout, /^updated timer: every 30 minutes -> every 10 minutes$/m);
  assert.equal(readFileSync(plistPath(w.home), "utf8"), plistFor("10m", w.home), "the new plist is written at once");
  await until("the agent to be loaded again", () => loadedPlist(w.home) === plistFor("10m", w.home));
  assert.deepEqual(sawAtBootout(w.home), ["gone"], "the agent was booted out only once the apply had exited");
  const verbs = lines(w.home, "launchctl").map((c) => c[0]);
  assert.deepEqual(verbs.slice(-2), ["bootout", "bootstrap"], "booted out, then loaded again");
  assert.match(readFileSync(join(w.home, "Library/Logs/fleet.log"), "utf8"), /reloaded the timer/);
});

test("timer: off applied by the LaunchAgent's own run removes the agent after that run has exited", async () => {
  const w = await loadedMac("30m");
  w.write("hosts/laptop.yaml", "timer: off\n");
  const job = await applyAsJob(w, true);
  assert.equal(job.code, 0);
  assert.match(job.stdout, /^removed timer$/m);
  await until("the agent to be removed", () => !existsSync(plistPath(w.home)) && loadedPlist(w.home) === null);
  assert.deepEqual(sawAtBootout(w.home), ["gone"]);
});

test("a reload that cannot load the agent again is retried and logged, and the plist stays for the next login", async () => {
  const w = await loadedMac("30m");
  w.write("hosts/laptop.yaml", "timer: 10m\n");
  writeFileSync(join(w.home, "fake-launchctl-fail"), "");
  const job = await applyAsJob(w, true);
  assert.equal(job.code, 0, "the apply itself is not failed by the reload");
  await until("the retries to run out", () => lines(w.home, "launchctl").filter((c) => c[0] === "bootstrap").length >= 5);
  assert.equal(readFileSync(plistPath(w.home), "utf8"), plistFor("10m", w.home));
  rmSync(join(w.home, "fake-launchctl-fail"));
});

test("an apply from the LaunchAgent with nothing to change asks launchd nothing", async () => {
  const w = await loadedMac("30m");
  rmSync(join(w.home, "launchctl-calls.log"), { force: true });
  const job = await applyAsJob(w, true);
  assert.equal(job.code, 0);
  assert.deepEqual(lines(w.home, "launchctl"), []);
});

test("on Linux an apply run by fleet.service changes the timer without touching the running service", () => {
  const w = world({ host: "timer: 30m\n" });
  assert.equal(w.run("apply").code, EXIT.ok);
  w.write("hosts/laptop.yaml", "timer: 10m\n");
  rmSync(join(w.home, "systemctl-calls.log"));
  const r = runFleet(w.clone, ["apply"], { home: w.home, env: { INVOCATION_ID: "0123456789abcdef", JOURNAL_STREAM: "8:12345" } });
  assert.equal(r.code, EXIT.ok, r.stderr);
  const calls = lines(w.home, "systemctl").map((c) => c.join(" "));
  assert.ok(calls.every((c) => !c.includes("fleet.service")), `fleet.service is never named: ${calls.join("; ")}`);
  assert.ok(calls.every((c) => !/\b(stop|kill|disable)\b/.test(c)), `nothing is stopped: ${calls.join("; ")}`);
  assert.ok(existsSync(join(w.home, ".fake-timer-on")), "the timer is on when the apply ends");
  assert.equal(readFileSync(join(units(w.home), "fleet.timer"), "utf8"), `${SYSTEMD_TIMER("10m")}\n`);
});
