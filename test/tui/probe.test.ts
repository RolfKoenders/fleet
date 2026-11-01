import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, installFakeSsh, installStatusTools, makeClone, makeHome, publish, writeExecutable } from "../helpers.ts";
import type { SshPlan } from "../helpers.ts";
import { createApp } from "../../src/tui/app.ts";
import { loadModel } from "../../src/tui/model.ts";
import { realProbe } from "../../src/tui/probe.ts";
import { runOnTerminal } from "../../src/tui/runtime.ts";
import { cannedProbe } from "./fixture.ts";

const doc = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ok: true,
    code: "ok",
    host: "remote",
    messages: [],
    repos: { fleet: { branch: "main", sha: "abc1234", clean: true, ahead: 0, behind: 0 } },
    applied: { at: "2026-10-30T10:00:00Z", ageSeconds: 600 },
    timer: "active",
    pending: 0,
    conflicts: 0,
    tools: { claude: "2.1.4", opencode: "1.4.2", sops: "3.13.3", node: "22.18.0", t3: "0.1.0" },
    ...over,
  });

function world(hosts: Record<string, SshPlan | null>) {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  mkdirSync(join(clone, "hosts"), { recursive: true });
  writeFileSync(join(clone, "hosts/laptop.yaml"), "ssh: me@laptop\n");
  const plans: Record<string, SshPlan> = {};
  for (const [name, plan] of Object.entries(hosts)) {
    writeFileSync(join(clone, "hosts", `${name}.yaml`), plan === null ? "{}\n" : `ssh: me@${name}\n`);
    if (plan) plans[`me@${name}`] = plan;
  }
  publish(clone, "hosts");
  installStatusTools(home);
  installFakeSsh(home, plans);
  return { clone, home, probe: realProbe(clone, clone, home), model: loadModel(clone, "laptop") };
}

// The fake tools log their own calls into the home; those logs are the test's, not the bridge's.
const tree = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.endsWith("-calls.log")).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? tree(p) : [`${p} ${statSync(p).size} ${statSync(p).mtimeMs}`];
  });

const never = new AbortController().signal;

test("probe: this host is read in place, off the main thread, and the other answers go through the same cut-down as status --all", async () => {
  const w = world({ server: { stdout: doc({ pending: 4, timer: "active\u001b[31m" }) } });
  const self = await w.probe.host(w.model.hosts.find((h) => h.self)!, never);
  assert.equal(self.result, "ok");
  assert.equal(self.status?.repos.fleet.sha, git(w.clone, "rev-parse", "HEAD"));
  assert.equal(self.status?.tools.claude, "2.1.4");
  const remote = await w.probe.host(w.model.hosts.find((h) => h.name === "server")!, never);
  assert.equal(remote.status?.pending, 4);
  assert.equal(remote.status?.timer, "active?[31m");
});

test("probe: unreachable, unusable and timer hosts are told apart", async () => {
  const w = world({
    down: { exit: 255, stderr: "ssh: connect to host down port 22: Connection refused" },
    odd: { stdout: "this is not json" },
    refused: { stdout: JSON.stringify({ ok: false, code: "invalid", messages: ["fleet: bad"] }), exit: 2 },
    edge: null,
  });
  const ask = (name: string) => w.probe.host(w.model.hosts.find((h) => h.name === name)!, never);
  const down = await ask("down");
  assert.equal(down.result, "unreachable");
  assert.match(down.detail ?? "", /Connection refused/);
  assert.equal((await ask("odd")).result, "error");
  assert.match((await ask("refused")).detail ?? "", /its status gave invalid: fleet: bad/);
  assert.deepEqual(await ask("edge"), { result: "timer", status: null });
});

test("probe: hosts are asked at once, and the screen keeps moving while they are slow", async () => {
  const w = world({ a: { exit: 255 }, b: { exit: 255 }, c: { exit: 255 }, d: { exit: 255 } });
  writeExecutable(join(w.home, ".local/bin/ssh"), `#!/bin/sh\nsleep 0.5\necho '${doc()}'\n`);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 20);
  const started = Date.now();
  const hosts = w.model.hosts.filter((h) => !h.self && h.ssh !== null);
  assert.equal(hosts.length, 4);
  const answers = await Promise.all(hosts.map((h) => w.probe.host(h, never)));
  clearInterval(timer);
  const took = Date.now() - started;
  assert.ok(answers.every((a) => a.result === "ok"));
  assert.ok(took < 1500, `four 0.5 s hosts took ${took} ms, one after another would take 2000+`);
  assert.ok(ticks >= 10, `the event loop ran ${ticks} times while waiting`);
});

test("probe: leaving cancels a slow ssh", async () => {
  const w = world({ a: { exit: 255 } });
  writeExecutable(join(w.home, ".local/bin/ssh"), `#!/bin/sh\nexec sleep 30\n`);
  const abort = new AbortController();
  const started = Date.now();
  const pending = w.probe.host(w.model.hosts.find((h) => h.name === "a")!, abort.signal);
  setTimeout(() => abort.abort(), 100);
  const r = await pending;
  assert.ok(Date.now() - started < 3000);
  assert.equal(r.result, "unreachable");
});

