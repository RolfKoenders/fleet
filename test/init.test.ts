import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { bareToolPath, skipIfSystemWide, git, installFakeClaude, makeClone, makeHome, pinText, pinToHead, publish, runFleet, tempDir, writeExecutable } from "./helpers.ts";
import { EXIT } from "../src/exit.ts";
import { findTool } from "../src/tools.ts";

const SOPS = findTool("sops");
const AGE_KEYGEN = findTool("age-keygen");
if (SOPS === null || AGE_KEYGEN === null) throw new Error("these tests need sops and age-keygen on the probe path");

const SERVICE = "[Service]\nType=oneshot\nExecStart=%h/.local/bin/fleet apply\n";
const TIMER = "[Timer]\nOnBootSec=2min\nOnUnitActiveSec=30min\nPersistent=true\n[Install]\nWantedBy=timers.target\n";

/**
 * The fake `ssh` answers for one destination by running the command for real in a second
 * machine's HOME, with the bare environment a non-interactive login has: no FLEET_NODE, no fnm.
 */
const FAKE_SSH = `
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

/** Logs each call, refuses anything that is not --user, and keeps "is the timer on" in a file. */
const FAKE_SYSTEMCTL = `
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

type Identity = { key: string; recipient: string };

function newIdentity(): Identity {
  const key = spawnSync(AGE_KEYGEN!, [], { encoding: "utf8" }).stdout;
  const recipient = spawnSync(AGE_KEYGEN!, ["-y"], { encoding: "utf8", input: key }).stdout.trim();
  return { key, recipient };
}

function installFake(home: string, name: string, script: string): void {
  const file = join(home, `.fake-${name}.js`);
  writeFileSync(file, script);
  writeExecutable(join(home, ".local/bin", name), `#!/bin/sh\nexec ${process.execPath} ${file} "$@"\n`);
}

/**
 * Everything a machine needs, in its own `~/.local/bin`, which is first on the probe path: real sops
 * and age-keygen, Node, and fakes for `claude`, `opencode` and `systemctl`. The real ones are on the
 * path of the test run, so a machine without these fakes could change the host running the tests.
 */
function stock(home: string): void {
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  symlinkSync(SOPS!, join(home, ".local/bin/sops"));
  symlinkSync(AGE_KEYGEN!, join(home, ".local/bin/age-keygen"));
  symlinkSync(process.execPath, join(home, ".local/bin/node"));
  installFakeClaude(home);
  writeExecutable(join(home, ".local/bin/opencode"), "#!/bin/sh\nexit 0\n");
  installFake(home, "systemctl", FAKE_SYSTEMCTL);
}

const identityOf = (home: string): Identity => {
  const key = readFileSync(join(home, ".config/fleet/age.key"), "utf8");
  return { key, recipient: spawnSync(AGE_KEYGEN!, ["-y"], { encoding: "utf8", input: key }).stdout.trim() };
};
const keyLine = (identity: Identity) => identity.key.split("\n").find((l) => l.startsWith("AGE-SECRET-KEY-"))!;

type Setup = {
  /** `laptop` runs `init` on itself: fresh, with no key and no host name. Otherwise laptop is the initialised admin and `server` the new host. */
  local?: boolean;
  lab?: string;
  laptop?: string;
  /** Replaces the `ssh:` line of hosts/server.yaml. */
  labSsh?: string;
};

function setup(o: Setup = {}) {
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

type S = ReturnType<typeof setup>;

/** The first apply picks something up only if the host has a file to link or a setting to write. */
const WITH_FILE = "files:\n  - { source: config/note.md, target: ~/.claude/note.md }\n";
const withNote = (s: S) => {
  s.write("config/note.md", "a note\n");
  publish(s.clone, "note");
};

function leaks(needle: string, dirs: string[], skip: (path: string) => boolean = () => false): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || skip(path)) continue;
      if (stat.isDirectory()) walk(path);
      else if (readFileSync(path).includes(needle)) found.push(path);
    }
  };
  for (const dir of dirs) walk(dir);
  return found;
}

test("on every machine the tools that could reach the real host are the fakes", () => {
  const s = setup();
  const bare = { PATH: "/usr/bin:/bin" };
  for (const [home, tools] of [[s.home, ["ssh", "systemctl", "claude", "opencode"]], [s.lab, ["systemctl", "claude", "opencode"]]] as const) {
    for (const tool of tools) {
      assert.equal(findTool(tool, bare, home), join(home, ".local/bin", tool), `${tool} in ${home} is the fake`);
    }
  }
  // The remote shell puts ~/.local/bin first too, so the same fakes answer there.
  for (const tool of ["systemctl", "claude", "opencode"]) {
    const r = spawnSync("sh", ["-c", `PATH="$HOME/.local/bin:$PATH"; command -v ${tool}`], { env: { HOME: s.lab, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    assert.equal(r.stdout.trim(), join(s.lab, ".local/bin", tool));
  }
});

test("init needs one host name that has a host file", () => {
  const s = setup();
  assert.equal(s.run([]).code, EXIT.invalid);
  assert.equal(s.run(["nowhere"]).code, EXIT.invalid);
  assert.equal(s.run(["../server"]).code, EXIT.invalid);
  assert.equal(s.run(["server", "extra"]).code, EXIT.invalid);
  assert.deepEqual(s.sshCalls(), []);
});

test("a remote host without an ssh destination, or with an option for one, exits 2 before any ssh call", () => {
  for (const labSsh of ["# no ssh destination", "ssh: -oProxyCommand=x"]) {
    const s = setup({ labSsh });
    const r = s.run();
    assert.equal(r.code, EXIT.invalid, r.stderr);
    assert.match(r.stderr, /ssh/);
    assert.deepEqual(s.sshCalls(), []);
  }
});

test("init for another host runs only from the admin host", () => {
  const s = setup();
  writeFileSync(join(s.home, ".config/fleet/host"), "server\n");
  const r = s.run();
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /admin host/);
  assert.deepEqual(s.sshCalls(), []);

  const fresh = setup({ local: true });
  const none = fresh.run(["server"]);
  assert.equal(none.code, EXIT.invalid);
  assert.match(none.stderr, /fleet init laptop/, "an admin that is not set up yet is told to run its own init first");
});

test("the admin's local form refuses a machine that already has another host's name", () => {
  const s = setup({ local: true });
  mkdirSync(join(s.home, ".config/fleet"), { recursive: true });
  writeFileSync(join(s.home, ".config/fleet/host"), "server\n");
  const r = s.run(["laptop"]);
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /server/);
  assert.equal(existsSync(join(s.home, ".config/fleet/age.key")), false);
});

test("an origin URL with a password in it is refused, so it never reaches another machine's argv", () => {
  const s = setup();
  git(s.clone, "remote", "set-url", "origin", "https://alice:hunter2-pw@example.invalid/fleet.git");
  const r = s.run();
  assert.equal(r.code, EXIT.invalid);
  assert.equal((r.stdout + r.stderr).includes("hunter2-pw"), false);
  assert.deepEqual(s.sshCalls(), []);
});

test("an unreachable host exits 4 and prints the SSH checklist item", () => {
  const s = setup();
  writeFileSync(join(s.home, "fake-ssh.json"), JSON.stringify({ "alice@server": { exit: 255, stderr: "ssh: connect to host server port 22: Connection timed out" } }));
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.unreachable, r.stderr);
  assert.equal(doc.code, "unreachable");
  assert.match(doc.checklist.join("\n"), /authorized_keys/);
  assert.equal(s.sshCalls().length, 1, "it stopped at the first call");
  assert.equal(s.remoteHead(), git(s.clone, "rev-parse", "HEAD"));
});

