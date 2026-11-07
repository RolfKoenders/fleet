import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, installFakeSsh, installStatusTools, makeClone, makeHome, publish, repoRoot, tempDir, writeExecutable } from "../helpers.ts";
import { EXIT } from "../../src/exit.ts";
import { LEAVE, ENTER } from "../../src/tui/terminal.ts";

const hasScript = spawnSync("script", ["--version"], { stdio: "ignore" }).status === 0;
const skip = hasScript ? false : "script(1) is not installed, so there is no pty to run in";

type Ran = { code: number | null; out: string };

/** Where `until` next appears in `out` from `from` on, as the index just past it. */
function find(out: string, until: string | RegExp, from: number): { end: number } | null {
  if (typeof until === "string") {
    const i = out.indexOf(until, from);
    return i < 0 ? null : { end: i + until.length };
  }
  const re = new RegExp(until.source, until.flags.includes("g") ? until.flags : `${until.flags}g`);
  re.lastIndex = from;
  const m = re.exec(out);
  return m ? { end: m.index + m[0].length } : null;
}

/** Runs `command` in a real pty made by script(1), types `keys` once `ready` shows, signals it after `signal`. */
function inPty(command: string, opts: { env: Record<string, string>; ready: string; keys?: string; then?: string; signal?: { name: string; pattern: string }; steps?: { until: string | RegExp; keys: string }[]; /** Signals the process once `until` is true (polled), however far the screen has got. */ after?: { until: () => boolean; signal: { name: string; pattern: string } } }): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn("script", ["-qec", `stty cols 100 rows 30; ${command}`, "/dev/null"], { env: { PATH: "/usr/bin:/bin", ...opts.env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let acted = false;
    // Each step waits until its text has newly appeared in the output, then types its keys.
    const steps = [...(opts.steps ?? [])];
    let seen = 0;
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      out += d;
      const step = steps[0];
      const found = step && find(out, step.until, seen);
      if (step && found) {
        seen = found.end;
        steps.shift();
        setTimeout(() => child.stdin.write(step.keys), 150);
      }
      if (acted || !out.includes(opts.ready)) return;
      acted = true;
      setTimeout(() => {
        if (opts.keys !== undefined) child.stdin.write(opts.keys);
        if (opts.then !== undefined) setTimeout(() => child.stdin.write(opts.then!), 600);
        if (opts.signal) spawnSync("pkill", [`-${opts.signal.name}`, "-f", opts.signal.pattern]);
      }, 300);
    });
    const poll = opts.after ? setInterval(() => {
      if (!opts.after!.until()) return;
      clearInterval(poll);
      spawnSync("pkill", [`-${opts.after!.signal.name}`, "-f", opts.after!.signal.pattern]);
    }, 25) : undefined;
    const timer = setTimeout(() => {
      clearInterval(poll);
      child.kill("SIGKILL");
      reject(new Error(`pty run timed out; saw ${JSON.stringify(out.slice(-300))}`));
    }, 45_000);
    child.on("close", (code) => {
      clearInterval(poll);
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

function bridgeWorld() {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  mkdirSync(join(clone, "hosts"), { recursive: true });
  writeFileSync(join(clone, "hosts/laptop.yaml"), "{}\n");
  writeFileSync(join(clone, "hosts/other.yaml"), "ssh: me@other\n");
  publish(clone, "hosts");
  installStatusTools(home);
  installFakeSsh(home, {});
  const env = { HOME: home, FLEET_CONFIG: clone, FLEET_NODE: process.execPath, TERM: "xterm-256color", COLORTERM: "truecolor", FLEET_NO_MOTION: "1" };
  return { clone, home, env, command: `${join(clone, "bin/fleet")} bridge; echo "EXIT=$?"; stty -a`, pattern: `${clone}/src/main.ts bridge` };
}

/** The parameters of every colour or attribute sequence in `out`, as numbers. */
const sgr = (out: string): number[][] => [...out.matchAll(/\u001b\[([0-9;]*)m/g)].map((m) => m[1]!.split(";").map(Number));
const colours = (out: string): number[] => sgr(out).flat().filter((n) => (n >= 30 && n <= 38) || (n >= 40 && n <= 48) || (n >= 90 && n <= 107));

const cooked = (out: string) => /\bicanon\b/.test(out.replace(/-icanon/g, "")) && /\becho\b/.test(out.replace(/-echo/g, ""));

test("pty: fleet bridge takes the screen, shows the hosts, and q gives everything back", { skip }, async () => {
  const w = bridgeWorld();
  const r = await inPty(w.command, { env: w.env, ready: "laptop", keys: "q" });
  assert.ok(r.out.includes(ENTER), "entered the alternate screen");
  assert.ok(r.out.includes("laptop") && r.out.includes("other"));
  assert.ok(r.out.indexOf(LEAVE) > r.out.indexOf(ENTER), "left it again");
  assert.match(r.out, /EXIT=0/);
  assert.ok(cooked(r.out.slice(r.out.indexOf("EXIT="))), "the tty is back in cooked mode");
});

test("pty: SIGTERM, SIGINT and SIGHUP each restore the terminal before the process goes", { skip }, async () => {
  for (const [name, exit] of [["TERM", 143], ["INT", 130], ["HUP", 129]] as const) {
    const w = bridgeWorld();
    const r = await inPty(w.command, { env: w.env, ready: "laptop", signal: { name, pattern: w.pattern } });
    assert.ok(r.out.includes(LEAVE), `${name}: screen left`);
    assert.match(r.out, new RegExp(`EXIT=${exit}`), name);
    assert.ok(cooked(r.out.slice(r.out.indexOf("EXIT="))), `${name}: cooked mode again`);
  }
});

test("pty: a crash and an unhandled rejection restore the terminal, then say what happened", { skip }, async () => {
  for (const mode of ["throw", "reject"]) {
    const command = `${process.execPath} ${join(repoRoot, "test/tui/pty-app.ts")} ${mode}; echo "EXIT=$?"; stty -a`;
    const r = await inPty(command, { env: { HOME: makeHome(), TERM: "xterm-256color" }, ready: "READY" });
    assert.ok(r.out.includes(ENTER) && r.out.includes(LEAVE), mode);
    assert.ok(r.out.indexOf(LEAVE) < r.out.indexOf(mode === "throw" ? "kaboom" : "rejected"), "the error is printed after the screen is back");
    assert.match(r.out, /EXIT=1/);
    assert.ok(cooked(r.out.slice(r.out.indexOf("EXIT="))), mode);
  }
});

test("pty: NO_COLOR writes no colour at all and the screen is still usable", { skip }, async () => {
  const w = bridgeWorld();
  const r = await inPty(w.command, { env: { ...w.env, NO_COLOR: "1" }, ready: "laptop", keys: "2q" });
  assert.deepEqual(colours(r.out), []);
  assert.ok(sgr(r.out).some((p) => p.includes(1)), "bold is still used");
  assert.ok(r.out.includes("laptop"));
  assert.match(r.out, /EXIT=0/);
});

test("pty: at 256 and 16 colours the bridge writes only what that terminal has", { skip }, async () => {
  const w = bridgeWorld();
  const r256 = await inPty(w.command, { env: { ...w.env, COLORTERM: "", TERM: "xterm-256color" }, ready: "laptop", keys: "q" });
  assert.ok(sgr(r256.out).every((p) => !p.includes(2) || p[p.indexOf(2) - 1] !== 38), "no truecolor");
  assert.ok(sgr(r256.out).some((p) => p[0] === 0 && p[1] === 38 && p[2] === 5 || p.join(";").includes("38;5;")));
  const r16 = await inPty(w.command, { env: { ...w.env, COLORTERM: "", TERM: "xterm" }, ready: "laptop", keys: "q" });
  assert.ok(sgr(r16.out).every((p) => !p.includes(38) && !p.includes(48)), "no 256 or truecolor");
  assert.ok(colours(r16.out).length > 0);
});

test("pty: the boot animation plays when allowed and any key skips it", { skip }, async () => {
  const w = bridgeWorld();
  const env = { ...w.env };
  delete (env as Record<string, string | undefined>).FLEET_NO_MOTION;
  const r = await inPty(w.command, { env, ready: "skip", keys: "x", then: "q" });
  assert.match(r.out, /any key to skip/);
  assert.ok(r.out.includes("laptop"), "the app followed it");
  assert.match(r.out, /EXIT=0/);
});

test("pty: fleet bridge --view matrix --host other opens the matrix, and an unknown name never takes the screen", { skip }, async () => {
  const w = bridgeWorld();
  const fleet = join(w.clone, "bin/fleet");
  const r = await inPty(`${fleet} bridge --view matrix --host other; echo "EXIT=$?"`, { env: w.env, ready: "bundle", keys: "q" });
  assert.ok(r.out.includes(ENTER));
  assert.match(r.out, /EXIT=0/);
  const bad = await inPty(`${fleet} bridge --view nowhere; echo "EXIT=$?"`, { env: w.env, ready: "EXIT=" });
  assert.match(bad.out, /EXIT=2/);
  assert.match(bad.out, /unknown view 'nowhere'/);
  assert.ok(!bad.out.includes(ENTER), "the screen was never taken");
  const badHost = await inPty(`${fleet} bridge --host nobody; echo "EXIT=$?"`, { env: w.env, ready: "EXIT=" });
  assert.match(badHost.out, /EXIT=2/);
  assert.match(badHost.out, /unknown host 'nobody'\. The hosts are: laptop, other/);
  assert.ok(!badHost.out.includes(ENTER));
});

test("fleet bridge without a terminal exits 2 and points at fleet status", () => {
  const w = bridgeWorld();
  const r = spawnSync(join(w.clone, "bin/fleet"), ["bridge"], { env: { PATH: "/usr/bin:/bin", ...w.env }, encoding: "utf8", input: "" });
  assert.equal(r.status, EXIT.invalid);
  assert.match(r.stderr, /needs a terminal.*fleet status --all/);
  assert.equal(r.stdout, "");
  assert.ok(!r.stdout.includes(ENTER) && !r.stderr.includes(ENTER), "no escape sequence on a pipe");
});

test("fleet bridge --json is invalid, with or without a terminal", { skip }, async () => {
  const w = bridgeWorld();
  const r = spawnSync(join(w.clone, "bin/fleet"), ["bridge", "--json"], { env: { PATH: "/usr/bin:/bin", ...w.env }, encoding: "utf8", input: "" });
  assert.equal(r.status, EXIT.invalid);
  assert.match(r.stderr, /no --json form/);
  const p = await inPty(`${join(w.clone, "bin/fleet")} bridge --json; echo "EXIT=$?"`, { env: w.env, ready: "EXIT=" });
  assert.match(p.out, /EXIT=2/);
  assert.ok(!p.out.includes(ENTER));
});

test("bare fleet still prints help, and the help lists bridge as a command that changes things", () => {
  const w = bridgeWorld();
  const r = spawnSync(join(w.clone, "bin/fleet"), [], { env: { PATH: "/usr/bin:/bin", ...w.env }, encoding: "utf8", input: "" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^ {2}bridge +Open the full-screen view/m);
  const agent = spawnSync(join(w.clone, "bin/fleet"), ["agent"], { env: { PATH: "/usr/bin:/bin", ...w.env }, encoding: "utf8", input: "" });
  assert.match(agent.stdout, /### Changes things[\s\S]*fleet bridge/);
  assert.doesNotMatch(agent.stdout, /### Read-only[\s\S]*fleet bridge[\s\S]*### Changes things/);
});

test("pty: P, the typed word and enter run a real push in a temp home, and the lanes tick off", { skip }, async () => {
  const w = bridgeWorld();
  installFakeSsh(w.home, { "me@other": { stdout: JSON.stringify({ ok: true, code: "ok", host: "other", messages: [], created: [{}, {}], updated: [], removed: [], conflicts: [] }) } });
  writeFileSync(join(w.clone, "notes.md"), "a note\n");
  const env = { ...w.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  const r = await inPty(w.command, {
    env,
    ready: "laptop",
    keys: "P",
    steps: [
      { until: "notes.md", keys: "push" },
      { until: "push\u001b", keys: "\r" },
      { until: "Push finished", keys: "q" },
    ],
  });
  assert.ok(r.out.includes("Review before you push"));
  assert.match(r.out, /Push finished/);
  assert.match(r.out, /other/);
  assert.match(r.out, /EXIT=0/);
  assert.equal(git(w.clone, "log", "-1", "--format=%s", "main"), "fleet push from laptop: 1 files");
  assert.ok(cooked(r.out.slice(r.out.indexOf("EXIT="))), "the tty is back in cooked mode");
});

/**
 * A push, started from the bridge in a real pty, whose bridge is then killed while it is applying on the slow host. The
 * push has its own session, so it must go on and finish by itself: commit, publish, apply here and on the host.
 * Everything runs in a temp home with a fake ssh; `FLEET_NODE` is a wrapper that logs how each fleet process ended.
 */
async function killedMidPush(signal: string): Promise<{ w: ReturnType<typeof bridgeWorld>; ended: () => string[]; r: Ran }> {
  const w = bridgeWorld();
  assert.ok(w.home.startsWith(realpathSync(tmpdir())), "a temp home");
  const log = join(w.home, "node-exits.log");
  const node = join(w.home, "node-wrapper");
  writeExecutable(node, `#!/bin/sh\n"$REAL_NODE" "$@"; code=$?\ncase "$*" in *main.ts*) echo "$code $*" >> "$NODE_LOG";; esac\nexit $code\n`);
  writeExecutable(join(w.home, ".local/bin/ssh"), `#!/bin/sh\ncase "$*" in\n  *apply*) echo started >> "$HOME/remote-started"; sleep 3; echo "$*" >> "$HOME/remote-done"; printf '%s' '{"ok":true,"code":"ok","host":"other","messages":[],"created":[{}],"updated":[],"removed":[],"conflicts":[]}';;\n  *) exit 255;;\nesac\n`);
  writeFileSync(join(w.clone, "notes.md"), "a note\n");
  const env = { ...w.env, FLEET_NODE: node, REAL_NODE: process.execPath, NODE_LOG: log, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  const r = await inPty(w.command, {
    env,
    ready: "laptop",
    keys: "P",
    steps: [
      { until: "notes.md", keys: "push" },
      { until: "push\u001b", keys: "\r" },
    ],
    after: { until: () => existsSync(join(w.home, "remote-started")), signal: { name: signal, pattern: w.pattern } },
  });
  // The terminal is gone. The push is not: wait for the slow host to be done.
  const until = Date.now() + 20_000;
  while (!existsSync(join(w.home, "remote-done")) && Date.now() < until) await new Promise((res) => setTimeout(res, 100));
  assert.ok(existsSync(join(w.home, "remote-done")), "the apply on the slow host ran to its end");
  const settle = Date.now() + 10_000;
  const exits = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l !== "") : []);
  while (!exits().some((l) => / push /.test(l)) && Date.now() < settle) await new Promise((res) => setTimeout(res, 100));
  return { w, ended: exits, r };
}

for (const signal of ["HUP", "KILL"]) {
  test(`pty: a push survives its terminal going away (${signal}) and still finishes: commit, publish, applies`, { skip }, async () => {
    const { w, ended, r } = await killedMidPush(signal);
    assert.ok(!r.out.includes("Push finished"), "the bridge was gone before the push ended");
    const remote = git(w.clone, "remote", "get-url", "origin");
    assert.equal(git(w.clone, "log", "-1", "--format=%s", "main"), "fleet push from laptop: 1 files", "committed");
    assert.equal(git(remote, "log", "-1", "--format=%s", "main"), "fleet push from laptop: 1 files", "published");
    assert.ok(existsSync(join(w.home, ".local/state/fleet/applied.json")), "applied here");
    assert.match(readFileSync(join(w.home, "remote-done"), "utf8"), /apply --json/, "applied on the other host");
    const lines = ended();
    assert.ok(lines.some((l) => /^0 .* push --json/.test(l)), `the push itself ended with exit 0, not a crash on its closed pipes: ${lines.join(" | ")}`);
    assert.ok(lines.some((l) => /^0 .* apply --json/.test(l)), "and so did the local apply");
  });
}

/** A real-looking home with things a demo must not touch, and a PATH directory whose tools leave a marker if run. */
function demoDecoy() {
  const home = makeHome("realhost");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh/config"), "Host *\n  User real\n");
  const marks = tempDir("fleet-marks-");
  const path = tempDir("fleet-decoy-path-");
  for (const tool of ["ssh", "claude", "opencode", "sops", "age", "age-keygen", "systemctl"]) writeExecutable(join(path, tool), `#!/bin/sh\necho "${tool} $*" >> ${join(marks, "calls")}\nexit 1\n`);
  const tmp = tempDir("fleet-demo-tmp-");
  const env = { HOME: home, PATH: `${path}:/usr/bin:/bin`, TMPDIR: tmp, TERM: "xterm-256color", COLORTERM: "truecolor", FLEET_NODE: process.execPath };
  return { home, tmp, env, marked: () => (existsSync(join(marks, "calls")) ? readFileSync(join(marks, "calls"), "utf8") : "") };
}

test("pty: fleet demo on a terminal goes straight into the bridge on fake hosts, boot animation and DEMO pill included, and quitting deletes the world", { skip }, async () => {
  const d = demoDecoy();
  const r = await inPty(`${join(repoRoot, "bin/fleet")} demo; echo "EXIT=$?"`, { env: d.env, ready: "skip", keys: "x", steps: [{ until: "watch a push", keys: "q" }] });
  assert.ok(r.out.includes(ENTER) && r.out.includes(LEAVE));
  assert.match(r.out, /DEMO/);
  assert.match(r.out, /watch a push/);
  assert.doesNotMatch(r.out, /read-only; P pushes/, "the DEMO pill replaces the normal one");
  assert.ok(r.out.includes("laptop") && r.out.includes("server") && r.out.includes("devbox"));
  assert.doesNotMatch(r.out, /To try:/, "no printed tour outside --shell");
  assert.match(r.out, /EXIT=0/);
  assert.deepEqual(readdirSync(d.tmp), [], "the fake world is deleted");
  assert.equal(d.marked(), "", "no real tool ran");
  assert.equal(existsSync(join(d.home, ".local")), false, "the real home was not written");
});

test("pty: in the demo, P shows a push of fake hosts and runs it in the sandbox; the seeded conflict stops it", { skip }, async () => {
  const d = demoDecoy();
  const r = await inPty(`${join(repoRoot, "bin/fleet")} demo; echo "EXIT=$?"`, {
    env: { ...d.env, FLEET_NO_MOTION: "1" },
    ready: "watch a push",
    keys: "P",
    steps: [
      // The prompt is drawn only once the preview is in, so the word typed now counts.
      { until: "press enter to go", keys: "push" },
      // The typed word echoes with the cursor after it; the footer's "type push" never has one.
      { until: /push(\u001b\[[0-9;]*m)*▏/, keys: "\r" },
      { until: "Push ended", keys: "q" },
    ],
  });
  assert.match(r.out, /fake hosts, nothing real is touched/);
  assert.match(r.out, /Push ended: conflict/);
  assert.match(r.out, /EXIT=0/);
  assert.deepEqual(readdirSync(d.tmp), []);
  assert.equal(d.marked(), "");
  assert.equal(existsSync(join(d.home, ".local")), false);
});

test("the DEMO pill appears only for the demo's own sandbox, never because of a variable alone", async () => {
  const { inDemo } = await import("../../src/tui/bridge.ts");
  const real = makeHome("laptop");
  assert.equal(inDemo({ FLEET_DEMO_ROOT: tmpdir() + "/fleet-demo-x" }, real), false, "home outside the root");
  assert.equal(inDemo({ FLEET_DEMO_ROOT: real }, real), false, "not a demo directory");
  assert.equal(inDemo({}, real), false);
  assert.equal(inDemo({ FLEET_DEMO_ROOT: "/fleet-demo-x" }, "/fleet-demo-x/laptop"), false, "not in the temp directory");
});
