import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeClone, makeHome, publish, runFleet } from "./helpers.ts";
import type { Run } from "./helpers.ts";
import { EXIT } from "../src/exit.ts";

type FileSpec = { source: string; target: string };

function setup(opts: { host?: string; defaults?: FileSpec[]; files?: FileSpec[] } = {}) {
  const host = opts.host ?? "laptop";
  const { clone } = makeClone();
  const home = makeHome(host);
  const writeSource = (source: string, content = `${source}\n`) => {
    const path = join(clone, source);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  };
  const writeYaml = (name: string, yaml: string) => {
    mkdirSync(join(clone, "hosts"), { recursive: true });
    writeFileSync(join(clone, "hosts", name), yaml);
  };
  const filesYaml = (records: FileSpec[]) =>
    records.length === 0 ? "files: []\n" : `files:\n${records.map((r) => `  - { source: ${r.source}, target: ${r.target} }`).join("\n")}\n`;
  for (const r of [...(opts.defaults ?? []), ...(opts.files ?? [])]) writeSource(r.source);
  if (opts.defaults) writeYaml("_defaults.yaml", filesYaml(opts.defaults));
  writeYaml(`${host}.yaml`, opts.files ? filesYaml(opts.files) : "{}\n");
  const run = (args: string[]) => (publish(clone), runFleet(clone, args, { home }));
  const json = (args: string[]) => {
    const r = run([...args, "--json"]);
    return { r, doc: JSON.parse(r.stdout) };
  };
  return { clone, home, host, writeSource, writeYaml, filesYaml, run, json };
}

const statePath = (home: string) => join(home, ".local/state/fleet/applied.json");
/** Every apply links the tool's `fleet` skill too; these tests are about the config's own links, so it is left out. */
const FLEET_SKILL = "~/.claude/skills/fleet";
const notFleetSkill = <T extends { target: string }>(links: T[]): T[] => links.filter((l) => l.target !== FLEET_SKILL);
const readState = (home: string) => {
  const state = JSON.parse(readFileSync(statePath(home), "utf8"));
  return { ...state, links: notFleetSkill(state.links as { target: string; source: string }[]) };
};
const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
const rec = (source: string, target: string): FileSpec => ({ source, target });

test("apply creates a missing link, parent directories included, and records it in mode 600 state", () => {
  const s = setup({ files: [rec("config/AGENTS.md", "~/.claude/CLAUDE.md")] });
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  const target = join(s.home, ".claude/CLAUDE.md");
  assert.equal(readlinkSync(target), join(s.clone, "config/AGENTS.md"));
  assert.equal(readFileSync(target, "utf8"), "config/AGENTS.md\n");
  assert.equal(lstatSync(statePath(s.home)).mode & 0o777, 0o600);
  const state = readState(s.home);
  assert.equal(state.version, 1);
  assert.equal(state.host, "laptop");
  assert.match(state.appliedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual(state.links, [{ target: "~/.claude/CLAUDE.md", source: join(s.clone, "config/AGENTS.md") }]);
});

test("a directory can be linked", () => {
  const s = setup();
  s.writeSource("skills/demo/SKILL.md");
  s.writeYaml("laptop.yaml", s.filesYaml([rec("skills/demo", "~/.claude/skills/demo")]));
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.equal(readlinkSync(join(s.home, ".claude/skills/demo")), join(s.clone, "skills/demo"));
});

test("a second apply changes nothing and leaves the state file as it was", () => {
  const s = setup({ files: [rec("config/AGENTS.md", "~/.claude/CLAUDE.md")] });
  s.run(["apply"]);
  const before = readFileSync(statePath(s.home), "utf8");
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.ok);
  assert.deepEqual(doc.created, []);
  assert.deepEqual(doc.removed, []);
  assert.equal(readFileSync(statePath(s.home), "utf8"), before);
});

test("a correct symlink nobody recorded is left alone and recorded", () => {
  const s = setup({ files: [rec("config/AGENTS.md", "~/.claude/CLAUDE.md")] });
  mkdirSync(join(s.home, ".claude"));
  symlinkSync(join(s.clone, "config/AGENTS.md"), join(s.home, ".claude/CLAUDE.md"));
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.ok);
  assert.deepEqual(notFleetSkill(doc.created), []);
  assert.deepEqual(readState(s.home).links, [
    { target: "~/.claude/CLAUDE.md", source: join(s.clone, "config/AGENTS.md") },
  ]);
});

