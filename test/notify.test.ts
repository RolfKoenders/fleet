import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { gitEnv, makeClone, makeHome, NODE, pinText, publish, repoRoot, runFleet, tempDir, writeExecutable } from "./helpers.ts";
import { bridgeFor, makeConfig, ok } from "./tui/fixture.ts";
import { loadConfig, InvalidConfigError } from "../src/config.ts";
import { EXIT } from "../src/exit.ts";
import { alertAfterApply, alertsStatus, notifyStatePath, readNotifyState } from "../src/notify.ts";
import { channelsOf, mergeNotify, readNotify } from "../src/notifyconfig.ts";
import { desktopSender, realSenders } from "../src/notifysend.ts";
import type { Alert, Outcome, Senders } from "../src/notifysend.ts";
import type { Result } from "../src/output.ts";
import { LAUNCHD_LABEL } from "../src/scheduler.ts";
import { startedByTimer } from "../src/timerplan.ts";
import { findTool } from "../src/tools.ts";

/*
 * Alerts after a timer run. The rules of when to alert run against injected senders; the channels run against a
 * fake ntfy and webhook server on 127.0.0.1 and a fake desktop notifier on the home's PATH. Nothing here reaches
 * a network or a real desktop.
 */

const FAKE_URL_SECRET = "s3cr3t-topic-4f9a";
const FAKE_TOKEN = "tk_fake_token_77b1";

const conflictOf = (...paths: string[]): Result => ({
  code: "conflict",
  messages: ["fleet: conflict"],
  fields: { conflicts: paths.map((path) => ({ kind: "link", path, detail: "it is a file", fix: "move it" })) },
});
const OK: Result = { code: "ok", fields: { conflicts: [], warnings: ["claude is not installed"] } };
const failed = (code: Result["code"]): Result => ({ code, messages: ["fleet: it went wrong"] });

// ---- the rules, against injected senders ----

type Calls = { desktop: Alert[]; ntfy: { url: string; token: string | null; alert: Alert }[]; webhook: { url: string; alert: Alert }[] };

function unit(host: string, defaults = "{}\n") {
  const configDir = tempDir("fleet-notify-config-");
  mkdirSync(join(configDir, "hosts"), { recursive: true });
  writeFileSync(join(configDir, "hosts/laptop.yaml"), host);
  writeFileSync(join(configDir, "hosts/_defaults.yaml"), defaults);
  const home = makeHome("laptop");
  const calls: Calls = { desktop: [], ntfy: [], webhook: [] };
  const outcome: { desktop: Outcome; ntfy: Outcome; webhook: Outcome } = { desktop: { status: "sent" }, ntfy: { status: "sent" }, webhook: { status: "sent" } };
  const senders: Senders = {
    desktop: async (alert) => (calls.desktop.push(alert), outcome.desktop),
    ntfy: async (url, token, alert) => (calls.ntfy.push({ url, token, alert }), outcome.ntfy),
    webhook: async (url, alert) => (calls.webhook.push({ url, alert }), outcome.webhook),
  };
  const run = (result: Result, byTimer = true) => alertAfterApply(result, byTimer, { configDir, toolDir: repoRoot, home, senders });
  const alerts = () => calls.desktop.map((a) => a.event);
  return { configDir, home, calls, outcome, run, alerts };
}

const DESKTOP = "notify:\n  desktop: true\n";
const ALL = `notify:\n  desktop: true\n  ntfy: https://ntfy.example.com/topic\n  ntfy_token: tk_plain\n  webhook: https://hooks.example.com/in/abc\n`;

test("only a run the timer started alerts: a manual apply, a push and init show their result on screen", async () => {
  const u = unit(DESKTOP);
  assert.deepEqual(await u.run(conflictOf("~/a"), false), []);
  assert.deepEqual(u.alerts(), []);
  assert.equal(existsSync(notifyStatePath(u.home)), false, "a run that is not the timer's leaves nothing remembered");
  await u.run(conflictOf("~/a"), true);
  assert.deepEqual(u.alerts(), ["conflict"]);
});

test("a run that relaunched into new code alerts once: the run it started does it, not this one", async () => {
  const u = unit(DESKTOP);
  await alertAfterApply({ relayed: 3 }, true, { configDir: u.configDir, toolDir: repoRoot, home: u.home, senders: u.calls as never });
  assert.deepEqual(u.alerts(), []);
});