test("probe: conflicts are listed in full from this host, and nothing under the home changes", async () => {
  const w = world({});
  writeFileSync(join(w.clone, "hosts/_defaults.yaml"), "files:\n  - { source: fleet.yaml, target: ~/.claude/CLAUDE.md }\n");
  publish(w.clone, "defaults");
  mkdirSync(join(w.home, ".claude"), { recursive: true });
  writeFileSync(join(w.home, ".claude/CLAUDE.md"), "mine\n");
  const before = tree(w.home);
  const r = await w.probe.conflicts(never);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.items.length, 1);
    assert.match(r.items[0]!.detail, /~\/\.claude\/CLAUDE\.md is a file/);
    assert.match(r.items[0]!.fix, /fleet apply/);
  }
  await w.probe.host(w.model.hosts[0]!, never);
  assert.deepEqual(tree(w.home), before, "the probes wrote nothing");
});

function terminalRun(app: ReturnType<typeof createApp>) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 32 });
  let out = "";
  stdout.on("data", (d: Buffer) => (out += d.toString()));
  const done = runOnTerminal(app, { stdin, stdout }, { level: "truecolor" });
  const until = async (text: string, ms = 8000) => {
    const end = Date.now() + ms;
    while (!out.includes(text)) {
      if (Date.now() > end) throw new Error(`never saw ${JSON.stringify(text)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { stdin, out: () => out, done, until };
}

test("an escape sequence sent by a remote host cannot reach the terminal", async () => {
  const evil = "\u001b]52;c;ZXZpbA==\u0007\u001b[2J\u001b[31m\u001b]0;pwned\u0007";
  const w = world({
    a: { stdout: doc({ timer: `active${evil}`, repos: { fleet: { branch: `main${evil}`, sha: `abc${evil}`, clean: true, ahead: 0, behind: 0 } }, tools: { claude: `2.1.4${evil}`, opencode: null, sops: null, node: null, t3: null } }) },
    b: { exit: 255, stderr: `ssh: ${evil} refused` },
    c: { stdout: JSON.stringify({ ok: false, code: `bad${evil}`, messages: [`fleet: ${evil}`] }), exit: 2 },
    d: { stdout: evil },
  });
  const run = terminalRun(createApp({ model: w.model, probe: w.probe, motion: false, boot: false }));
  await run.until("2.1.4?");
  await run.until("unreachable over ssh");
  run.stdin.write("q");
  assert.equal(await run.done, 0);
  const out = run.out();
  assert.ok(out.includes("?]52;c;ZXZpbA=="), "the text is shown, with its controls turned into ?");
  // The bridge itself emits no OSC, no BEL and only the colour and cursor sequences it chose.
  assert.ok(!out.includes("\u001b]"), "no OSC sequence");
  assert.ok(!out.includes("\u0007"), "no bell");
  assert.ok(!out.includes("pwned") || !out.includes("\u001b]0;"), "no title change");
  const escapes = out.match(/\u001b\[[0-9;?$]*[A-Za-z]/g) ?? [];
  assert.ok(!escapes.some((e) => e === "\u001b[31m"), "the red the host asked for was not written");
});

test("even text that skipped the cleaning cannot reach the terminal: cells refuse controls", async () => {
  const evil = "\u001b]52;c;ZXZpbA==\u0007\u001b[31m";
  const base = cannedProbe();
  const model = loadModel(world({ a: { exit: 255 } }).clone, "laptop");
  const run = terminalRun(createApp({ model, probe: { ...base, host: async (h) => (h.self ? base.host(h, never) : { result: "error", status: null, detail: `raw ${evil}` }) }, motion: false, boot: false }));
  await run.until("raw ?]52");
  run.stdin.write("q");
  await run.done;
  assert.ok(!run.out().includes("\u001b]") && !run.out().includes("\u0007"));
  assert.ok(!(run.out().match(/\u001b\[[0-9;]*m/g) ?? ([] as string[])).includes("\u001b[31m"));
});

test("the terminal is put back when the app quits: the screen is left, the cursor shown", async () => {
  const model = loadModel(world({}).clone, "laptop");
  const run = terminalRun(createApp({ model, probe: cannedProbe(), motion: false, boot: false }));
  await run.until("fleet");
  assert.ok(run.out().includes("\u001b[?1049h"));
  run.stdin.write("\u0003");
  assert.equal(await run.done, 0);
  assert.ok(run.out().endsWith("\u001b[?25h\u001b[0m\u001b[?1049l") || run.out().includes("\u001b[?1049l"));
  assert.ok(run.out().lastIndexOf("\u001b[?1049l") > run.out().lastIndexOf("\u001b[?1049h"));
});

test("a task that throws is reported on the screen and does not stop it", async () => {
  const model = loadModel(world({}).clone, "laptop");
  const probe = { ...cannedProbe(), conflicts: async () => { throw new Error("boom"); } };
  const run = terminalRun(createApp({ model, probe, motion: false, boot: false }));
  await run.until("a background task failed: boom");
  run.stdin.write("q");
  assert.equal(await run.done, 0);
});