test("ssh is called with BatchMode and a connect timeout, and runs its command under sh", () => {
  const s = setup();
  s.run();
  const [first] = s.sshCalls();
  assert.deepEqual(first!.slice(0, 5), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "alice@server"]);
  assert.match(first![5]!, /^sh -c '/);
});

test("missing or old prerequisites exit 6 with a checklist, and nothing is changed on the host", { skip: skipIfSystemWide("sops", "age-keygen") }, () => {
  const s = setup();
  rmSync(join(s.lab, ".local/bin/sops"));
  rmSync(join(s.lab, ".local/bin/age-keygen"));
  // A Node that cannot strip types stands in for a missing one: it shadows any Node the machine has
  // at a system path (the probe path puts `~/.local/bin` first), so the result does not depend on the machine.
  rmSync(join(s.lab, ".local/bin/node"));
  writeExecutable(join(s.lab, ".local/bin/node"), "#!/bin/sh\nexit 1\n");
  rmSync(join(s.lab, ".local/bin/claude"));
  rmSync(join(s.lab, ".local/bin/opencode"));
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT["missing-prerequisite"], r.stderr);
  assert.equal(doc.code, "missing-prerequisite");
  const list = doc.checklist.join("\n");
  for (const what of [/Node/, /sops/, /age-keygen/]) assert.match(list, what);
  assert.doesNotMatch(list, /claude|opencode/);
  assert.equal(existsSync(join(s.lab, "fleet-config")), false, "no clone");
  assert.equal(existsSync(join(s.lab, ".config")), false, "no key, no host name");
  assert.equal(existsSync(join(s.lab, ".config/systemd")), false);
  assert.equal(s.initCommits(), 0);
  assert.equal(s.systemctl().length, 0);
  assert.equal(s.sshCalls().length, 1);
});

test("a Node on the system PATH is enough, even with none in ~/.local/bin", () => {
  const s = setup();
  rmSync(join(s.lab, ".local/bin/node"));
  const system = tempDir("fleet-system-");
  symlinkSync(process.execPath, join(system, "node"));
  writeFileSync(join(s.home, "fake-ssh.json"), JSON.stringify({ "alice@server": { home: s.lab, env: { PATH: `/usr/bin:/bin:${system}` } } }));
  const { doc } = s.json();
  assert.doesNotMatch((doc.checklist ?? []).join("\n"), /Node/);
});

test("a sops older than 3.11 is a missing prerequisite", () => {
  const s = setup();
  rmSync(join(s.lab, ".local/bin/sops"));
  writeExecutable(join(s.lab, ".local/bin/sops"), "#!/bin/sh\necho 'sops 3.10.2 (latest)'\n");
  const r = s.run();
  assert.equal(r.code, 6);
  assert.match(r.stdout, /sops.*3\.10\.2.*3\.11/s);
});

test("a repository the host cannot reach is a missing prerequisite (git and GitHub)", () => {
  const s = setup();
  git(s.clone, "remote", "set-url", "origin", "/nonexistent/fleet.git");
  const r = s.run();
  assert.equal(r.code, 6, r.stderr);
  assert.match(r.stdout, /git/i);
  assert.equal(existsSync(join(s.lab, "fleet-config")), false);
});

test("a host that can read the repository but not push exits 6 and keeps its clone for the rerun", () => {
  const s = setup();
  // Pushes go somewhere that does not exist; reads still work.
  writeFileSync(join(s.lab, ".gitconfig"), `[url "/nonexistent/"]\n\tpushInsteadOf = ${s.remote}\n`);
  const r = s.run();
  assert.equal(r.code, 6, r.stderr);
  assert.match(r.stdout, /push/i);
  assert.equal(existsSync(s.labKey), false, "stopped before the key");
  rmSync(join(s.lab, ".gitconfig"));
  assert.equal(s.run().code, EXIT.ok);
});

test("a host with neither agent tool still finishes, with a warning", { skip: skipIfSystemWide("claude", "opencode") }, () => {
  const s = setup();
  rmSync(join(s.lab, ".local/bin/claude"));
  rmSync(join(s.lab, ".local/bin/opencode"));
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stderr, /neither Claude Code nor opencode/);
});

test("one agent tool is enough, and gets no warning", { skip: skipIfSystemWide("opencode") }, () => {
  const s = setup();
  rmSync(join(s.lab, ".local/bin/opencode"));
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.doesNotMatch(r.stderr, /neither/);
});

