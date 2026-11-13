import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, installFakeSsh, linkFleetSkill, makeClone, makeHome, makeSource, publish, runFleet, tempDir, writeExecutable } from "./helpers.ts";
import type { SshPlan } from "./helpers.ts";
import { EVENT_VERSION } from "../src/events.ts";
import { EXIT } from "../src/exit.ts";
import { advanceReplay, listJournals, readJournal, startReplay } from "../src/journal.ts";
import { finish, readEnd, reduce, startRun } from "../src/pushrun.ts";
import { findTool } from "../src/tools.ts";

const applyDoc = (code: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ok: code === "ok", code, host: "remote", messages: [], created: [], updated: [], removed: [], conflicts: [], ...extra });

const none = { changes: 0, created: [], updated: [], removed: [] };
const OK: SshPlan = { stdout: applyDoc("ok") };
const UNREACHABLE: SshPlan = { exit: 255, stderr: "ssh: connect to host x port 22: Connection timed out" };
const CONFLICT: SshPlan = {
  exit: 3,
  stdout: applyDoc("conflict", { conflicts: [{ kind: "link", path: "~/.claude/x.md", detail: "is a real file", fix: "move it" }] }),
};

type Setup = {
  /** Host name to its `ssh` destination, or null for a host reached by its timer. laptop is the pusher. */
  hosts?: Record<string, string | null>;
  ssh?: Record<string, SshPlan>;
  defaults?: string;
  laptop?: string;
  source?: boolean;
};

function setup(opts: Setup = {}) {
  const { clone, remote } = makeClone();
  const home = makeHome("laptop");
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(clone, rel)), { recursive: true });
    writeFileSync(join(clone, rel), content);
  };
  const src = opts.source ? makeSource({ "planning/SKILL.md": "---\nname: planning\n---\n" }) : null;
  if (src) {
    write("catalog/skills.yaml", `sources:\n  mine:\n    repo: ${src.remote}\n    path: .\n    branch: main\nbundles:\n  core: [planning]\n`);
  }
  write("hosts/laptop.yaml", opts.laptop ?? (src ? "bundles: [core]\n" : "{}\n"));
  if (opts.defaults !== undefined) write("hosts/_defaults.yaml", opts.defaults);
  for (const [name, dest] of Object.entries(opts.hosts ?? {})) write(`hosts/${name}.yaml`, dest === null ? "{}\n" : `ssh: ${dest}\n`);
  publish(clone, "config");

  linkFleetSkill(home, clone);

  // Always installed, first on the probe path: a test must never reach the real ssh and a real host.
  installFakeSsh(home, opts.ssh ?? {});

  const run = (args: string[] = [], env: Record<string, string> = {}) => runFleet(clone, ["push", ...args], { home, env });
  const json = (args: string[] = []) => {
    const r = run([...args, "--json"]);
    return { r, doc: JSON.parse(r.stdout) };
  };
  const sshCalls = (): string[][] => {
    try {
      return readFileSync(join(home, "ssh-calls.log"), "utf8").trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as string[]);
    } catch {
      return [];
    }
  };
  const sshHosts = () => sshCalls().map((c) => c[c.length - 2]);
  const remoteHead = () => git(remote, "rev-parse", "main");
  const remoteSubject = () => git(remote, "log", "-1", "--format=%s", "main");
  const sourceClone = join(home, ".local/share/fleet/sources/mine");
  if (src) assert.equal(runFleet(clone, ["apply"], { home }).code, EXIT.ok, "the source is applied once before the test starts");
  const orderLog = join(tempDir("fleet-order-"), "pushes");
  const watch = (bare: string, label: string) => writeExecutable(join(bare, "hooks/post-receive"), `#!/bin/sh\necho ${label} >> ${orderLog}\n`);
  const pushes = () => (existsSync(orderLog) ? readFileSync(orderLog, "utf8").trim().split("\n") : []);
  const machine = (name: string) => {
    const base = tempDir("fleet-machine-");
    const mhome = join(base, "home");
    mkdirSync(join(mhome, ".config/fleet"), { recursive: true });
    writeFileSync(join(mhome, ".config/fleet/host"), `${name}\n`);
    git(base, "clone", "--quiet", remote, "fleet");
    writeFileSync(join(mhome, ".config/fleet/config"), `${join(base, "fleet")}\n`);
    linkFleetSkill(mhome, join(base, "fleet"));
    mkdirSync(join(mhome, ".local/bin"), { recursive: true });
    symlinkSync(join(base, "fleet/bin/fleet"), join(mhome, ".local/bin/fleet"));
    return mhome;
  };
  const plan = (dest: string, p: SshPlan) => {
    const plans = JSON.parse(readFileSync(join(home, "fake-ssh.json"), "utf8"));
    writeFileSync(join(home, "fake-ssh.json"), JSON.stringify({ ...plans, [dest]: p }));
  };
  return { clone, remote, home, src, write, run, json, sshCalls, sshHosts, remoteHead, remoteSubject, sourceClone, watch, pushes, machine, plan };
}

const skillFile = (name: string) => ({ [`${name}/SKILL.md`]: `---\nname: ${name}\n---\n` });

test("a config that fails validation exits 2 before any commit", () => {
  const s = setup({ hosts: { server: "alice@server" } });
  const before = s.remoteHead();
  s.write("hosts/laptop.yaml", "nonsense: true\n");
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.invalid, r.stderr);
  assert.equal(doc.code, "invalid");
  assert.match(r.stderr, /unknown key 'nonsense'/);
  assert.equal(s.remoteHead(), before, "nothing was pushed");
  assert.notEqual(git(s.clone, "status", "--porcelain"), "", "the edit is still uncommitted");
  assert.equal(git(s.clone, "rev-parse", "HEAD"), before, "nothing was committed");
  assert.deepEqual(s.sshCalls(), []);
});

