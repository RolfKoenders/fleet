import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, symlinkSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFake, setup } from "./initworld.ts";
import type { S } from "./initworld.ts";
import { installStatusTools, makeClone, makeHome, repoRoot, runFleet, writeExecutable } from "./helpers.ts";
import { EXIT } from "../src/exit.ts";
import { HOMEBREW_BIN, HOMEBREW_KEG_NODES, probeDirs, SHELL_NODE_CANDIDATES, SHELL_PROBE_PATH } from "../src/tools.ts";
import { LAUNCHD_LABEL, LAUNCHD_PLIST, macosVersionProblem, parseOs } from "../src/scheduler.ts";
import { LOG_KEEP, LOG_LIMIT, trimLog } from "../src/logtrim.ts";

/*
 * Nothing here runs on a Mac. A host is made to look like one with fakes in its `~/.local/bin`, which is
 * first on the probe path: `uname` says Darwin, `stat` is BSD's (it has no -c), and `launchctl` keeps the
 * state of one LaunchAgent in a file. They prove what fleet asks launchd, not what launchd does.
 */

const uid = process.getuid!();
const domain = `gui/${uid}`;
const service = `${domain}/${LAUNCHD_LABEL}`;

/** Refuses the legacy verbs and any domain but `gui/<uid>`, and fails `bootstrap` of a loaded agent the way launchd does. */
const FAKE_LAUNCHCTL = `
const fs = require("node:fs");
const home = process.env.HOME;
const args = process.argv.slice(2);
fs.appendFileSync(home + "/launchctl-calls.log", JSON.stringify(args) + "\\n");
const loaded = home + "/.fake-agent-loaded";
const [verb, target, plist] = args;
if (!["print", "bootstrap", "bootout"].includes(verb)) { process.stderr.write("fake launchctl: refusing " + verb + "\\n"); process.exit(2); }
if (!/^gui\\/\\d+(\\/|$)/.test(target)) { process.stderr.write("fake launchctl: refusing domain " + target + "\\n"); process.exit(2); }
const inDomain = target.split("/").length === 2;
if (verb === "print") {
  if (fs.existsSync(home + "/fake-no-session")) { process.stderr.write("Could not find domain for " + target + "\\n"); process.exit(113); }
  process.exit(inDomain || fs.existsSync(loaded) ? 0 : 113);
}
if (verb === "bootstrap") {
  if (fs.existsSync(home + "/fake-launchctl-fail")) { process.stderr.write("Bootstrap failed: 5: Input/output error\\n"); process.exit(5); }
  if (fs.existsSync(loaded)) { process.stderr.write("Bootstrap failed: 5: Input/output error\\n"); process.exit(5); }
  if (!fs.existsSync(plist)) { process.stderr.write("no such plist\\n"); process.exit(2); }
  fs.writeFileSync(loaded, fs.readFileSync(plist));
  process.exit(0);
}
if (verb === "bootout") { fs.rmSync(loaded, { force: true }); process.exit(0); }
`;

/** Makes `home` look like a Mac to the scripts `init` runs: BSD `stat`, `uname` and `launchctl`. */
function makeMac(home: string): void {
  installFake(home, "launchctl", FAKE_LAUNCHCTL);
  writeExecutable(join(home, ".local/bin/sw_vers"), `#!/bin/sh\nif [ "$1" = "-productVersion" ]; then cat "$HOME/fake-macos-version" 2>/dev/null || echo 14.5; else exit 1; fi\n`);
  writeExecutable(join(home, ".local/bin/uname"), `#!/bin/sh\nif [ "$1" = "-s" ]; then echo Darwin; else exec /usr/bin/uname "$@"; fi\n`);
  writeExecutable(
    join(home, ".local/bin/stat"),
    `#!/bin/sh
echo "$@" >> "$HOME/stat-calls.log"
case "$1" in
  -c) echo "stat: illegal option -- c" >&2; exit 1 ;;
  -f) [ "$2" = "%Lp" ] && { /usr/bin/stat -c %a "$3" 2>/dev/null || /usr/bin/stat -f %Lp "$3"; exit $?; }; exit 1 ;;
esac
exit 1
`,
  );
}