test("a fresh host is brought up in order", () => {
  const s = setup({ lab: WITH_FILE });
  withNote(s);
  writeExecutable(join(s.remote, "hooks/post-receive"), `#!/bin/sh\necho "push" >> ${join(s.home, "order.log")}\necho --- >> ${join(s.home, "order.log")}\n`);
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(doc.code, "ok");
  const label = (entry: string) => (entry === "push" ? "push" : /# fleet init: ([a-z-]+)/.exec(entry)?.[1] ?? `?? ${entry.slice(0, 40)}`);
  const events = readFileSync(join(s.home, "order.log"), "utf8").split("---\n").filter((e) => e.trim() !== "").map((e) => label(e.trim()));
  assert.deepEqual(events, ["prerequisites", "clone", "key", "push", "pull-and-link", "apply", "timer"]);
  assert.deepEqual(doc.steps.map((st: { name: string; state: string }) => [st.name, st.state]), [
    ["prerequisites", "unchanged"], ["clone", "done"], ["key", "done"], ["recipient", "done"], ["pull-and-link", "done"], ["secrets", "unchanged"], ["apply", "done"], ["timer", "done"],
  ]);
});

test("a finished host is cloned, named, linked, applied and on the timer", () => {
  const s = setup({ lab: WITH_FILE });
  withNote(s);
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(git(join(s.lab, "fleet-config"), "rev-parse", "HEAD"), s.remoteHead(), "the clone has the commit that records its recipient");
  assert.equal(readFileSync(join(s.lab, ".config/fleet/host"), "utf8"), "server\n");
  assert.equal(readlinkSync(join(s.lab, ".local/bin/fleet")), join(s.lab, ".local/share/fleet/fleet/bin/fleet"));
  assert.equal(readlinkSync(join(s.lab, ".claude/note.md")), join(s.lab, "fleet-config/config/note.md"), "the first apply ran");
  assert.equal(JSON.parse(readFileSync(join(s.lab, ".local/state/fleet/applied.json"), "utf8")).host, "server");
  assert.equal(s.timerOn(), true);
  assert.equal(existsSync(join(s.home, ".config/systemd")), false, "nothing was installed on the admin");
  assert.deepEqual(s.systemctl(s.home), []);
});

test("a new host gets both repos: the config in ~/fleet-config and the tool at the pin, detached", () => {
  const s = setup({ lab: WITH_FILE });
  withNote(s);
  const pinned = /^  commit: (\S+)$/m.exec(s.read("fleet.yaml"))![1]!;
  assert.notEqual(pinned, s.remoteHead(), "the pin is an earlier commit than the config's head, so the two clones differ");
  assert.equal(s.run().code, EXIT.ok);
  const config = join(s.lab, "fleet-config");
  const tool = join(s.lab, ".local/share/fleet/fleet");
  assert.equal(git(config, "remote", "get-url", "origin"), s.remote);
  assert.equal(git(tool, "remote", "get-url", "origin"), s.remote, "the tool's URL is the pin's repo");
  assert.equal(git(tool, "rev-parse", "HEAD"), pinned);
  assert.equal(git(tool, "branch", "--show-current"), "", "detached at the pin");
  assert.equal(readFileSync(join(s.lab, ".config/fleet/config"), "utf8"), `${config}\n`);
});

test("the config repo's path is what the host's own fleet reads: its first apply used it", () => {
  const s = setup({ lab: WITH_FILE });
  withNote(s);
  assert.equal(s.run().code, EXIT.ok);
  const r = spawnSync(join(s.lab, ".local/bin/fleet"), ["status", "--json"], { encoding: "utf8", env: { HOME: s.lab, PATH: "/usr/bin:/bin", FLEET_NODE: process.execPath } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).pending, 0);
});

test("a tool repo the host cannot reach is a missing prerequisite, named in the checklist", () => {
  const s = setup();
  writeFileSync(join(s.clone, "fleet.yaml"), pinText("/nonexistent/tool.git", "a".repeat(40)));
  publish(s.clone, "unreachable tool");
  const { r, doc } = s.json();
  assert.equal(r.code, 6, r.stderr);
  assert.match(doc.checklist.join("\n"), /tool at \/nonexistent\/tool\.git/);
  assert.doesNotMatch(doc.checklist.join("\n"), /git and GitHub/, "the config repo itself was fine");
  assert.equal(existsSync(join(s.lab, "fleet-config")), false);
});

test("a pin that is missing or has a password in the tool URL exits 2 before any ssh call", () => {
  for (const text of [null, pinText("https://u:hunter2-pw@example.invalid/fleet.git", "a".repeat(40))]) {
    const s = setup();
    if (text === null) rmSync(join(s.clone, "fleet.yaml"));
    else writeFileSync(join(s.clone, "fleet.yaml"), text);
    publish(s.clone, "bad pin");
    const r = s.run();
    assert.equal(r.code, EXIT.invalid, r.stderr);
    assert.doesNotMatch(r.stderr + r.stdout, /hunter2/);
    assert.deepEqual(s.sshCalls(), []);
  }
});

test("a pinned commit the tool repo does not have exits 2 at the move, with the host's clone left alone", () => {
  const s = setup();
  writeFileSync(join(s.clone, "fleet.yaml"), pinText(s.remote, "b".repeat(40)));
  publish(s.clone, "pin a commit that does not exist");
  const r = s.run();
  assert.equal(r.code, EXIT.invalid, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /pinned tool commit b{40} is not in/);
  assert.equal(existsSync(join(s.lab, ".local/bin/fleet")), false, "it stopped before the link");
});

test("a tool URL with shell syntax in it is quoted in the host's script, not run", () => {
  const s = setup();
  // A real, readable repo whose path holds $(...); the pinned commit is missing, which is what makes the pull-and-link step print the URL.
  const evil = join(tempDir("fleet-evil-"), "tool$(printf INJECTED).git");
  git(dirname(evil), "clone", "--quiet", "--bare", s.remote, evil);
  writeFileSync(join(s.clone, "fleet.yaml"), pinText(evil, "b".repeat(40)));
  publish(s.clone, "pin a missing commit in an odd repo");
  const r = s.run();
  assert.equal(r.code, EXIT.invalid, `${r.stdout}${r.stderr}`);
  assert.ok(r.stderr.includes("tool$(printf INJECTED).git"), `the URL is printed as written: ${r.stderr}`);
  assert.equal(r.stderr.includes("toolINJECTED"), false);
});

test("a fleet clone with work in it on the new host is a conflict at the move", () => {
  const s = setup();
  assert.equal(s.run().code, EXIT.ok);
  const tool = join(s.lab, ".local/share/fleet/fleet");
  const pinned = git(tool, "rev-parse", "HEAD");
  git(tool, "checkout", "--quiet", "main");
  writeFileSync(join(tool, "scratch.txt"), "half done");
  const r = s.run();
  assert.equal(r.code, EXIT.conflict, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /uncommitted changes/);
  assert.notEqual(git(tool, "rev-parse", "HEAD"), pinned, "left where it was");
});

test("running init again changes nothing", () => {
  const s = setup({ lab: WITH_FILE });
  withNote(s);
  assert.equal(s.run().code, EXIT.ok);
  const key = readFileSync(s.labKey);
  const head = s.remoteHead();
  const unit = readFileSync(join(s.units, "fleet.service"));
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(s.remoteHead(), head, "no new commit");
  assert.deepEqual(readFileSync(s.labKey), key);
  assert.deepEqual(readFileSync(join(s.units, "fleet.service")), unit);
  assert.equal(s.initCommits(), 1);
  assert.deepEqual(s.systemctl().slice(4), [["--user", "is-active", "--quiet", "fleet.timer"]], "a timer that is already on is only asked, not enabled again");
  const { doc } = s.json();
  assert.deepEqual(doc.steps.map((st: { state: string }) => st.state), ["unchanged", "unchanged", "unchanged", "unchanged", "unchanged", "unchanged", "unchanged", "unchanged"]);
});

test("a new key is mode 600 in a private directory, and its recipient is in the host file, .sops.yaml and the push", () => {
  const s = setup();
  assert.equal(s.run().code, EXIT.ok);
  assert.equal(statSync(s.labKey).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(s.labKey)).mode & 0o077, 0, "the directory is private");
  const lab = identityOf(s.lab);
  assert.match(lab.recipient, /^age1/);
  assert.match(s.read("hosts/server.yaml"), new RegExp(`^age: ${lab.recipient}$`, "m"));
  assert.match(s.read("hosts/server.yaml"), /^ssh: alice@server$/m, "the rest of the file is as it was");
  assert.match(s.read(".sops.yaml"), new RegExp(lab.recipient));
  assert.match(git(s.remote, "show", "main:hosts/server.yaml"), new RegExp(`age: ${lab.recipient}`));
  assert.match(git(s.remote, "show", "main:.sops.yaml"), new RegExp(lab.recipient));
  assert.equal(readdirSync(dirname(s.labKey)).sort().join(), "age.key,config,host", "no temporary file is left behind");
  assert.equal(s.initCommits(), 1);
  assert.equal(git(s.clone, "status", "--porcelain"), "");
});

