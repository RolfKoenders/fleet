import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { bareToolPath, FAKE_VERSIONS, git, installFakeTool, installStatusTools, linkFleetSkill, makeClone, makeHome, makeSource, publish, runFleet, tempDir, toolCalls, linuxOnly } from "./helpers.ts";
import { findTool } from "../src/tools.ts";

type Repo = { branch: string | null; sha: string; clean: boolean; ahead: number | null; behind: number | null };

function withTools(home: string): string {
  if (!existsSync(join(home, ".local/bin/systemctl"))) installStatusTools(home);
  return home;
}

function status(clone: string, home: string, extra: string[] = [], env?: Record<string, string>) {
  withTools(home);
  const r = runFleet(clone, ["status", "--json", ...extra], { home, env });
  assert.equal(r.code, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  return { doc, repo: doc.repos.fleet as Repo, stderr: r.stderr };
}

test("status reports the host and a clean, up to date clone", () => {
  const { clone } = makeClone();
  const { doc, repo } = status(clone, makeHome("laptop"));
  assert.equal(doc.host, "laptop");
  assert.equal(doc.ok, true);
  assert.deepEqual(repo, {
    branch: "main",
    sha: git(clone, "rev-parse", "HEAD"),
    clean: true,
    ahead: 0,
    behind: 0,
  });
});

test("status sees uncommitted and untracked files as not clean", () => {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  writeFileSync(join(clone, "untracked.txt"), "x");
  assert.equal(status(clone, home).repo.clean, false);
  git(clone, "add", "-A");
  git(clone, "commit", "-m", "tracked");
  assert.equal(status(clone, home).repo.clean, true);
  writeFileSync(join(clone, "package.json"), "{}");
  assert.equal(status(clone, home).repo.clean, false);
});

test("status counts local commits as ahead", () => {
  const { clone } = makeClone();
  writeFileSync(join(clone, "a.txt"), "a");
  git(clone, "add", "-A");
  git(clone, "commit", "-m", "local");
  const { repo } = status(clone, makeHome("laptop"));
  assert.equal(repo.ahead, 1);
  assert.equal(repo.behind, 0);
});

test("status reports behind only after a fetch, and never fetches itself", () => {
  const { clone, remote } = makeClone();
  const home = makeHome("laptop");
  const other = join(tempDir(), "other");
  git(tempDir(), "clone", remote, other);
  writeFileSync(join(other, "b.txt"), "b");
  git(other, "add", "-A");
  git(other, "commit", "-m", "remote only");
  git(other, "push", "origin", "main");

  assert.equal(status(clone, home).repo.behind, 0);
  git(clone, "fetch");
  assert.equal(status(clone, home).repo.behind, 1);
});

test("status reports null ahead and behind when the branch has no upstream", () => {
  const { clone } = makeClone();
  git(clone, "checkout", "-b", "local-only");
  const { repo } = status(clone, makeHome("laptop"));
  assert.equal(repo.branch, "local-only");
  assert.equal(repo.ahead, null);
  assert.equal(repo.behind, null);
});

test("status before init has a null host and says so", () => {
  const { clone } = makeClone();
  const { doc } = status(clone, makeHome());
  assert.equal(doc.host, null);
  assert.equal(doc.ok, true);
  assert.match(doc.messages.join("\n"), /no host name/);
});

test("status in human form names the host and the clone state", () => {
  const { clone } = makeClone();
  const r = runFleet(clone, ["status"], { home: withTools(makeHome("laptop")) });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^host: laptop$/m);
  assert.match(r.stdout, /branch: main/);
  assert.match(r.stdout, /clean: yes/);
  assert.match(r.stdout, /ahead: 0/);
  assert.match(r.stdout, /behind: 0/);
});

test("status works with git only on a bare PATH, found by absolute path", () => {
  const { clone } = makeClone();
  const { repo } = status(clone, makeHome("laptop"), [], { PATH: bareToolPath() });
  assert.equal(repo.clean, true);
});

type Full = {
  host: string | null;
  applied: { at: string | null; ageSeconds: number | null; config: string | null };
  timer: string | null;
  pending: number | null;
  conflicts: number | null;
  tools: { claude: string | null; opencode: string | null; sops: string | null; node: string | null; t3: string | null };
  messages: string[];
};

const full = (clone: string, home: string, extra: string[] = []) => status(clone, home, extra).doc as Full;

test("status reports each tool's version, the way the tool prints it", () => {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  const { tools } = full(clone, home);
  assert.deepEqual(tools, { claude: FAKE_VERSIONS.claude, opencode: FAKE_VERSIONS.opencode, sops: FAKE_VERSIONS.sops, node: process.version.slice(1), t3: null });
  // The fakes are the ones that were found, and each was asked for its version only.
  assert.deepEqual(toolCalls(home, "claude"), [["--version"]]);
  assert.deepEqual(toolCalls(home, "opencode"), [["--version"]]);
});

