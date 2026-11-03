import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeSsh, linkFleetSkill, makeClone, makeHome, publish, runFleet } from "./helpers.ts";
import type { SshPlan } from "./helpers.ts";
import { EXIT } from "../src/exit.ts";
import { readLine } from "../src/events.ts";

const EVENTS = { FLEET_EVENTS: "1" };

type Ev = Record<string, unknown>;
const lines = (stderr: string): Ev[] => stderr.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Ev);

const applyDoc = (code: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ok: code === "ok", code, host: "remote", messages: [], created: [], updated: [], removed: [], conflicts: [], ...extra });

function setup(opts: { files?: number; hosts?: Record<string, string | null>; ssh?: Record<string, SshPlan>; laptop?: string } = {}) {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(clone, rel)), { recursive: true });
    writeFileSync(join(clone, rel), content);
  };
  const n = opts.files ?? 0;
  const files = Array.from({ length: n }, (_, i) => `  - { source: f${i}.md, target: ~/.claude/f${i}.md }\n`).join("");
  for (let i = 0; i < n; i++) write(`f${i}.md`, `file ${i}\n`);
  write("hosts/laptop.yaml", opts.laptop ?? (n > 0 ? `files:\n${files}` : "{}\n"));
  for (const [name, dest] of Object.entries(opts.hosts ?? {})) write(`hosts/${name}.yaml`, dest === null ? "{}\n" : `ssh: ${dest}\n`);
  publish(clone, "config");
  linkFleetSkill(home, clone);
  installFakeSsh(home, opts.ssh ?? {});
  const sshCalls = (): string[][] => {
    try {
      return readFileSync(join(home, "ssh-calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    } catch {
      return [];
    }
  };
  return { clone, home, write, sshCalls, run: (args: string[], env: Record<string, string> = {}) => runFleet(clone, args, { home, env }) };
}

test("apply with events on writes only JSON lines to stderr: stages, then a step for each write, n of of", () => {
  const s = setup({ files: 3 });
  const r = s.run(["apply", "--json"], EVENTS);
  assert.equal(r.code, EXIT.ok, r.stderr);
  const events = lines(r.stderr);
  assert.ok(events.every((e) => e.v === 1 && typeof e.event === "string"));
  assert.deepEqual(events.filter((e) => e.event === "stage").map((e) => e.stage), ["sync", "plan", "write"]);
  assert.equal(events.find((e) => e.stage === "write")!.of, 3);
  const steps = events.filter((e) => e.event === "step");
  assert.deepEqual(steps.map((e) => [e.step, e.n, e.of]), [0, 1, 2].map((i) => ["write-link", i + 1, 3]));
  assert.ok(steps.every((e) => e.host === "laptop"));
  assert.ok(steps.some((e) => e.target === "~/.claude/f1.md"));
  assert.equal(JSON.parse(r.stdout).code, "ok", "stdout is still the one document");
});

test("the document, the exit code and the files are the same with events on and off", () => {
  const a = setup({ files: 2 });
  const b = setup({ files: 2 });
  const off = a.run(["apply", "--json"]);
  const on = b.run(["apply", "--json"], EVENTS);
  assert.equal(on.code, off.code);
  assert.equal(JSON.parse(on.stdout).created.length, 2);
  assert.deepEqual(Object.keys(JSON.parse(on.stdout)), Object.keys(JSON.parse(off.stdout)));
  assert.equal(off.stderr.includes('"event"'), false, "no events unless asked");
});

test("with events on, a human message is a message event and stderr holds nothing else", () => {
  const s = setup({ files: 1 });
  writeFileSync(join(s.home, ".claude", "f0.md"), "in the way\n");
  const r = s.run(["apply", "--json"], EVENTS);
  assert.equal(r.code, EXIT.conflict);
  const events = lines(r.stderr);
  const message = events.find((e) => e.event === "message" && String(e.text).includes("conflict"));
  assert.ok(message, r.stderr);
  assert.equal(message.host, "laptop");
});

test("a value other than 1 turns events off", () => {
  const s = setup({ files: 1 });
  assert.equal(s.run(["apply"], { FLEET_EVENTS: "0" }).stderr.includes('"event"'), false);
});

test("push with events: stages, host events in order, apply events tagged by host, and the same final document", () => {
  const s = setup({
    files: 2,
    hosts: { alpha: "me@alpha", edge: null, zed: "me@zed" },
    ssh: {
      "me@alpha": { stdout: applyDoc("ok", { created: [{}] }), stderr: [JSON.stringify({ v: 1, event: "stage", host: "spoof", stage: "write", of: 5 }), JSON.stringify({ v: 1, event: "step", step: "write-link", target: "~/.x", n: 1, of: 5 }), JSON.stringify({ v: 1, event: "host", host: "zed", state: "done", result: "ok" })].join("\n") },
      "me@zed": { stdout: applyDoc("ok"), stderr: "just an old fleet \u001b[31mwriting text\u001b[0m" },
    },
  });
  const r = s.run(["push", "--json"], EVENTS);
  assert.equal(r.code, EXIT.ok, r.stderr);
  const events = lines(r.stderr);
  assert.deepEqual(events.filter((e) => e.event === "stage" && e.host === undefined).map((e) => e.stage), ["validate", "publish", "apply"]);
  assert.deepEqual(events.find((e) => e.event === "hosts")!.hosts, [{ host: "laptop", via: "local" }, { host: "alpha", via: "ssh" }, { host: "edge", via: "timer" }, { host: "zed", via: "ssh" }]);
  assert.deepEqual(events.filter((e) => e.event === "host").map((e) => `${e.host}:${e.state}`), ["laptop:start", "laptop:done", "alpha:start", "alpha:done", "edge:start", "edge:done", "zed:start", "zed:done"]);
  const alpha = events.filter((e) => e.host === "alpha" && (e.event === "stage" || e.event === "step"));
  assert.deepEqual(alpha.map((e) => e.event), ["stage", "step"], "a remote's own host event is not forwarded");
  assert.equal(alpha[0]!.stage, "write", "the lane is the one that ssh reached, not the one the remote claimed");
  const old = events.find((e) => e.host === "zed" && e.event === "message");
  assert.equal(old!.text, "just an old fleet ?[31mwriting text?[0m", "text from a remote is cut to printable characters");
  assert.ok(events.some((e) => e.host === "laptop" && e.event === "step"), "the local apply's steps are forwarded too");
  assert.equal(events.filter((e) => e.event === "step" && e.host === undefined).length, 1, "one publish step for the config repo");
  const doc = JSON.parse(r.stdout);
  assert.deepEqual(doc.hosts.map((h: Ev) => [h.host, h.result]), [["laptop", "ok"], ["alpha", "ok"], ["edge", "timer"], ["zed", "ok"]]);
  assert.equal(doc.hosts[1].changes, 1);
});

test("push runs the remote with FLEET_EVENTS=1 only when events are on", () => {
  const s = setup({ hosts: { server: "me@server" }, ssh: { "me@server": { stdout: applyDoc("ok") } } });
  assert.equal(s.run(["push", "--json"]).code, EXIT.ok);
  assert.equal(s.sshCalls()[0]!.at(-1), "~/.local/bin/fleet apply --json");
  assert.equal(s.run(["push", "--json"], EVENTS).code, EXIT.ok);
  assert.equal(s.sshCalls()[1]!.at(-1), "FLEET_EVENTS=1 ~/.local/bin/fleet apply --json");
});

test("a remote that emits no events still ends with its one document, and an unreachable host is told", () => {
  const s = setup({
    hosts: { a: "me@a", b: "me@b" },
    ssh: { "me@a": { stdout: applyDoc("ok") }, "me@b": { exit: 255, stderr: "ssh: connect to host b port 22: Connection timed out" } },
  });
  const r = s.run(["push", "--json"], EVENTS);
  assert.equal(r.code, EXIT.unreachable);
  const events = lines(r.stderr);
  assert.equal(events.filter((e) => e.host === "a" && (e.event === "step" || e.event === "stage")).length, 0);
  assert.ok(events.some((e) => e.host === "b" && e.event === "message" && String(e.text).includes("Connection timed out")));
  assert.deepEqual(JSON.parse(r.stdout).hosts.map((h: Ev) => h.result), ["ok", "ok", "unreachable"]);
});

test("a local conflict stops the rest: the other hosts are skipped and never reached", () => {
  const s = setup({ files: 1, hosts: { server: "me@server", edge: null }, ssh: { "me@server": { stdout: applyDoc("ok") } } });
  mkdirSync(join(s.home, ".claude"), { recursive: true });
  writeFileSync(join(s.home, ".claude/f0.md"), "in the way\n");
  const r = s.run(["push", "--json"], EVENTS);
  assert.equal(r.code, EXIT.conflict);
  const events = lines(r.stderr);
  assert.deepEqual(events.filter((e) => e.event === "host").map((e) => `${e.host}:${e.state}:${e.result ?? ""}`), ["laptop:start:", "laptop:done:conflict", "edge:skip:", "server:skip:"]);
  assert.deepEqual(s.sshCalls(), []);
});

test("readLine: a version it does not know, or text that is not JSON, becomes a message", () => {
  assert.deepEqual(readLine(JSON.stringify({ v: 2, event: "step", step: "x", target: "y", n: 1, of: 2 }), "h"), { event: "message", host: "h", text: '{"v":2,"event":"step","step":"x","target":"y","n":1,"of":2}' });
  assert.deepEqual(readLine("plain", "h"), { event: "message", host: "h", text: "plain" });
  assert.deepEqual(readLine(JSON.stringify({ v: 1, event: "step", step: "s", target: "t", n: -1, of: "x" }), "h"), { event: "step", host: "h", step: "s", target: "t", n: 0, of: 0 });
});
