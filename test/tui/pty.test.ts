import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, installFakeSsh, installStatusTools, makeClone, makeHome, publish, repoRoot } from "../helpers.ts";
import { EXIT } from "../../src/exit.ts";
import { LEAVE, ENTER } from "../../src/tui/terminal.ts";

const hasScript = spawnSync("script", ["--version"], { stdio: "ignore" }).status === 0;
const skip = hasScript ? false : "script(1) is not installed, so there is no pty to run in";

type Ran = { code: number | null; out: string };

/** Runs `command` in a real pty made by script(1), types `keys` once `ready` shows, signals it after `signal`. */
function inPty(command: string, opts: { env: Record<string, string>; ready: string; keys?: string; then?: string; signal?: { name: string; pattern: string }; steps?: { until: string; keys: string }[] }): Promise<Ran> {
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
      if (step && out.indexOf(step.until, seen) >= 0) {
        seen = out.indexOf(step.until, seen) + step.until.length;
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
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pty run timed out; saw ${JSON.stringify(out.slice(-300))}`));
    }, 20_000);
    child.on("close", (code) => {
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