test("a relative symlink that resolves to the source counts as correct", () => {
  const s = setup({ files: [rec("config/AGENTS.md", "~/.claude/CLAUDE.md")] });
  mkdirSync(join(s.home, ".claude"));
  const link = join(s.home, ".claude/CLAUDE.md");
  symlinkSync(relative(dirname(link), join(s.clone, "config/AGENTS.md")), link);
  assert.equal(s.run(["apply"]).code, EXIT.ok);
});

function conflictSetup(make: (home: string, clone: string) => void) {
  const s = setup({
    files: [rec("config/a.md", "~/conflicted"), rec("config/b.md", "~/other/created")],
  });
  make(s.home, s.clone);
  return s;
}

for (const [name, make, detail] of [
  ["a real file", (home: string) => writeFileSync(join(home, "conflicted"), "mine"), /file/],
  ["a directory", (home: string) => mkdirSync(join(home, "conflicted")), /directory/],
  ["a wrong symlink", (home: string) => symlinkSync("/etc/hostname", join(home, "conflicted")), /\/etc\/hostname/],
  ["a dangling symlink", (home: string) => symlinkSync("/nonexistent/x", join(home, "conflicted")), /\/nonexistent\/x/],
] as const) {
  test(`${name} at a target is a conflict: exit 3, nothing written anywhere, a fix given`, () => {
    const s = conflictSetup(make);
    const { r, doc } = s.json(["apply"]);
    assert.equal(r.code, EXIT.conflict);
    assert.equal(doc.ok, false);
    assert.equal(doc.code, "conflict");
    assert.equal(doc.conflicts.length, 1);
    const [c] = doc.conflicts;
    assert.deepEqual(Object.keys(c).sort(), ["detail", "fix", "kind", "path"]);
    assert.equal(c.kind, "link");
    assert.equal(c.path, "~/conflicted");
    assert.match(c.detail, detail);
    assert.match(c.fix, /fleet apply/);
    assert.equal(exists(join(s.home, "other")), false);
    assert.equal(exists(statePath(s.home)), false);
  });
}

test("a file where a parent directory should be is a conflict", () => {
  const s = setup({ files: [rec("config/a.md", "~/blocker/child")] });
  writeFileSync(join(s.home, "blocker"), "a file");
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.conflict);
  assert.equal(doc.conflicts[0].path, "~/blocker");
});

test("a step that fails keeps the state written for the steps before it", () => {
  const s = setup({ files: [rec("config/a.md", "~/first"), rec("config/b.md", "~/locked/second")] });
  mkdirSync(join(s.home, "locked"));
  chmodSync(join(s.home, "locked"), 0o500);
  const r = s.run(["apply", "--json"]);
  chmodSync(join(s.home, "locked"), 0o700);
  assert.equal(r.code, EXIT.error);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.code, "error");
  assert.match(doc.messages.join("\n"), /EACCES/);
  assert.doesNotMatch(r.stderr, /\n\s+at /, "no stack trace");
  assert.equal(exists(join(s.home, ".local/state/fleet/lock")), false);
  assert.deepEqual(readState(s.home).links, [{ target: "~/first", source: join(s.clone, "config/a.md") }]);
});

test("removing a record removes its link when it still points where state says", () => {
  const s = setup({ files: [rec("config/a.md", "~/keep"), rec("config/b.md", "~/drop")] });
  s.run(["apply"]);
  s.writeYaml("laptop.yaml", s.filesYaml([rec("config/a.md", "~/keep")]));
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(doc.removed.map((x: { target: string }) => x.target), ["~/drop"]);
  assert.equal(exists(join(s.home, "drop")), false);
  assert.equal(exists(join(s.home, "keep")), true);
  assert.deepEqual(readState(s.home).links.map((l: { target: string }) => l.target), ["~/keep"]);
});

test("a removed record whose path was changed since is a removal conflict and nothing is written", () => {
  const s = setup({ files: [rec("config/a.md", "~/keep"), rec("config/b.md", "~/drop")] });
  s.run(["apply"]);
  s.writeYaml("laptop.yaml", s.filesYaml([]));
  rmSync(join(s.home, "drop"));
  symlinkSync("/etc/hostname", join(s.home, "drop"));
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.conflict);
  assert.equal(doc.conflicts.length, 1);
  assert.equal(doc.conflicts[0].kind, "removal");
  assert.equal(doc.conflicts[0].path, "~/drop");
  assert.match(doc.conflicts[0].fix, /fleet apply/);
  assert.equal(exists(join(s.home, "keep")), true, "the other removal is not carried out");
  assert.equal(readState(s.home).links.length, 2);
});

