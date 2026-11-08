import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, installFakeSsh, installStatusTools, makeClone, makeHome, publish, runFleet, tempDir, toolCalls } from "./helpers.ts";
import type { SshPlan } from "./helpers.ts";
import { EXIT } from "../src/exit.ts";

const REMOTE_COMMAND = "~/.local/bin/fleet status --json";

const statusDoc = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ok: true,
    code: "ok",
    host: "remote",
    messages: [],
    repos: { fleet: { branch: "main", sha: "abc123", clean: true, ahead: 0, behind: 0 } },
    applied: { at: "2026-10-30T10:00:00Z", ageSeconds: 600, config: null },
    timer: "active",
    pending: 0,
    conflicts: 0,
    tools: { claude: "2.1.4", opencode: "1.4.2", sops: "3.13.3", node: "22.18.0", t3: "0.1.0" },
    ...over,
  });

const OK: SshPlan = { stdout: statusDoc() };
const UNREACHABLE: SshPlan = { exit: 255, stderr: "ssh: connect to host x port 22: Connection timed out" };

type Host = { name: string; ssh: string | null };
type HostRecord = { host: string; result: string; status: any; detail?: string };

function setup(hosts: Host[], ssh: Record<string, SshPlan>) {
  const { clone, remote } = makeClone();
  const home = makeHome("laptop");
  mkdirSync(join(clone, "hosts"), { recursive: true });
  for (const h of [{ name: "laptop", ssh: "alice@laptop" }, ...hosts]) writeFileSync(join(clone, "hosts", `${h.name}.yaml`), h.ssh === null ? "{}\n" : `ssh: ${h.ssh}\n`);
  publish(clone, "hosts");
  installStatusTools(home);
  // Always installed: with the real ssh on the probe path a test could reach a real host.
  installFakeSsh(home, ssh);
  const json = (extra: string[] = []) => {
    const r = runFleet(clone, ["status", "--all", "--json", ...extra], { home });
    return { r, doc: JSON.parse(r.stdout) as { ok: boolean; code: string; host: string; hosts: HostRecord[]; tools: Record<string, string> } };
  };
  return { clone, remote, home, json, calls: () => toolCalls(home, "ssh") };
}

const byHost = (records: HostRecord[], name: string) => records.find((r) => r.host === name)!;

test("status --all asks each host with ssh for its status over ssh, in name order, and not this host", () => {
  const s = setup(
    [{ name: "server", ssh: "alice@server" }, { name: "box", ssh: "alice@box" }],
    { "alice@server": { stdout: statusDoc({ host: "server", pending: 4 }) }, "alice@box": OK, "alice@laptop": OK },
  );
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(doc.ok, true);
  assert.deepEqual(s.calls(), [
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "alice@box", REMOTE_COMMAND],
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "alice@server", REMOTE_COMMAND],
  ]);
  assert.deepEqual(doc.hosts.map((h) => [h.host, h.result]), [["box", "ok"], ["laptop", "ok"], ["server", "ok"]]);
  assert.equal(byHost(doc.hosts, "server").status.pending, 4);
  assert.equal(byHost(doc.hosts, "server").status.tools.t3, "0.1.0");
});

test("this host is read in place, so the top level and its record carry its own status", () => {
  const s = setup([{ name: "server", ssh: "alice@server" }], { "alice@server": OK });
  const { doc } = s.json();
  assert.equal(doc.host, "laptop");
  const local = byHost(doc.hosts, "laptop");
  assert.equal(local.result, "ok");
  assert.equal(local.status.tools.claude, "2.1.4");
  assert.equal(local.status.timer, "active");
  assert.equal(local.status.repos.fleet.sha, git(s.clone, "rev-parse", "HEAD"));
});

test("an unreachable host is marked, the others are still asked, and the exit is 4", () => {
  const s = setup(
    [{ name: "a", ssh: "alice@a" }, { name: "b", ssh: "alice@b" }, { name: "c", ssh: "alice@c" }],
    { "alice@a": OK, "alice@b": UNREACHABLE, "alice@c": OK },
  );
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.unreachable, r.stderr);
  assert.equal(doc.ok, false);
  assert.equal(doc.code, "unreachable");
  assert.equal(byHost(doc.hosts, "b").result, "unreachable");
  assert.equal(byHost(doc.hosts, "b").status, null);
  assert.equal(byHost(doc.hosts, "a").result, "ok");
  assert.equal(byHost(doc.hosts, "c").result, "ok");
  assert.equal(s.calls().length, 3);
  assert.match(r.stderr, /b: unreachable over ssh/);
});

