import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readDoctor } from "../../src/tui/doctorread.ts";
import type { DoctorResult } from "../../src/tui/doctorread.ts";
import { realProbe } from "../../src/tui/probe.ts";
import { loadModel } from "../../src/tui/model.ts";
import { bridgeFor, makeConfig } from "./fixture.ts";
import { makeClone, makeHome, runFleet, tempDir, writeExecutable } from "../helpers.ts";

const server = (name: string, tool: string, result: string, over: Record<string, unknown> = {}) => ({ server: name, tool, transport: "stdio", result, tools: result === "ok" ? 12 : null, latencyMs: 30, detail: null, fails: result !== "ok" && result !== "login", ...over });

/** A document as the newer doctor prints it: a `protocol` on each server, a `login` result, exit code 8 behind it. */
const NEW = {
  ok: false,
  code: "unhealthy",
  host: "laptop",
  messages: ["fleet: doctor found 1 problem"],
  checks: [{ name: "timer", result: "ok", detail: null }],
  servers: [
    server("docs", "claude", "ok", { protocol: "2025-06-18" }),
    server("docs", "opencode", "ok", { protocol: "2025-06-18" }),
    server("tracker", "claude", "login"),
    server("tracker-local", "claude", "timeout", { detail: "no answer in 30s" }),
  ],
};

/** The document of an older doctor: no protocol, `auth-needed` for a server that wants a login. */
const OLD = { ok: true, code: "ok", host: "laptop", messages: [], checks: [], servers: [server("docs", "claude", "ok"), server("tracker", "claude", "auth-needed", { fails: false })] };

const ALL = {
  ...NEW,
  hosts: [
    { host: "box", result: "ok", doctor: { checks: [], servers: [server("docs", "claude", "ok"), server("tracker", "claude", "quantum-state"), server("tracker-local", "claude", "exited", { detail: "gone\u001b[31m red" })] } },
    { host: "edge", result: "timer", doctor: null },
    { host: "laptop", result: "problems", doctor: { checks: [], servers: NEW.servers } },
    { host: "server", result: "unreachable", doctor: null, detail: "unreachable over ssh" },
  ],
};

test("doctor json: ok is ok, login is neutral, real failures are bad, and a word it does not know is unknown", () => {
  const r = readDoctor(JSON.stringify(NEW), null);
  assert.ok(r.ok);
  const s = r.hosts.laptop!.servers;
  assert.equal(s.docs!.health, "ok");
  assert.equal(s.docs!.protocol, "2025-06-18");
  assert.equal(s.tracker!.health, "neutral");
  assert.equal(s["tracker-local"]!.health, "bad");
  assert.equal(s["tracker-local"]!.detail, "no answer in 30s");
  assert.match(s.docs!.words, /claude: ok, 12 tools, opencode: ok, 12 tools/);
});

test("doctor json: an older document reads the same way, without a protocol, and auth-needed that does not fail is neutral", () => {
  const r = readDoctor(JSON.stringify(OLD), null);
  assert.ok(r.ok);
  assert.equal(r.hosts.laptop!.servers.docs!.protocol, null);
  assert.equal(r.hosts.laptop!.servers.tracker!.health, "neutral");
  const failing = readDoctor(JSON.stringify({ ...OLD, servers: [server("tracker", "claude", "auth-needed", { fails: true })] }), null);
  assert.ok(failing.ok);
  assert.equal(failing.hosts.laptop!.servers.tracker!.health, "bad");
});

test("doctor json: --all gives a record for each host, unknown results stay unknown, and text from a host is cut down", () => {
  const r = readDoctor(JSON.stringify(ALL), null);
  assert.ok(r.ok);
  assert.deepEqual(Object.keys(r.hosts).sort(), ["box", "edge", "laptop", "server"]);
  assert.equal(r.hosts.box!.servers.tracker!.health, "unknown");
  assert.equal(r.hosts.box!.servers["tracker-local"]!.health, "bad");
  assert.doesNotMatch(JSON.stringify(r), /\u001b/);
  assert.match(r.hosts.edge!.note!, /no ssh destination/);
  assert.equal(r.hosts.server!.note, "unreachable over ssh");
  assert.deepEqual(r.hosts.server!.servers, {});
});