test("the recipient reaches the secrets files that were already encrypted", () => {
  const s = setup();
  s.setSecret("shared", "SHARED_TOKEN", "mock-shared-1");
  assert.equal(s.decrypt("shared", "SHARED_TOKEN", s.admin), "mock-shared-1");
  assert.equal(s.run().code, EXIT.ok);
  const lab = identityOf(s.lab);
  assert.equal(s.decrypt("shared", "SHARED_TOKEN", lab), "mock-shared-1", "the new host can read shared");
  assert.equal(s.decrypt("shared", "SHARED_TOKEN", s.admin), "mock-shared-1", "the admin still can");
  assert.match(git(s.remote, "show", "main:secrets/shared.enc.yaml"), new RegExp(lab.recipient));
});

test("an existing key is never replaced, and its recipient is what gets recorded", () => {
  const s = setup();
  const existing = newIdentity();
  mkdirSync(dirname(s.labKey), { recursive: true });
  writeFileSync(s.labKey, existing.key, { mode: 0o600 });
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(readFileSync(s.labKey, "utf8"), existing.key, "byte for byte");
  assert.match(s.read("hosts/server.yaml"), new RegExp(`^age: ${existing.recipient}$`, "m"));
  assert.equal(s.run().code, EXIT.ok);
  assert.equal(readFileSync(s.labKey, "utf8"), existing.key, "and after a second run");
});

test("an existing key that matches the recorded recipient makes the key and recipient steps no-ops", () => {
  const s = setup();
  const existing = newIdentity();
  mkdirSync(dirname(s.labKey), { recursive: true });
  writeFileSync(s.labKey, existing.key, { mode: 0o600 });
  s.write("hosts/server.yaml", `ssh: alice@server\nage: ${existing.recipient}\n`);
  assert.equal(runFleet(s.clone, ["secrets", "rekey"], { home: s.home }).code, EXIT.ok);
  publish(s.clone, "server has its recipient");
  const head = s.remoteHead();
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(s.remoteHead(), head, "nothing committed or pushed");
  assert.equal(doc.steps.find((st: { name: string }) => st.name === "key").state, "unchanged");
  assert.equal(doc.steps.find((st: { name: string }) => st.name === "recipient").state, "unchanged");
  assert.equal(readFileSync(s.labKey, "utf8"), existing.key);
});

test("an existing key that differs from the host file's recipient wins, and the old recipient is rekeyed out", () => {
  const s = setup();
  const stale = newIdentity();
  const existing = newIdentity();
  s.write("hosts/server.yaml", `ssh: alice@server\nage: ${stale.recipient}  # from an old install\n`);
  publish(s.clone, "stale recipient");
  s.setSecret("shared", "SHARED_TOKEN", "mock-shared-2");
  assert.equal(s.decrypt("shared", "SHARED_TOKEN", stale), "mock-shared-2");
  mkdirSync(dirname(s.labKey), { recursive: true });
  writeFileSync(s.labKey, existing.key, { mode: 0o600 });
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(s.read("hosts/server.yaml"), new RegExp(`^age: ${existing.recipient}  # from an old install$`, "m"));
  assert.equal(s.decrypt("shared", "SHARED_TOKEN", existing), "mock-shared-2");
  assert.equal(s.decrypt("shared", "SHARED_TOKEN", stale), null);
  assert.match(r.stderr, /replaced.*recipient/i);
});

