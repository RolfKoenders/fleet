import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { host } from "../src/hostcli.ts";
import type { HostOptions } from "../src/hostcli.ts";
import { gitEnv, git, publish, runFleet } from "./helpers.ts";
import { setup } from "./initworld.ts";
import type { S } from "./initworld.ts";
import { scriptedTerminal } from "./terminal.ts";

Object.assign(process.env, gitEnv);

const SHARED_VALUE = "mock-shared-value-7f3a";
const OWN_VALUE = "mock-server-value-91bc";

/** laptop is the admin and this machine; `server` has a key, a timer the fake ssh can reach, and secrets of its own and in `shared`; `box` has no key. */
function world(): S {
  const s = setup();
  const done = s.json(["server"]);
  assert.equal(done.doc.ok, true, JSON.stringify(done.doc));
  s.setSecret("shared", "SHARED_TOKEN", SHARED_VALUE);
  s.setSecret("server", "SERVER_ONLY", OWN_VALUE);
  s.write("hosts/box.yaml", "ssh: bob@box\nage: \"\"\n");
  publish(s.clone, "box");
  return s;
}

const options = (s: S, over: Partial<HostOptions> = {}): HostOptions => ({ home: s.home, toolDir: s.clone, ...over });
const head = (s: S) => git(s.clone, "rev-parse", "HEAD");
const dirty = (s: S) => git(s.clone, "status", "--porcelain");

test("it refuses this machine and the only admin host, and touches nothing", async () => {
  const s = world();
  const before = head(s);
  const self = await host(s.clone, ["remove", "laptop"], options(s, { yes: true }));
  assert.equal(self.code, "invalid");
  assert.match(self.messages!.join(" "), /laptop is this host/);
  // From another machine the admin is still refused.
  writeFileSync(join(s.home, ".config/fleet/host"), "server\n");
  const admin = await host(s.clone, ["remove", "laptop"], options(s, { yes: true }));
  assert.equal(admin.code, "invalid");
  assert.match(admin.messages!.join(" "), /only admin host/);
  const nobody = await host(s.clone, ["remove", "nobody"], options(s, { yes: true }));
  assert.equal(nobody.code, "invalid");
  assert.equal(existsSync(join(s.clone, "hosts/laptop.yaml")), true);
  assert.equal(head(s), before);
  assert.equal(dirty(s), "");
});

test("a failure before the commit puts every file back and says so", async () => {
  const s = world();
  // A shared file sops cannot read: rekey stops on it, after the host's files have been deleted.
  writeFileSync(join(s.clone, "secrets/shared.enc.yaml"), "not: a sops file\n");
  git(s.clone, "commit", "-qam", "break shared");
  const before = head(s);
  const sshBefore = s.sshCalls().length;
  const files = ["hosts/server.yaml", "secrets/server.enc.yaml", ".sops.yaml"].map((f) => [f, s.read(f)] as const);
  const r = await host(s.clone, ["remove", "server"], options(s, { yes: true }));
  assert.notEqual(r.code, "ok");
  assert.match(r.messages!.join(" "), /the repo is as it was/);
  for (const [f, text] of files) assert.equal(s.read(f), text, f);
  assert.equal(head(s), before);
  assert.equal(dirty(s), "");
  assert.equal(r.fields!.removedHost, null);
  assert.equal(s.timerOn(), true, "the machine is not told anything when nothing was removed");
  assert.equal(s.sshCalls().length, sshBefore);
});

test("on a terminal it asks, removes, stops the timer over ssh on yes, leaves the rest of the machine alone and lists what the host could read", async () => {
  const s = world();
  const lab = scriptedTerminal(["y", "y", "n"]);
  assert.equal(s.timerOn(), true);
  const r = await host(s.clone, ["remove", "server"], options(s, { terminal: lab }));
  assert.equal(r.code, "ok", JSON.stringify(r));
  assert.equal(existsSync(join(s.clone, "hosts/server.yaml")), false);
  assert.equal(existsSync(join(s.clone, "secrets/server.enc.yaml")), false);
  assert.equal(git(s.clone, "log", "-1", "--format=%s"), "Remove host server");
  assert.equal(head(s), git(s.clone, "rev-parse", "origin/main"), "pushed");
  assert.equal(dirty(s), "");
  // The question names the secrets, and only the timer is touched on the machine.
  assert.equal(lab.asked(), 3);
  assert.match(lab.shown(), /It could read these secrets: SHARED_TOKEN, SERVER_ONLY\./);
  assert.equal(s.timerOn(), false);
  assert.equal(existsSync(join(s.units, "fleet.timer")), false);
  assert.equal(existsSync(s.labKey), true, "its key stays");
  assert.deepEqual(r.fields!.timer && (r.fields!.timer as any).state, "stopped");
  assert.match(r.messages!.join("\n"), /its agent config, skills and links are as they were/);
  // The summary lists the secrets of the host and of shared, and says how to rotate them.
  assert.match(r.text!, /server could read these secrets: SHARED_TOKEN, SERVER_ONLY\./);
  assert.match(r.text!, /fleet secrets rotate/);
  assert.deepEqual(r.fields!.readable, { shared: ["SHARED_TOKEN"], own: ["SERVER_ONLY"] });
  assert.ok(!JSON.stringify(r).includes("mock-"), "no value in the result");
  assert.ok(!lab.shown().includes("mock-"), "no value on the terminal");
});