test("a secrets file without a sops key exits 2 before any commit, and its content is not printed", () => {
  const s = setup({ hosts: { server: "alice@server" } });
  const before = s.remoteHead();
  s.write("secrets/shared.enc.yaml", "DEPLOYER_ACCESS_TOKEN: plaintext-token-value\n");
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.invalid, r.stderr);
  assert.equal(doc.code, "invalid");
  assert.match(r.stderr, /secrets\/shared\.enc\.yaml.*sops/);
  assert.equal((r.stdout + r.stderr).includes("plaintext-token-value"), false);
  assert.equal(s.remoteHead(), before);
  assert.equal(git(s.clone, "rev-parse", "HEAD"), before);
  assert.deepEqual(s.sshCalls(), []);
});

test("a secrets file that cannot be read as YAML exits 2 too", () => {
  const s = setup();
  s.write("secrets/laptop.enc.yaml", "a: [unclosed\n");
  assert.equal(s.run().code, EXIT.invalid);
});

test("a secrets file with a sops key is pushed", () => {
  const s = setup();
  s.write("secrets/shared.enc.yaml", "A: ENC[AES256_GCM,data:abc]\nsops:\n  version: 3.11.0\n");
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(git(s.remote, "show", "main:secrets/shared.enc.yaml").includes("sops:"), true);
});

test("a ssh destination that looks like an option exits 2, and ssh is never called", () => {
  const s = setup({ hosts: { server: "-oProxyCommand=x" } });
  const r = s.run();
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /server.*ssh/);
  assert.deepEqual(s.sshCalls(), []);
});

test("a followed source's unpublished skill counts when validating the bundles", () => {
  const s = setup({ source: true });
  writeFileSync(join(s.clone, "hosts/laptop.yaml"), "bundles: [core]\n");
  s.write("catalog/skills.yaml", readFileSync(join(s.clone, "catalog/skills.yaml"), "utf8").replace("[planning]", "[planning, fresh]"));
  for (const [rel, content] of Object.entries(skillFile("fresh"))) {
    mkdirSync(dirname(join(s.sourceClone, rel)), { recursive: true });
    writeFileSync(join(s.sourceClone, rel), content);
  }
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(readlinkSync(join(s.home, ".claude/skills/fresh")), join(s.sourceClone, "fresh"));
});

test("validation still checks the bundles while the followed source holds unpublished work", () => {
  const s = setup({ source: true });
  writeFileSync(join(s.sourceClone, "notes.md"), "unpublished");
  s.write("catalog/skills.yaml", readFileSync(join(s.clone, "catalog/skills.yaml"), "utf8").replace("[planning]", "[planning, nowhere]"));
  const before = s.remoteHead();
  const r = s.run();
  assert.equal(r.code, EXIT.invalid, r.stderr);
  assert.match(r.stderr, /skill 'nowhere' is in no source/);
  assert.equal(s.remoteHead(), before);
  assert.notEqual(git(s.sourceClone, "status", "--porcelain"), "", "the source was not committed");
});

test("a dirty fleet clone is committed with a generated message and pushed", () => {
  const s = setup();
  s.write("notes.md", "one");
  s.write("more/notes.md", "two");
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(s.remoteSubject(), "fleet push from laptop: 2 files");
  assert.equal(git(s.clone, "status", "--porcelain"), "");
  assert.equal(git(s.clone, "rev-parse", "HEAD"), s.remoteHead());
});