test("an existing key file that is not an age key stops init and is left alone", () => {
  const s = setup();
  mkdirSync(dirname(s.labKey), { recursive: true });
  writeFileSync(s.labKey, "not a key\n", { mode: 0o600 });
  const r = s.run();
  assert.equal(r.code, EXIT.error);
  assert.match(r.stderr, /age\.key/);
  assert.equal(readFileSync(s.labKey, "utf8"), "not a key\n");
  assert.equal(s.initCommits(), 0);
});

test("an existing key that others can read is kept as it is, with a warning", () => {
  const s = setup();
  const existing = newIdentity();
  mkdirSync(dirname(s.labKey), { recursive: true });
  writeFileSync(s.labKey, existing.key);
  chmodSync(s.labKey, 0o644);
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stderr, /644/);
  assert.equal(readFileSync(s.labKey, "utf8"), existing.key);
});

test("a host file whose age cannot be edited in place exits 2 before anything is committed", () => {
  const s = setup();
  s.write("hosts/server.yaml", "{ ssh: alice@server, age: '' }\n");
  publish(s.clone, "flow style");
  const r = s.run();
  assert.equal(r.code, EXIT.invalid, r.stderr);
  assert.match(r.stderr, /age/);
  assert.equal(s.initCommits(), 0);
});

test("only the files init changes are committed, not the admin's other work", () => {
  const s = setup();
  s.write("notes.md", "unrelated work in progress\n");
  assert.equal(s.run().code, EXIT.ok);
  assert.equal(git(s.clone, "status", "--porcelain"), "?? notes.md");
  assert.equal(git(s.remote, "show", "--stat", "--format=", "main").includes("notes.md"), false);
});

test("an admin clone that has diverged from GitHub exits 3 and the host gets no half-set-up recipient", () => {
  const s = setup();
  const other = join(tempDir("fleet-elsewhere-"), "w");
  git(tempDir("fleet-elsewhere-"), "clone", "--quiet", s.remote, other);
  writeFileSync(join(other, "theirs.md"), "1");
  git(other, "add", "-A");
  git(other, "commit", "-m", "theirs");
  git(other, "push", "--quiet");
  const r = s.run();
  assert.equal(r.code, EXIT.conflict, r.stderr);
  assert.match(r.stderr + r.stdout, /diverged/);
  assert.equal(existsSync(join(s.lab, ".local/bin/fleet")), false, "it stopped before the link");
  assert.equal(s.timerOn(), false);
});

test("missing secrets stop before the first apply with exit 5 and their names", () => {
  const s = setup({ lab: 'settings:\n  claude:\n    apiToken: "secret:ALICE_TOKEN"\n    other: "Bearer secret:SHARED_TOKEN"\n' });
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT["needs-secret"], r.stderr);
  assert.equal(doc.code, "needs-secret");
  assert.deepEqual(doc.missingSecrets, ["ALICE_TOKEN", "SHARED_TOKEN"]);
  assert.match(r.stderr, /ALICE_TOKEN/);
  assert.equal(existsSync(join(s.lab, ".local/state/fleet/applied.json")), false, "no apply");
  assert.equal(existsSync(join(s.lab, ".claude/settings.json")), false);
  assert.deepEqual(s.systemctl(), [], "no timer");
  assert.equal(existsSync(s.units), false);
  // Everything before it is done, so the rerun only has the rest to do.
  assert.equal(readFileSync(join(s.lab, ".config/fleet/host"), "utf8"), "server\n");
  assert.ok(existsSync(join(s.lab, ".local/bin/fleet")));
  assert.equal(doc.steps.at(-1).name, "secrets");
  assert.equal(doc.steps.at(-1).state, "failed");

  s.setSecret("server", "ALICE_TOKEN", "mock-alice-token");
  const partly = s.json();
  assert.equal(partly.r.code, 5);
  assert.deepEqual(partly.doc.missingSecrets, ["SHARED_TOKEN"], "only what is still missing");
  s.setSecret("shared", "SHARED_TOKEN", "mock-shared-token");
  const done = s.run();
  assert.equal(done.code, EXIT.ok, done.stderr);
  const settings = JSON.parse(readFileSync(join(s.lab, ".claude/settings.json"), "utf8"));
  assert.equal(settings.apiToken, "mock-alice-token", "the host decrypted it with its own key");
  assert.equal(settings.other, "Bearer mock-shared-token");
  assert.equal(s.timerOn(), true);
});

test("secrets that are set count even in the shared file, and a host that needs none goes straight on", () => {
  const s = setup({ lab: 'settings:\n  claude:\n    apiToken: "secret:SHARED_TOKEN"\n' });
  s.setSecret("shared", "SHARED_TOKEN", "mock-shared-3");
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
});

test("a conflict on the first apply exits 3, names it, and leaves the timer off", () => {
  const s = setup({ lab: WITH_FILE });
  withNote(s);
  mkdirSync(join(s.lab, ".claude"), { recursive: true });
  writeFileSync(join(s.lab, ".claude/note.md"), "mine, not fleet's\n");
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.conflict, r.stderr);
  assert.equal(doc.code, "conflict");
  assert.equal(doc.conflicts.length, 1);
  assert.match(doc.conflicts[0].path, /note\.md/);
  assert.equal(s.timerOn(), false);
  assert.deepEqual(s.systemctl(), []);
  assert.equal(existsSync(s.units), false, "no unit file either");
  assert.equal(readFileSync(join(s.lab, ".claude/note.md"), "utf8"), "mine, not fleet's\n", "nothing overwritten");
  assert.ok(existsSync(join(s.lab, ".local/bin/fleet")), "the steps before it stay done");
  const text = s.run().stdout;
  assert.match(text, /note\.md/);
  assert.match(text, /fix:/);

  rmSync(join(s.lab, ".claude/note.md"));
  const again = s.run();
  assert.equal(again.code, EXIT.ok, again.stderr);
  assert.equal(s.timerOn(), true);
});

test("a config that does not validate exits 2 and leaves the timer off", () => {
  const s = setup();
  s.write("hosts/_defaults.yaml", "files:\n  - { source: missing.md, target: ~/.claude/x.md }\n");
  publish(s.clone, "broken");
  const r = s.run();
  assert.equal(r.code, EXIT.invalid, r.stderr);
  assert.equal(s.timerOn(), false);
});