test("a new conflict, a stop with a real error and back to ok each alert once, and a repeat is quiet", async () => {
  const u = unit(DESKTOP);
  for (const result of [conflictOf("~/a"), conflictOf("~/a"), conflictOf("~/a")]) await u.run(result);
  assert.deepEqual(u.alerts(), ["conflict"], "the same conflict on every run is one alert");
  await u.run(conflictOf("~/a", "~/b"));
  assert.deepEqual(u.alerts(), ["conflict", "conflict"], "a conflict that was not there before is new");
  await u.run(conflictOf("~/b"));
  assert.deepEqual(u.alerts(), ["conflict", "conflict"], "one of them going away is not an alert while another remains");
  await u.run(failed("invalid"));
  await u.run(failed("invalid"));
  assert.deepEqual(u.alerts(), ["conflict", "conflict", "failed"]);
  await u.run(failed("needs-secret"));
  assert.deepEqual(u.alerts(), ["conflict", "conflict", "failed", "failed"], "a different error is a change");
  await u.run(OK);
  await u.run(OK);
  assert.deepEqual(u.alerts(), ["conflict", "conflict", "failed", "failed", "ok"]);
  assert.equal(readNotifyState(u.home)?.state, "ok");
  await u.run(conflictOf("~/a"));
  assert.equal(u.alerts().length, 6, "the conflict is new again after ok");
});

test("warnings, another apply running and an unreachable config repo are not alerts and do not change what the host remembers", async () => {
  const u = unit(DESKTOP);
  await u.run(OK);
  await u.run(failed("locked"));
  await u.run(failed("unreachable"));
  assert.deepEqual(u.alerts(), [], "an ok run with a warning, a locked apply and no network say nothing");
  await u.run(conflictOf("~/a"));
  await u.run(failed("locked"));
  await u.run(failed("unreachable"));
  await u.run(conflictOf("~/a"));
  assert.deepEqual(u.alerts(), ["conflict"], "and they do not make the conflict new, or the host ok");
  assert.equal(readNotifyState(u.home)?.state, "conflict");
});

test("the first run after alerts are turned on alerts once when the host is in a conflict or failing, and stays quiet when it is fine", async () => {
  const fine = unit(DESKTOP);
  await fine.run(OK);
  assert.deepEqual(fine.alerts(), []);
  const conflicted = unit(DESKTOP);
  await conflicted.run(conflictOf("~/a"));
  assert.deepEqual(conflicted.alerts(), ["conflict"]);
  const stopped = unit(DESKTOP);
  await stopped.run(failed("error"));
  assert.deepEqual(stopped.alerts(), ["failed"]);
});

test("turning alerts off makes the host forget, so turning them on again starts from nothing", async () => {
  const u = unit(DESKTOP);
  await u.run(conflictOf("~/a"));
  writeFileSync(join(u.configDir, "hosts/laptop.yaml"), "notify: off\n");
  await u.run(conflictOf("~/a"));
  assert.equal(existsSync(notifyStatePath(u.home)), false);
  writeFileSync(join(u.configDir, "hosts/laptop.yaml"), DESKTOP);
  await u.run(OK);
  assert.deepEqual(u.alerts(), ["conflict"], "fine after a conflict that was never cleared on record: nothing to say");
});

test("a config that cannot be read is the apply's to report: the host's alerts are left as they were", async () => {
  const u = unit(DESKTOP);
  await u.run(conflictOf("~/a"));
  writeFileSync(join(u.configDir, "hosts/laptop.yaml"), "notify: [not, a, map]\n");
  assert.deepEqual(await u.run(failed("invalid")), []);
  assert.equal(readNotifyState(u.home)?.state, "conflict");
});