test("-m is the commit message", () => {
  const s = setup();
  s.write("notes.md", "one");
  const r = s.run(["-m", "Tidy the notes"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(s.remoteSubject(), "Tidy the notes");
});

test("-m belongs to push alone, and cannot be empty", () => {
  const s = setup();
  assert.equal(runFleet(s.clone, ["apply", "-m", "x"], { home: s.home }).code, EXIT.invalid);
  assert.equal(s.run(["-m", ""]).code, EXIT.invalid);
  assert.equal(s.run(["-m"]).code, EXIT.invalid);
});

test("a clean fleet clone commits nothing and still applies", () => {
  const s = setup({ defaults: "files:\n  - { source: notes.md, target: ~/.claude/notes.md }\n" });
  s.write("notes.md", "one");
  publish(s.clone, "notes");
  const before = s.remoteHead();
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(s.remoteHead(), before);
  assert.equal(readlinkSync(join(s.home, ".claude/notes.md")), join(s.clone, "notes.md"));
});

test("a clone that is only behind is fast-forwarded", () => {
  const s = setup();
  const base = tempDir("fleet-elsewhere-");
  git(base, "clone", "--quiet", s.remote, "w");
  writeFileSync(join(base, "w/theirs.md"), "1");
  git(join(base, "w"), "add", "-A");
  git(join(base, "w"), "commit", "-m", "theirs");
  git(join(base, "w"), "push", "--quiet");
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(readFileSync(join(s.clone, "theirs.md"), "utf8"), "1");
});

test("the followed source is committed and pushed before the fleet clone", () => {
  const s = setup({ source: true });
  s.watch(s.src!.remote, "my-skills");
  s.watch(s.remote, "fleet");
  writeFileSync(join(s.sourceClone, "notes.md"), "a skill note");
  s.write("notes.md", "a fleet note");
  const r = s.run(["-m", "both"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(s.pushes(), ["my-skills", "fleet"]);
  assert.equal(git(s.src!.remote, "log", "-1", "--format=%s", "main"), "both");
  assert.equal(s.remoteSubject(), "both");
});

test("a clean source is not pushed to, and the source's generated message names the host", () => {
  const s = setup({ source: true });
  s.watch(s.src!.remote, "my-skills");
  assert.equal(s.run().code, EXIT.ok);
  assert.deepEqual(s.pushes(), []);
  writeFileSync(join(s.sourceClone, "notes.md"), "x");
  assert.equal(s.run().code, EXIT.ok);
  assert.equal(git(s.src!.remote, "log", "-1", "--format=%s", "main"), "fleet push from laptop: 1 files");
});

test("a diverged fleet clone exits 3 and stops: nothing is pushed and no host is touched", () => {
  const s = setup({ hosts: { server: "alice@server" }, ssh: { "alice@server": OK } });
  const base = tempDir("fleet-elsewhere-");
  git(base, "clone", "--quiet", s.remote, "w");
  writeFileSync(join(base, "w/theirs.md"), "1");
  git(join(base, "w"), "add", "-A");
  git(join(base, "w"), "commit", "-m", "theirs");
  git(join(base, "w"), "push", "--quiet");
  const theirs = s.remoteHead();
  s.write("mine.md", "1");
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.conflict, r.stderr);
  assert.equal(doc.code, "conflict");
  assert.equal(doc.conflicts[0].kind, "repo");
  assert.equal(doc.conflicts[0].path, s.clone);
  assert.match(doc.conflicts[0].detail, /diverged.*1 ahead.*1 behind/);
  assert.ok(doc.conflicts[0].fix.length > 0);
  assert.equal(s.remoteHead(), theirs, "GitHub was not changed");
  assert.deepEqual(s.sshCalls(), []);
});

test("a diverged source stops the push before the fleet clone is published", () => {
  const s = setup({ source: true });
  s.watch(s.remote, "fleet");
  s.src!.commit({ "theirs.md": "1" }, "theirs");
  // The source clone has not fetched that; give it a different local commit and let fleet fetch.
  writeFileSync(join(s.sourceClone, "mine.md"), "1");
  git(s.sourceClone, "add", "-A");
  git(s.sourceClone, "commit", "-m", "mine");
  s.write("notes.md", "fleet note");
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.conflict, r.stderr);
  assert.equal(doc.conflicts[0].kind, "repo");
  assert.match(doc.conflicts[0].detail, /diverged/);
  assert.deepEqual(s.pushes(), [], "the fleet clone was not pushed");
});

test("GitHub unreachable exits 4 before any host is touched", () => {
  const s = setup({ hosts: { server: "alice@server" }, ssh: { "alice@server": OK } });
  rmSync(s.remote, { recursive: true });
  const r = s.run();
  assert.equal(r.code, EXIT.unreachable, r.stderr);
  assert.deepEqual(s.sshCalls(), []);
});

test("a conflict in the local apply exits 3 and no other host is touched", () => {
  const s = setup({
    hosts: { alpha: "alice@alpha", server: "alice@server" },
    ssh: { "alice@alpha": OK, "alice@server": OK },
    defaults: "files:\n  - { source: notes.md, target: ~/.claude/notes.md }\n",
  });
  s.write("notes.md", "one");
  mkdirSync(join(s.home, ".claude"), { recursive: true });
  writeFileSync(join(s.home, ".claude/notes.md"), "a real file");
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.conflict, r.stderr);
  assert.deepEqual(s.sshCalls(), []);
  assert.deepEqual(doc.hosts.map((h: { host: string }) => h.host), ["laptop"], "only the local host ran");
  assert.equal(doc.hosts[0].result, "conflict");
  assert.equal(doc.hosts[0].conflicts[0].kind, "link");
  assert.equal(s.remoteSubject(), "fleet push from laptop: 1 files", "it was published before the apply");
});

test("a local apply that fails for another reason is reported, and the other hosts still run", () => {
  const s = setup({ hosts: { server: "alice@server" }, ssh: { "alice@server": OK } });
  mkdirSync(join(s.home, ".local/state/fleet/lock"), { recursive: true });
  writeFileSync(join(s.home, ".local/state/fleet/lock/pid"), `${process.pid}\n`);
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.error, r.stderr);
  assert.deepEqual(doc.hosts.map((h: { host: string; result: string }) => [h.host, h.result]), [["laptop", "error"], ["server", "ok"]]);
  assert.deepEqual(s.sshHosts(), ["alice@server"]);
});

test("remote hosts run in name order, with batch-mode ssh, a 10-second timeout and fleet by its ~/.local/bin path", () => {
  const s = setup({
    hosts: { zulu: "alice@zulu", alpha: "alice@alpha", mike: "alice@mike" },
    ssh: { "alice@zulu": OK, "alice@alpha": OK, "alice@mike": OK },
  });
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(s.sshCalls(), [
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "alice@alpha", "~/.local/bin/fleet apply --json"],
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "alice@mike", "~/.local/bin/fleet apply --json"],
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "alice@zulu", "~/.local/bin/fleet apply --json"],
  ]);
});

test("one failing host does not stop the others, and each gets its own record", () => {
  const s = setup({
    hosts: { alpha: "alice@alpha", bravo: "alice@bravo", charlie: "alice@charlie", delta: "alice@delta" },
    ssh: {
      "alice@alpha": UNREACHABLE,
      "alice@bravo": CONFLICT,
      "alice@charlie": { stdout: applyDoc("ok", { created: [{}, {}], updated: [{}], removed: [{}] }) },
      "alice@delta": { exit: 1, stdout: "not json" },
    },
  });
  const { r, doc } = s.json();
  assert.equal(s.sshCalls().length, 4);
  assert.equal(r.code, EXIT.conflict, "a conflict wins");
  assert.deepEqual(doc.hosts, [
    { host: "laptop", result: "ok", ...none, conflicts: [] },
    { host: "alpha", result: "unreachable", ...none, conflicts: [] },
    { host: "bravo", result: "conflict", ...none, conflicts: [{ kind: "link", path: "~/.claude/x.md", detail: "is a real file", fix: "move it" }] },
    { host: "charlie", result: "ok", changes: 4, created: [{}, {}], updated: [{}], removed: [{}], conflicts: [] },
    { host: "delta", result: "error", ...none, conflicts: [] },
  ]);
  assert.equal(doc.ok, false);
  assert.equal(doc.code, "conflict");
});

