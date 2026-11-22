import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EXIT } from "../src/exit.ts";
import { git, installFakeSsh, installStatusTools, linkFleetSkill, makeClone, makeHome, publish, runFleet, tempDir } from "./helpers.ts";
import type { SshPlan } from "./helpers.ts";


const none = { changes: 0, created: [], updated: [], removed: [], conflicts: [] };
const OK: SshPlan = {
  stdout: JSON.stringify({ ok: true, code: "ok", host: "remote", messages: [], ...none }),
};

function setup(hosts: Record<string, string | null> = {}, ssh: Record<string, SshPlan> = {}) {
  const { clone, remote } = makeClone();
  const home = makeHome("laptop");
  installStatusTools(home);
  linkFleetSkill(home, clone);
  installFakeSsh(home, ssh);
  mkdirSync(join(clone, "hosts"), { recursive: true });
  writeFileSync(join(clone, "hosts/laptop.yaml"), "{}\n");
  for (const [name, dest] of Object.entries(hosts)) {
    writeFileSync(join(clone, "hosts", `${name}.yaml`), dest === null ? "{}\n" : `ssh: ${dest}\n`);
  }
  publish(clone, "hosts");
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(clone, rel)), { recursive: true });
    writeFileSync(join(clone, rel), content);
  };
  const run = (args: string[] = [], env: Record<string, string> = {}) => runFleet(clone, ["undo", ...args], { home, env });
  const json = (args: string[] = [], env: Record<string, string> = {}) => {
    const r = run([...args, "--json"], env);
    return { r, doc: JSON.parse(r.stdout) as Record<string, unknown> };
  };
  const push = (args: string[] = []) => runFleet(clone, ["push", ...args], { home });
  const remoteHead = () => git(remote, "rev-parse", "main");
  const remoteSubject = () => git(remote, "log", "-1", "--format=%s", "main");
  const localSubject = () => git(clone, "log", "-1", "--format=%s", "HEAD");
  const journalFiles = () => (existsSync(join(home, ".local/state/fleet/pushes")) ? readdirSync(join(home, ".local/state/fleet/pushes")).sort() : []);
  return { clone, remote, home, write, run, json, push, remoteHead, remoteSubject, localSubject, journalFiles };
}

test("undo needs a recorded push", () => {
  const s = setup();
  const { r, doc } = s.json(["--yes"]);
  assert.equal(r.code, EXIT.invalid, r.stderr);
  assert.equal(doc.code, "invalid");
  assert.match(r.stderr, /no push recorded yet/);
});