const lines = (file: string): string[][] => {
  try {
    return readFileSync(file, "utf8").trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as string[]);
  } catch {
    return [];
  }
};
const launchctl = (s: S) => lines(join(s.lab, "launchctl-calls.log"));
const plistPath = (s: S) => join(s.lab, LAUNCHD_PLIST);
const loaded = (s: S) => existsSync(join(s.lab, ".fake-agent-loaded"));

function mac(o: Parameters<typeof setup>[0] = {}): S {
  const s = setup(o);
  makeMac(s.lab);
  return s;
}

test("the OS of a host is read from `uname -s`, and only Linux and Darwin are known", () => {
  assert.equal(parseOs("Linux\n"), "linux");
  assert.equal(parseOs("Darwin\n"), "darwin");
  assert.equal(parseOs("FreeBSD"), null);
  assert.equal(parseOs(""), null);
});

test("a Mac host gets a LaunchAgent, loaded with bootstrap into gui/<uid>, and no systemd unit", () => {
  const s = mac();
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stdout, new RegExp(`${LAUNCHD_LABEL} runs 'fleet apply' at login and every 30 minutes`));
  assert.equal(loaded(s), true);
  assert.deepEqual(launchctl(s), [["print", domain], ["print", service], ["bootstrap", domain, plistPath(s)], ["print", service]]);
  assert.equal(existsSync(join(s.lab, ".config/systemd")), false, "no systemd units on a Mac");
  assert.deepEqual(s.systemctl(), [], "systemctl is not called on a Mac");
  assert.deepEqual(launchctl(s).filter(([verb]) => verb === "load" || verb === "unload"), []);
});

test("the agent runs fleet apply by absolute path, at load and on the half hour, and logs to ~/Library/Logs", () => {
  const s = mac();
  assert.equal(s.run().code, EXIT.ok);
  const plist = readFileSync(plistPath(s), "utf8");
  assert.ok(!plist.includes("$HOME") && !plist.includes("~"), "launchd expands neither, so the file holds real paths");
  assert.match(plist, new RegExp(`<key>Label</key>\\s*<string>${LAUNCHD_LABEL}</string>`));
  assert.ok(plist.includes(`<string>${s.lab}/.local/bin/fleet</string>\n    <string>apply</string>`));
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>StartCalendarInterval<\/key>/);
  assert.ok(!plist.includes("StartInterval"), "StartInterval drops the runs missed during sleep");
  assert.deepEqual([...plist.matchAll(/<key>Minute<\/key><integer>(\d+)<\/integer>/g)].map((m) => m[1]), ["0", "30"]);
  assert.ok(plist.includes(`<key>StandardOutPath</key>\n  <string>${s.lab}/Library/Logs/fleet.log</string>`));
  assert.match(plist, /\/opt\/homebrew\/bin:\/usr\/local\/bin/, "a LaunchAgent's PATH has no Homebrew");
  assert.ok(existsSync(join(s.lab, "Library/Logs")));
  assert.deepEqual(readdirSync(join(s.lab, "Library/LaunchAgents")), [`${LAUNCHD_LABEL}.plist`], "no .tmp file is left");
  // Only a Mac has plutil, so only a Mac runner (the CI job) checks the file against Apple's own parser.
  const plutil = "/usr/bin/plutil";
  if (existsSync(plutil)) assert.equal(spawnSync(plutil, ["-lint", plistPath(s)], { encoding: "utf8" }).status, 0);
});

test("a rerun on a loaded agent only asks launchd, and a changed file boots it out and in again", () => {
  const s = mac();
  assert.equal(s.run().code, EXIT.ok);
  rmSync(join(s.lab, "launchctl-calls.log"));
  assert.equal(s.run().code, EXIT.ok);
  assert.deepEqual(launchctl(s), [["print", domain], ["print", service]], "nothing to do: no bootstrap, which would fail on a loaded agent");

  rmSync(join(s.lab, "launchctl-calls.log"));
  writeFileSync(plistPath(s), "stale\n");
  assert.equal(s.run().code, EXIT.ok);
  assert.deepEqual(launchctl(s), [["print", domain], ["print", service], ["bootout", service], ["bootstrap", domain, plistPath(s)], ["print", service]]);
  assert.match(readFileSync(plistPath(s), "utf8"), /RunAtLoad/);
});