test("the exit code is conflict, then unreachable, then other", () => {
  const exitFor = (a: SshPlan, b: SshPlan, c: SshPlan) => {
    const s = setup({
      hosts: { alpha: "alice@alpha", bravo: "alice@bravo", charlie: "alice@charlie" },
      ssh: { "alice@alpha": a, "alice@bravo": b, "alice@charlie": c },
    });
    return s.run().code;
  };
  const ERROR: SshPlan = { exit: 1, stdout: applyDoc("error") };
  assert.equal(exitFor(ERROR, UNREACHABLE, CONFLICT), EXIT.conflict);
  assert.equal(exitFor(CONFLICT, UNREACHABLE, ERROR), EXIT.conflict);
  assert.equal(exitFor(ERROR, UNREACHABLE, OK), EXIT.unreachable);
  assert.equal(exitFor(UNREACHABLE, ERROR, OK), EXIT.unreachable);
  assert.equal(exitFor(OK, ERROR, OK), EXIT.error);
  assert.equal(exitFor(OK, OK, OK), EXIT.ok);
});

test("a remote apply that fails in some other way is an error record, not unreachable", () => {
  const s = setup({
    hosts: { server: "alice@server" },
    ssh: { "alice@server": { exit: 5, stdout: applyDoc("needs-secret") } },
  });
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.error);
  assert.equal(doc.hosts[1].result, "error");
  assert.match(r.stderr, /server/);
});

test("a host without ssh is reported as timer and does not affect the exit code", () => {
  const s = setup({
    hosts: { laptop2: null, server: "alice@server" },
    ssh: { "alice@server": OK },
  });
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(doc.hosts.find((h: { host: string }) => h.host === "laptop2"), { host: "laptop2", result: "timer", ...none, conflicts: [] });
  assert.deepEqual(s.sshHosts(), ["alice@server"], "a timer host is never reached");
});

test("a timer host does not hide another host's failure", () => {
  const s = setup({ hosts: { laptop2: null, server: "alice@server" }, ssh: { "alice@server": UNREACHABLE } });
  assert.equal(s.run().code, EXIT.unreachable);
});

test("the human output lists each host with its result and the fix for a conflict", () => {
  const s = setup({
    hosts: { alpha: "alice@alpha", bravo: "alice@bravo", laptop2: null },
    ssh: { "alice@alpha": UNREACHABLE, "alice@bravo": CONFLICT },
  });
  const r = s.run();
  assert.equal(r.code, EXIT.conflict);
  assert.match(r.stdout, /^laptop: ok \(\d+\.\ds\)$/m);
  assert.match(r.stdout, /^alpha: unreachable$/m);
  assert.match(r.stdout, /^bravo: conflict \(\d+\.\ds\)$/m);
  assert.match(r.stdout, /~\/\.claude\/x\.md: is a real file/);
  assert.match(r.stdout, /\n {2}fix: move it/);
  assert.match(r.stdout, /^laptop2: timer$/m);
});

test("the local host is never reached over ssh, even with ssh set in its own file", () => {
  const s = setup({ hosts: { server: "alice@server" }, ssh: { "alice@server": OK }, laptop: "ssh: alice@laptop\n" });
  assert.equal(s.run().code, EXIT.ok);
  assert.deepEqual(s.sshHosts(), ["alice@server"]);
});

test("the remote host really applies the change, by the fleet it has at ~/.local/bin/fleet", () => {
  const s = setup({
    hosts: { server: "alice@server" },
    defaults: "files:\n  - { source: notes.md, target: ~/.claude/notes.md }\n",
  });
  const rhome = s.machine("server");
  s.plan("alice@server", { home: rhome });
  s.write("notes.md", "one");
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(doc.hosts.map((h: { host: string; result: string; changes: number }) => [h.host, h.result, h.changes]), [["laptop", "ok", 1], ["server", "ok", 1]]);
  assert.match(readlinkSync(join(rhome, ".claude/notes.md")), /notes\.md$/);
  assert.equal(existsSync(join(rhome, ".local/state/fleet/applied.json")), true);
});

test("a conflict on the remote host is reported with its details, and its exit is 3", () => {
  const s = setup({
    hosts: { server: "alice@server" },
    defaults: "files:\n  - { source: notes.md, target: ~/.claude/notes.md }\n",
  });
  const rhome = s.machine("server");
  mkdirSync(join(rhome, ".claude"), { recursive: true });
  writeFileSync(join(rhome, ".claude/notes.md"), "already here");
  s.plan("alice@server", { home: rhome });
  s.write("notes.md", "one");
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.conflict, r.stderr);
  assert.equal(doc.hosts[0].result, "ok", "the local host applied");
  assert.equal(doc.hosts[1].result, "conflict");
  assert.equal(doc.hosts[1].conflicts[0].kind, "link");
});

test("the document shape: ok, code, host and one record per host", () => {
  const s = setup({ hosts: { server: null } });
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(doc.ok, true);
  assert.equal(doc.code, "ok");
  assert.equal(doc.host, "laptop");
  assert.deepEqual(doc.hosts, [
    { host: "laptop", result: "ok", ...none, conflicts: [] },
    { host: "server", result: "timer", ...none, conflicts: [] },
  ]);
});

