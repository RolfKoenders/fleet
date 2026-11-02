import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSandbox, destroy, fakeCallsLog, sandboxEnv } from "../src/demo/sandbox.ts";
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
 * whose `ssh`, `claude`, `opencode`, `sops`, `age`, `systemctl` all leave a marker if they are ever run.
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
  for (const tool of ["ssh", "claude", "opencode", "sops", "age", "age-keygen", "systemctl"]) {
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
  assert.match(r.stdout, /server: ok \(2 changes\)/);
  assert.match(r.stdout, /every step behaved as expected/);
  assert.deepEqual(readdirSync(d.tmp), [], "nothing is left in the temp directory");
});

test("nothing in the real home changes, and the real ssh, claude, opencode, sops and systemctl are never run", () => {
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
      for (const repo of [join(host.home, "fleet-config"), join(host.home, ".local/share/fleet/fleet"), join(host.home, ".local/share/fleet/sources/example-skills")]) {
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

test("destroy refuses a directory that is not a demo sandbox", () => {
  assert.throws(() => destroy(tempDir("fleet-test-")), /refusing to delete/);
  assert.throws(() => destroy(join(repoRoot, "src")), /refusing to delete/);
});

test("on a terminal it starts a shell with a prompt marker and the tour, and deletes the sandbox on exit", { skip: spawnSync("sh", ["-c", "command -v script"]).status !== 0 && "script is not installed" }, () => {
  const d = decoy();
  const before = snapshot(d.home);
  const env = { HOME: d.home, PATH: `${d.path}:/usr/bin:/bin`, TMPDIR: d.tmp, TERM: "dumb", FLEET_NODE: process.execPath };
  const r = spawnSync("script", ["-qec", `${bin} demo`, "/dev/null"], { input: "fleet status | head -1\nssh me@server hostname 2>&1 | head -1\nexit\n", encoding: "utf8", env, timeout: 90_000 });
  assert.match(r.stdout, /To try:/);
  assert.match(r.stdout, /\(fleet demo\) .*\$ /);
  assert.match(r.stdout, /host: laptop/);
  assert.deepEqual(readdirSync(d.tmp), []);
  assert.deepEqual(snapshot(d.home), before);
  assert.equal(d.marked(), "");
});

test("an argument is refused", () => {
  const r = decoy().run(["demo", "extra"]);
  assert.equal(r.code, EXIT.invalid);
});
