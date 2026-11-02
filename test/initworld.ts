import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { git, installFakeClaude, makeClone, makeHome, pinToHead, publish, runFleet, tempDir, writeExecutable } from "./helpers.ts";
import { EXIT } from "../src/exit.ts";
import { findTool } from "../src/tools.ts";

const SOPS = findTool("sops");
const AGE_KEYGEN = findTool("age-keygen");
if (SOPS === null || AGE_KEYGEN === null) throw new Error("these tests need sops and age-keygen on the probe path");

/** The two-machine world the `init` tests run in: an admin, a host, a fake `ssh`, and fakes for the tools that could reach the real machine. */
export const SERVICE = "[Service]\nType=oneshot\nExecStart=%h/.local/bin/fleet apply\n";
export const TIMER = "[Timer]\nOnBootSec=2min\nOnUnitActiveSec=30min\nPersistent=true\n[Install]\nWantedBy=timers.target\n";

/**
 * The fake `ssh` answers for one destination by running the command for real in a second
 * machine's HOME, with the bare environment a non-interactive login has: no FLEET_NODE, no fnm.
 */
export const FAKE_SSH = `
const fs = require("node:fs");
const cp = require("node:child_process");
const home = process.env.HOME;
const args = process.argv.slice(2);
fs.appendFileSync(home + "/ssh-calls.log", JSON.stringify(args) + "\\n");
fs.appendFileSync(home + "/order.log", "ssh " + args[args.length - 1] + "\\n---\\n");
const plans = JSON.parse(fs.readFileSync(home + "/fake-ssh.json", "utf8"));
const plan = plans[args[args.length - 2]] || { exit: 255, stderr: "ssh: Could not resolve hostname" };
if (plan.home) {
  const r = cp.spawnSync("sh", ["-c", args[args.length - 1]], {
    env: { HOME: plan.home, PATH: "/usr/bin:/bin", GIT_CONFIG_SYSTEM: "/dev/null", ...(plan.env || {}) },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  // What comes back over the wire is logged, so a test can see what crossed it.
  fs.appendFileSync(home + "/ssh-output.log", r.stdout + r.stderr);
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exit(r.status === null ? 1 : r.status);
}
if (plan.stderr) process.stderr.write(plan.stderr + "\\n");
process.exit(plan.exit === undefined ? 0 : plan.exit);
`;

/** Refuses the legacy verbs and any domain but `gui/<uid>`, and fails `bootstrap` of a loaded agent the way launchd does. */
export const FAKE_LAUNCHCTL = `
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

/** Logs each call, refuses anything that is not --user, and keeps "is the timer on" in a file. */
export const FAKE_SYSTEMCTL = `
const fs = require("node:fs");
const home = process.env.HOME;
const args = process.argv.slice(2);
fs.appendFileSync(home + "/systemctl-calls.log", JSON.stringify(args) + "\\n");
if (args[0] !== "--user") { process.stderr.write("fake systemctl: refusing a call without --user\\n"); process.exit(2); }
if (fs.existsSync(home + "/fake-systemctl-fail")) { process.stderr.write("Failed to connect to bus: No medium found\\n"); process.exit(1); }
const on = home + "/.fake-timer-on";
const [, verb, ...rest] = args;
if (verb === "daemon-reload") process.exit(0);
if (verb === "enable") { if (rest.includes("--now")) fs.writeFileSync(on, "1"); process.exit(0); }
if (verb === "is-active") process.exit(fs.existsSync(on) ? 0 : 3);
process.exit(2);
`;

export type Identity = { key: string; recipient: string };

export function newIdentity(): Identity {
  const key = spawnSync(AGE_KEYGEN!, [], { encoding: "utf8" }).stdout;
  const recipient = spawnSync(AGE_KEYGEN!, ["-y"], { encoding: "utf8", input: key }).stdout.trim();
  return { key, recipient };
}

export function installFake(home: string, name: string, script: string): void {
  const file = join(home, `.fake-${name}.js`);
  writeFileSync(file, script);
  writeExecutable(join(home, ".local/bin", name), `#!/bin/sh\nexec ${process.execPath} ${file} "$@"\n`);
}

/**
 * Everything a machine needs, in its own `~/.local/bin`, which is first on the probe path: real sops
 * and age-keygen, Node, and fakes for `claude`, `opencode`, `systemctl` and `launchctl`. The real ones are
 * on the path of the test run, so a machine without these fakes could change the host running the tests.
 * Its `uname -s` says Linux whatever the tests run on; a test makes a Mac on purpose.
 */