test("an alert says the host, what happened, the first conflict and the command, and the webhook gets the same as fields", async () => {
  const u = unit(ALL);
  await u.run(conflictOf("~/.claude/CLAUDE.md", "~/b"));
  const [alert] = u.calls.desktop;
  assert.equal(alert!.host, "laptop");
  assert.equal(alert!.message, "laptop has 2 conflicts: link ~/.claude/CLAUDE.md and 1 more. Run: fleet status --conflicts");
  const [hook] = u.calls.webhook;
  assert.equal(hook!.url, "https://hooks.example.com/in/abc");
  assert.deepEqual(Object.keys(hook!.alert).sort(), ["conflict", "event", "fleet", "host", "message", "time"]);
  assert.deepEqual(hook!.alert.conflict, { kind: "link", path: "~/.claude/CLAUDE.md" });
  assert.equal(u.calls.ntfy[0]!.token, "tk_plain");
  await u.run(failed("invalid"));
  assert.equal(u.calls.desktop[1]!.message, "laptop: the apply stopped: the config is invalid. Run: fleet apply");
  assert.equal(u.calls.desktop[1]!.conflict, null);
  await u.run(OK);
  assert.equal(u.calls.desktop[2]!.message, "laptop is ok again.");
});

test("a failed delivery does not fail the apply: it is a line for the log, it is remembered, and the next change tries again", async () => {
  const u = unit(ALL);
  u.outcome.ntfy = { status: "failed", reason: "HTTP 403" };
  u.outcome.desktop = { status: "skipped", reason: "no desktop session" };
  const lines = await u.run(conflictOf("~/a"));
  assert.deepEqual(lines, ["fleet: alert not delivered (ntfy: HTTP 403)"], "only a failure is logged; a skipped desktop is not");
  assert.equal(u.calls.webhook.length, 1, "the other channels still went");
  assert.deepEqual(readNotifyState(u.home)!.sent!.channels, { desktop: "skipped: no desktop session", ntfy: "failed: HTTP 403", webhook: "sent" });
  assert.deepEqual(await u.run(conflictOf("~/a")), [], "no retry loop: the same state sends nothing");
  assert.equal(u.calls.ntfy.length, 1);
  u.outcome.ntfy = { status: "sent" };
  await u.run(OK);
  assert.equal(u.calls.ntfy.length, 2, "the next change of state tries again");
  assert.equal(alertsStatus(u.configDir, "laptop", u.home)!.failures.length, 0);
});

test("a sender that throws is a failed delivery, and the apply is not touched", async () => {
  const u = unit(DESKTOP);
  const lines = await alertAfterApply(conflictOf("~/a"), true, { configDir: u.configDir, toolDir: repoRoot, home: u.home, senders: { ...u.calls, desktop: async () => { throw new Error("boom https://x.example.com/s3cret"); } } as never });
  assert.deepEqual(lines, ["fleet: alert not delivered (desktop: could not send)"]);
});

// ---- the key ----

test("notify: a host file overrides one field at a time, and off turns every alert off for that host", () => {
  const u = unit("notify:\n  desktop: false\n", `notify:\n  desktop: true\n  ntfy: secret:NTFY_URL\n  webhook: secret:FLEET_WEBHOOK\n`);
  const config = readNotify(u.configDir, "laptop", []);
  assert.deepEqual(config, { desktop: false, ntfy: "secret:NTFY_URL", ntfyToken: null, webhook: "secret:FLEET_WEBHOOK" });
  assert.deepEqual(channelsOf(config), ["ntfy", "webhook"]);
  writeFileSync(join(u.configDir, "hosts/laptop.yaml"), "notify:\n  ntfy_token: secret:T\n  webhook: https://hooks.example.com/x\n");
  assert.deepEqual(readNotify(u.configDir, "laptop", []), { desktop: true, ntfy: "secret:NTFY_URL", ntfyToken: "secret:T", webhook: "https://hooks.example.com/x" });
  writeFileSync(join(u.configDir, "hosts/laptop.yaml"), "notify: off\n");
  assert.equal(readNotify(u.configDir, "laptop", []), null);
  writeFileSync(join(u.configDir, "hosts/laptop.yaml"), "{}\n");
  assert.notEqual(readNotify(u.configDir, "laptop", []), null, "no key in the host file keeps the defaults'");
});

test("notify: no notify key means no alerts, and desktop is only on when a file says so", () => {
  assert.equal(mergeNotify(null, null), null);
  assert.equal(mergeNotify("off", null), null);
  assert.deepEqual(mergeNotify(null, { ntfy: "https://ntfy.example.com/t" }), { desktop: false, ntfy: "https://ntfy.example.com/t", ntfyToken: null, webhook: null });
  assert.deepEqual(channelsOf(mergeNotify({ desktop: false }, null)), []);
  const u = unit("{}\n");
  assert.equal(readNotify(u.configDir, "laptop", []), null);
});