test("a removed record whose path is a real file now is a removal conflict", () => {
  const s = setup({ files: [rec("config/a.md", "~/drop")] });
  s.run(["apply"]);
  s.writeYaml("laptop.yaml", s.filesYaml([]));
  rmSync(join(s.home, "drop"));
  writeFileSync(join(s.home, "drop"), "mine now");
  assert.equal(s.run(["apply"]).code, EXIT.conflict);
});

test("a removed record whose path is already gone just leaves the state", () => {
  const s = setup({ files: [rec("config/a.md", "~/drop")] });
  s.run(["apply"]);
  s.writeYaml("laptop.yaml", s.filesYaml([]));
  rmSync(join(s.home, "drop"));
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.deepEqual(readState(s.home).links, []);
});

test("a host's record replaces the default's at the same target; other defaults stay", () => {
  const s = setup({
    defaults: [rec("config/default.md", "~/shared"), rec("config/also.md", "~/also")],
    files: [rec("config/host.md", "~/shared")],
  });
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(readlinkSync(join(s.home, "shared")), join(s.clone, "config/host.md"));
  assert.equal(readlinkSync(join(s.home, "also")), join(s.clone, "config/also.md"));
  assert.equal(notFleetSkill(doc.created).length, 2);
});

test("the defaults file alone is enough, and the host file need not list files", () => {
  const s = setup({ defaults: [rec("config/a.md", "~/a")] });
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.equal(readlinkSync(join(s.home, "a")), join(s.clone, "config/a.md"));
});

test("a host with no host file, or no name, exits 2", () => {
  const noFile = setup();
  const r = runFleet(noFile.clone, ["apply"], { home: makeHome("nowhere") });
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /nowhere\.yaml/);
  const noName = runFleet(noFile.clone, ["apply"], { home: makeHome() });
  assert.equal(noName.code, EXIT.invalid);
  assert.match(noName.stderr, /host name/);
});

const invalidCases: [string, (s: ReturnType<typeof setup>) => void, RegExp][] = [
  ["an unknown key in the host file", (s) => s.writeYaml("laptop.yaml", "files: []\nfiel: 1\n"), /laptop\.yaml: unknown key 'fiel'/],
  ["an unknown key in the defaults", (s) => s.writeYaml("_defaults.yaml", "colour: red\n"), /_defaults\.yaml: unknown key 'colour'/],
  ["a host-only key in the defaults", (s) => s.writeYaml("_defaults.yaml", "ssh: alice@server\n"), /_defaults\.yaml: unknown key 'ssh'/],
  ["an unknown key in a file record", (s) => s.writeYaml("laptop.yaml", "files:\n  - { source: a, target: ~/a, mode: 600 }\n"), /unknown key 'mode'/],
  ["an unknown key under mcp", (s) => s.writeYaml("laptop.yaml", "mcp:\n  add: [x]\n"), /unknown key 'mcp.add'/],
  ["setting vars.HOME", (s) => s.writeYaml("laptop.yaml", "vars:\n  HOME: /x\n"), /HOME/],
  ["a target outside the home directory", (s) => s.writeYaml("laptop.yaml", "files:\n  - { source: config/a.md, target: /etc/a }\n"), /must start with '~\/'/],
  ["a target listed twice", (s) => s.writeYaml("laptop.yaml", "files:\n  - { source: config/a.md, target: ~/a }\n  - { source: config/a.md, target: ~/a }\n"), /listed twice/],
  ["a source that is not in the clone", (s) => s.writeYaml("laptop.yaml", "files:\n  - { source: config/gone.md, target: ~/a }\n"), /config\/gone\.md.*does not exist/],
  ["a files entry without a source", (s) => s.writeYaml("laptop.yaml", "files:\n  - { target: ~/a }\n"), /'source' must be a path/],
  ["files that is not a list", (s) => s.writeYaml("laptop.yaml", "files: nope\n"), /'files' must be a list/],
  ["YAML that does not parse", (s) => s.writeYaml("laptop.yaml", "files: [\n"), /laptop\.yaml/],
  ["a duplicate YAML key", (s) => s.writeYaml("laptop.yaml", "files: []\nfiles: []\n"), /laptop\.yaml/],
];

