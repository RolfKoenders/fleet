import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, installFakeSsh, linkFleetSkill, makeClone, makeHome, publish, repoRoot } from "../helpers.ts";
import type { SshPlan } from "../helpers.ts";
import { RealPusher } from "../../src/tui/pusher.ts";
import { loadModel } from "../../src/tui/model.ts";
import { reduce, startRun, finish } from "../../src/tui/pushrun.ts";
import type { FleetEvent } from "../../src/events.ts";

// Everything a spawned process inherits points into temp directories: nothing here can reach the real home.
Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", PATH: "/usr/bin:/bin" });

const applyDoc = (code: string) => JSON.stringify({ ok: code === "ok", code, host: "remote", messages: [], created: [], updated: [], removed: [], conflicts: [] });

function world(ssh: Record<string, SshPlan>, hosts: Record<string, string | null>) {
  const { clone, remote } = makeClone();
  const home = makeHome("laptop");
  process.env.HOME = home;
  process.env.FLEET_NODE = process.execPath;
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(clone, rel)), { recursive: true });
    writeFileSync(join(clone, rel), content);
  };
  write("hosts/laptop.yaml", "{}\n");
  for (const [name, dest] of Object.entries(hosts)) write(`hosts/${name}.yaml`, dest === null ? "{}\n" : `ssh: ${dest}\n`);
  publish(clone, "config");
  linkFleetSkill(home, clone);
  installFakeSsh(home, ssh);
  const model = loadModel(clone, "laptop");
  return { clone, remote, home, write, model, pusher: new RealPusher(repoRoot, clone, home, model.hosts) };
}

test("the real pusher runs fleet push as a child with events on, and reads its lanes and its document", async () => {
  const w = world(
    { "me@box": { stdout: applyDoc("ok"), stderr: JSON.stringify({ v: 1, event: "stage", stage: "write", of: 2 }) + "\n" + JSON.stringify({ v: 1, event: "step", step: "write-link", target: "~/.x", n: 1, of: 2 }) } },
    { box: "me@box", edge: null },
  );
  w.write("notes.md", "one\n");
  const events: FleetEvent[] = [];
  const end = await w.pusher.run((e) => events.push(e));
  assert.equal(end.exit, 0);
  assert.equal(end.code, "ok");
  assert.deepEqual(end.hosts.map((h) => [h.host, h.result]), [["laptop", "ok"], ["box", "ok"], ["edge", "timer"]]);
  assert.equal(git(w.remote, "log", "-1", "--format=%s", "main"), "fleet push from laptop: 1 files");
  assert.equal(w.pusher.running(), null, "nothing is running once it has ended");

  let run = startRun(w.model.hosts, 0);
  for (const e of events) run = reduce(run, e);
  run = finish(run, end);
  assert.deepEqual(run.lanes.map((l) => [l.host, l.state, l.result]), [["laptop", "done", "ok"], ["box", "done", "ok"], ["edge", "done", "timer"]]);
  assert.deepEqual(run.lanes[1]!.step, { name: "write-link", target: "~/.x", n: 1, of: 2 });
  assert.deepEqual(Object.values(run.phases), ["done", "done", "done"]);
});

test("a ssh host that cannot be reached ends its lane without stopping the next one", async () => {
  const w = world({ "me@a": { exit: 255, stderr: "ssh: connect to host a port 22: Connection timed out" }, "me@b": { stdout: applyDoc("ok") } }, { a: "me@a", b: "me@b" });
  const events: FleetEvent[] = [];
  const end = await w.pusher.run((e) => events.push(e));
  assert.equal(end.exit, 4);
  assert.deepEqual(end.hosts.map((h) => h.result), ["ok", "unreachable", "ok"]);
});

test("the preview reads the dirty files and the plan, and changes nothing", async () => {
  const w = world({}, { box: "me@box" });
  w.write("notes.md", "one\n");
  w.write("catalog/extra.yaml", "x: 1\n");
  const before = git(w.clone, "rev-parse", "HEAD");
  const r = await w.pusher.preview(new AbortController().signal);
  assert.ok(r.ok, JSON.stringify(r));
  const repo = r.preview.repos.at(-1)!;
  assert.equal(repo.shown, w.clone);
  assert.equal(repo.branch, "main");
  assert.deepEqual(repo.files.map((f) => f.path).sort(), ["catalog/extra.yaml", "notes.md"]);
  assert.ok(repo.files.every((f) => f.status === "??"));
  assert.ok(r.preview.plan.length > 0);
  assert.equal(git(w.clone, "rev-parse", "HEAD"), before, "nothing was committed");
  assert.equal(git(w.clone, "status", "--porcelain").split("\n").length, 2, "nothing was staged");
});