test("notify: the loader refuses what is not a channel, a bool or a URL, and never shows the value it refused", () => {
  const bad = (yaml: string): string[] => {
    const u = unit(yaml);
    writeFileSync(join(u.configDir, "fleet.yaml"), pinText("https://example.invalid/fleet.git", "a".repeat(40)));
    try {
      loadConfig(u.configDir, "laptop", { home: u.home, sources: "none" });
      return [];
    } catch (error) {
      if (!(error instanceof InvalidConfigError)) throw error;
      return error.problems;
    }
  };
  assert.deepEqual(bad("notify:\n  desktop: true\n  ntfy: secret:NTFY_URL\n"), []);
  assert.deepEqual(bad("notify: off\n"), []);
  assert.match(bad("notify:\n  slack: x\n").join("\n"), /unknown key 'notify.slack'/);
  assert.match(bad("notify: on\n").join("\n"), /'notify' must be a map of channels or off/);
  assert.match(bad("notify:\n  desktop: yes please\n").join("\n"), /'notify.desktop' must be true or false/);
  const url = bad(`notify:\n  webhook: not-a-url-${FAKE_URL_SECRET}\n`).join("\n");
  assert.match(url, /'notify.webhook' must be an http or https URL, or secret:NAME/);
  assert.doesNotMatch(url, new RegExp(FAKE_URL_SECRET));
  assert.match(bad("notify:\n  ntfy: 5\n").join("\n"), /'notify.ntfy' must be a string/);
});

// ---- who started the run ----

test("startedByTimer: a run in fleet.service's control group is the timer's, on a Mac the agent's label is", () => {
  assert.equal(startedByTimer("linux", {}, "0::/user.slice/user-1000.slice/user@1000.service/app.slice/fleet.service\n"), true);
  assert.equal(startedByTimer("linux", {}, "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-kitty@1234.service\n"), false, "a terminal started as a service is not the timer");
  assert.equal(startedByTimer("linux", {}, "0::/user.slice/user-1000.slice/user@1000.service/app.slice/notfleet.service\n"), false);
  assert.equal(startedByTimer("linux", { INVOCATION_ID: "abc" }, ""), false, "INVOCATION_ID is not enough");
  assert.equal(startedByTimer("darwin", { XPC_SERVICE_NAME: LAUNCHD_LABEL }), true);
  assert.equal(startedByTimer("darwin", { XPC_SERVICE_NAME: "0" }), false);
  assert.equal(startedByTimer("linux", { XPC_SERVICE_NAME: LAUNCHD_LABEL }, ""), false);
});

// ---- the channels ----

type Hit = { method: string | undefined; url: string | undefined; headers: IncomingMessage["headers"]; body: string };