test("saying no to the timer leaves it running, and saying no to the removal changes nothing", async () => {
  const s = world();
  const no = scriptedTerminal(["n"]);
  const before = head(s);
  const declined = await host(s.clone, ["remove", "server"], options(s, { terminal: no }));
  assert.equal(declined.code, "ok");
  assert.equal(declined.fields!.removedHost, null);
  assert.equal(head(s), before);
  assert.equal(existsSync(join(s.clone, "hosts/server.yaml")), true);

  const keep = scriptedTerminal(["y", "n", "n"]);
  const r = await host(s.clone, ["remove", "server"], options(s, { terminal: keep }));
  assert.equal(r.code, "ok", JSON.stringify(r));
  assert.equal((r.fields!.timer as any).state, "declined");
  assert.equal(s.timerOn(), true);
  assert.match(r.messages!.join("\n"), /left running/);
});

test("a machine that does not answer is told nothing, and the summary says so", async () => {
  const s = world();
  writeFileSync(join(s.home, "fake-ssh.json"), "{}");
  const lab = scriptedTerminal(["y", "n"]);
  const r = await host(s.clone, ["remove", "server"], options(s, { terminal: lab }));
  assert.equal(r.code, "ok", JSON.stringify(r));
  assert.equal((r.fields!.timer as any).state, "unreachable");
  assert.equal(lab.asked(), 2, "no question about the timer");
  assert.match(r.messages!.join("\n"), /did not answer over ssh, so it was told nothing/);
  assert.equal(s.timerOn(), true);
  assert.equal(r.fields!.removedHost, "server");
});

test("a host without an ssh destination is not tried", async () => {
  const s = world();
  s.write("hosts/box.yaml", "age: \"\"\n");
  publish(s.clone, "box has no ssh");
  const sshBefore = s.sshCalls().length;
  const r = await host(s.clone, ["remove", "box"], options(s, { yes: true }));
  assert.equal(r.code, "ok", JSON.stringify(r));
  assert.equal((r.fields!.timer as any).state, "no-destination");
  assert.equal(s.sshCalls().length, sshBefore);
  assert.match(r.text!, /box had no key, so it could read no secret/);
});

test("without a terminal it needs --yes, which also stops the timer and rotates nothing", async () => {
  const s = world();
  const before = head(s);
  const refused = await host(s.clone, ["remove", "server"], options(s));
  assert.equal(refused.code, "invalid");
  assert.match(refused.messages!.join(" "), /pass --yes/);
  assert.equal(head(s), before);

  const r = await host(s.clone, ["remove", "server"], options(s, { yes: true }));
  assert.equal(r.code, "ok", JSON.stringify(r));
  assert.equal(s.timerOn(), false);
  assert.equal(r.fields!.rotation, null);
  assert.match(r.text!, /server could read these secrets: SHARED_TOKEN, SERVER_ONLY\./);
});

test("the command line: --json without a terminal, and --yes", () => {
  const s = world();
  const no = runFleet(s.clone, ["host", "remove", "server", "--json"], { home: s.home });
  assert.equal(JSON.parse(no.stdout).code, "invalid");
  assert.equal(existsSync(join(s.clone, "hosts/server.yaml")), true);
  const yes = runFleet(s.clone, ["host", "remove", "server", "--yes", "--json"], { home: s.home });
  const doc = JSON.parse(yes.stdout);
  assert.equal(doc.ok, true, yes.stdout + yes.stderr);
  assert.equal(doc.removedHost, "server");
  assert.equal(doc.committed, true);
  assert.equal(doc.pushed, true);
  assert.deepEqual(doc.readable, { shared: ["SHARED_TOKEN"], own: ["SERVER_ONLY"] });
  assert.equal(doc.timer.state, "stopped");
  assert.ok(!yes.stdout.includes("mock-") && !yes.stderr.includes("mock-"));
  assert.equal(readFileSync(join(s.clone, ".sops.yaml"), "utf8").includes("server.enc.yaml"), false);
  // `--yes` belongs to a few commands only.
  assert.equal(runFleet(s.clone, ["status", "--yes"], { home: s.home }).code !== 0, true);
});

test("after removing, the offer to rotate leads through the secrets the host could read, and the new values reach only the shared file", async () => {
  const s = world();
  const NEW = "mock-NEW-value-c0ffee";
  // remove: y, timer: y, rotate now: y, list: enter (the ticked ones: shared), value, push: n
  const lab = scriptedTerminal(["y", "y", "y", "\r", `${NEW}\r`, "n"]);
  const r = await host(s.clone, ["remove", "server"], options(s, { terminal: lab, rotation: { push: async () => ({ code: "ok" }), doctor: async () => ({ code: "ok" }) } }));
  assert.equal(r.code, "ok", JSON.stringify(r));
  assert.match(lab.shown(), /\[x\]\s+\d+\. SHARED_TOKEN/);
  assert.match(lab.shown(), /\[ \]\s+\d+\. SERVER_ONLY/);
  assert.equal(s.decrypt("shared", "SHARED_TOKEN", s.admin), NEW);
  assert.equal(git(s.clone, "log", "-1", "--format=%s"), "Rotate secret SHARED_TOKEN");
  assert.deepEqual((r.fields!.rotation as any).rotated, [{ name: "SHARED_TOKEN", files: ["secrets/shared.enc.yaml"] }]);
  // Its own file is gone, so its token cannot be set anywhere: it is listed for revoking.
  assert.deepEqual((r.fields!.rotation as any).unplaced, ["SERVER_ONLY"]);
  assert.match(r.text!, /Revoke: SHARED_TOKEN, SERVER_ONLY\./);
  for (const where of [lab.shown(), r.text!, JSON.stringify(r)]) assert.ok(!where.includes(NEW));
});