test("a version that cannot be read is null: a failing tool, one that prints no version, one that prints nothing", () => {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  installStatusTools(home);
  installFakeTool(home, "claude", { stdout: "claude: broken", exit: 1 });
  installFakeTool(home, "opencode", { stdout: "no version here" });
  installFakeTool(home, "sops");
  const { tools } = full(clone, home);
  assert.equal(tools.claude, null);
  assert.equal(tools.opencode, null);
  assert.equal(tools.sops, null);
  assert.equal(tools.node, process.version.slice(1), "node is read from the running Node");
  assert.equal(toolCalls(home, "claude").length, 1, "the fake claude is the one that ran");
});

test("status shows an unreadable version as unknown in human form", () => {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  installStatusTools(home);
  installFakeTool(home, "claude", { exit: 1 });
  const r = runFleet(clone, ["status"], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^ {2}claude: unknown$/m);
  assert.match(r.stdout, new RegExp(`^ {2}opencode: ${FAKE_VERSIONS.opencode}$`, "m"));
});

test("sops is asked for its version with --disable-version-check, which is what keeps it off the network", () => {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  full(clone, home);
  assert.deepEqual(toolCalls(home, "sops"), [["--version", "--disable-version-check"]]);
});

const REAL_SOPS = findTool("sops");

test("those exact sops arguments make no network request with the real sops, where the old flag does", { skip: REAL_SOPS === null }, async () => {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  full(clone, home);
  const [args] = toolCalls(home, "sops");
  assert.ok(args);

  // sops follows HTTPS_PROXY, so a listener on loopback sees any request it makes, and nothing leaves the machine.
  let connections = 0;
  const server = net.createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const proxy = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  const runSops = (sopsArgs: string[]) =>
    new Promise<string>((resolve) => {
      let out = "";
      const child = spawn(REAL_SOPS!, sopsArgs, { env: { PATH: "/usr/bin:/bin", HOME: home, HTTPS_PROXY: proxy, HTTP_PROXY: proxy } });
      child.stdout.on("data", (d) => (out += d));
      child.on("close", () => resolve(out));
      setTimeout(() => child.kill(), 20_000).unref();
    });
  try {
    connections = 0;
    const out = await runSops(args);
    assert.equal(connections, 0, "fleet's arguments made a request");
    assert.match(out, /^sops \d+\.\d+\.\d+$/m);
    assert.doesNotMatch(out, /latest/);

    // The control: the old flag still asks GitHub, so the test would notice if the proxy were ignored.
    connections = 0;
    await runSops(["--version", "--check-for-updates=false"]);
    assert.ok(connections > 0, "the control made no request, so this test proves nothing");
  } finally {
    server.close();
  }
});

test("the timer state is what systemctl --user is-active fleet.timer prints", { skip: linuxOnly }, () => {
  const { clone } = makeClone();
  for (const state of ["active", "inactive", "failed"]) {
    const home = makeHome("laptop");
    installStatusTools(home);
    installFakeTool(home, "systemctl", { stdout: state, exit: state === "active" ? 0 : 3, only: ["--user", "is-active", "fleet.timer"] });
    assert.equal(full(clone, home).timer, state);
    assert.deepEqual(toolCalls(home, "systemctl"), [["--user", "is-active", "fleet.timer"]]);
  }
});

test("a timer state that cannot be read is null", { skip: linuxOnly }, () => {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  installStatusTools(home);
  installFakeTool(home, "systemctl", { exit: 1 });
  assert.equal(full(clone, home).timer, null);
  assert.equal(toolCalls(home, "systemctl").length, 1);
});

test("with nothing applied, the applied state is null", () => {
  const { clone } = makeClone();
  const { applied } = full(clone, makeHome("laptop"));
  assert.deepEqual(applied, { at: null, ageSeconds: null, config: null });
});

const writeApplied = (home: string, appliedAt: string, repos: Record<string, string> = {}) => {
  mkdirSync(join(home, ".local/state/fleet"), { recursive: true });
  writeFileSync(join(home, ".local/state/fleet/applied.json"), JSON.stringify({ version: 1, host: "laptop", appliedAt, repos, links: [], keys: [] }));
};

test("the config commit of the last apply is reported, and an older state without one reads as unknown", () => {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  const at = "2026-10-30T10:00:00Z";
  writeApplied(home, at);
  assert.equal(full(clone, home).applied.config, null);
  assert.match(runFleet(clone, ["status"], { home }).stdout, /^ {2}config: unknown$/m);
  writeApplied(home, at, { config: "abc1234" });
  assert.equal(full(clone, home).applied.config, "abc1234");
  assert.match(runFleet(clone, ["status"], { home }).stdout, /^ {2}config: abc1234$/m);
});