async function listen(status: () => number = () => 200): Promise<{ server: Server; url: string; hits: Hit[] }> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.statusCode = status();
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${port}`, hits };
}

const alert = (over: Partial<Alert> = {}): Alert => ({ event: "conflict", host: "laptop", message: "laptop has a conflict: link ~/a. Run: fleet status --conflicts", conflict: { kind: "link", path: "~/a" }, time: "2026-11-22T10:00:00Z", fleet: "abc1234", ...over });

test("ntfy gets the message as the body, high priority and a warning tag for a problem, default priority for ok, and the token as a bearer", async () => {
  const ntfy = await listen();
  try {
    const senders = realSenders(makeHome("laptop"), "linux", {});
    assert.deepEqual(await senders.ntfy(`${ntfy.url}/topic`, FAKE_TOKEN, alert()), { status: "sent" });
    assert.deepEqual(await senders.ntfy(`${ntfy.url}/topic`, null, alert({ event: "ok", message: "laptop is ok again." })), { status: "sent" });
    const [problem, fine] = ntfy.hits;
    assert.equal(problem!.method, "POST");
    assert.equal(problem!.url, "/topic");
    assert.equal(problem!.body, "laptop has a conflict: link ~/a. Run: fleet status --conflicts");
    assert.equal(problem!.headers.priority, "high");
    assert.equal(problem!.headers.tags, "warning");
    assert.equal(problem!.headers.title, "fleet: laptop");
    assert.equal(problem!.headers.authorization, `Bearer ${FAKE_TOKEN}`);
    assert.equal(fine!.headers.priority, "default");
    assert.equal(fine!.headers.tags, "white_check_mark");
    assert.equal(fine!.headers.authorization, undefined, "no token, no header");
  } finally {
    ntfy.server.close();
  }
});

test("the webhook gets a POST of the small versioned JSON body", async () => {
  const hook = await listen();
  try {
    const senders = realSenders(makeHome("laptop"), "linux", {});
    assert.deepEqual(await senders.webhook(`${hook.url}/in`, alert()), { status: "sent" });
    await senders.webhook(`${hook.url}/in`, alert({ event: "ok", message: "laptop is ok again.", conflict: null }));
    assert.equal(hook.hits[0]!.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(hook.hits[0]!.body), { v: 1, host: "laptop", event: "conflict", message: "laptop has a conflict: link ~/a. Run: fleet status --conflicts", conflict: { kind: "link", path: "~/a" }, time: "2026-11-22T10:00:00Z", fleet: "abc1234" });
    assert.equal(JSON.parse(hook.hits[1]!.body).conflict, null);
  } finally {
    hook.server.close();
  }
});

test("a refusing, a redirecting and an absent server are failures with a reason that holds no URL", async () => {
  const refusing = await listen(() => 403);
  const redirecting = await listen(() => 302);
  const senders = realSenders(makeHome("laptop"), "linux", {});
  try {
    assert.deepEqual(await senders.ntfy(`${refusing.url}/${FAKE_URL_SECRET}`, FAKE_TOKEN, alert()), { status: "failed", reason: "HTTP 403" });
    assert.deepEqual(await senders.webhook(`${redirecting.url}/${FAKE_URL_SECRET}`, alert()), { status: "failed", reason: "HTTP 302" });
  } finally {
    refusing.server.close();
    redirecting.server.close();
  }
  const gone = await listen();
  gone.server.close();
  const refused = await senders.webhook(`${gone.url}/${FAKE_URL_SECRET}`, alert());
  assert.deepEqual(refused, { status: "failed", reason: "connection refused" });
  assert.deepEqual(await senders.webhook(`not a url ${FAKE_URL_SECRET}`, alert()), { status: "failed", reason: "not a valid URL" });
});

function fakeNotifier(home: string, name: string, exit = 0): string {
  const log = join(home, `${name}.log`);
  writeExecutable(join(home, ".local/bin", name), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > ${log}\nexit ${exit}\n`);
  return log;
}