test("with no desktop login session the agent is written, init stops, and the message says to log in", () => {
  const s = mac();
  writeFileSync(join(s.lab, "fake-no-session"), "");
  const r = s.run();
  assert.equal(r.code, EXIT.error);
  assert.match(r.stderr, /no desktop login session/);
  assert.match(r.stderr, /fleet init server/);
  assert.equal(existsSync(plistPath(s)), true, "the file is there for the next login");
  assert.equal(loaded(s), false);
  assert.deepEqual(launchctl(s).map(([verb]) => verb), ["print"], "no bootstrap into a domain that is not there");

  rmSync(join(s.lab, "fake-no-session"));
  assert.equal(s.run().code, EXIT.ok, "the rerun finishes the job");
  assert.equal(loaded(s), true);
});

test("a failing launchctl exits 1 with its message, and the rerun finishes", () => {
  const s = mac();
  writeFileSync(join(s.lab, "fake-launchctl-fail"), "");
  const r = s.run();
  assert.equal(r.code, EXIT.error);
  assert.match(r.stderr, /launchctl failed/);
  rmSync(join(s.lab, "fake-launchctl-fail"));
  assert.equal(s.run().code, EXIT.ok);
  assert.equal(loaded(s), true);
});

test("the key's mode is read with BSD stat when stat has no -c", () => {
  const s = mac();
  assert.equal(s.run().code, EXIT.ok);
  const calls = readFileSync(join(s.lab, "stat-calls.log"), "utf8").trim().split("\n");
  assert.deepEqual(calls.slice(0, 2).map((c) => c.split(" ").slice(0, 2).join(" ")), ["-c %a", "-f %Lp"]);
  assert.equal(readFileSync(s.labKey, "utf8").includes("AGE-SECRET-KEY-"), true);
});

test("a Mac host with a sops that is too old gets a brew checklist, and nothing is changed there", () => {
  const s = mac();
  rmSync(join(s.lab, ".local/bin/sops"));
  writeExecutable(join(s.lab, ".local/bin/sops"), "#!/bin/sh\necho 'sops 3.0.0'\n");
  const { doc } = s.json();
  assert.equal(doc.code, "missing-prerequisite");
  const items = (doc.checklist as string[]).join("\n");
  assert.match(items, /brew install sops age/);
  assert.doesNotMatch(items, /pacman|apt/);
  assert.equal(existsSync(join(s.lab, ".config/systemd")) || existsSync(plistPath(s)), false, "nothing changed on the host");
});

test("a Linux host is unchanged: systemd, and the admin's OS does not matter", () => {
  const s = setup();
  makeMac(s.home); // the admin looks like a Mac; the host it sets up is Linux
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(existsSync(join(s.lab, ".config/systemd/user/fleet.timer")), true);
  assert.equal(existsSync(plistPath(s)), false);
  assert.deepEqual(launchctl(s), []);
});

test("a host that is neither Linux nor macOS is refused before anything is changed", () => {
  const s = setup();
  writeExecutable(join(s.lab, ".local/bin/uname"), `#!/bin/sh\nif [ "$1" = "-s" ]; then echo FreeBSD; else exec /usr/bin/uname "$@"; fi\n`);
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT["missing-prerequisite"]);
  assert.match((doc.checklist as string[]).join("\n"), /FreeBSD/);
  assert.equal(existsSync(join(s.lab, "fleet-config")), false);
});

