import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSandbox, destroy, fakeCallsLog, sandboxEnv } from "../src/demo/sandbox.ts";
import { LAUNCHD_PLIST } from "../src/scheduler.ts";
import { CONFIG_DIR } from "../src/init.ts";
import { makeHome, repoRoot, runBin, tempDir, writeExecutable } from "./helpers.ts";
import { EXIT } from "../src/exit.ts";

const bin = join(repoRoot, "bin/fleet");

/** Every file under `dir` with what a change would show: its mode, mtime, and content or link target. */
function snapshot(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((e) => {
      const path = join(e.parentPath, e.name);
      const st = lstatSync(path);
      const what = st.isSymbolicLink() ? readlinkSync(path) : st.isFile() ? readFileSync(path, "utf8") : "";
      return `${path} ${st.mode} ${st.mtimeMs} ${what}`;
    })
    .sort();
}

/**
 * A stand-in for the real system around a run: a home with things a demo must not touch, and a PATH directory
 * whose `ssh`, `claude`, `opencode`, `sops`, `age`, `systemctl`, `launchctl` all leave a marker if they are ever run.
 */
function decoy() {
  const home = makeHome("realhost");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh/config"), "Host *\n  User real\n");
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Real Person\n");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/CLAUDE.md"), "my real instructions\n");
  writeFileSync(join(home, ".config/fleet/config"), `${join(home, "real-config")}\n`);
  const marks = tempDir("fleet-marks-");
  const path = tempDir("fleet-decoy-path-");
  for (const tool of ["ssh", "claude", "opencode", "sops", "age", "age-keygen", "systemctl", "launchctl"]) {
    writeExecutable(join(path, tool), `#!/bin/sh\necho "${tool} $*" >> ${join(marks, "calls")}\nexit 1\n`);
  }
  const tmp = tempDir("fleet-demo-tmp-");
  const run = (args: string[], env: Record<string, string> = {}) =>
    runBin(bin, args, { home, env: { PATH: `${path}:/usr/bin:/bin`, TMPDIR: tmp, FLEET_CONFIG: join(home, "real-config"), SSH_AUTH_SOCK: "/nonexistent", ...env } });
  const marked = () => (existsSync(join(marks, "calls")) ? readFileSync(join(marks, "calls"), "utf8") : "");
  return { home, tmp, path, run, marked };
}