const MIXED: SshPlan = {
  stdout: applyDoc("ok", {
    created: [{ file: "~/.claude/settings.json", path: "env.TOKEN" }, { target: "~/.claude/a.md", source: "/x/a.md" }, { target: "~/.claude/b.md", source: "/x/b.md" }],
    updated: [{ file: "~/.claude/settings.json", path: "model" }],
    removed: [{ target: "~/.claude/old.md" }],
    forgotten: ["~/.claude/gone.md"],
    unchanged: ["~/.claude/same.md"],
  }),
};

test("an ok host carries the lists apply reported, and changes stays the count", () => {
  const s = setup({ hosts: { server: "alice@server" }, ssh: { "alice@server": MIXED } });
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.ok, r.stderr);
  const server = doc.hosts[1];
  assert.deepEqual(Object.keys(server).sort(), ["changes", "conflicts", "created", "host", "removed", "result", "updated"]);
  assert.equal(server.changes, 5);
  assert.deepEqual(server.created, [{ file: "~/.claude/settings.json", path: "env.TOKEN" }, { target: "~/.claude/a.md", source: "/x/a.md" }, { target: "~/.claude/b.md", source: "/x/b.md" }]);
  assert.deepEqual(server.updated, [{ file: "~/.claude/settings.json", path: "model" }]);
  assert.deepEqual(server.removed, [{ target: "~/.claude/old.md" }]);
  assert.equal(server.result, "ok");
});

test("timer, unreachable and error hosts have empty lists", () => {
  const s = setup({ hosts: { a: null, b: "alice@b", c: "alice@c" }, ssh: { "alice@b": UNREACHABLE, "alice@c": { exit: 1, stdout: "garbage" } } });
  const { doc } = s.json();
  assert.deepEqual(doc.hosts.map((h: { host: string; result: string }) => [h.host, h.result]), [["laptop", "ok"], ["a", "timer"], ["b", "unreachable"], ["c", "error"]]);
  for (const h of doc.hosts.slice(1)) assert.deepEqual([h.changes, h.created, h.updated, h.removed], [0, [], [], []], h.host);
});

test("the summary counts changes by kind and shows each applied host's time", () => {
  const keysOnly: SshPlan = { stdout: applyDoc("ok", { created: [{ file: "f", path: "a" }], updated: [{ file: "f", path: "b" }] }) };
  const oneLink: SshPlan = { stdout: applyDoc("ok", { created: [{ target: "t", source: "s" }] }) };
  const s = setup({ hosts: { m: "alice@m", k: "alice@k", l: "alice@l", t: null }, ssh: { "alice@m": MIXED, "alice@k": keysOnly, "alice@l": oneLink } });
  const r = s.run();
  assert.match(r.stdout, /^laptop: ok \(\d+\.\ds\)$/m);
  assert.match(r.stdout, /^m: ok · 3 links, 2 keys \(\d+\.\ds\)$/m);
  assert.match(r.stdout, /^k: ok · 2 keys \(\d+\.\ds\)$/m);
  assert.match(r.stdout, /^l: ok · 1 link \(\d+\.\ds\)$/m);
  assert.match(r.stdout, /^t: timer$/m);
});

test("a secret-backed setting reaches the push document as its key path, never its value", () => {
  const TOKEN = "tok-plaintext-9f3";
  const s = setup();
  s.write("catalog/mcp.yaml", "servers:\n  tracker:\n    command: [npx, -y, \"@example/tracker-mcp@1.0.2\"]\n    env:\n      TRACKER_API_KEY: secret:TRACKER_API_KEY\n");
  const keygen = findTool("age-keygen")!;
  mkdirSync(join(s.home, ".local/bin"), { recursive: true });
  for (const [name, path] of [["sops", findTool("sops")!], ["age-keygen", keygen]] as const) symlinkSync(path, join(s.home, ".local/bin", name));
  const key = spawnSync(keygen, [], { encoding: "utf8" }).stdout;
  const recipient = spawnSync(keygen, ["-y"], { encoding: "utf8", input: key }).stdout.trim();
  mkdirSync(join(s.home, ".config/fleet"), { recursive: true });
  writeFileSync(join(s.home, ".config/fleet/age.key"), key, { mode: 0o600 });
  s.write("hosts/laptop.yaml", `admin: true\nage: ${recipient}\nmcp:\n  include: [tracker]\n`);
  assert.equal(runFleet(s.clone, ["secrets", "set", "shared", "TRACKER_API_KEY"], { home: s.home, input: TOKEN }).code, EXIT.ok);
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.ok, r.stderr);
  // Claude's entry is only there when claude is installed; opencode's always is.
  const created = doc.hosts[0].created as { file: string; path: string }[];
  assert.deepEqual(created.find((e) => e.file.includes("opencode")), { file: "~/.config/opencode/opencode.jsonc", path: "mcp.tracker" }, "the key is listed by file and path");
  for (const e of created) assert.match(e.path, /tracker$/);
  assert.equal(r.stdout.includes(TOKEN) || r.stderr.includes(TOKEN), false, "the value is in neither output");
  assert.equal(readFileSync(join(s.home, ".config/opencode/opencode.jsonc"), "utf8").includes(TOKEN), true, "the secret did reach the file");
});

const PUSH_LOCK = ".local/state/fleet/push.lock";
const holdPushLock = (home: string, pid: number | string) => {
  mkdirSync(join(home, PUSH_LOCK), { recursive: true });
  writeFileSync(join(home, PUSH_LOCK, "pid"), `${pid}\n`);
};