test("status shows whether the LaunchAgent is loaded, asking launchctl about gui/<uid>/<label>", () => {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  installStatusTools(home);
  // No unit of either kind: systemd's answer, from the fake.
  assert.equal(JSON.parse(runFleet(clone, ["status", "--json"], { home }).stdout).timer, "active");

  writeFileSync(join(home, ".fake-launchctl.js"), `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HOME + "/launchctl-calls.log", JSON.stringify(args) + "\\n");
process.exit(fs.existsSync(process.env.HOME + "/.fake-agent-loaded") ? 0 : 113);
`);
  writeExecutable(join(home, ".local/bin/launchctl"), `#!/bin/sh\nexec ${process.execPath} ${join(home, ".fake-launchctl.js")} "$@"\n`);
  mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
  writeFileSync(join(home, LAUNCHD_PLIST), "<plist/>\n");

  const asked = () => JSON.parse(runFleet(clone, ["status", "--json"], { home }).stdout).timer;
  assert.equal(asked(), "inactive");
  writeFileSync(join(home, ".fake-agent-loaded"), "");
  assert.equal(asked(), "active");
  assert.deepEqual(lines(join(home, "launchctl-calls.log")).at(-1), ["print", service]);
});

test("the shell scripts and the TypeScript name the same Homebrew places", () => {
  const dirs = probeDirs("/h");
  assert.deepEqual(dirs, ["/h/.local/bin", "/h/.opencode/bin", "/usr/bin", "/usr/local/bin", HOMEBREW_BIN], "the Linux order is as it was, with Homebrew appended");
  assert.equal(SHELL_PROBE_PATH, "$HOME/.local/bin:$HOME/.opencode/bin:/usr/bin:/usr/local/bin:/opt/homebrew/bin");
  const wanted = [`${HOMEBREW_BIN}/node`, ...HOMEBREW_KEG_NODES];
  assert.deepEqual(SHELL_NODE_CANDIDATES, wanted.map((p) => `"${p}"`));
  for (const file of ["bin/fleet", "install.sh"]) {
    const text = readFileSync(join(repoRoot, file), "utf8");
    const at = text.indexOf('"$(command -v node 2>/dev/null || true)"');
    const tail = text.slice(at).split("\n").slice(1, wanted.length + 1).map((l) => l.trim().replace(/ \\$/, ""));
    assert.deepEqual(tail, wanted, `${file} tries the Homebrew Nodes after PATH`);
  }
});

test("the label is the reverse-DNS one, in the plist's name and its Label", () => {
  assert.equal(LAUNCHD_LABEL, "io.github.rolfkoenders.fleet.apply");
  assert.equal(LAUNCHD_PLIST, "Library/LaunchAgents/io.github.rolfkoenders.fleet.apply.plist");
});

test("macOS 12.3 is the oldest version accepted", () => {
  for (const ok of ["12.3", "12.3.1", "12.7.6", "13", "13.0", "14.5", "15.1.1", "26.0"]) assert.equal(macosVersionProblem(ok), null, ok);
  for (const old of ["12.2", "12.2.1", "12", "11.7.10", "10.15.7"]) assert.match(macosVersionProblem(old) ?? "", /needs 12\.3 or newer/, old);
  for (const bad of ["", "unknown", "12.x"]) assert.match(macosVersionProblem(bad) ?? "", /could not read/, bad);
});

test("init stops with missing-prerequisite on a Mac older than 12.3, and changes nothing", () => {
  for (const [version, message] of [["12.2.1", /macOS 12\.3 or newer: this host runs macOS 12\.2\.1/], ["", /could not read the macOS version/]] as const) {
    const s = mac();
    writeFileSync(join(s.lab, "fake-macos-version"), version);
    const { r, doc } = s.json();
    assert.equal(r.code, EXIT["missing-prerequisite"]);
    assert.match((doc.checklist as string[]).join("\n"), message);
    assert.equal(existsSync(plistPath(s)) || existsSync(join(s.lab, "fleet-config")), false, "nothing changed on the host");
    assert.deepEqual(launchctl(s), []);
  }
  const s = mac();
  writeFileSync(join(s.lab, "fake-macos-version"), "12.3\n");
  assert.equal(s.run().code, EXIT.ok, "12.3 itself is accepted");
});