test("a scripted run walks the tour, passes, and deletes the sandbox", () => {
  const d = decoy();
  const r = d.run(["demo"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stdout, /\$ fleet push -m "Add the triage skill"\n[\s\S]*server: conflict/);
  assert.match(r.stdout, /\$ ssh me@server 'rm ~\/\.claude\/rules\/host\.md'/);
  assert.match(r.stdout, /server: ok · 2 links \(\d+\.\ds\)/);
  assert.match(r.stdout, /every step behaved as expected/);
  assert.deepEqual(readdirSync(d.tmp), [], "nothing is left in the temp directory");
});

test("nothing in the real home changes, and the real ssh, claude, opencode, sops, systemctl and launchctl are never run", () => {
  const d = decoy();
  const before = snapshot(d.home);
  const r = d.run(["demo"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(snapshot(d.home), before);
  assert.equal(d.marked(), "", "a real tool ran");
  assert.match(r.stdout, /server: ok/, "the fake ssh reached server, which the real one could not");
});

test("the demo does not need sops or age", () => {
  const d = decoy();
  const r = d.run(["demo", "--json"], { PATH: `${tempDir("fleet-bare-")}:/usr/bin:/bin` });
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(d.marked(), "");
});

test("--json gives one document with each step's exit", () => {
  const r = decoy().run(["demo", "--json"]);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.code, "ok");
  assert.deepEqual(doc.steps.map((s: { exit: number }) => s.exit), [0, 0, 3, 0, 0, 0]);
});

test("the sandbox builds every path from its root and its environment from an allowlist", () => {
  const d = decoy();
  const tool = repoRoot;
  const sandbox = buildSandbox(tool);
  try {
    assert.ok(existsSync(sandbox.root));
    for (const host of sandbox.hosts) assert.ok(host.home.startsWith(sandbox.root + sep), `${host.name} is inside the sandbox`);

    const caller = { HOME: d.home, PATH: "/usr/bin", FLEET_CONFIG: "/real", SSH_AUTH_SOCK: "/s", GITHUB_TOKEN: "t", XDG_CONFIG_HOME: "/real/.config", GIT_SSH_COMMAND: "ssh", TERM: "xterm" };
    const env = sandboxEnv(sandbox.root, sandbox.admin.home, { config: sandbox.config, passthrough: caller });
    assert.equal(env.TERM, "xterm");
    for (const [name, value] of Object.entries(env)) {
      if (["TERM", "FLEET_NODE", "GIT_CONFIG_NOSYSTEM", "GIT_ALLOW_PROTOCOL", "GIT_TERMINAL_PROMPT", "GIT_PAGER"].includes(name)) continue;
      assert.ok(value.split(":").every((p) => p.startsWith(sandbox.root)), `${name}=${value} is inside the sandbox`);
    }
    for (const leaked of ["SSH_AUTH_SOCK", "GITHUB_TOKEN", "XDG_CONFIG_HOME", "GIT_SSH_COMMAND"]) assert.equal(leaked in env, false, leaked);
    assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");

    const git = (cwd: string, ...args: string[]) => spawnSync("/usr/bin/git", args, { cwd, env, encoding: "utf8" });
    for (const host of sandbox.hosts) {
      for (const repo of [join(host.home, CONFIG_DIR), join(host.home, ".local/share/fleet/fleet"), join(host.home, ".local/share/fleet/sources/example-skills")]) {
        const urls = git(repo, "remote", "-v").stdout.split("\n").filter((l) => l !== "").map((l) => l.split(/\s+/)[1]!);
        assert.ok(urls.length > 0 && urls.every((u) => u.startsWith(sandbox.root + sep)), `${repo}: ${urls}`);
      }
    }
    const origins = git(sandbox.config, "config", "--list", "--show-origin").stdout.split("\n").filter((l) => l !== "").map((l) => l.split("\t")[0]!);
    assert.ok(origins.every((o) => o.startsWith(`file:${sandbox.root}${sep}`) || o.startsWith("file:.git/")), origins.join("\n"));

    const network = git(sandbox.config, "ls-remote", "https://127.0.0.1:9/x.git");
    assert.notEqual(network.status, 0);
    assert.match(network.stderr, /not allowed/);
    const viaSsh = git(sandbox.config, "ls-remote", "ssh://127.0.0.1:9/x.git");
    assert.match(viaSsh.stderr, /not allowed/);

    const reach = spawnSync(join(sandbox.admin.home, ".local/bin/ssh"), ["-o", "BatchMode=yes", "nobody@elsewhere", "true"], { env, encoding: "utf8" });
    assert.equal(reach.status, 255, "a host the demo does not know is unreachable");
    assert.match(readFileSync(fakeCallsLog(sandbox.root), "utf8"), /"tool":"ssh"/);
  } finally {
    destroy(sandbox.root);
  }
  assert.equal(existsSync(sandbox.root), false);
});

test("a demo host with the LaunchAgent, as on a Mac, reports its timer active through the fake launchctl", () => {
  const sandbox = buildSandbox(repoRoot);
  try {
    const host = sandbox.admin;
    mkdirSync(join(host.home, LAUNCHD_PLIST, ".."), { recursive: true });
    writeFileSync(join(host.home, LAUNCHD_PLIST), "<plist/>\n");
    const env = sandboxEnv(sandbox.root, host.home, { config: sandbox.config });
    const r = spawnSync(join(host.home, ".local/bin/fleet"), ["status", "--json"], { cwd: sandbox.config, env, encoding: "utf8" });
    assert.equal(JSON.parse(r.stdout).timer, "active", r.stderr);
    assert.match(readFileSync(fakeCallsLog(sandbox.root), "utf8"), /"tool":"launchctl"/);
  } finally {
    destroy(sandbox.root);
  }
});

test("destroy refuses a directory that is not a demo sandbox", () => {
  assert.throws(() => destroy(tempDir("fleet-test-")), /refusing to delete/);
  assert.throws(() => destroy(join(repoRoot, "src")), /refusing to delete/);
});

test("on a terminal, demo --shell starts a shell with a prompt marker and the tour, and deletes the sandbox on exit", { skip: spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0 && "script(1) from util-linux is not installed, so there is no pty to run in" }, () => {
  const d = decoy();
  const before = snapshot(d.home);
  const env = { HOME: d.home, PATH: `${d.path}:/usr/bin:/bin`, TMPDIR: d.tmp, TERM: "dumb", FLEET_NODE: process.execPath };
  const r = spawnSync("script", ["-qec", `${bin} demo --shell`, "/dev/null"], { input: "fleet status | head -1\nssh me@server hostname 2>&1 | head -1\nexit\n", encoding: "utf8", env, timeout: 90_000 });
  assert.match(r.stdout, /To try:/);
  assert.match(r.stdout, /\(fleet demo\) .*\$ /);
  assert.match(r.stdout, /host: laptop/);
  assert.deepEqual(readdirSync(d.tmp), []);
  assert.deepEqual(snapshot(d.home), before);
  assert.equal(d.marked(), "");
});

test("--shell is only for demo, and is listed in the help", () => {
  const d = decoy();
  assert.equal(d.run(["status", "--shell"]).code, EXIT.invalid);
  const help = d.run(["help"]);
  assert.match(help.stdout, /demo +Try the bridge on made-up hosts.*--shell/);
  assert.equal(d.run(["demo", "--shell", "--json"]).code, EXIT.ok, "without a terminal the scripted run stays");
});

test("an argument is refused", () => {
  const r = decoy().run(["demo", "extra"]);
  assert.equal(r.code, EXIT.invalid);
});

test("the demo's bridge takes --view and --host too, and names its own hosts when one is wrong", () => {
  const sandbox = buildSandbox(repoRoot);
  try {
    const env = sandboxEnv(sandbox.root, sandbox.admin.home, { config: sandbox.config });
    const run = (...args: string[]) => spawnSync(join(sandbox.admin.home, ".local/bin/fleet"), ["bridge", ...args], { cwd: sandbox.config, env, encoding: "utf8", input: "" });
    const host = run("--host", "mainframe");
    assert.equal(host.status, EXIT.invalid);
    assert.match(host.stderr, /unknown host 'mainframe'\. The hosts are: laptop, devbox, server/);
    const view = run("--view", "inbox", "--host", "server");
    assert.equal(view.status, EXIT.invalid);
    assert.match(view.stderr, /unknown view 'inbox'/);
    // Names that are right get past the checks, and then only the missing terminal stops it.
    const fine = run("--view", "matrix", "--host", "server");
    assert.equal(fine.status, EXIT.invalid);
    assert.match(fine.stderr, /needs a terminal/);
  } finally {
    destroy(sandbox.root);
  }
});

test("the demo's hosts have a made-up startup context: measured servers, one host with an unmeasured server and a hand-made skill", () => {
  const sandbox = buildSandbox(repoRoot);
  try {
    const context = (name: string) => {
      const host = sandbox.hosts.find((h) => h.name === name)!;
      const r = spawnSync(join(host.home, ".local/bin/fleet"), ["context", "--json"], { env: sandboxEnv(sandbox.root, host.home), encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return (JSON.parse(r.stdout).agents as { agent: string; complete: boolean; tokens: number; items: { kind: string; name: string; tokens: number | null; fromConfig: boolean; measurement: { current: boolean | null } | null }[] }[]).find((a) => a.agent === "claude")!;
    };
    const laptop = context("laptop");
    assert.equal(laptop.complete, true);
    const tracker = laptop.items.find((i) => i.name === "tracker")!;
    assert.ok(tracker.tokens! > 10_000, "a heavy server to find at a glance");
    assert.notEqual(tracker.measurement!.current, false, "not shown as out of date");
    const devbox = context("devbox");
    assert.equal(devbox.complete, false);
    assert.equal(devbox.items.find((i) => i.kind === "mcp")!.tokens, null, "unknown, not zero");
    assert.equal(devbox.items.find((i) => i.name === "scratch")!.fromConfig, false);
    assert.equal(context("server").complete, true);
  } finally {
    destroy(sandbox.root);
  }
});