test("the units are fixed, and systemctl is only ever called with --user", () => {
  const s = setup();
  assert.equal(s.run().code, EXIT.ok);
  assert.equal(readFileSync(join(s.units, "fleet.service"), "utf8"), SERVICE);
  assert.equal(readFileSync(join(s.units, "fleet.timer"), "utf8"), TIMER);
  assert.deepEqual(s.systemctl(), [
    ["--user", "is-active", "--quiet", "fleet.timer"],
    ["--user", "daemon-reload"],
    ["--user", "enable", "--now", "fleet.timer"],
    ["--user", "is-active", "--quiet", "fleet.timer"],
  ]);
  assert.deepEqual(readdirSync(s.units).sort(), ["fleet.service", "fleet.timer"]);
  assert.equal(s.timerOn(), true);
});

test("the service runs under systemd's bare environment, with no fnm and no ~/.profile", () => {
  const s = setup({ lab: WITH_FILE });
  withNote(s);
  assert.equal(s.run().code, EXIT.ok);
  // The PATH holds the wrapper's own tools and nothing else, so no Node the machine has (at /usr/bin, /usr/local/bin) can be found by it.
  const bare = { HOME: s.lab, PATH: bareToolPath() };
  assert.notEqual(spawnSync("sh", ["-c", "command -v node"], { env: bare }).status, 0, "precondition: no Node on that PATH, so only the wrapper's own search can find it");
  const exec = /^ExecStart=(.*)$/m.exec(readFileSync(join(s.units, "fleet.service"), "utf8"))![1]!.replaceAll("%h", s.lab).split(" ");
  const r = spawnSync(exec[0]!, exec.slice(1), { env: bare, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /nothing to do/);
  // It really ran: remove what the first apply made and the service puts it back.
  rmSync(join(s.lab, ".claude/note.md"));
  const again = spawnSync(exec[0]!, exec.slice(1), { env: bare, encoding: "utf8" });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readlinkSync(join(s.lab, ".claude/note.md")), join(s.lab, "fleet-config/config/note.md"));
});

test("a failing systemctl exits 1, and the rerun finishes the job without duplicating anything", () => {
  const s = setup();
  writeFileSync(join(s.lab, "fake-systemctl-fail"), "");
  const r = s.run();
  assert.equal(r.code, EXIT.error, r.stderr);
  assert.match(r.stderr, /systemctl/);
  assert.equal(s.timerOn(), false);
  rmSync(join(s.lab, "fake-systemctl-fail"));
  assert.equal(s.run().code, EXIT.ok);
  assert.equal(s.timerOn(), true);
  assert.equal(s.initCommits(), 1);
});

type Break = { step: string; code: number; lab?: string; skip?: string | false; fail: (s: S) => void; repair: (s: S) => void };

const breaks: Break[] = [
  {
    step: "1 prerequisites",
    code: 6,
    skip: skipIfSystemWide("sops"),
    fail: (s) => rmSync(join(s.lab, ".local/bin/sops")),
    repair: (s) => symlinkSync(SOPS!, join(s.lab, ".local/bin/sops")),
  },
  {
    step: "2 clone",
    code: EXIT.error,
    fail: (s) => writeFileSync(join(s.lab, "fleet-config"), "in the way"),
    repair: (s) => rmSync(join(s.lab, "fleet-config")),
  },
  {
    step: "3 key",
    code: EXIT.error,
    fail: (s) => {
      const real = join(s.lab, ".local/bin/age-keygen");
      rmSync(real);
      writeExecutable(real, `#!/bin/sh\n[ -e "$HOME/age-fails" ] && { echo 'age-keygen: boom' >&2; exit 1; }\nexec ${AGE_KEYGEN} "$@"\n`);
      writeFileSync(join(s.lab, "age-fails"), "");
    },
    repair: (s) => rmSync(join(s.lab, "age-fails")),
  },
  {
    step: "4 recipient",
    code: EXIT.unreachable,
    fail: (s) => writeExecutable(join(s.remote, "hooks/pre-receive"), "#!/bin/sh\necho 'rejected by the test' >&2\nexit 1\n"),
    repair: (s) => rmSync(join(s.remote, "hooks/pre-receive")),
  },
  {
    step: "5 pull, host name, link",
    code: EXIT.conflict,
    fail: (s) => {
      mkdirSync(join(s.lab, ".local/bin"), { recursive: true });
      writeFileSync(join(s.lab, ".local/bin/fleet"), "#!/bin/sh\necho my own fleet\n");
    },
    repair: (s) => rmSync(join(s.lab, ".local/bin/fleet")),
  },
  {
    step: "5 host name",
    code: EXIT.error,
    fail: (s) => {
      mkdirSync(join(s.lab, ".config/fleet"), { recursive: true });
      writeFileSync(join(s.lab, ".config/fleet/host"), "elsewhere\n");
    },
    repair: (s) => writeFileSync(join(s.lab, ".config/fleet/host"), "server\n"),
  },
  {
    step: "2 tool clone",
    code: EXIT.error,
    fail: (s) => {
      mkdirSync(join(s.lab, ".local/share/fleet"), { recursive: true });
      writeFileSync(join(s.lab, ".local/share/fleet/fleet"), "in the way");
    },
    repair: (s) => rmSync(join(s.lab, ".local/share/fleet/fleet")),
  },
  {
    step: "5 config file",
    code: EXIT.error,
    fail: (s) => {
      mkdirSync(join(s.lab, ".config/fleet"), { recursive: true });
      writeFileSync(join(s.lab, ".config/fleet/config"), "/somewhere/else\n");
    },
    repair: (s) => writeFileSync(join(s.lab, ".config/fleet/config"), `${join(s.lab, "fleet-config")}\n`),
  },
  {
    step: "6 secrets",
    code: 5,
    lab: `${WITH_FILE}settings:\n  claude:\n    apiToken: "secret:ALICE_TOKEN"\n`,
    fail: () => {},
    repair: (s) => s.setSecret("server", "ALICE_TOKEN", "mock-alice-token"),
  },
  {
    step: "7 first apply",
    code: EXIT.conflict,
    fail: (s) => {
      mkdirSync(join(s.lab, ".claude"), { recursive: true });
      writeFileSync(join(s.lab, ".claude/note.md"), "in the way");
    },
    repair: (s) => rmSync(join(s.lab, ".claude/note.md")),
  },
  {
    step: "8 timer",
    code: EXIT.error,
    fail: (s) => writeFileSync(join(s.lab, "fake-systemctl-fail"), ""),
    repair: (s) => rmSync(join(s.lab, "fake-systemctl-fail")),
  },
];