test("a push is refused at once while another push holds the lock, and touches nothing", () => {
  const s = setup({ hosts: { server: "alice@server" }, ssh: { "alice@server": OK } });
  s.write("notes.md", "one\n");
  const before = s.remoteHead();
  holdPushLock(s.home, process.pid);
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.locked, r.stderr);
  assert.equal(doc.code, "locked");
  assert.equal(doc.ok, false);
  assert.match(r.stderr, new RegExp(`a push is already running \\(pid ${process.pid}\\)`));
  assert.equal(s.remoteHead(), before);
  assert.deepEqual(s.sshCalls(), []);
  assert.equal(readFileSync(join(s.home, PUSH_LOCK, "pid"), "utf8"), `${process.pid}\n`, "the holder's lock is left alone");
  const plain = s.run();
  assert.equal(plain.code, EXIT.locked);
  assert.match(plain.stderr, /a push is already running/);
});

test("the apply lock does not stop a push", () => {
  const s = setup();
  mkdirSync(join(s.home, ".local/state/fleet/lock"), { recursive: true });
  writeFileSync(join(s.home, ".local/state/fleet/lock/pid"), `${process.pid}\n`);
  // The push applies here as its own apply, which the held apply lock refuses; the push itself was not refused.
  assert.doesNotMatch(s.run().stderr, /a push is already running/);
});

test("a push lock left by a process that is gone is taken over, and the lock is gone after the push", () => {
  const s = setup();
  holdPushLock(s.home, 2 ** 22 + 12345);
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(existsSync(join(s.home, PUSH_LOCK)), false);
});

test("the push lock is gone after a push that fails, and after one whose config does not load", () => {
  const s = setup({ hosts: { server: "alice@server" }, ssh: { "alice@server": UNREACHABLE } });
  assert.equal(s.run().code, EXIT.unreachable);
  assert.equal(existsSync(join(s.home, PUSH_LOCK)), false);
  s.write("hosts/laptop.yaml", "nonsense: true\n");
  assert.equal(s.run().code, EXIT.invalid);
  assert.equal(existsSync(join(s.home, PUSH_LOCK)), false);
});

const STAMP = /^\d\d:\d\d:\d\d /;

test("piped, push prints a timestamped line when each host starts and when it has a result, and the host's own text, and no line per step", () => {
  const s = setup({ hosts: { server: "alice@server", edge: null }, ssh: { "alice@server": { ...OK, stderr: "fleet: a note from the host" } } });
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  const lines = r.stderr.split("\n").filter((l) => l !== "");
  const stamped = lines.filter((l) => STAMP.test(l)).map((l) => l.replace(STAMP, "").replace(/\(\d+\.\ds\)/, "(T)"));
  assert.deepEqual(stamped.filter((l) => !/^laptop: running from /.test(l)), ["laptop: started", "laptop: ok (T)", "edge: started", "edge: timer", "server: started", "server: a note from the host", "server: ok (T)"]);
  assert.ok(stamped.some((l) => /^laptop: running from /.test(l)), "the local apply's own text gets its host's name too");
  for (const line of lines) assert.doesNotMatch(line, /write-|sync|plan|\u001b|█/, `a plain line is not a step or a drawing: ${line}`);
  assert.doesNotMatch(r.stderr, /pushed in/, "no summary block when piped");
});

test("what a push prints on stdout and in --json does not depend on how stderr is shown", () => {
  const s = setup({ hosts: { server: "alice@server" }, ssh: { "alice@server": OK } });
  const normal = (text: string) => text.replace(/\(\d+\.\ds\)/g, "(T)");
  const plain = s.run();
  assert.equal(normal(plain.stdout), "laptop: ok (T)\nserver: ok (T)\n");
  const events = s.run([], { FLEET_EVENTS: "1" });
  assert.equal(normal(events.stdout), normal(plain.stdout), "the same text with the events on stderr");
  const a = JSON.parse(s.run(["--json"]).stdout);
  const b = JSON.parse(s.run(["--json"], { FLEET_EVENTS: "1" }).stdout);
  assert.deepEqual(a, b);
  assert.deepEqual(Object.keys(a), ["ok", "code", "host", "messages", "hosts"]);
});