test("a Linux host is never asked for a macOS version", () => {
  const s = setup();
  writeExecutable(join(s.lab, ".local/bin/sw_vers"), `#!/bin/sh\necho called >> "$HOME/sw_vers-calls.log"; echo 10.0\n`);
  assert.equal(s.run().code, EXIT.ok);
  assert.equal(existsSync(join(s.lab, "sw_vers-calls.log")), false);
});

const logIn = (home: string) => join(home, "Library/Logs/fleet.log");
function writeLog(home: string, bytes: number): string {
  mkdirSync(join(home, "Library/Logs"), { recursive: true });
  const text = Array.from({ length: Math.ceil(bytes / 20) }, (_, i) => `line ${String(i).padStart(14, "0")}\n`).join("").slice(0, bytes);
  writeFileSync(logIn(home), text);
  return text;
}

test("on macOS a log over 1 MB is cut to its last lines, in the same file", () => {
  const home = makeHome("laptop");
  const text = writeLog(home, LOG_LIMIT + 5000);
  const inode = statSync(logIn(home)).ino;
  assert.equal(trimLog(home, "darwin"), true);
  const after = readFileSync(logIn(home), "utf8");
  assert.equal(statSync(logIn(home)).ino, inode, "the inode stays, because launchd holds it open");
  assert.ok(after.length <= LOG_KEEP && after.length > LOG_KEEP - 100, `kept ${after.length}`);
  assert.ok(text.endsWith(after), "what is left is the end of the log");
  assert.match(after, /^line \d{14}\n/, "it starts at a whole line");
});

test("a descriptor that appends, like launchd's, writes at the new end after a trim", () => {
  const home = makeHome("laptop");
  writeLog(home, LOG_LIMIT + 10);
  const fd = openSync(logIn(home), "a");
  assert.equal(trimLog(home, "darwin"), true);
  writeSync(fd, "after trim\n");
  closeSync(fd);
  const after = readFileSync(logIn(home), "utf8");
  assert.ok(after.endsWith("after trim\n") && !after.includes("\0"));
});

test("a log at or under 1 MB, a missing log, and any other OS are left alone", () => {
  const home = makeHome("laptop");
  assert.equal(trimLog(home, "darwin"), false, "no file is not an error");
  const text = writeLog(home, LOG_LIMIT);
  assert.equal(trimLog(home, "darwin"), false);
  assert.equal(readFileSync(logIn(home), "utf8"), text);
  writeLog(home, LOG_LIMIT + 1000);
  assert.equal(trimLog(home, "linux"), false);
  assert.equal(statSync(logIn(home)).size, LOG_LIMIT + 1000);
});

test("apply on Linux does not touch a big ~/Library/Logs/fleet.log", () => {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  writeLog(home, LOG_LIMIT + 1000);
  runFleet(clone, ["apply", "--json"], { home });
  assert.equal(statSync(logIn(home)).size, LOG_LIMIT + 1000);
});

test("a symlinked log is not followed, and an unwritable one is skipped", () => {
  const home = makeHome("laptop");
  mkdirSync(join(home, "Library/Logs"), { recursive: true });
  const target = join(home, "elsewhere.log");
  writeFileSync(target, "x".repeat(LOG_LIMIT + 1000));
  symlinkSync(target, logIn(home));
  assert.equal(trimLog(home, "darwin"), false);
  assert.equal(statSync(target).size, LOG_LIMIT + 1000);
  rmSync(logIn(home));
  writeLog(home, LOG_LIMIT + 1000);
  chmodSync(logIn(home), 0o400);
  if (process.getuid?.() !== 0) assert.equal(trimLog(home, "darwin"), false);
  assert.equal(statSync(logIn(home)).size, LOG_LIMIT + 1000);
});

test("a log with no newline in its tail is kept whole from the cut", () => {
  const home = makeHome("laptop");
  mkdirSync(join(home, "Library/Logs"), { recursive: true });
  writeFileSync(logIn(home), "y".repeat(LOG_LIMIT + 1000));
  assert.equal(trimLog(home, "darwin"), true);
  assert.equal(statSync(logIn(home)).size, LOG_KEEP);
});