test("an ssh that cannot even start counts as unreachable", () => {
  const s = setup([{ name: "a", ssh: "alice@a" }], {});
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.unreachable);
  assert.equal(byHost(doc.hosts, "a").result, "unreachable");
});

test("a host with no ssh destination is reported as timer and leaves the exit code alone", () => {
  const s = setup([{ name: "quiet", ssh: null }, { name: "a", ssh: "alice@a" }], { "alice@a": OK });
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(byHost(doc.hosts, "quiet").result, "timer");
  assert.equal(byHost(doc.hosts, "quiet").status, null);
  assert.deepEqual(s.calls().map((c) => c[4]), ["alice@a"]);
});

test("an answer that is not a status document is an error with exit 1, and unreachable still wins over it", () => {
  const s = setup(
    [{ name: "a", ssh: "alice@a" }, { name: "b", ssh: "alice@b" }],
    { "alice@a": { stdout: "sh: fleet: not found", exit: 127 }, "alice@b": OK },
  );
  const first = s.json();
  assert.equal(first.r.code, EXIT.error, first.r.stderr);
  assert.equal(first.doc.code, "error");
  assert.equal(byHost(first.doc.hosts, "a").result, "error");
  assert.equal(byHost(first.doc.hosts, "b").result, "ok");

  const t = setup(
    [{ name: "a", ssh: "alice@a" }, { name: "b", ssh: "alice@b" }],
    { "alice@a": { stdout: "garbage", exit: 1 }, "alice@b": UNREACHABLE },
  );
  assert.equal(t.json().r.code, EXIT.unreachable);
});

test("a host whose status could not be computed is an error that says which code it gave", () => {
  const s = setup([{ name: "a", ssh: "alice@a" }], { "alice@a": { stdout: JSON.stringify({ ok: false, code: "missing-prerequisite", host: "a", messages: ["fleet: git is not installed"] }), exit: 6 } });
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.error, r.stderr);
  const a = byHost(doc.hosts, "a");
  assert.equal(a.result, "error");
  assert.equal(a.status, null);
  assert.match(a.detail ?? "", /missing-prerequisite/);
  assert.match(a.detail ?? "", /git is not installed/);
});

test("what a remote host sends is cut down to the expected fields and printable text", () => {
  const s = setup([{ name: "a", ssh: "alice@a" }], { "alice@a": { stdout: statusDoc({ timer: "active\u001b[31m", extra: "ignored", tools: { claude: "2.1.4\u0007", opencode: 7 } }) } });
  const { doc } = s.json();
  const a = byHost(doc.hosts, "a").status;
  assert.equal(a.timer, "active?[31m");
  assert.equal(a.extra, undefined);
  assert.deepEqual(a.tools, { claude: "2.1.4?", opencode: null, sops: null, node: null, t3: null });
  const human = runFleet(s.clone, ["status", "--all"], { home: s.home });
  assert.equal(human.stdout.includes("\u001b"), false);
  assert.equal(human.stdout.includes("\u0007"), false);
});

test("a newer host's conflictList is passed through as kind and path, cut to printable text of bounded length", () => {
  const list = [
    { kind: "link", path: "~/.claude/CLAUDE.md", detail: "ignored", fix: "ignored" },
    { kind: "ke\u001by", path: `~/${"p".repeat(300)}` },
    "nonsense",
    { kind: "link" },
    { kind: "link", path: "~/c" },
    { kind: "link", path: "~/d" },
    { kind: "link", path: "~/e" },
  ];
  const s = setup([{ name: "a", ssh: "alice@a" }, { name: "b", ssh: "alice@b" }, { name: "c", ssh: "alice@c" }], {
    "alice@a": { stdout: statusDoc({ conflicts: 7, conflictList: list }) },
    "alice@b": OK,
    "alice@c": { stdout: statusDoc({ conflicts: 2, conflictList: "link ~/x" }) },
  });
  const { doc } = s.json();
  const a = byHost(doc.hosts, "a").status.conflictList;
  assert.deepEqual(a.slice(0, 2), [{ kind: "link", path: "~/.claude/CLAUDE.md" }, { kind: "ke?y", path: `~/${"p".repeat(198)}` }]);
  assert.ok(a.length <= 5, "bounded");
  assert.deepEqual(a.at(-1), { kind: "link", path: "~/c" }, "an entry without a path or that is not an object is dropped");
  assert.equal(byHost(doc.hosts, "b").status.conflictList, null, "a host on an older fleet has none, and is not an error");
  assert.equal(byHost(doc.hosts, "b").result, "ok");
  assert.equal(byHost(doc.hosts, "c").status.conflictList, null, "a list that is not a list is none");
});