for (const b of breaks) {
  test(`init fails at step ${b.step} and the rerun after the repair finishes the job`, { skip: b.skip }, () => {
    const s = setup({ lab: b.lab ?? WITH_FILE });
    withNote(s);
    b.fail(s);
    // A pre-existing key proves, at every step, that a failed run never replaces one.
    const existing = newIdentity();
    if (b.step !== "3 key" && b.step !== "1 prerequisites" && b.step !== "2 clone") {
      mkdirSync(dirname(s.labKey), { recursive: true });
      writeFileSync(s.labKey, existing.key, { mode: 0o600 });
    }
    const failed = s.run();
    assert.equal(failed.code, b.code, `${failed.stdout}${failed.stderr}`);
    assert.equal(s.timerOn(), false, "the timer is not on after a failure");
    assert.ok(s.initCommits() <= 1);

    b.repair(s);
    const again = s.run();
    assert.equal(again.code, EXIT.ok, `${again.stdout}${again.stderr}`);
    assert.equal(s.initCommits(), 1, "one commit for the recipient, however many runs");
    assert.equal(s.timerOn(), true);
    assert.equal(identityOf(s.lab).recipient, /^age: (\S+)/m.exec(s.read("hosts/server.yaml"))![1]);
    assert.equal(readFileSync(join(s.units, "fleet.service"), "utf8"), SERVICE);
    assert.equal(readFileSync(join(s.lab, ".config/fleet/host"), "utf8"), "server\n");
    assert.equal(readlinkSync(join(s.lab, ".local/bin/fleet")), join(s.lab, ".local/share/fleet/fleet/bin/fleet"));
    assert.equal(readdirSync(dirname(s.labKey)).sort().join(), "age.key,config,host");
    if (b.step !== "3 key" && b.step !== "1 prerequisites" && b.step !== "2 clone") {
      assert.equal(readFileSync(s.labKey, "utf8"), existing.key, "the key was never replaced");
    }
    assert.equal(s.run().code, EXIT.ok, "and a further run is quiet");
    assert.equal(s.initCommits(), 1);
  });
}

test("a key made by a failed run is the key the rerun keeps", () => {
  const s = setup({ lab: WITH_FILE });
  withNote(s);
  writeExecutable(join(s.remote, "hooks/pre-receive"), "#!/bin/sh\nexit 1\n");
  assert.equal(s.run().code, EXIT.unreachable);
  const made = readFileSync(s.labKey, "utf8");
  const ahead = git(s.clone, "rev-list", "--count", "@{upstream}..HEAD");
  assert.equal(ahead, "1", "the recipient is committed and waiting to be pushed");
  rmSync(join(s.remote, "hooks/pre-receive"));
  assert.equal(s.run().code, EXIT.ok);
  assert.equal(readFileSync(s.labKey, "utf8"), made);
  assert.equal(s.initCommits(), 1);
});