test("the applied state age is counted from appliedAt", () => {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  const at = new Date(Date.now() - 2 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  writeApplied(home, at);
  const { applied } = full(clone, home);
  assert.equal(applied.at, at);
  assert.ok(applied.ageSeconds !== null && applied.ageSeconds >= 7200 && applied.ageSeconds < 7260, String(applied.ageSeconds));
  const r = runFleet(clone, ["status"], { home });
  assert.match(r.stdout, /^applied: 2h ago \(/m);
});

test("an applied state that cannot be read is null, said on stderr, and does not fail status", () => {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  mkdirSync(join(home, ".local/state/fleet"), { recursive: true });
  writeFileSync(join(home, ".local/state/fleet/applied.json"), "{ not json");
  const { doc, stderr } = status(clone, home);
  assert.deepEqual(doc.applied, { at: null, ageSeconds: null, config: null });
  assert.match(stderr, /applied state/);
});

function described(opts: { files?: string[]; settings?: string } = {}) {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  linkFleetSkill(home, clone);
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(clone, rel)), { recursive: true });
    writeFileSync(join(clone, rel), content);
  };
  const describe = (files: string[], settings = opts.settings ?? "") => {
    for (const f of files) write(`config/${f}`, `${f}\n`);
    const records = files.map((f) => `  - { source: config/${f}, target: ~/.config/t/${f} }`).join("\n");
    write("hosts/laptop.yaml", `${files.length > 0 ? `files:\n${records}\n` : ""}${settings}` || "{}\n");
    publish(clone);
  };
  describe(opts.files ?? []);
  return { clone, home, describe, write };
}

test("pending changes are the links and keys apply would create, update or remove", () => {
  const s = described({ files: ["a", "b"], settings: "settings:\n  claude:\n    attribution:\n      commit: ''\n" });
  assert.equal(full(s.clone, withTools(s.home)).pending, 3, "two links and one key");
  assert.equal(full(s.clone, s.home).conflicts, 0);
  assert.equal(runFleet(s.clone, ["apply"], { home: s.home }).code, 0);
  const done = full(s.clone, s.home);
  assert.equal(done.pending, 0);
  assert.equal(done.conflicts, 0);

  s.describe(["a"], "settings:\n  claude:\n    attribution:\n      commit: ''\n      pr: ''\n");
  assert.equal(full(s.clone, s.home).pending, 2, "the link to b to remove and the key attribution.pr to create; attribution.commit is already right");
});

test("the counts are the ones fleet diff reports", () => {
  const s = described({ files: ["a", "b", "c"] });
  mkdirSync(join(s.home, ".config/t"), { recursive: true });
  writeFileSync(join(s.home, ".config/t/b"), "a real file in the way");
  const diff = JSON.parse(runFleet(s.clone, ["diff", "--json"], { home: withTools(s.home) }).stdout);
  const counts = full(s.clone, s.home);
  assert.equal(counts.conflicts, 1);
  assert.equal(counts.conflicts, diff.conflicts.length);
  assert.equal(counts.pending, diff.created.length + diff.updated.length + diff.removed.length);
  assert.equal(counts.pending, 2, "a conflicted link is not pending");
});

test("a config that does not validate gives null counts and says why, with exit 0", () => {
  const s = described({ files: ["a"] });
  s.write("hosts/laptop.yaml", "nonsense: true\n");
  publish(s.clone);
  const { doc, stderr } = status(s.clone, withTools(s.home));
  assert.equal(doc.ok, true);
  assert.equal(doc.pending, null);
  assert.equal(doc.conflicts, null);
  assert.match(stderr, /pending changes and conflicts.*unknown/);
  assert.match(stderr, /unknown key 'nonsense'/);
});

test("status never clones a missing skill source: the counts are null and it says to run fleet apply", () => {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  const src = makeSource({ "planning/SKILL.md": "---\nname: planning\n---\n" });
  mkdirSync(join(clone, "catalog"), { recursive: true });
  mkdirSync(join(clone, "hosts"), { recursive: true });
  writeFileSync(join(clone, "catalog/skills.yaml"), `sources:\n  mine:\n    repo: ${src.remote}\n    path: .\n    branch: main\nbundles:\n  core: [planning]\n`);
  writeFileSync(join(clone, "hosts/laptop.yaml"), "bundles: [core]\n");
  publish(clone);
  const { doc, stderr } = status(clone, home);
  assert.equal(doc.pending, null);
  assert.equal(doc.conflicts, null);
  assert.match(stderr, /source 'mine' is not cloned yet/);
  assert.equal(existsSync(join(home, ".local/share/fleet/sources")), false, "nothing was cloned");
});