test("ctrl-c: the summary so far, exit 130, and the push lock is let go", async () => {
  const s = setup({ hosts: { alpha: "me@alpha", slow: "me@slow", zed: "me@zed" }, ssh: { "me@alpha": OK, "me@slow": { ...OK, delay: 8_000 }, "me@zed": OK } });
  const child = spawn(join(s.clone, "bin/fleet"), ["push"], {
    env: { PATH: "/usr/bin:/bin", HOME: s.home, FLEET_NODE: process.execPath, FLEET_CONFIG: s.clone, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let [stdout, stderr] = ["", ""];
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  const until = Date.now() + 20_000;
  while (!s.sshHosts().includes("me@slow") && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  assert.ok(s.sshHosts().includes("me@slow"), "the push reached the slow host");
  assert.equal(existsSync(join(s.home, PUSH_LOCK)), true, "the lock is held while it runs");
  child.kill("SIGINT");
  assert.equal(await closed, 130);
  assert.match(stderr, /alpha: ok/);
  assert.match(stderr, /slow: interrupted \(\d+\.\ds\)/);
  assert.match(stderr, /zed: not reached/);
  assert.match(stderr, /interrupted after \d+\.\ds: 2 ok, 1 interrupted, 1 not reached/);
  assert.equal(stdout, "", "no result document is printed for a push that was cut short");
  assert.equal(existsSync(join(s.home, PUSH_LOCK)), false, "the lock is gone");
  assert.deepEqual(s.sshHosts(), ["me@alpha", "me@slow"], "the host after it was never asked");
});

const HERE_NOTE = { defaults: "files:\n  - { source: notes.md, target: ~/.claude/notes.md }\n" };

test("--host box applies only on box: over ssh, and not on this host", () => {
  const s = setup({ ...HERE_NOTE, hosts: { box: "alice@box", server: "alice@server", edge: null }, ssh: { "alice@box": OK, "alice@server": OK } });
  s.write("notes.md", "one");
  const { r, doc } = s.json(["--host", "box"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(s.sshHosts(), ["alice@box"]);
  assert.deepEqual(doc.hosts.map((h: { host: string }) => h.host), ["box"]);
  assert.equal(existsSync(join(s.home, ".claude/notes.md")), false, "this host was not applied");
  assert.equal(s.remoteSubject(), "fleet push from laptop: 1 files", "it was published as usual");
});

test("--host box does not let a conflict on this host stop it", () => {
  const s = setup({ ...HERE_NOTE, hosts: { box: "alice@box" }, ssh: { "alice@box": OK } });
  s.write("notes.md", "one");
  mkdirSync(join(s.home, ".claude"), { recursive: true });
  writeFileSync(join(s.home, ".claude/notes.md"), "a real file");
  const { r, doc } = s.json(["--host", "box"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(doc.hosts.map((h: { host: string; result: string }) => [h.host, h.result]), [["box", "ok"]]);
});

test("--host <this host> publishes and applies here only", () => {
  const s = setup({ ...HERE_NOTE, hosts: { box: "alice@box" }, ssh: { "alice@box": OK } });
  s.write("notes.md", "one");
  const { r, doc } = s.json(["--host", "laptop"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(s.sshCalls(), []);
  assert.deepEqual(doc.hosts.map((h: { host: string }) => h.host), ["laptop"]);
  assert.equal(readFileSync(join(s.home, ".claude/notes.md"), "utf8"), "one");
  assert.equal(s.remoteSubject(), "fleet push from laptop: 1 files");
});

test("--host with a timer host or an unknown name exits 2 with the reason, before anything is published", () => {
  const s = setup({ hosts: { box: "alice@box", edge: null }, ssh: { "alice@box": OK } });
  s.write("notes.md", "one");
  const before = s.remoteHead();
  const timer = s.json(["--host", "edge"]);
  assert.equal(timer.r.code, EXIT.invalid);
  assert.deepEqual(timer.doc.messages, ["fleet: edge has no ssh destination; it applies on its own timer"]);
  const unknown = s.json(["--host", "nope"]);
  assert.equal(unknown.r.code, EXIT.invalid);
  assert.deepEqual(unknown.doc.messages, ["fleet: unknown host 'nope'; the hosts are box, edge, laptop"]);
  assert.equal(s.remoteHead(), before, "nothing was published");
  assert.equal(git(s.clone, "status", "--porcelain").includes("notes.md"), true, "nothing was committed");
  assert.deepEqual(s.sshCalls(), []);
});

test("--host takes the push lock like a push does", () => {
  const s = setup({ hosts: { box: "alice@box" }, ssh: { "alice@box": OK } });
  s.write("notes.md", "one\n");
  const before = s.remoteHead();
  holdPushLock(s.home, process.pid);
  const { r, doc } = s.json(["--host", "box"]);
  assert.equal(r.code, EXIT.locked, r.stderr);
  assert.equal(doc.code, "locked");
  assert.equal(s.remoteHead(), before);
  assert.deepEqual(s.sshCalls(), []);
});

test("--host is for bridge and push alone", () => {
  const s = setup();
  const r = runFleet(s.clone, ["apply", "--host", "laptop"], { home: s.home });
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /--host is only for 'bridge' and 'push'/);
});

const JOURNAL = ".local/state/fleet/pushes";
const journalFiles = (home: string): string[] => {
  try {
    return readdirSync(join(home, JOURNAL)).sort();
  } catch {
    return [];
  }
};

test("a push writes its journal: a header, then its events with their times, private to the user", () => {
  const s = setup({ hosts: { server: "alice@server" }, ssh: { "alice@server": OK } });
  s.write("notes.md", "one");
  assert.equal(s.run().code, EXIT.ok);
  const files = journalFiles(s.home);
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^\d{8}T\d{6}\.\d{3}Z-\d+\.jsonl$/, "a sortable UTC time without colons, and the pid");
  assert.equal(statSync(join(s.home, JOURNAL)).mode & 0o777, 0o700);
  assert.equal(statSync(join(s.home, JOURNAL, files[0]!)).mode & 0o777, 0o600);
  const lines = readFileSync(join(s.home, JOURNAL, files[0]!), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const [header, ...events] = lines;
  assert.equal(header.journal, 1);
  assert.equal(header.v, EVENT_VERSION);
  assert.equal(header.commit, git(s.clone, "rev-parse", "HEAD"), "the commit pushed");
  assert.equal(header.only, null);
  assert.deepEqual(header.hosts, ["laptop", "server"]);
  assert.equal(header.result, "ok");
  assert.equal(header.interrupted, false);
  assert.ok(header.ms >= 0 && Date.parse(header.time) > 0);
  assert.equal(header.end.code, "ok");
  assert.deepEqual(events.slice(0, 2).map((e) => [e.event, e.stage]), [["stage", "validate"], ["hosts", undefined]]);
  assert.ok(events.some((e) => e.event === "host" && e.host === "server" && e.state === "done"));
  for (const e of events) {
    assert.equal(e.v, EVENT_VERSION);
    assert.equal(typeof e.t, "number");
  }
  assert.deepEqual(events.map((e) => e.t), [...events.map((e) => e.t)].sort((a, b) => a - b), "in the order they arrived");
});

test("the journal is written whether or not the events are on stderr, and a --host push says which host it was for", () => {
  const s = setup({ hosts: { box: "alice@box", server: "alice@server" }, ssh: { "alice@box": OK, "alice@server": OK } });
  assert.equal(s.run([], { FLEET_EVENTS: "1" }).code, EXIT.ok);
  assert.equal(s.run(["--host", "box"]).code, EXIT.ok);
  const entries = listJournals(s.home);
  assert.deepEqual(entries.map((e) => [e.header.only, e.header.hosts]), [["box", ["box"]], [null, ["laptop", "box", "server"]]], "newest first");
});

test("only the last 20 journals are kept; older ones are deleted when a new one is written", () => {
  const s = setup({ ssh: {} });
  mkdirSync(join(s.home, JOURNAL), { recursive: true });
  const old = (i: number) => `2020010${i % 10}T0${Math.floor(i / 10)}0000.000Z-1.jsonl`;
  for (let i = 0; i < 24; i++) writeFileSync(join(s.home, JOURNAL, old(i)), `${JSON.stringify({ journal: 1, v: 1, time: "2020-01-01T00:00:00Z", commit: null, only: null, hosts: ["laptop"], ms: 1, interrupted: false, result: "ok", end: null })}\n`);
  writeFileSync(join(s.home, JOURNAL, "notes.txt"), "not a journal");
  assert.equal(s.run().code, EXIT.ok);
  const files = journalFiles(s.home).filter((f) => f.endsWith(".jsonl"));
  assert.equal(files.length, 20);
  assert.ok(files.at(-1)!.startsWith(String(new Date().getUTCFullYear())), "the new one is kept");
  assert.equal(files.filter((f) => f.startsWith("2020")).length, 19);
  assert.ok(existsSync(join(s.home, JOURNAL, "notes.txt")), "what is not a journal is left alone");
});

test("a push that is refused before it starts writes no journal", () => {
  const s = setup({ hosts: { box: "alice@box", edge: null }, ssh: { "alice@box": OK } });
  assert.equal(s.run(["--host", "nope"]).code, EXIT.invalid);
  assert.equal(s.run(["--host", "edge"]).code, EXIT.invalid);
  s.write("hosts/laptop.yaml", "nonsense: true\n");
  assert.equal(s.run().code, EXIT.invalid);
  mkdirSync(join(s.home, PUSH_LOCK), { recursive: true });
  writeFileSync(join(s.home, PUSH_LOCK, "pid"), `${process.pid}\n`);
  assert.equal(s.run().code, EXIT.locked);
  assert.deepEqual(journalFiles(s.home), []);
});

test("a push that stopped on a conflict still has a journal, with the result", () => {
  const s = setup({ ...HERE_NOTE });
  s.write("notes.md", "one");
  mkdirSync(join(s.home, ".claude"), { recursive: true });
  writeFileSync(join(s.home, ".claude/notes.md"), "a real file");
  assert.equal(s.run().code, EXIT.conflict);
  const [entry] = listJournals(s.home);
  assert.equal(entry!.header.result, "conflict");
  assert.equal(entry!.header.interrupted, false);
});

test("ctrl-c keeps a partial journal, marked as interrupted", async () => {
  const s = setup({ hosts: { alpha: "me@alpha", slow: "me@slow" }, ssh: { "me@alpha": OK, "me@slow": { ...OK, delay: 8_000 } } });
  const child = spawn(join(s.clone, "bin/fleet"), ["push"], {
    env: { PATH: "/usr/bin:/bin", HOME: s.home, FLEET_NODE: process.execPath, FLEET_CONFIG: s.clone, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  const until = Date.now() + 20_000;
  while (!s.sshHosts().includes("me@slow") && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  child.kill("SIGINT");
  assert.equal(await closed, 130);
  const stored = readJournal(journalFiles(s.home)[0]!, s.home)!;
  assert.equal(stored.header.interrupted, true);
  assert.equal(stored.header.result, null);
  assert.equal(stored.header.commit, git(s.clone, "rev-parse", "HEAD"));
  assert.deepEqual(stored.header.hosts, ["laptop", "alpha", "slow"]);
  assert.ok(stored.events.some((e) => e.event.event === "host" && e.event.host === "alpha" && e.event.state === "done"), "what happened before is kept");
  assert.ok(!stored.events.some((e) => e.event.event === "host" && e.event.host === "slow" && e.event.state === "done"));
});

test("a journal that cannot be written is a message, and the push still succeeds", () => {
  const s = setup({ hosts: { server: "alice@server" }, ssh: { "alice@server": OK } });
  mkdirSync(join(s.home, ".local/state/fleet"), { recursive: true });
  writeFileSync(join(s.home, JOURNAL), "a file where the directory should be");
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(doc.code, "ok");
  assert.match(r.stderr, /fleet: could not write the push journal/);
  assert.equal(doc.messages.some((m: string) => /push journal/.test(m)), true);
});

test("a replay of a real push, run through the reducer, ends where the push did", () => {
  const s = setup({ hosts: { server: "alice@server" }, ssh: { "alice@server": { ...OK, stdout: applyDoc("ok", { created: [{ target: "~/.claude/a.md" }] }) } } });
  s.write("notes.md", "one");
  assert.equal(s.run().code, EXIT.ok);
  const stored = readJournal(journalFiles(s.home)[0]!, s.home)!;
  // The original run: the same events at their own times, then the end.
  let run = startRun(stored.header.hosts.map((name) => ({ name, ssh: null, self: false })), 1000);
  for (const { t, event } of stored.events) run = reduce(run, event, 1000 + t);
  const end = readEnd(0, JSON.stringify(stored.header.end));
  const original = finish(run, end, 1000 + stored.header.ms);
  let replay = startReplay(stored, 1000);
  replay = advanceReplay(replay, 1000 + stored.header.ms - 1);
  assert.equal(replay.over, false, "not over before its time");
  replay = advanceReplay(replay, 1000 + stored.header.ms + 5000);
  assert.equal(replay.over, true);
  assert.deepEqual(replay.run, original);
  assert.equal(replay.run.end?.code, "ok");
  assert.equal(replay.run.lanes.find((l) => l.host === "server")?.state, "done");
});