test("the local form skips SSH, makes the admin's key, installs the timer here and prints the key to back up", () => {
  const s = setup({ local: true, laptop: WITH_FILE });
  withNote(s);
  const r = s.run(["laptop"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(s.sshCalls(), [], "ssh was not called");

  const key = join(s.home, ".config/fleet/age.key");
  assert.equal(statSync(key).mode & 0o777, 0o600);
  const identity = identityOf(s.home);
  assert.equal(r.stdout.split(keyLine(identity)).length - 1, 1, "the key is printed once");
  assert.match(r.stdout, /password manager/i);
  assert.match(r.stdout, /back(ed)? ?up/i);
  assert.equal(r.stderr.includes(keyLine(identity)), false, "and not on stderr");

  assert.match(s.read("hosts/laptop.yaml"), new RegExp(`^age: ${identity.recipient}$`, "m"));
  assert.match(s.read("hosts/laptop.yaml"), /^admin: true$/m);
  assert.match(git(s.remote, "show", "main:.sops.yaml"), new RegExp(identity.recipient));
  assert.equal(s.initCommits("laptop"), 1);
  assert.equal(readFileSync(join(s.home, ".config/fleet/host"), "utf8"), "laptop\n");
  assert.equal(readlinkSync(join(s.home, ".local/bin/fleet")), join(s.home, ".local/share/fleet/fleet/bin/fleet"), "the link points into the fleet clone fleet manages");
  assert.equal(existsSync(join(s.home, "fleet-config")), false, "no second clone of the config");
  assert.equal(readFileSync(join(s.home, ".config/fleet/config"), "utf8"), `${s.clone}\n`, "the config it ran from is written down");
  assert.equal(git(join(s.home, ".local/share/fleet/fleet"), "rev-parse", "HEAD"), /^  commit: (\S+)$/m.exec(s.read("fleet.yaml"))![1]);
  assert.equal(readlinkSync(join(s.home, ".claude/note.md")), join(s.clone, "config/note.md"), "the first apply ran here");
  assert.equal(JSON.parse(readFileSync(join(s.home, ".local/state/fleet/applied.json"), "utf8")).host, "laptop");
  assert.equal(readFileSync(join(s.home, ".config/systemd/user/fleet.service"), "utf8"), SERVICE);
  assert.equal(readFileSync(join(s.home, ".config/systemd/user/fleet.timer"), "utf8"), TIMER);
  assert.equal(existsSync(join(s.home, ".fake-timer-on")), true);
});

test("the local form with --json puts the key in the one document, once", () => {
  const s = setup({ local: true });
  const { r, doc } = s.json(["laptop"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(doc.backup.key, readFileSync(join(s.home, ".config/fleet/age.key"), "utf8").trim());
  assert.equal(doc.backup.path, "~/.config/fleet/age.key");
  assert.equal(r.stdout.split(keyLine(identityOf(s.home))).length - 1, 1);
});

test("the local form reruns without printing the key again, and keeps the key's bytes", () => {
  const s = setup({ local: true });
  assert.equal(s.run(["laptop"]).code, EXIT.ok);
  const key = readFileSync(join(s.home, ".config/fleet/age.key"));
  const head = s.remoteHead();
  const r = s.run(["laptop"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(readFileSync(join(s.home, ".config/fleet/age.key")), key);
  assert.equal(r.stdout.includes("AGE-SECRET-KEY"), false);
  assert.equal(r.stderr.includes("AGE-SECRET-KEY"), false);
  assert.match(r.stderr, /age\.key/, "it still says where the key to back up is");
  assert.equal(s.remoteHead(), head);
  assert.deepEqual(s.sshCalls(), []);
});

test("the local form prints the key even when a later step fails, and the rerun does not print it again", () => {
  const s = setup({ local: true, laptop: 'settings:\n  claude:\n    apiToken: "secret:ADMIN_TOKEN"\n' });
  const r = s.run(["laptop"]);
  assert.equal(r.code, 5, r.stderr);
  const identity = identityOf(s.home);
  assert.equal(r.stdout.split(keyLine(identity)).length - 1, 1, "shown in the run that made it, though it stopped at step 6");
  s.setSecret("laptop", "ADMIN_TOKEN", "mock-admin-token");
  const again = s.run(["laptop"]);
  assert.equal(again.code, EXIT.ok, again.stderr);
  assert.equal(again.stdout.includes("AGE-SECRET-KEY"), false);
});

test("the local form's prerequisites are checked first too", { skip: skipIfSystemWide("age-keygen") }, () => {
  const s = setup({ local: true });
  rmSync(join(s.home, ".local/bin/age-keygen"));
  const r = s.run(["laptop"]);
  assert.equal(r.code, 6, r.stderr);
  assert.match(r.stdout, /age-keygen/);
  assert.equal(existsSync(join(s.home, ".config/fleet/age.key")), false);
  assert.equal(s.initCommits("laptop"), 0);
});

test("a local-form conflict on the first apply exits 3 and leaves the timer off", () => {
  const s = setup({ local: true, laptop: WITH_FILE });
  withNote(s);
  mkdirSync(join(s.home, ".claude"), { recursive: true });
  writeFileSync(join(s.home, ".claude/note.md"), "mine");
  const r = s.run(["laptop"]);
  assert.equal(r.code, EXIT.conflict, r.stderr);
  assert.equal(existsSync(join(s.home, ".fake-timer-on")), false);
  assert.deepEqual(s.systemctl(s.home), []);
});

test("secret values and the host's private key appear only where they belong", () => {
  const s = setup({ lab: 'settings:\n  claude:\n    apiToken: "secret:ALICE_TOKEN"\n' });
  // server has no recipient until init records one, so the secret can only be set after the first run stops.
  const first = s.run();
  assert.equal(first.code, 5, first.stderr);
  s.setSecret("server", "ALICE_TOKEN", "mock-value-never-printed-1");
  const second = s.run();
  assert.equal(second.code, EXIT.ok, second.stderr);
  const jsonRun = s.run(["server", "--json"]);
  const everything = [first, second, jsonRun].map((r) => r.stdout + r.stderr).join("\n");
  const secret = "mock-value-never-printed-1";
  const lab = identityOf(s.lab);
  const labLine = keyLine(lab);
  const adminLine = keyLine(s.admin);
  const sshLog = ["ssh-calls.log", "order.log", "ssh-output.log"].map((f) => readFileSync(join(s.home, f), "utf8")).join("\n");
  const systemctlLog = readFileSync(join(s.lab, "systemctl-calls.log"), "utf8");
  const history = git(s.clone, "log", "--all", "-p") + git(s.remote, "log", "--all", "-p");

  for (const [name, text] of [["output", everything], ["ssh log", sshLog], ["systemctl log", systemctlLog], ["git history", history]] as const) {
    for (const needle of [secret, labLine, adminLine, lab.key.trim()]) assert.equal(text.includes(needle), false, `${needle.slice(0, 14)} is in the ${name}`);
  }
  // On disk: the host's settings file has the value by design; nothing else has it.
  const settings = join(s.lab, ".claude/settings.json");
  assert.deepEqual(leaks(secret, [s.home, s.lab, s.clone, s.remote], (p) => p === settings), []);
  assert.deepEqual(leaks(labLine, [s.home, s.lab, s.clone, s.remote], (p) => p === s.labKey), []);
  assert.deepEqual(leaks(adminLine, [s.lab, s.clone, s.remote]), []);
  assert.equal(readFileSync(join(s.lab, ".local/state/fleet/applied.json"), "utf8").includes(secret), false);
});

test("the admin's key is in the local form's one print and nowhere else", () => {
  const s = setup({ local: true, laptop: 'settings:\n  claude:\n    apiToken: "secret:ADMIN_TOKEN"\n' });
  const first = s.run(["laptop"]);
  s.setSecret("laptop", "ADMIN_TOKEN", "mock-admin-secret-2");
  const second = s.run(["laptop"]);
  assert.equal(second.code, EXIT.ok, second.stderr);
  const identity = identityOf(s.home);
  const line = keyLine(identity);
  assert.equal(first.stdout.split(line).length - 1, 1);
  assert.equal(first.stderr.includes(line), false);
  assert.equal(second.stdout.includes(line) || second.stderr.includes(line), false);
  assert.equal((git(s.clone, "log", "--all", "-p") + git(s.remote, "log", "--all", "-p")).includes(line), false);
  const key = join(s.home, ".config/fleet/age.key");
  assert.deepEqual(leaks(line, [s.home, s.clone, s.remote], (p) => p === key), []);
  const secretLeaks = leaks("mock-admin-secret-2", [s.home, s.clone, s.remote], (p) => p === join(s.home, ".claude/settings.json"));
  assert.deepEqual(secretLeaks, []);
  assert.equal((first.stdout + first.stderr + second.stdout + second.stderr).includes("mock-admin-secret-2"), false);
});