test("undo reverts the last push and pushes the revert to all hosts", () => {
  const s = setup({ server: "alice@server" }, { "alice@server": OK });
  s.write("notes.md", "one");
  assert.equal(s.push(["-m", "Add notes"]).code, EXIT.ok);
  const beforeRevert = s.remoteHead();
  const { r, doc } = s.json(["--yes"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(doc.code, "ok");
  assert.equal(doc.pushed, true);
  assert.match(s.localSubject(), /^Revert "Add notes"/);
  assert.notEqual(s.remoteHead(), beforeRevert);
  assert.equal(s.remoteSubject(), `Revert "Add notes"`);
  assert.equal(existsSync(join(s.clone, "notes.md")), false, "the revert removed notes.md");
});

test("undo --no-push commits the revert but does not push", () => {
  const s = setup();
  s.write("notes.md", "one");
  assert.equal(s.push(["-m", "Add notes"]).code, EXIT.ok);
  const beforeRevert = s.remoteHead();
  const { r, doc } = s.json(["--no-push", "--yes"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(doc.code, "ok");
  assert.equal(doc.pushed, false);
  assert.match(s.localSubject(), /^Revert "Add notes"/);
  assert.equal(s.remoteHead(), beforeRevert, "remote was not pushed");
  assert.notEqual(git(s.clone, "rev-parse", "HEAD"), beforeRevert, "local has the revert commit");
});

test("undo <commit> reverts a named push", () => {
  const s = setup();
  s.write("notes.md", "one");
  assert.equal(s.push(["-m", "First notes"]).code, EXIT.ok);
  const firstCommit = s.remoteHead();
  s.write("more.md", "two");
  assert.equal(s.push(["-m", "Add more"]).code, EXIT.ok);
  const { r, doc } = s.json(["--no-push", "--yes", firstCommit]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(doc.code, "ok");
  assert.match(s.localSubject(), /^Revert "First notes"/);
});

test("undo refuses when the revert clashes with a newer commit", () => {
  const s = setup();
  s.write("notes.md", "one");
  assert.equal(s.push(["-m", "Add notes"]).code, EXIT.ok);
  const pushedCommit = s.remoteHead();
  // Make a newer commit on the remote that changes the same file.
  const elsewhere = tempDir("fleet-elsewhere-");
  git(elsewhere, "clone", "--quiet", s.remote, "w");
  writeFileSync(join(elsewhere, "w/notes.md"), "remote change");
  git(join(elsewhere, "w"), "add", "-A");
  git(join(elsewhere, "w"), "commit", "-m", "Change notes remotely");
  git(join(elsewhere, "w"), "push", "--quiet");
  // Pull the newer commit locally so the revert clashes.
  git(s.clone, "pull", "--ff-only", "--quiet");
  const { r, doc } = s.json(["--no-push", "--yes", pushedCommit]);
  assert.equal(r.code, EXIT.conflict, r.stderr);
  assert.equal(doc.code, "conflict");
  assert.match(r.stderr, /clashes with a newer commit/);
  assert.match(r.stderr, /notes\.md/);
  assert.equal(git(s.clone, "status", "--porcelain"), "", "repo is left clean");
});

test("undo warns when the push changed a secrets file", () => {
  const s = setup();
  s.write("secrets/shared.enc.yaml", "A: ENC[AES256_GCM,data:abc]\nsops:\n  version: 3.11.0\n");
  assert.equal(s.push(["-m", "Add secret"]).code, EXIT.ok);
  const { r, doc } = s.json(["--no-push", "--yes"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(doc.code, "ok");
  assert.ok((doc.messages as string[]).some((m) => /secrets file/.test(m) && /encrypted/.test(m)), r.stderr);
  assert.match(r.stderr, /brings back the old encrypted values/);
});

test("undo without --yes and without a terminal is refused", () => {
  const s = setup();
  s.write("notes.md", "one");
  assert.equal(s.push(["-m", "Add notes"]).code, EXIT.ok);
  const { r, doc } = s.json([]);
  assert.equal(r.code, EXIT.invalid, r.stderr);
  assert.equal(doc.code, "invalid");
  assert.match(r.stderr, /pass --yes/);
});

test("undo without a recorded push matching the named commit is refused", () => {
  const s = setup();
  s.write("notes.md", "one");
  assert.equal(s.push(["-m", "Add notes"]).code, EXIT.ok);
  const { r, doc } = s.json(["--yes", "1234567"]);
  assert.equal(r.code, EXIT.invalid, r.stderr);
  assert.match(r.stderr, /no recorded push matches commit '1234567'/);
});

test("undo pushes the revert to the scope of the push it undoes", () => {
  const s = setup({ server: "alice@server" }, { "alice@server": OK });
  s.write("notes.md", "one");
  assert.equal(s.push(["-m", "Add notes", "--host", "laptop"]).code, EXIT.ok);
  const { r } = s.json(["--yes"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  const newest = s.journalFiles().at(-1)!;
  const header = JSON.parse(readFileSync(join(s.home, ".local/state/fleet/pushes", newest), "utf8").split("\n")[0]!) as { only: string | null };
  assert.equal(header.only, "laptop", "the revert push was scoped to the one host");
  assert.equal(s.remoteSubject(), `Revert "Add notes"`);
});