export function stock(home: string): void {
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  symlinkSync(SOPS!, join(home, ".local/bin/sops"));
  symlinkSync(AGE_KEYGEN!, join(home, ".local/bin/age-keygen"));
  symlinkSync(process.execPath, join(home, ".local/bin/node"));
  installFakeClaude(home);
  writeExecutable(join(home, ".local/bin/opencode"), "#!/bin/sh\nexit 0\n");
  installFake(home, "systemctl", FAKE_SYSTEMCTL);
  installFake(home, "launchctl", FAKE_LAUNCHCTL);
  writeExecutable(join(home, ".local/bin/uname"), `#!/bin/sh\nif [ "$1" = "-s" ]; then echo Linux; else exec /usr/bin/uname "$@"; fi\n`);
}

export const identityOf = (home: string): Identity => {
  const key = readFileSync(join(home, ".config/fleet/age.key"), "utf8");
  return { key, recipient: spawnSync(AGE_KEYGEN!, ["-y"], { encoding: "utf8", input: key }).stdout.trim() };
};
export const keyLine = (identity: Identity) => identity.key.split("\n").find((l) => l.startsWith("AGE-SECRET-KEY-"))!;

export type Setup = {
  /** `laptop` runs `init` on itself: fresh, with no key and no host name. Otherwise laptop is the initialised admin and `server` the new host. */
  local?: boolean;
  lab?: string;
  laptop?: string;
  /** Replaces the `ssh:` line of hosts/server.yaml. */
  labSsh?: string;
};

export function setup(o: Setup = {}) {
  const admin = newIdentity();
  const { clone, remote } = makeClone();
  const home = o.local ? makeHome() : makeHome("laptop");
  stock(home);
  installFake(home, "ssh", FAKE_SSH);
  if (!o.local) {
    mkdirSync(join(home, ".config/fleet"), { recursive: true });
    writeFileSync(join(home, ".config/fleet/age.key"), admin.key, { mode: 0o600 });
  }
  const lab = makeHome();
  stock(lab);
  writeFileSync(join(home, "fake-ssh.json"), JSON.stringify({ "alice@server": { home: lab } }));

  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(clone, rel)), { recursive: true });
    writeFileSync(join(clone, rel), content);
  };
  write("hosts/_defaults.yaml", "{}\n");
  write("hosts/laptop.yaml", `admin: true\nage: ${o.local ? '""' : admin.recipient}\n${o.laptop ?? ""}`);
  write("hosts/server.yaml", `${o.labSsh ?? "ssh: alice@server"}\nage: ""\n${o.lab ?? ""}`);
  publish(clone, "config");
  pinToHead(clone);

  const run = (args: string[] = ["server"], opts: { input?: string; env?: Record<string, string> } = {}) => runFleet(clone, ["init", ...args], { home, ...opts });
  const json = (args: string[] = ["server"]) => {
    const r = run([...args, "--json"]);
    return { r, doc: JSON.parse(r.stdout) };
  };
  const calls = (file: string, at: string) => {
    try {
      return readFileSync(join(at, file), "utf8").trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as string[]);
    } catch {
      return [];
    }
  };
  const sshCalls = () => calls("ssh-calls.log", home);
  const systemctl = (at: string = lab) => calls("systemctl-calls.log", at);
  const remoteHead = () => git(remote, "rev-parse", "main");
  const initCommits = (name = "server") => git(remote, "log", "--format=%s", "--grep", `fleet init ${name}`, "main").split("\n").filter((l) => l !== "").length;
  const labKey = join(lab, ".config/fleet/age.key");
  const units = join(lab, ".config/systemd/user");
  const timerOn = () => existsSync(join(lab, ".fake-timer-on"));
  const setSecret = (file: string, name: string, value: string) => {
    const r = runFleet(clone, ["secrets", "set", file, name], { home, input: `${value}\n` });
    assert.equal(r.code, EXIT.ok, r.stderr);
    publish(clone, `secret ${name}`);
  };
  const decrypt = (file: string, name: string, identity: Identity): string | null => {
    const keyPath = join(tempDir("fleet-key-"), "key");
    writeFileSync(keyPath, identity.key, { mode: 0o600 });
    const r = spawnSync(SOPS!, ["decrypt", "--extract", `["${name}"]`, join(clone, "secrets", `${file}.enc.yaml`)], { encoding: "utf8", env: { ...process.env, SOPS_AGE_KEY_FILE: keyPath } });
    return r.status === 0 ? r.stdout : null;
  };
  return { admin, clone, remote, home, lab, write, run, json, sshCalls, systemctl, remoteHead, initCommits, labKey, units, timerOn, setSecret, decrypt, read: (rel: string) => readFileSync(join(clone, rel), "utf8") };
}

export type S = ReturnType<typeof setup>;