test("this host in status --all carries its own conflictList", () => {
  const s = setup([{ name: "a", ssh: "alice@a" }], { "alice@a": OK });
  assert.deepEqual(byHost(s.json().doc.hosts, "laptop").status.conflictList, []);
});

test("human output has one block per host and names the unreachable one", () => {
  const s = setup([{ name: "a", ssh: "alice@a" }, { name: "b", ssh: "alice@b" }, { name: "c", ssh: null }], { "alice@a": OK, "alice@b": UNREACHABLE });
  const r = runFleet(s.clone, ["status", "--all"], { home: s.home });
  assert.equal(r.code, EXIT.unreachable);
  assert.match(r.stdout, /^a: ok$/m);
  assert.match(r.stdout, /^b: unreachable$/m);
  assert.match(r.stdout, /^c: timer \(no ssh destination; it applies on its own schedule\)$/m);
  assert.match(r.stdout, /^laptop \(this host\): ok$/m);
  assert.match(r.stdout, /^ {2}timer: active$/m);
  assert.match(r.stdout, /^ {2}pending: 0$/m);
});

test("status without --all never calls ssh", () => {
  const s = setup([{ name: "a", ssh: "alice@a" }], { "alice@a": OK });
  const r = runFleet(s.clone, ["status", "--json"], { home: s.home });
  assert.equal(r.code, EXIT.ok);
  assert.deepEqual(s.calls(), []);
  assert.equal(JSON.parse(r.stdout).hosts, undefined);
});

test("--all is only for status", () => {
  const s = setup([{ name: "a", ssh: "alice@a" }], { "alice@a": OK });
  const r = runFleet(s.clone, ["diff", "--all"], { home: s.home });
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /--all is only for 'status'/);
  assert.deepEqual(s.calls(), []);
});

test("a host file with an ssh destination ssh would read as an option exits 2 before any call", () => {
  const s = setup([{ name: "a", ssh: "-oProxyCommand=x" }], { "alice@a": OK });
  const r = runFleet(s.clone, ["status", "--all"], { home: s.home });
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /'ssh' must be a destination/);
  assert.deepEqual(s.calls(), []);
});

test("a remote that really runs fleet status answers with its own repo, tools and timer", () => {
  const s = setup([{ name: "server", ssh: "alice@server" }], {});
  // A second machine: its own HOME and clone of the same remote, with its own fake tools.
  const base = tempDir("fleet-machine-");
  const mhome = join(base, "home");
  mkdirSync(join(mhome, ".config/fleet"), { recursive: true });
  writeFileSync(join(mhome, ".config/fleet/host"), "server\n");
  git(base, "clone", "--quiet", s.remote, "fleet");
  writeFileSync(join(mhome, ".config/fleet/config"), `${join(base, "fleet")}\n`);
  mkdirSync(join(mhome, ".local/bin"), { recursive: true });
  symlinkSync(join(base, "fleet/bin/fleet"), join(mhome, ".local/bin/fleet"));
  installStatusTools(mhome);
  installFakeSsh(s.home, { "alice@server": { home: mhome } });

  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.ok, r.stderr);
  const remote = byHost(doc.hosts, "server");
  assert.equal(remote.result, "ok");
  assert.equal(remote.status.repos.fleet.sha, git(join(base, "fleet"), "rev-parse", "HEAD"));
  assert.equal(remote.status.timer, "active");
  assert.equal(remote.status.tools.sops, "3.13.3");
  assert.deepEqual(toolCalls(mhome, "sops"), [["--version", "--disable-version-check"]], "the remote ran its own fake sops, once");
});