test("desktop: notify-send on Linux gets the title and the message as arguments; with no desktop session it is skipped, not an error", async () => {
  const home = makeHome("laptop");
  // A notify-send installed in a system directory cannot be hidden, and must not be run: only the fake below is.
  if (findTool("notify-send", {}, home) === null) assert.deepEqual(await desktopSender(home, "linux", { DISPLAY: ":0" })(alert()), { status: "skipped", reason: "notify-send is not installed" });
  const log = fakeNotifier(home, "notify-send");
  assert.deepEqual(await desktopSender(home, "linux", { DISPLAY: ":0" })(alert()), { status: "sent" });
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["--app-name=fleet", "--urgency=critical", "fleet: laptop", "laptop has a conflict: link ~/a. Run: fleet status --conflicts"]);
  assert.deepEqual(await desktopSender(home, "linux", { WAYLAND_DISPLAY: "wayland-1", DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent" })(alert({ event: "ok" })), { status: "sent" });
  assert.match(readFileSync(log, "utf8"), /--urgency=normal/);
  const server = await desktopSender(home, "linux", { XDG_RUNTIME_DIR: tempDir("fleet-run-") })(alert());
  assert.deepEqual(server, { status: "skipped", reason: "no desktop session" }, "a server has no display and no session bus");
  fakeNotifier(home, "notify-send", 1);
  assert.deepEqual(await desktopSender(home, "linux", { DISPLAY: ":0" })(alert()), { status: "failed", reason: "notify-send failed" });
  assert.deepEqual(await desktopSender(home, "linux", { XDG_RUNTIME_DIR: tempDir("fleet-run-"), DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent" })(alert()), { status: "skipped", reason: "no desktop session" }, "a failure with no display is a missing session");
});

test("desktop: osascript on a Mac gets the text as arguments, never inside the script", async () => {
  const home = makeHome("laptop");
  const log = fakeNotifier(home, "osascript");
  const nasty = `a "quote" and $(touch ${join(home, "pwned")}) and 'single'`;
  assert.deepEqual(await desktopSender(home, "darwin", {})(alert({ message: nasty })), { status: "sent" });
  const args = readFileSync(log, "utf8").split("\n");
  assert.deepEqual(args.slice(0, 4), ["-e", "on run argv", "-e", "display notification (item 1 of argv) with title (item 2 of argv)"]);
  assert.ok(args.includes(nasty));
  assert.equal(existsSync(join(home, "pwned")), false);
  writeExecutable(join(home, ".local/bin/osascript"), "#!/bin/sh\necho 'execution error: Connection invalid (-609)' >&2\nexit 1\n");
  assert.deepEqual(await desktopSender(home, "darwin", {})(alert()), { status: "skipped", reason: "no desktop session" });
});

// ---- end to end, through the CLI, as the timer runs it ----

const SOPS = findTool("sops");
const AGE_KEYGEN = findTool("age-keygen");
if (SOPS === null || AGE_KEYGEN === null) throw new Error("these tests need sops and age-keygen on the probe path");

type Done = { code: number | null; stdout: string; stderr: string };

/** Runs `fleet` without blocking this process, which holds the fake servers. */
function runAsync(clone: string, home: string, args: string[], env: Record<string, string> = {}): Promise<Done> {
  return new Promise((resolve) => {
    const child = spawn(join(clone, "bin/fleet"), args, { env: { PATH: "/usr/bin:/bin", HOME: home, FLEET_NODE: NODE, ...gitEnv, FLEET_CONFIG: clone, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** The timer's own run on a Mac: the label launchd gives a job. */
const TIMER = { XPC_SERVICE_NAME: LAUNCHD_LABEL };

async function world(webhookStatus: () => number = () => 200) {
  const ntfy = await listen();
  const hook = await listen(webhookStatus);
  const { clone } = makeClone();
  const home = makeHome("laptop");
  writeExecutable(join(home, ".local/bin/uname"), `#!/bin/sh\nif [ "$1" = "-s" ]; then echo Darwin; else exec /usr/bin/uname "$@"; fi\n`);
  const osascriptLog = fakeNotifier(home, "osascript");
  for (const [name, path] of [["sops", SOPS!], ["age-keygen", AGE_KEYGEN!]] as const) symlinkSync(path, join(home, ".local/bin", name));
  const key = spawnSync(AGE_KEYGEN!, [], { encoding: "utf8" }).stdout;
  const recipient = spawnSync(AGE_KEYGEN!, ["-y"], { encoding: "utf8", input: key }).stdout.trim();
  mkdirSync(join(home, ".config/fleet"), { recursive: true });
  writeFileSync(join(home, ".config/fleet/age.key"), key, { mode: 0o600 });
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(clone, rel)), { recursive: true });
    writeFileSync(join(clone, rel), text);
  };
  write("hosts/_defaults.yaml", "{}\n");
  write("config/a.md", "a\n");
  write("hosts/laptop.yaml", `admin: true\nage: ${recipient}\nnotify:\n  desktop: true\n  ntfy: secret:NTFY_URL\n  ntfy_token: secret:NTFY_TOKEN\n  webhook: secret:FLEET_WEBHOOK\nfiles:\n  - { source: config/a.md, target: ~/conflicted }\n`);
  publish(clone);
  for (const [name, value] of [["NTFY_URL", `${ntfy.url}/${FAKE_URL_SECRET}`], ["NTFY_TOKEN", FAKE_TOKEN], ["FLEET_WEBHOOK", `${hook.url}/${FAKE_URL_SECRET}`]] as const) {
    const r = runFleet(clone, ["secrets", "set", "laptop", name], { home, input: value });
    assert.equal(r.code, EXIT.ok, r.stderr);
  }
  publish(clone);
  writeFileSync(join(home, "conflicted"), "mine");
  const everything = (...runs: Done[]): string => [...runs.flatMap((r) => [r.stdout, r.stderr]), existsSync(notifyStatePath(home)) ? readFileSync(notifyStatePath(home), "utf8") : "", existsSync(osascriptLog) ? readFileSync(osascriptLog, "utf8") : ""].join("\n");
  return { ntfy, hook, clone, home, osascriptLog, write, everything, close: () => (ntfy.server.close(), hook.server.close()) };
}

const hasNothingSecret = (text: string): void => {
  for (const secret of [FAKE_URL_SECRET, FAKE_TOKEN]) assert.equal(text.includes(secret), false, `${secret} must not appear`);
};

test("end to end: the timer's apply alerts through desktop, ntfy and the webhook once per change, and a manual apply never does", async () => {
  const w = await world();
  try {
    const manual = await runAsync(w.clone, w.home, ["apply"]);
    assert.equal(manual.code, EXIT.conflict);
    assert.equal(w.ntfy.hits.length + w.hook.hits.length, 0, "a manual apply shows its result on screen and sends nothing");
    assert.equal(existsSync(notifyStatePath(w.home)), false);

    const first = await runAsync(w.clone, w.home, ["apply"], TIMER);
    assert.equal(first.code, EXIT.conflict, "the alert does not change the apply's result");
    assert.equal(w.ntfy.hits.length, 1);
    assert.equal(w.hook.hits.length, 1);
    const [n] = w.ntfy.hits;
    assert.equal(n!.url, `/${FAKE_URL_SECRET}`, "the secret was rendered into the topic URL");
    assert.equal(n!.headers.authorization, `Bearer ${FAKE_TOKEN}`);
    assert.equal(n!.headers.priority, "high");
    assert.match(n!.body, /^laptop has a conflict: link ~\/conflicted\. Run: fleet status --conflicts$/);
    const body = JSON.parse(w.hook.hits[0]!.body);
    assert.deepEqual({ ...body, time: "t", fleet: "f" }, { v: 1, host: "laptop", event: "conflict", message: n!.body, conflict: { kind: "link", path: "~/conflicted" }, time: "t", fleet: "f" });
    assert.match(body.fleet, /^[0-9a-f]{7}$/);
    assert.match(readFileSync(w.osascriptLog, "utf8"), /laptop has a conflict/, "the desktop got it too");

    await runAsync(w.clone, w.home, ["apply"], TIMER);
    assert.equal(w.ntfy.hits.length, 1, "the same conflict on the next run is not an alert");

    writeFileSync(join(w.home, "conflicted"), "");
    spawnSync("rm", [join(w.home, "conflicted")]);
    const fine = await runAsync(w.clone, w.home, ["apply"], TIMER);
    assert.equal(fine.code, EXIT.ok);
    assert.equal(w.ntfy.hits.length, 2);
    assert.equal(w.ntfy.hits[1]!.headers.priority, "default");
    assert.equal(JSON.parse(w.hook.hits[1]!.body).event, "ok");
    hasNothingSecret(w.everything(manual, first, fine));
  } finally {
    w.close();
  }
});

test("end to end: a refusing webhook fails nothing, shows in the log and in status text and --json, and no secret is in any output", async () => {
  const w = await world(() => 403);
  try {
    const run = await runAsync(w.clone, w.home, ["apply"], TIMER);
    assert.equal(run.code, EXIT.conflict, "the conflict is the apply's result, the webhook does not add to it");
    assert.match(run.stderr, /fleet: alert not delivered \(webhook: HTTP 403\)/);
    const text = await runAsync(w.clone, w.home, ["status"], TIMER);
    assert.match(text.stdout, /^alerts: desktop, ntfy, webhook · last sent \d+s ago \(conflict\) · webhook failed: HTTP 403$/m);
    const json = await runAsync(w.clone, w.home, ["status", "--json"]);
    const alerts = JSON.parse(json.stdout).alerts;
    assert.deepEqual(alerts.channels, ["desktop", "ntfy", "webhook"]);
    assert.equal(alerts.last.event, "conflict");
    assert.deepEqual(alerts.failures, [{ channel: "webhook", reason: "HTTP 403" }]);
    const asJson = await runAsync(w.clone, w.home, ["apply", "--json"], TIMER);
    hasNothingSecret(w.everything(run, text, json, asJson));
  } finally {
    w.close();
  }
});

test("end to end: fleet notify --test sends a test alert through every channel and reports each, without remembering it", async () => {
  const w = await world(() => 403);
  try {
    const r = await runAsync(w.clone, w.home, ["notify", "--test"]);
    assert.equal(r.code, EXIT.error, "a channel that failed makes the command fail");
    assert.deepEqual(r.stdout.trim().split("\n"), ["desktop: sent", "ntfy: sent", "webhook: failed: HTTP 403"]);
    assert.match(w.ntfy.hits[0]!.body, /Test alert from fleet on laptop\./);
    assert.equal(JSON.parse(w.hook.hits[0]!.body).test, true);
    assert.equal(existsSync(notifyStatePath(w.home)), false);
    const json = await runAsync(w.clone, w.home, ["notify", "--test", "--json"]);
    assert.deepEqual(JSON.parse(json.stdout).channels, [{ channel: "desktop", result: "sent" }, { channel: "ntfy", result: "sent" }, { channel: "webhook", result: "failed", reason: "HTTP 403" }]);
    hasNothingSecret(w.everything(r, json));
    const bare = await runAsync(w.clone, w.home, ["notify"]);
    assert.equal(bare.code, EXIT.invalid);
    assert.match(bare.stderr, /notify needs --test/);
  } finally {
    w.close();
  }
});

test("end to end: a secret that cannot be read fails its channel with a fixed reason, and says nothing of the value", async () => {
  const w = await world();
  try {
    w.write("hosts/laptop.yaml", readFileSync(join(w.clone, "hosts/laptop.yaml"), "utf8").replace("secret:FLEET_WEBHOOK", "secret:NOT_THERE"));
    publish(w.clone);
    const r = await runAsync(w.clone, w.home, ["notify", "--test"]);
    assert.deepEqual(r.stdout.trim().split("\n"), ["desktop: sent", "ntfy: sent", "webhook: failed: a secret it uses could not be read"]);
    hasNothingSecret(w.everything(r));
  } finally {
    w.close();
  }
});

test("fleet notify --test on a host with no alerts says so and exits 2", () => {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  mkdirSync(join(clone, "hosts"), { recursive: true });
  writeFileSync(join(clone, "hosts/laptop.yaml"), "{}\n");
  publish(clone);
  const r = runFleet(clone, ["notify", "--test"], { home });
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /no alerts set up/);
  const status = runFleet(clone, ["status"], { home });
  assert.doesNotMatch(status.stdout, /alerts:/, "a host that has no alerts shows no line");
  assert.equal(JSON.parse(runFleet(clone, ["status", "--json"], { home }).stdout).alerts, null);
  assert.equal(runFleet(clone, ["status", "--test"], { home }).code, EXIT.invalid);
});

test("an unreadable or foreign notify.json is no memory at all, and status copes with it", () => {
  const u = unit(DESKTOP);
  mkdirSync(dirname(notifyStatePath(u.home)), { recursive: true });
  for (const text of ["not json", "[]", '{"version":2}', '{"version":1,"state":"bogus"}']) {
    writeFileSync(notifyStatePath(u.home), text);
    assert.equal(readNotifyState(u.home), null, text);
  }
  assert.deepEqual(alertsStatus(u.configDir, "laptop", u.home), { channels: ["desktop"], last: null, failures: [] });
  chmodSync(dirname(notifyStatePath(u.home)), 0o700);
});

// ---- the bridge ----

test("the bridge's host card shows a small mark when the last delivery failed, and not otherwise or for an old answer", async () => {
  const alerts = (failures: { channel: "ntfy"; reason: string }[]) => ({ channels: ["ntfy" as const], last: { event: "conflict" as const, at: "2026-11-22T10:00:00Z", ageSeconds: 60 }, failures });
  const marked = (await bridgeFor(makeConfig(), { hosts: { laptop: ok({ alerts: alerts([{ channel: "ntfy", reason: "HTTP 403" }]) }) } })).frame();
  assert.match(marked, /timer active  ⚠ alert not sent/);
  const fine = (await bridgeFor(makeConfig(), { hosts: { laptop: ok({ alerts: alerts([]) }) } })).frame();
  assert.doesNotMatch(fine, /alert not sent/);
  const none = (await bridgeFor(makeConfig(), { hosts: { laptop: ok() } })).frame();
  assert.doesNotMatch(none, /alert not sent/);
});