test("once the source is cloned, status counts its skills and still does not fetch", () => {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  const src = makeSource({ "planning/SKILL.md": "---\nname: planning\n---\n" });
  mkdirSync(join(clone, "catalog"), { recursive: true });
  mkdirSync(join(clone, "hosts"), { recursive: true });
  writeFileSync(join(clone, "catalog/skills.yaml"), `sources:\n  mine:\n    repo: ${src.remote}\n    path: .\n    branch: main\nbundles:\n  core: [planning]\n`);
  writeFileSync(join(clone, "hosts/laptop.yaml"), "bundles: [core]\n");
  publish(clone);
  withTools(home);
  assert.equal(runFleet(clone, ["apply"], { home }).code, 0);
  src.commit({ "planning/NOTES.md": "more" }, "upstream moves on");
  const after = full(clone, home);
  assert.equal(after.pending, 0);
  assert.equal(after.conflicts, 0);
  const sourceClone = join(home, ".local/share/fleet/sources/mine");
  assert.notEqual(git(sourceClone, "rev-parse", "HEAD"), git(src.work, "rev-parse", "HEAD"), "upstream moved and status did not fetch it");
  assert.equal(git(sourceClone, "rev-parse", "origin/main"), git(sourceClone, "rev-parse", "HEAD"));
});

test("status before init has null counts and does not repeat the missing host name", () => {
  const { clone } = makeClone();
  const { doc } = status(clone, makeHome());
  assert.equal(doc.pending, null);
  assert.equal(doc.conflicts, null);
  assert.equal(doc.messages.filter((m: string) => /no host name/.test(m)).length, 1);
});

test("human status shows applied age, timer, counts and tools", () => {
  const s = described({ files: ["a"] });
  const r = runFleet(s.clone, ["status"], { home: withTools(s.home) });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^applied: never$/m);
  assert.match(r.stdout, /^timer: active$/m);
  assert.match(r.stdout, /^pending: 1$/m);
  assert.match(r.stdout, /^conflicts: 0$/m);
  assert.match(r.stdout, /^tools:$/m);
  assert.match(r.stdout, new RegExp(`^ {2}claude: ${FAKE_VERSIONS.claude}$`, "m"));
  assert.match(r.stdout, /^ {2}t3: unknown$/m);
});

const t3Home = (layout: (versions: string) => void) => {
  const home = makeHome("laptop");
  const versions = join(home, ".t3/runtime/versions");
  mkdirSync(versions, { recursive: true });
  layout(versions);
  return home;
};

test("the T3 version is the newest directory name under ~/.t3/runtime/versions, and nothing inside them is read", () => {
  const { clone } = makeClone();
  let locked: string[] = [];
  const home = t3Home((versions) => {
    // The older version is readable and holds a decoy that would win if anything read it.
    mkdirSync(join(versions, "0.0.42"));
    writeFileSync(join(versions, "0.0.42/package.json"), JSON.stringify({ version: "9.9.9" }));
    writeFileSync(join(versions, "0.0.42/VERSION"), "9.9.9\n");
    // The newer one cannot be opened at all: a read of its content would fail.
    mkdirSync(join(versions, "0.1.0"));
    writeFileSync(join(versions, "0.1.0/package.json"), JSON.stringify({ version: "9.9.9" }));
    // Not versions: a file and a directory with another name.
    writeFileSync(join(versions, "9.9.9"), "a file, not a version directory");
    mkdirSync(join(versions, "latest"));
    writeFileSync(join(versions, "../service-state.json"), JSON.stringify({ version: "9.9.9" }));
    chmodSync(join(versions, "0.1.0"), 0o000);
    locked = [join(versions, "0.1.0")];
  });
  try {
    assert.equal(full(clone, home).tools.t3, "0.1.0");
  } finally {
    for (const dir of locked) chmodSync(dir, 0o700);
  }
});

test("the T3 version is null with no versions directory, or no version-shaped name in it", () => {
  const { clone } = makeClone();
  assert.equal(full(clone, makeHome("laptop")).tools.t3, null);
  assert.equal(full(clone, t3Home((v) => mkdirSync(join(v, "current")))).tools.t3, null);
});

test("version directories are compared as numbers", () => {
  const { clone } = makeClone();
  const home = t3Home((v) => {
    for (const name of ["0.9.0", "0.10.0", "0.2.5"]) mkdirSync(join(v, name));
  });
  assert.equal(full(clone, home).tools.t3, "0.10.0");
});