test("doctor json: nothing that is not a document is a pass", () => {
  for (const text of ["", "not json", "[]", "{}", JSON.stringify({ code: "invalid", messages: ["fleet: no host name set"] })]) {
    const r: DoctorResult = readDoctor(text, null);
    assert.equal(r.ok, false, text);
  }
  const r = readDoctor(JSON.stringify({ code: "invalid", messages: ["fleet: no host name set; run init"] }), null);
  assert.equal(r.ok === false && r.detail, "doctor gave invalid: no host name set; run init");
});

/** A tool directory whose `bin/fleet` prints a fixture and exits as told, and notes how it was run. */
function fakeTool(output: unknown, exit: number) {
  const dir = tempDir("fleet-fake-tool-");
  writeExecutable(join(dir, "bin/fleet"), `#!/bin/sh\necho "$HOME|$FLEET_CONFIG|$*" >> "$HOME/doctor-runs"\ncat <<'EOF'\n${JSON.stringify(output)}\nEOF\nexit ${exit}\n`);
  return dir;
}

test("the real probe runs fleet doctor --json as a child in the given home, reads the document and ignores the exit code", async () => {
  for (const exit of [0, 1, 8, 2]) {
    const home = makeHome("laptop");
    const config = tempDir("fleet-cfg-");
    const probe = realProbe(fakeTool(ALL, exit), config, home);
    const r = await probe.doctor!(true, new AbortController().signal);
    assert.ok(r.ok, `exit ${exit}`);
    assert.equal(Object.keys(r.hosts).length, 4);
    assert.equal(readFileSync(join(home, "doctor-runs"), "utf8").trim(), `${home}|${config}|doctor --json --all`);
  }
  const home = makeHome("laptop");
  const one = await realProbe(fakeTool(NEW, 8), tempDir("fleet-cfg-"), home).doctor!(false, new AbortController().signal);
  assert.ok(one.ok && Object.keys(one.hosts).join() === "laptop");
  assert.match(readFileSync(join(home, "doctor-runs"), "utf8"), /\|doctor --json$/m);
});

function bridgeWithDoctor(result: DoctorResult | (() => Promise<DoctorResult>)) {
  const asked: boolean[] = [];
  const doctor = async (all: boolean): Promise<DoctorResult> => {
    asked.push(all);
    return typeof result === "function" ? result() : result;
  };
  return { asked, make: () => bridgeFor(makeConfig(), { doctor }) };
}

const parsed = (doc: unknown): DoctorResult => readDoctor(JSON.stringify(doc), "laptop");

test("opening the bridge and moving about never starts a server; d asks first, with the warning, and esc cancels", async () => {
  const w = bridgeWithDoctor(parsed(ALL));
  const b = await w.make();
  for (const k of ["2", "down", "right", "3", "4", "5", "6", "7", "1", "r"]) b.press(k);
  await b.settle();
  assert.deepEqual(w.asked, []);
  b.press("2", "d");
  const f = b.frame().replace(/\s*│\s*\n?\s*│\s*/g, " ").replace(/\s+/g, " ");
  assert.match(f, /run doctor\?/);
  assert.match(f, /starts the MCP servers each host has picked/);
  assert.match(f, /their real credentials/);
  assert.match(f, /Nothing starts until you press a key below/);
  b.press("escape");
  await b.settle();
  assert.deepEqual(w.asked, [], "cancelling asks nothing");
  b.press("d", "x", "enter".replace("enter", "space"));
  await b.settle();
  assert.deepEqual(w.asked, [], "an unrelated key does not confirm");
});