for (const [name, make, message] of invalidCases) {
  for (const command of ["apply", "diff"]) {
    test(`${name} makes ${command} exit 2 and writes nothing`, () => {
      const s = setup({ files: [rec("config/a.md", "~/a")] });
      make(s);
      const r = s.run([command]);
      assert.equal(r.code, EXIT.invalid, r.stderr);
      assert.match(r.stderr, message);
      assert.equal(exists(join(s.home, "a")), false);
      assert.equal(exists(statePath(s.home)), false);
    });
  }
}

test("every problem in a file is reported, not only the first", () => {
  const s = setup();
  s.writeYaml("laptop.yaml", "one: 1\ntwo: 2\n");
  const r = s.run(["apply"]);
  assert.match(r.stderr, /unknown key 'one'/);
  assert.match(r.stderr, /unknown key 'two'/);
});

test("--json carries the validation problems in messages", () => {
  const s = setup();
  s.writeYaml("laptop.yaml", "one: 1\n");
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.invalid);
  assert.equal(doc.ok, false);
  assert.equal(doc.code, "invalid");
  assert.match(doc.messages[0], /unknown key 'one'/);
});

function holdLock(home: string, pid: number) {
  const lock = join(home, ".local/state/fleet/lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "pid"), `${pid}\n`);
  return lock;
}

function deadPid(): number {
  const child = spawnSync("true");
  assert.ok(child.pid);
  return child.pid;
}

test("apply exits 7 while another apply holds the lock, and changes nothing", () => {
  const s = setup({ files: [rec("config/a.md", "~/a")] });
  const lock = holdLock(s.home, process.pid);
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.locked);
  assert.match(r.stderr, new RegExp(`pid ${process.pid}`));
  assert.equal(exists(join(s.home, "a")), false);
  assert.equal(readFileSync(join(lock, "pid"), "utf8"), `${process.pid}\n`, "the other apply's lock is untouched");
});

test("a lock left by a dead process is replaced, and released when apply ends", () => {
  const s = setup({ files: [rec("config/a.md", "~/a")] });
  const lock = holdLock(s.home, deadPid());
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.equal(exists(join(s.home, "a")), true);
  assert.equal(exists(lock), false);
});

test("a lock directory with no readable pid is stale", () => {
  const s = setup({ files: [rec("config/a.md", "~/a")] });
  mkdirSync(join(s.home, ".local/state/fleet/lock"), { recursive: true });
  assert.equal(s.run(["apply"]).code, EXIT.ok);
});

test("the lock is released after a conflict and after a validation failure", () => {
  const s = setup({ files: [rec("config/a.md", "~/a")] });
  writeFileSync(join(s.home, "a"), "mine");
  assert.equal(s.run(["apply"]).code, EXIT.conflict);
  assert.equal(exists(join(s.home, ".local/state/fleet/lock")), false);
  s.writeYaml("laptop.yaml", "nope: 1\n");
  assert.equal(s.run(["apply"]).code, EXIT.invalid);
  assert.equal(exists(join(s.home, ".local/state/fleet/lock")), false);
});

test("diff prints the plan and writes nothing, not even the state directory", () => {
  const s = setup({ files: [rec("config/a.md", "~/new/a")] });
  const r = s.run(["diff"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stdout, /create ~\/new\/a -> .*config\/a\.md/);
  assert.equal(exists(join(s.home, "new")), false);
  assert.equal(exists(join(s.home, ".local")), false);
});

test("diff shows pending removals and exits 0", () => {
  const s = setup({ files: [rec("config/a.md", "~/a")] });
  s.run(["apply"]);
  s.writeYaml("laptop.yaml", s.filesYaml([]));
  const { r, doc } = s.json(["diff"]);
  assert.equal(r.code, EXIT.ok);
  assert.deepEqual(doc.removed.map((x: { target: string }) => x.target), ["~/a"]);
  assert.equal(exists(join(s.home, "a")), true, "diff removes nothing");
});

test("diff takes no lock: it runs while an apply is running and leaves the lock alone", () => {
  const s = setup({ files: [rec("config/a.md", "~/a")] });
  const lock = holdLock(s.home, process.pid);
  assert.equal(s.run(["diff"]).code, EXIT.ok);
  assert.equal(readFileSync(join(lock, "pid"), "utf8"), `${process.pid}\n`);
});

test("diff exits 3 on a conflict and lists it with its fix", () => {
  const s = setup({ files: [rec("config/a.md", "~/a")] });
  writeFileSync(join(s.home, "a"), "mine");
  const r = s.run(["diff"]);
  assert.equal(r.code, EXIT.conflict);
  assert.match(r.stdout, /conflict ~\/a: /);
  assert.match(r.stdout, /fix: .*fleet apply/);
  const { doc } = s.json(["diff"]);
  assert.equal(doc.conflicts[0].kind, "link");
  assert.equal(readFileSync(join(s.home, "a"), "utf8"), "mine");
});

test("diff on a host that already matches says there is nothing to do", () => {
  const s = setup({ files: [rec("config/a.md", "~/a")] });
  s.run(["apply"]);
  const r = s.run(["diff"]);
  assert.equal(r.code, EXIT.ok);
  assert.match(r.stdout, /nothing to do/);
});

test("--json documents carry ok, code, host and messages", () => {
  const s = setup({ files: [rec("config/a.md", "~/a")] });
  const { doc } = s.json(["apply"]);
  assert.equal(doc.ok, true);
  assert.equal(doc.code, "ok");
  assert.equal(doc.host, "laptop");
  assert.deepEqual(doc.messages, []);
  assert.deepEqual(notFleetSkill(doc.created), [{ target: "~/a", source: join(s.clone, "config/a.md") }]);
});

test("a removed record under a path that is now a file just leaves the state", () => {
  const s = setup({ files: [rec("config/a.md", "~/dir/drop")] });
  s.run(["apply"]);
  s.writeYaml("laptop.yaml", s.filesYaml([]));
  rmSync(join(s.home, "dir"), { recursive: true });
  writeFileSync(join(s.home, "dir"), "now a file");
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.deepEqual(readState(s.home).links, []);
});

test("a dangling symlink where a parent directory should be is a conflict, not a crash", () => {
  const s = setup({ files: [rec("config/a.md", "~/first"), rec("config/b.md", "~/dangling/child")] });
  symlinkSync("/nonexistent/dir", join(s.home, "dangling"));
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.conflict);
  assert.equal(doc.conflicts[0].path, "~/dangling");
  assert.equal(exists(join(s.home, "first")), false);
});

test("diff and apply report a record that only leaves the state", () => {
  const s = setup({ files: [rec("config/a.md", "~/drop")] });
  s.run(["apply"]);
  s.writeYaml("laptop.yaml", s.filesYaml([]));
  rmSync(join(s.home, "drop"));
  const diff = s.json(["diff"]);
  assert.match(s.run(["diff"]).stdout, /forget ~\/drop \(already gone\)/);
  assert.deepEqual(diff.doc.forgotten, ["~/drop"]);
  assert.deepEqual(s.json(["apply"]).doc.forgotten, ["~/drop"]);
});

for (const [name, target, source] of [
  ["an absolute source", "~/a", "/etc/hostname"],
  ["a source that climbs out of the clone", "~/a", "../outside.md"],
  ["a target with a '..' segment", "~/x/../../etc/a", "config/a.md"],
  ["a target with a '.' segment", "~/./a", "config/a.md"],
] as const) {
  test(`${name} is invalid`, () => {
    const s = setup({ files: [rec("config/a.md", "~/ok")] });
    writeFileSync(join(s.clone, "../outside.md"), "outside");
    s.writeYaml("laptop.yaml", `files:\n  - { source: ${source}, target: ${target} }\n`);
    const r = s.run(["diff"]);
    assert.equal(r.code, EXIT.invalid, r.stderr);
  });
}

test("apply records the commit of the config repo, and a new commit alone is recorded by the next apply", () => {
  const s = setup({ files: [rec("config/AGENTS.md", "~/.claude/CLAUDE.md")] });
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  const first = readState(s.home).repos.config;
  assert.match(first, /^[0-9a-f]{40}$/);
  s.writeSource("notes.md");
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  const second = readState(s.home).repos.config;
  assert.match(second, /^[0-9a-f]{40}$/);
  assert.notEqual(second, first);
});

test("a state written before the config commit was recorded still applies, and gains it", () => {
  const s = setup({ files: [rec("config/AGENTS.md", "~/.claude/CLAUDE.md")] });
  s.run(["apply"]);
  const old = JSON.parse(readFileSync(statePath(s.home), "utf8"));
  delete old.repos.config;
  writeFileSync(statePath(s.home), JSON.stringify(old));
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.match(readState(s.home).repos.config, /^[0-9a-f]{40}$/);
});