test("y runs doctor on every host, t on this host only; the matrix fills a health mark for each server that is on", async () => {
  const w = bridgeWithDoctor(parsed(ALL));
  const b = await w.make();
  b.press("2", "d", "y");
  assert.match(b.frame(), /doctor is running on every host: it starts real servers/);
  await b.settle();
  b.advance(50);
  assert.deepEqual(w.asked, [true]);
  const f = b.frame();
  assert.match(f, /health .*healthy.*needs a login.*failing.*unknown/);
  // Rows: docs, tracker, tracker-local; columns: laptop (this host), box, edge, server.
  const rows = f.split("\n");
  const docs = rows.find((l) => /^\s*docs\b/.test(l) || / docs /.test(l) && /✓/.test(l))!;
  assert.match(docs, /✓/);
  const text = rows.join("\n");
  assert.match(text, /◇/, "login is neutral");
  assert.match(text, /✕/, "a timeout fails");
  // Cursor on a failing cell: the reason is on screen.
  b.press("down", "down");
  assert.match(b.frame(), /✓ doctor: claude: ok, 12 tools, opencode: ok, 12 tools, protocol 2025-06-18/);
  b.press("down");
  assert.match(b.frame(), /◇ needs a login: claude: login/);
  b.press("down", "right");
  assert.match(b.frame(), /✕ doctor: claude: exited \(gone\?\[31m red\)/, "a failing server says why, as printable text");

  const w2 = bridgeWithDoctor(parsed(NEW));
  const b2 = await w2.make();
  b2.press("d", "t");
  await b2.settle();
  assert.deepEqual(w2.asked, [false]);
});

test("a failed or unreadable doctor run says so and marks nothing", async () => {
  const b = await bridgeFor(makeConfig(), { doctor: async () => ({ ok: false, detail: "doctor printed no JSON document" }) });
  b.press("2", "d", "y");
  await b.settle();
  b.advance(50);
  const f = b.frame();
  assert.match(f, /doctor could not be read: doctor printed no JSON document/);
  assert.doesNotMatch(f, /✓|◇/);
});

test("where doctor is not offered, d says why and runs nothing", async () => {
  const asked: boolean[] = [];
  const b = await bridgeFor(makeConfig(), { doctor: async (all) => (asked.push(all), parsed(NEW)) }, { app: { noDoctor: "it would start real servers" } });
  b.press("d");
  assert.match(b.frame(), /Doctor is not offered here: it would start real servers/);
  b.press("y", "t", "enter");
  await b.settle();
  assert.deepEqual(asked, []);
  const bare = await bridgeFor(makeConfig());
  bare.press("d");
  assert.match(bare.frame(), /not offered here/);
});

test("with the real probe, opening the bridge runs no doctor child; only the confirmed key does", async () => {
  const home = makeHome("laptop");
  const config = makeConfig();
  const tool = fakeTool(NEW, 8);
  const model = loadModel(config, "laptop");
  const probe = realProbe(tool, config, home);
  const reads = { ...probe, host: async () => ({ result: "timer" as const, status: null }), conflicts: async () => ({ ok: true as const, items: [] }) };
  const { createApp } = await import("../../src/tui/app.ts");
  const { Headless } = await import("../../src/tui/headless.ts");
  const b = new Headless(createApp({ model, probe: reads, motion: false, boot: false }), { cols: 100, rows: 32 });
  await b.settle();
  b.press("2", "r", "d", "escape", "P", "escape");
  await b.settle();
  assert.equal(existsSync(join(home, "doctor-runs")), false, "no child was started");
  b.press("d", "y");
  await b.settle();
  assert.equal(readFileSync(join(home, "doctor-runs"), "utf8").trim().split("\n").length, 1);
});

test("against the real fleet doctor in a temp home: exit 8 (unhealthy) is read from the JSON and is not an error", async () => {
  // No MCP server is picked, so the real doctor starts nothing; its cheap checks fail in a bare home, which is exit 8.
  const { clone } = makeClone();
  mkdirSync(join(clone, "hosts"), { recursive: true });
  writeFileSync(join(clone, "hosts/laptop.yaml"), "{}\n");
  const home = makeHome("laptop");
  assert.ok(home.startsWith(realpathSync(tmpdir())));
  const direct = runFleet(clone, ["doctor", "--json"], { home });
  assert.equal(direct.code, 8, direct.stderr);
  assert.equal(JSON.parse(direct.stdout).code, "unhealthy");
  const r = await realProbe(clone, clone, home).doctor!(false, new AbortController().signal);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(Object.keys(r.hosts), ["laptop"]);
  const all = await realProbe(clone, clone, home).doctor!(true, new AbortController().signal);
  assert.ok(all.ok);
  const b = await bridgeFor(makeConfig(), { doctor: async () => r });
  b.press("2", "d", "y");
  await b.settle();
  b.advance(50);
  assert.doesNotMatch(b.frame(), /could not be read/);
});
