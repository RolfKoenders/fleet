import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, installFakeSsh, installFakeTool, installStatusTools, makeClone, makeHome, publish, runFleet, tempDir, toolCalls, fakeTimer, linuxOnly } from "./helpers.ts";
import type { SshPlan } from "./helpers.ts";
import { readDoctorResult } from "../src/doctorresult.ts";
import { EXIT } from "../src/exit.ts";
import { estimateTokens } from "../src/tokens.ts";
import { findTool } from "../src/tools.ts";

// ---- fake MCP servers, as separate processes so the blocking runs of fleet never starve them ----

const STDIO_SERVER = `
const fs = require("node:fs");
const cp = require("node:child_process");
const [mode, count, extra] = process.argv.slice(2);
const log = process.env.LOG;
const note = (text) => log && fs.appendFileSync(log, text + "\\n");
const fail = (id, code, message, data) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, data } }) + "\\n");
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
if (mode === "exit3" || (mode === "gate" && fs.existsSync(extra))) process.exit(3);
if (mode === "junk") { process.stdout.write("starting up, not json\\n"); process.exit(0); }
if (mode === "hang" || mode === "grandchild") {
  if (mode === "grandchild") {
    const helper = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    fs.writeFileSync(extra, JSON.stringify({ leader: process.pid, helper: helper.pid }));
  }
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  if (mode === "tokencheck") note("TOKEN=" + process.env.TOKEN);
  require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
    const m = JSON.parse(line);
    note(m.method + " " + JSON.stringify(m.params || null));
    if (m.method === "initialize" && mode !== "modern") {
      if (mode === "leak") {
        process.stderr.write("secret on stderr: " + process.env.TOKEN + "\\n");
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "bad token " + process.env.TOKEN } }) + "\\n");
        return;
      }
      reply(m.id, { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
    } else if (m.method === "server/discover" && mode === "silent") {
      // A legacy server that ignores what it does not know: the probe has to read the silence as legacy.
    } else if (m.method === "server/discover" && (mode === "modern" || mode === "dual")) {
      reply(m.id, { resultType: "complete", supportedVersions: mode === "dual" ? ["2026-07-28", "2025-11-25"] : ["2026-07-28"], capabilities: { tools: {} }, _meta: { "io.modelcontextprotocol/serverInfo": { name: "fake", version: "1" } } });
    } else if (m.method === "server/discover" && (mode === "oldonly" || mode === "nomatch")) {
      // A dual-era server that no longer offers a modern revision, and one that offers nothing fleet speaks.
      fail(m.id, -32022, "Unsupported protocol version", { supported: [mode === "oldonly" ? "2025-11-25" : "2024-01-01"], requested: "2026-07-28" });
    } else if (mode === "modern" && m.method === "initialize") {
      fail(m.id, -32601, "Method not found");
    } else if (m.method === "tools/list") {
      const modern = m.params && m.params._meta && m.params._meta["io.modelcontextprotocol/protocolVersion"];
      if (mode === "modern" && modern !== "2026-07-28") return fail(m.id, -32020, "missing protocol version");
      const start = m.params && m.params.cursor ? Number(m.params.cursor) : 0;
      const end = Math.min(start + 2, Number(count));
      const tools = []; for (let i = start; i < end; i++) tools.push(mode === "rich" ? { name: "marker-name-" + i, description: "marker-description for " + process.env.TOKEN, inputSchema: { type: "object", properties: { "marker-prop": { type: "string", description: process.env.TOKEN } } } } : { name: "t" + i, inputSchema: { type: "object" } });
      reply(m.id, end < Number(count) ? { tools, nextCursor: String(end) } : { tools });
    } else if (m.id !== undefined) {
      // What a legacy server answers to a method it does not know.
      fail(m.id, -32601, "Method not found");
    }
  });
}
`;

const HTTP_SERVER = `
const http = require("node:http");
const streams = new Map(); let nextStream = 0;
const send = (res, status, headers, body) => { res.writeHead(status, headers); res.end(body); };
const rpc = (id, result) => JSON.stringify({ jsonrpc: "2.0", id, result });
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = req.url;
    if (url === "/slow") return;
    if (url === "/err500") return send(res, 500, {}, "boom");
    if (url === "/html") return send(res, 200, { "content-type": "text/html" }, "<html>hi</html>");
    if (url === "/auth" || url === "/forbidden") {
      // Echoes what it was sent, as a careless server might.
      return send(res, url === "/auth" ? 401 : 403, { "www-authenticate": "Bearer" }, "rejected " + (req.headers.authorization || "nothing"));
    }
    if (url === "/oldsse") {
      if (req.method === "POST") return send(res, 405, {}, "");
      res.writeHead(200, { "content-type": "text/event-stream" });
      const id = String(nextStream++);
      streams.set(id, res);
      res.write("event: endpoint\\ndata: /oldmsg?s=" + id + "\\n\\n");
      return;
    }
    if (url.startsWith("/oldmsg")) {
      const sse = { res: streams.get(url.split("=")[1]) };
      const m = JSON.parse(body);
      send(res, 202, {}, "");
      if (m.method === "initialize") sse.res.write("event: message\\ndata: " + rpc(m.id, { protocolVersion: "2025-11-25", capabilities: {} }) + "\\n\\n");
      if (m.method === "tools/list") sse.res.write("event: message\\ndata: " + rpc(m.id, { tools: [{ name: "a" }, { name: "b" }, { name: "c" }] }) + "\\n\\n");
      return;
    }
    if (url === "/modern" || url === "/dual" || url === "/future") {
      // A modern server: no session, the revision and method in headers that must match the body, errors explained in the body.
      const m = JSON.parse(body);
      const meta = (m.params && m.params._meta) || {};
      const err = (status, code, message, data) => send(res, status, { "content-type": "application/json" }, JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code, message, data } }));
      if (url === "/dual" && m.method === "initialize") return send(res, 200, { "content-type": "application/json", "mcp-session-id": "sess-2" }, rpc(m.id, { protocolVersion: "2025-11-25", capabilities: { tools: {} } }));
      if (url === "/dual" && m.method === "notifications/initialized") return send(res, 202, {}, "");
      if (url === "/modern" && m.method === "initialize") return err(404, -32601, "Method not found");
      const supported = url === "/future" ? ["2027-03-01"] : ["2026-07-28", "2025-11-25"];
      const asked = meta["io.modelcontextprotocol/protocolVersion"];
      if (!supported.includes(asked)) return err(400, -32022, "Unsupported protocol version", { supported, requested: asked });
      if (req.headers["mcp-protocol-version"] !== asked || req.headers["mcp-method"] !== m.method || req.headers["mcp-session-id"]) return err(400, -32020, "Header mismatch");
      if (m.method === "server/discover") return send(res, 200, { "content-type": "application/json" }, rpc(m.id, { resultType: "complete", supportedVersions: supported, capabilities: { tools: {} } }));
      if (m.method === "tools/list") return send(res, 200, { "content-type": "text/event-stream" }, "event: message\\ndata: " + rpc(m.id, { tools: [{ name: "x" }, { name: "y" }] }) + "\\n\\n");
      return err(404, -32601, "Method not found");
    }
    if (url === "/ok") {
      if (req.method === "DELETE") return send(res, 200, {}, "");
      const m = JSON.parse(body);
      const accept = req.headers.accept || "";
      if (!accept.includes("application/json") || !accept.includes("text/event-stream")) return send(res, 406, {}, "");
      if (m.method === "initialize") return send(res, 200, { "content-type": "application/json", "mcp-session-id": "sess-1" }, rpc(m.id, { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} } }));
      if (req.headers["mcp-session-id"] !== "sess-1" || req.headers["mcp-protocol-version"] !== "2025-11-25") return send(res, 400, {}, "");
      if (m.method === "notifications/initialized") return send(res, 202, {}, "");
      if (m.method === "tools/list") return send(res, 200, { "content-type": "text/event-stream" }, "id: 1\\ndata: \\n\\nevent: message\\ndata: " + rpc(m.id, { tools: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }] }) + "\\n\\n");
    }
    send(res, 404, {}, "");
  });
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`;

type HttpServer = { port: number; stop: () => void };

async function startHttp(): Promise<HttpServer> {
  const script = join(tempDir("fleet-fake-"), "http.cjs");
  writeFileSync(script, HTTP_SERVER);
  const child: ChildProcess = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "ignore"] });
  process.on("exit", () => child.kill("SIGKILL"));
  const port = await new Promise<number>((resolve) => child.stdout!.once("data", (d: Buffer) => resolve(Number(d.toString().trim()))));
  return { port, stop: () => child.kill("SIGKILL") };
}

const stdioScript = (() => {
  let path: string | null = null;
  return () => {
    if (path === null) {
      path = join(tempDir("fleet-fake-"), "server.cjs");
      writeFileSync(path, STDIO_SERVER);
    }
    return path;
  };
})();

const node = process.execPath;
const stdioEntry = (name: string, mode: string, count = 3, extra = "", env = "") =>
  `  ${name}:\n    command: ["${node}", "${stdioScript()}", "${mode}", "${count}"${extra === "" ? "" : `, "${extra}"`}]\n${env}`;

// ---- setup ----

type Doc = { ok: boolean; code: string; host: string; messages: string[]; checks: { name: string; result: string; detail: string | null }[]; servers: Server[] };
type Server = { server: string; tool: string; transport: string; result: string; tools: number | null; size: number | null; tokens: number | null; latencyMs: number | null; protocol: string | null; detail: string | null; fails: boolean };

function setup(catalog: string, opts: { hosts?: Record<string, string>; ssh?: Record<string, SshPlan>; key?: boolean; timer?: string } = {}) {
  const { clone, remote } = makeClone();
  const home = makeHome("laptop");
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(clone, rel)), { recursive: true });
    writeFileSync(join(clone, rel), text);
  };
  const names = [...catalog.matchAll(/^ {2}(\w+):$/gm)].map((m) => m[1]);
  write("catalog/mcp.yaml", catalog === "" ? "servers: {}\n" : `servers:\n${catalog}`);
  write("hosts/_defaults.yaml", `mcp:\n  include: [${names.join(", ")}]\n`);
  write("hosts/laptop.yaml", opts.hosts?.laptop ?? "ssh: me@laptop\n");
  for (const [name, text] of Object.entries(opts.hosts ?? {})) if (name !== "laptop") write(`hosts/${name}.yaml`, text);
  publish(clone, "config");
  installStatusTools(home);
  if (opts.timer !== undefined) fakeTimer(home, opts.timer);
  installFakeSsh(home, opts.ssh ?? {});
  if (opts.key !== false) {
    mkdirSync(join(home, ".config/fleet"), { recursive: true });
    writeFileSync(join(home, ".config/fleet/age.key"), "AGE-SECRET-KEY-placeholder\n");
  }
  const run = (args: string[] = [], env: Record<string, string> = {}) => runFleet(clone, ["doctor", ...args], { home, env });
  const json = (args: string[] = []) => {
    const r = run([...args, "--json"]);
    return { r, doc: JSON.parse(r.stdout) as Doc };
  };
  const find = (doc: Doc, server: string, tool: string) => doc.servers.find((s) => s.server === server && s.tool === tool)!;
  return { clone, remote, home, write, run, json, find };
}

// ---- stdio ----

test("a stdio server is started, initialized, asked for its tools page by page, and reported once per tool config", () => {
  const log = join(tempDir(), "protocol.log");
  const s = setup(stdioEntry("alpha", "ok", 5, "", `    env:\n      LOG: ${log}\n`));
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(doc.ok, true);
  assert.deepEqual(doc.servers.map((x) => [x.server, x.tool, x.transport, x.result, x.tools, x.fails]), [
    ["alpha", "claude", "stdio", "ok", 5, false],
    ["alpha", "opencode", "stdio", "ok", 5, false],
  ]);
  assert.equal(typeof s.find(doc, "alpha", "claude").latencyMs, "number");
  assert.deepEqual(doc.checks.map((c) => [c.name, c.result]), [["timer", "ok"], ["age-key", "ok"], ["skill-links", "ok"]]);
  // Each of the two runs wrote to the same log, so the sequence is seen twice, interleaved by arrival.
  const methods = readFileSync(log, "utf8").trim().split("\n").map((l) => l.split(" ")[0]);
  assert.equal(methods.filter((m) => m === "initialize").length, 2);
  assert.equal(methods.filter((m) => m === "notifications/initialized").length, 2);
  assert.equal(methods.filter((m) => m === "tools/list").length, 6, "three pages each");
  assert.ok(methods.indexOf("initialize") < methods.indexOf("notifications/initialized"));
  const init = JSON.parse(readFileSync(log, "utf8").split("\n").find((l) => l.startsWith("initialize "))!.slice("initialize ".length));
  assert.equal(init.protocolVersion, "2025-11-25");
  assert.deepEqual(init.capabilities, {});
  assert.equal(init.clientInfo.name, "fleet-doctor");
});

test("the human form lists checks and one line per server and tool", () => {
  const s = setup(stdioEntry("alpha", "ok", 1));
  const r = s.run([], { NO_COLOR: "1" });
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stdout, /^host: laptop$/m);
  assert.match(r.stdout, /^ {2}timer: ok \(active\)$/m);
  assert.match(r.stdout, /^ {2}alpha \(claude, stdio\): ok, 1 tool, ~\d+ tokens, \d+ ms, MCP 2025-11-25$/m);
  assert.match(r.stdout, /^ {2}alpha \(opencode, stdio\): ok, 1 tool, ~\d+ tokens, \d+ ms, MCP 2025-11-25$/m);
});

test("a missing program, a server that exits, and one that writes text that is not JSON-RPC are told apart, and exit 8", () => {
  const s = setup(
    [
      `  gone:\n    command: ["/nonexistent/dir/mcp-gone"]\n`,
      `  bare:\n    command: [definitely-not-installed-mcp]\n`,
      stdioEntry("dies", "exit3"),
      stdioEntry("noisy", "junk"),
    ].join(""),
  );
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.unhealthy);
  assert.equal(doc.code, "unhealthy");
  assert.equal(s.find(doc, "gone", "claude").result, "missing-binary");
  assert.equal(s.find(doc, "bare", "opencode").result, "missing-binary");
  assert.equal(s.find(doc, "dies", "claude").result, "exited");
  assert.match(s.find(doc, "dies", "claude").detail!, /exit code 3/);
  assert.equal(s.find(doc, "noisy", "claude").result, "bad-response");
  assert.equal(doc.servers.every((x) => x.fails && x.tools === null && x.latencyMs === null), true);
  assert.match(r.stderr, /doctor found 8 problems/);
});

test("a server that never answers times out, and it and the helper it started are killed", async () => {
  const pids = join(tempDir(), "pids.json");
  const s = setup(stdioEntry("stuck", "grandchild", 0, pids));
  const started = Date.now();
  const { r, doc } = s.json(["--timeout", "1"]);
  assert.ok(Date.now() - started < 10_000, "the hard timeout bounds the run");
  assert.equal(r.code, EXIT.unhealthy);
  assert.equal(s.find(doc, "stuck", "claude").result, "timeout");
  const { leader, helper } = JSON.parse(readFileSync(pids, "utf8")) as { leader: number; helper: number };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 40 && (alive(leader) || alive(helper)); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(leader), false, "the server is dead, though it ignores SIGTERM");
  assert.equal(alive(helper), false, "so is the helper in its process group");
});

// ---- network ----

test("network servers: ok over JSON and SSE replies, the old SSE transport, auth, bad answers and an unreachable port", async (t) => {
  const http = await startHttp();
  t.after(http.stop);
  const closed = await startHttp();
  closed.stop();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const at = (port: number, path: string) => `http://127.0.0.1:${port}${path}`;
  const entry = (name: string, transport: string, url: string, headers = "") => `  ${name}:\n    transport: ${transport}\n    url: ${url}\n${headers}`;
  const s = setup(
    [
      entry("fine", "http", at(http.port, "/ok")),
      entry("old", "sse", at(http.port, "/oldsse")),
      entry("login", "http", at(http.port, "/auth")),
      entry("badtoken", "http", at(http.port, "/auth"), "    headers:\n      Authorization: Bearer not-a-secret-value\n"),
      entry("denied", "http", at(http.port, "/forbidden")),
      entry("page", "http", at(http.port, "/html")),
      entry("broken", "http", at(http.port, "/err500")),
      entry("slow", "http", at(http.port, "/slow")),
      entry("nobody", "http", at(closed.port, "/ok")),
    ].join(""),
  );
  const { r, doc } = s.json(["--timeout", "2"]);
  const got = (name: string, tool: string) => {
    const x = s.find(doc, name, tool);
    return [x.result, x.tools, x.fails, x.detail];
  };
  assert.deepEqual(got("fine", "claude"), ["ok", 4, false, null]);
  assert.deepEqual(got("fine", "opencode"), ["ok", 4, false, null]);
  assert.equal(s.find(doc, "fine", "claude").transport, "http");
  assert.equal(s.find(doc, "fine", "opencode").transport, "remote");
  assert.deepEqual(got("old", "claude"), ["ok", 3, false, null]);
  // opencode does not say which transport it is: it tries Streamable HTTP, is refused with 405, and falls back.
  assert.deepEqual(got("old", "opencode"), ["ok", 3, false, null]);
  // A login a person has not done yet is expected, so it does not fail the run. Rejected credentials do.
  assert.equal(s.find(doc, "login", "claude").result, "auth-needed");
  assert.equal(s.find(doc, "login", "claude").fails, false);
  assert.match(s.find(doc, "login", "claude").detail!, /HTTP 401/);
  assert.equal(s.find(doc, "badtoken", "claude").result, "auth-needed");
  assert.equal(s.find(doc, "badtoken", "claude").fails, true);
  assert.match(s.find(doc, "badtoken", "claude").detail!, /rejected the configured credentials/);
  assert.equal(s.find(doc, "denied", "claude").result, "auth-needed");
  assert.equal(s.find(doc, "page", "claude").result, "bad-response");
  assert.equal(s.find(doc, "broken", "claude").result, "bad-response");
  assert.equal(s.find(doc, "broken", "claude").detail, "HTTP 500");
  assert.equal(s.find(doc, "slow", "claude").result, "timeout");
  assert.equal(s.find(doc, "nobody", "claude").result, "unreachable");
  assert.equal(r.code, EXIT.unhealthy);
  assert.equal(doc.servers.some((x) => x.detail?.includes("127.0.0.1")), false, "no url is printed");
});

test("a login that has not been done is shown as a neutral login with one explaining line, and does not fail", async (t) => {
  const http = await startHttp();
  t.after(http.stop);
  const entry = (name: string, path: string) => `  ${name}:\n    transport: http\n    url: http://127.0.0.1:${http.port}${path}\n`;
  const s = setup(entry("login", "/auth") + entry("login2", "/forbidden"));
  const r = s.run([], { NO_COLOR: "1" });
  assert.equal(r.code, EXIT.ok, r.stdout + r.stderr);
  assert.match(r.stdout, /^ {2}login \(claude, http\): login$/m);
  assert.match(r.stdout, /^ {2}login2 \(opencode, remote\): login$/m);
  assert.equal(r.stdout.split("\n").filter((l) => /doctor cannot see login state/.test(l)).length, 1, "one line, not one per server");
  assert.doesNotMatch(r.stdout, /HTTP 40[13]/, "the line carries no detail of its own");
  const { doc } = s.json();
  assert.equal(s.find(doc, "login", "claude").result, "auth-needed");
  assert.equal(s.find(doc, "login", "claude").fails, false);
});

// ---- both protocol eras ----

test("stdio: a legacy, a modern, a dual-era and a silent legacy server all report ok, with the revision each answered in", () => {
  const log = join(tempDir(), "eras.log");
  const logged = (name: string, mode: string) => stdioEntry(name, mode, 3, "", `    env:\n      LOG: ${log}\n`);
  const s = setup([logged("legacy", "ok"), logged("modern", "modern"), logged("dual", "dual"), logged("oldonly", "oldonly"), logged("quiet", "silent")].join(""));
  const { r, doc } = s.json(["--timeout", "4"]);
  assert.equal(r.code, EXIT.ok, r.stdout + r.stderr);
  const got = (name: string) => {
    const x = s.find(doc, name, "claude");
    return [x.result, x.tools, x.protocol, x.fails];
  };
  assert.deepEqual(got("legacy"), ["ok", 3, "2025-11-25", false]);
  assert.deepEqual(got("modern"), ["ok", 3, "2026-07-28", false]);
  assert.deepEqual(got("dual"), ["ok", 3, "2026-07-28", false]);
  assert.deepEqual(got("oldonly"), ["ok", 3, "2025-11-25", false]);
  assert.deepEqual(got("quiet"), ["ok", 3, "2025-11-25", false]);
  // The modern way is asked first.
  const lines = readFileSync(log, "utf8").trim().split("\n");
  const discover = JSON.parse(lines.find((l) => l.startsWith("server/discover "))!.slice("server/discover ".length));
  assert.equal(discover._meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
  assert.equal(discover._meta["io.modelcontextprotocol/clientInfo"].name, "fleet-doctor");
  assert.deepEqual(discover._meta["io.modelcontextprotocol/clientCapabilities"], {});
  // The protocol is shown in the human form too.
  const text = s.run(["--timeout", "4"], { NO_COLOR: "1" }).stdout;
  assert.match(text, /^ {2}modern \(claude, stdio\): ok, 3 tools, ~\d+ tokens, \d+ ms, MCP 2026-07-28$/m);
  assert.match(text, /^ {2}legacy \(claude, stdio\): ok, 3 tools, ~\d+ tokens, \d+ ms, MCP 2025-11-25$/m);
});

test("stdio: a modern server that speaks no revision fleet speaks is a failure, not a fall back", () => {
  const s = setup(stdioEntry("future", "nomatch", 3));
  const { r, doc } = s.json(["--timeout", "4"]);
  assert.equal(r.code, EXIT.unhealthy);
  const x = s.find(doc, "future", "claude");
  assert.equal(x.result, "bad-response");
  assert.equal(x.protocol, null);
  assert.equal(x.fails, true);
  assert.match(x.detail!, /no protocol revision fleet speaks/);
});

test("http: a legacy, a modern, a dual-era and a newer-revision server all report ok, with the revision each answered in", async (t) => {
  const http = await startHttp();
  t.after(http.stop);
  const entry = (name: string, path: string, transport = "http") => `  ${name}:\n    transport: ${transport}\n    url: http://127.0.0.1:${http.port}${path}\n`;
  const s = setup([entry("legacy", "/ok"), entry("modern", "/modern"), entry("dual", "/dual"), entry("future", "/future"), entry("oldsse", "/oldsse", "sse")].join(""));
  const { r, doc } = s.json(["--timeout", "4"]);
  assert.equal(r.code, EXIT.ok, r.stdout + r.stderr);
  for (const tool of ["claude", "opencode"]) {
    const got = (name: string) => {
      const x = s.find(doc, name, tool);
      return [x.result, x.tools, x.protocol, x.fails];
    };
    assert.deepEqual(got("legacy"), ["ok", 4, "2025-11-25", false], tool);
    assert.deepEqual(got("modern"), ["ok", 2, "2026-07-28", false], tool);
    assert.deepEqual(got("dual"), ["ok", 2, "2026-07-28", false], tool);
    // It does not speak 2026-07-28, so it is asked again with the modern revision it listed.
    assert.deepEqual(got("future"), ["ok", 2, "2027-03-01", false], tool);
  }
  assert.deepEqual([s.find(doc, "oldsse", "claude").result, s.find(doc, "oldsse", "claude").protocol], ["ok", "2025-11-25"]);
});

test("one deadline covers both attempts: a server that answers neither way is cut off at --timeout", () => {
  const s = setup(stdioEntry("stuck", "hang", 0));
  const started = Date.now();
  const { doc } = s.json(["--timeout", "2"]);
  assert.ok(Date.now() - started < 8_000, "the second attempt does not get a fresh timeout");
  assert.equal(s.find(doc, "stuck", "claude").result, "timeout");
  assert.equal(s.find(doc, "stuck", "claude").protocol, null);
});

test("a timeout on an npx server says to retry with a higher --timeout, and one on another command does not", () => {
  const dir = tempDir("fleet-npx-");
  const npx = join(dir, "npx");
  writeFileSync(npx, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  const s = setup(`  viaNpx:\n    command: ["${npx}", "-y", "some-package"]\n` + stdioEntry("plain", "hang", 0));
  const { doc } = s.json(["--timeout", "1"]);
  const hinted = s.find(doc, "viaNpx", "claude");
  assert.equal(hinted.result, "timeout");
  assert.equal(hinted.detail, "no answer in time; npx may still be downloading the package; retry with a higher --timeout");
  assert.equal(s.find(doc, "plain", "claude").detail, "no answer in time");
});

// ---- secrets ----

const setSecret = (s: ReturnType<typeof setup>, name: string, value: string) =>
  assert.equal(runFleet(s.clone, ["secrets", "set", "shared", name], { home: s.home, input: value }).code, EXIT.ok);

/** Gives the host the real sops and a real age key, and sets one shared secret. */
function useSecrets(s: ReturnType<typeof setup>, name: string, value: string) {
  const sops = findTool("sops");
  const keygen = findTool("age-keygen");
  assert.ok(sops && keygen);
  mkdirSync(join(s.home, ".local/bin"), { recursive: true });
  for (const [tool, path] of [["sops", sops], ["age-keygen", keygen]] as const) {
    rmSync(join(s.home, ".local/bin", tool), { force: true });
    symlinkSync(path, join(s.home, ".local/bin", tool));
  }
  const key = spawnSync(keygen, [], { encoding: "utf8" }).stdout;
  const recipient = spawnSync(keygen, ["-y"], { encoding: "utf8", input: key }).stdout.trim();
  mkdirSync(join(s.home, ".config/fleet"), { recursive: true });
  writeFileSync(join(s.home, ".config/fleet/age.key"), key, { mode: 0o600 });
  s.write("hosts/laptop.yaml", `admin: true\nage: ${recipient}\nssh: me@laptop\n`);
  publish(s.clone, "age");
  setSecret(s, name, value);
}

test("a secret is delivered to the server and never printed, in text, JSON or errors", async (t) => {
  const TOKEN = "tok-plaintext-9f3-leakcheck";
  const http = await startHttp();
  t.after(http.stop);
  const seen = join(tempDir(), "seen.log");
  const s = setup(
    [
      stdioEntry("echoes", "leak", 1, "", `    env:\n      TOKEN: secret:API_TOKEN\n`),
      stdioEntry("checks", "tokencheck", 1, "", `    env:\n      TOKEN: secret:API_TOKEN\n      LOG: ${seen}\n`),
      `  remote:\n    transport: http\n    url: http://127.0.0.1:${http.port}/auth\n    headers:\n      Authorization: Bearer secret:API_TOKEN\n`,
    ].join(""),
    { hosts: { laptop: "admin: true\nssh: me@laptop\n" }, key: false },
  );
  useSecrets(s, "API_TOKEN", TOKEN);

  const text = s.run();
  const json = s.run(["--json"]);
  const everything = `${text.stdout}\n${text.stderr}\n${json.stdout}\n${json.stderr}`;
  assert.equal(everything.includes(TOKEN), false, "the secret appears nowhere");
  assert.equal(everything.includes("secret on stderr"), false, "the server's stderr is not echoed");
  // The same run proves the server really got the value, and that the failures happened.
  assert.ok(readFileSync(seen, "utf8").includes(`TOKEN=${TOKEN}`));
  const doc = JSON.parse(json.stdout) as Doc;
  assert.equal(s.find(doc, "echoes", "claude").result, "bad-response");
  assert.equal(s.find(doc, "remote", "claude").result, "auth-needed");
  assert.equal(s.find(doc, "remote", "claude").fails, true);
  // The applied tools' files are not touched: doctor wrote none.
  assert.equal(existsSync(join(s.home, ".claude.json")), false);
});

// ---- local checks and config ----

test("a dangling skill link and a stopped timer are problems, and exit 8", () => {
  const s = setup("", { timer: "inactive" });
  mkdirSync(join(s.home, ".claude/skills"), { recursive: true });
  symlinkSync("/nonexistent/skills/gone", join(s.home, ".claude/skills/gone"));
  mkdirSync(join(s.home, ".local/state/fleet"), { recursive: true });
  writeFileSync(
    join(s.home, ".local/state/fleet/applied.json"),
    JSON.stringify({ version: 1, host: "laptop", appliedAt: "2026-10-30T10:00:00Z", repos: {}, links: [{ target: "~/.claude/skills/gone", source: "/nonexistent/skills/gone" }], keys: [] }),
  );
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.unhealthy);
  const by = Object.fromEntries(doc.checks.map((c) => [c.name, c]));
  assert.equal(by["timer"]!.result, "problem");
  assert.equal(by["timer"]!.detail, "inactive");
  assert.equal(by["skill-links"]!.result, "problem");
  assert.match(by["skill-links"]!.detail!, /~\/\.claude\/skills\/gone/);
  assert.deepEqual(doc.servers, []);
});

test("a stopped timer always fails, even on a host that uses no secrets and has no servers", () => {
  const s = setup("", { timer: "failed", key: false });
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.unhealthy);
  assert.deepEqual(doc.checks.map((c) => [c.name, c.result]), [["timer", "problem"], ["age-key", "ok"], ["skill-links", "ok"]]);
});

test("a timer that systemd cannot be asked about, in a shell with no user session, is unknown and not a problem", { skip: linuxOnly }, () => {
  const s = setup("", { timer: "active" });
  // What `systemctl --user` does after `sudo -iu`: no bus to connect to, nothing on stdout.
  installFakeTool(s.home, "systemctl", { exit: 1, only: ["--user", "is-active", "fleet.timer"] });
  const r = s.run(["--json"]);
  const doc = JSON.parse(r.stdout) as Doc;
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(doc.messages, []);
  const timer = doc.checks.find((c) => c.name === "timer")!;
  assert.equal(timer.result, "unknown");
  assert.match(timer.detail!, /no user session in this shell, as after sudo -iu.*run doctor over ssh or from a login shell/);
  const text = s.run();
  assert.equal(text.code, EXIT.ok);
  assert.match(text.stdout, /^ {2}timer: unknown \(no user session in this shell/m);
  assert.doesNotMatch(text.stderr, /problem/);
});

test("a timer that gives no answer in a shell with a user session is still a problem", { skip: linuxOnly }, () => {
  const s = setup("", { timer: "active" });
  installFakeTool(s.home, "systemctl", { exit: 1, only: ["--user", "is-active", "fleet.timer"] });
  const r = s.run(["--json"], { XDG_RUNTIME_DIR: "/run/user/1000" });
  const doc = JSON.parse(r.stdout) as Doc;
  assert.equal(r.code, EXIT.unhealthy);
  assert.deepEqual(doc.checks.find((c) => c.name === "timer"), { name: "timer", result: "problem", detail: "unknown (the scheduler is not installed or gave no answer)" });
});

test("a missing age key fails only where the config uses secrets, which is read without decrypting", () => {
  const without = setup(stdioEntry("alpha", "ok", 1), { key: false });
  const a = without.json();
  assert.equal(a.r.code, EXIT.ok, a.r.stderr);
  const check = a.doc.checks.find((c) => c.name === "age-key")!;
  assert.equal(check.result, "ok");
  assert.match(check.detail!, /uses no secrets/);

  // No secrets file exists and sops is not run: the key check fails from the config alone.
  const withSecrets = setup(stdioEntry("needs", "ok", 1, "", `    env:\n      TOKEN: secret:SOME_TOKEN\n`), { key: false });
  const b = withSecrets.run(["--json"]);
  const docB = JSON.parse(b.stdout) as Doc;
  const keyB = docB.checks.find((c) => c.name === "age-key")!;
  assert.equal(keyB.result, "problem");
  assert.match(keyB.detail!, /~\/\.config\/fleet\/age\.key/);
});

test("a skill link that works is fine", () => {
  const s = setup("");
  const target = join(tempDir(), "skill");
  mkdirSync(target);
  mkdirSync(join(s.home, ".claude/skills"), { recursive: true });
  symlinkSync(target, join(s.home, ".claude/skills/live"));
  mkdirSync(join(s.home, ".local/state/fleet"), { recursive: true });
  writeFileSync(
    join(s.home, ".local/state/fleet/applied.json"),
    JSON.stringify({ version: 1, host: "laptop", appliedAt: "2026-10-30T10:00:00Z", repos: {}, links: [{ target: "~/.claude/skills/live", source: target }], keys: [] }),
  );
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(doc.checks.find((c) => c.name === "skill-links")!.result, "ok");
});

test("a secret that cannot be read exits 5, and the local checks are still shown", () => {
  const s = setup(stdioEntry("needs", "ok", 1, "", `    env:\n      TOKEN: secret:MISSING_ONE\n`), { key: false });
  const r = s.run();
  assert.equal(r.code, EXIT["needs-secret"]);
  assert.match(r.stdout, /^checks:$/m);
  assert.match(r.stdout, /age-key: problem/);
  assert.equal(r.stdout.includes("mcp servers: none"), true);
  assert.equal(existsSync(resultFile(s.home)), false, "nothing was started, so there is nothing to save");
});

test("a host with no name exits 2", () => {
  const s = setup("");
  const home = makeHome();
  const r = runFleet(s.clone, ["doctor"], { home });
  assert.equal(r.code, EXIT.invalid);
});

test("--timeout takes seconds, only for doctor; --all is for status and doctor", () => {
  const s = setup("");
  for (const bad of ["0", "abc", "601", "-3", "1e2"]) {
    const r = s.run(["--timeout", bad]);
    assert.equal(r.code, EXIT.invalid, bad);
    assert.match(r.stderr, bad === "-3" ? /--timeout/ : /--timeout must be a number of seconds/);
  }
  const other = runFleet(s.clone, ["status", "--timeout", "5"], { home: s.home });
  assert.equal(other.code, EXIT.invalid);
  assert.match(other.stderr, /--timeout is only for 'doctor'/);
  assert.equal(s.run(["--timeout", "0.5"]).code, EXIT.ok);
});

test("doctor is documented as starting servers, and is listed as a command that changes things", () => {
  const s = setup("");
  const help = runFleet(s.clone, ["help"], { home: s.home });
  assert.match(help.stdout, /doctor .*real credentials.*npx.*download.*never from the timer/);
  const agent = runFleet(s.clone, ["agent"], { home: s.home }).stdout;
  const changing = agent.slice(agent.indexOf("### Changes things"));
  assert.match(changing, /^- `fleet doctor \[--all\]/m);
  assert.doesNotMatch(agent.slice(agent.indexOf("### Read-only"), agent.indexOf("### Changes things")), /fleet doctor/);
});

test("doctor writes only its own doctor result: no applied state, no tool files", () => {
  const s = setup(stdioEntry("alpha", "ok", 1));
  assert.equal(s.run().code, EXIT.ok);
  assert.deepEqual(readdirSync(join(s.home, ".local/state/fleet")), ["doctor.json"]);
  for (const rel of [".claude.json", ".claude", ".config/opencode"]) assert.equal(existsSync(join(s.home, rel)), false, rel);
});

// ---- --all ----

const REMOTE_COMMAND = "~/.local/bin/fleet doctor --json";

const docOf = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ok: true,
    code: "ok",
    host: "remote",
    messages: [],
    checks: [{ name: "timer", result: "ok", detail: "active" }, { name: "age-key", result: "ok", detail: null }, { name: "skill-links", result: "ok", detail: null }],
    servers: [{ server: "alpha", tool: "claude", transport: "stdio", result: "ok", tools: 7, latencyMs: 40, protocol: "2025-11-25", detail: null, fails: false }],
    ...over,
  });
const UNREACHABLE: SshPlan = { exit: 255, stderr: "ssh: connect to host x port 22: Connection timed out" };

function setupAll(ssh: Record<string, SshPlan>, others: Record<string, string>) {
  const s = setup(stdioEntry("alpha", "ok", 2), { hosts: { laptop: "ssh: me@laptop\n", ...others }, ssh });
  return { ...s, all: (args: string[] = []) => s.json(["--all", ...args]) };
}

test("doctor --all runs here in place and over the same ssh form on the others, in name order", () => {
  const s = setupAll({ "me@zed": { stdout: docOf() }, "me@bee": { stdout: docOf() } }, { zed: "ssh: me@zed\n", bee: "ssh: me@bee\n" });
  const { r, doc } = s.all();
  const hosts = (doc as unknown as { hosts: { host: string; result: string; doctor: unknown }[] }).hosts;
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(hosts.map((h) => [h.host, h.result]), [["bee", "ok"], ["laptop", "ok"], ["zed", "ok"]]);
  assert.deepEqual(toolCalls(s.home, "ssh"), [
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "me@bee", REMOTE_COMMAND],
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "me@zed", REMOTE_COMMAND],
  ]);
  assert.equal(doc.servers.length, 2, "this host's own fields are at the top level");
});

test("--all: a host whose timer is unknown stays ok, and the grid says unknown with the reason below", () => {
  const unknown = { name: "timer", result: "unknown", detail: "no user session in this shell" };
  const s = setupAll({ "me@bee": { stdout: docOf({ checks: [unknown, { name: "age-key", result: "ok", detail: null }, { name: "skill-links", result: "ok", detail: null }] }) } }, { bee: "ssh: me@bee\n" });
  const { r, doc } = s.all();
  const hosts = (doc as unknown as { hosts: { host: string; result: string; doctor: { checks: { name: string; result: string }[] } }[] }).hosts;
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(hosts.find((h) => h.host === "bee")!.doctor.checks[0], unknown);
  const text = s.run(["--all"]);
  assert.match(text.stdout, /^timer\s+unknown\s+ok/m);
  assert.match(text.stdout, /^bee: timer: no user session in this shell$/m);
});

test("--timeout is passed on to the other hosts", () => {
  const s = setupAll({ "me@bee": { stdout: docOf() } }, { bee: "ssh: me@bee\n" });
  s.all(["--timeout", "5"]);
  assert.equal(toolCalls(s.home, "ssh")[0]![5], `${REMOTE_COMMAND} --timeout 5`);
});

test("--all: an unreachable host exits 4, a host with no ssh is timer, and a host with problems exits 8, and one with a bad answer exits 1", () => {
  const unreachable = setupAll({ "me@a": { stdout: docOf() }, "me@b": UNREACHABLE }, { a: "ssh: me@a\n", b: "ssh: me@b\n", quiet: "{}\n" });
  const first = unreachable.all();
  const records = (first.doc as unknown as { hosts: { host: string; result: string }[] }).hosts;
  assert.equal(first.r.code, EXIT.unreachable);
  assert.deepEqual(records.map((h) => [h.host, h.result]), [["a", "ok"], ["b", "unreachable"], ["laptop", "ok"], ["quiet", "timer"]]);
  assert.match(first.r.stderr, /b: unreachable over ssh/);

  const bad = setupAll({ "me@a": { stdout: docOf({ ok: false, code: "unhealthy", servers: [{ server: "alpha", tool: "claude", transport: "stdio", result: "timeout", tools: null, latencyMs: null, detail: "no answer in time", fails: true }] }), exit: 8 }, "me@b": { stdout: "garbage", exit: 8 } }, { a: "ssh: me@a\n", b: "ssh: me@b\n" });
  const second = bad.all();
  const recs = (second.doc as unknown as { hosts: { host: string; result: string; detail?: string }[] }).hosts;
  assert.equal(second.r.code, EXIT.error, "a host whose answer cannot be read is an unexpected failure, which outranks a found problem");
  assert.deepEqual(recs.map((h) => [h.host, h.result]), [["a", "problems"], ["b", "error"], ["laptop", "ok"]]);
  assert.match(recs[1]!.detail!, /not a fleet doctor document/);

  const onlyProblems = setupAll({ "me@a": { stdout: docOf({ ok: false, code: "unhealthy" }), exit: 8 } }, { a: "ssh: me@a\n" });
  assert.equal(onlyProblems.all().r.code, EXIT.unhealthy);

  const mixed = setupAll({ "me@a": { stdout: docOf({ ok: false, code: "unhealthy" }), exit: 8 }, "me@b": UNREACHABLE }, { a: "ssh: me@a\n", b: "ssh: me@b\n" });
  assert.equal(mixed.all().r.code, EXIT.unreachable, "unreachable wins over a found problem");
});

test("--all: what a remote host sends is cut to known fields and printable text", () => {
  const s = setupAll(
    { "me@a": { stdout: docOf({ servers: [{ server: "alpha", tool: "claude", transport: "stdio", result: "weird\u001b[31m", tools: "many", latencyMs: 5, detail: "ok\u0007\u001b[2J", fails: false, extra: "x" }] }) } },
    { a: "ssh: me@a\n" },
  );
  const { doc } = s.all();
  const a = (doc as unknown as { hosts: { host: string; doctor: Doc }[] }).hosts.find((h) => h.host === "a")!.doctor.servers[0]!;
  assert.equal(a.result, "bad-response");
  assert.equal(a.tools, null);
  assert.equal(a.detail, "ok??[2J");
  assert.equal((a as unknown as { extra?: string }).extra, undefined);
  const human = runFleet(s.clone, ["doctor", "--all"], { home: s.home });
  assert.equal(human.stdout.includes("\u001b"), false);
  assert.equal(human.stdout.includes("\u0007"), false);
});

test("--all text is a grid with a column per host and details below", () => {
  const s = setupAll(
    {
      "me@a": { stdout: docOf() },
      "me@b": { stdout: docOf({ ok: false, code: "unhealthy", servers: [{ server: "alpha", tool: "claude", transport: "stdio", result: "missing-binary", tools: null, latencyMs: null, detail: "the command is not installed or not executable", fails: true }] }), exit: 8 },
      "me@c": UNREACHABLE,
    },
    { a: "ssh: me@a\n", b: "ssh: me@b\n", c: "ssh: me@c\n", d: "{}\n" },
  );
  const r = runFleet(s.clone, ["doctor", "--all"], { home: s.home, env: { NO_COLOR: "1" } });
  const rows = r.stdout.split("\n");
  assert.match(rows[0]!, /^check\s+a\s+b\s+c\s+d\s+laptop \(this host\)$/);
  assert.match(rows.find((l) => l.startsWith("alpha (claude)"))!, /^alpha \(claude\)\s+ok \(7\)\s+missing-binary\s+unreachable\s+timer\s+ok \(2\)$/);
  assert.match(rows.find((l) => l.startsWith("timer"))!, /^timer\s+ok\s+ok\s+unreachable\s+timer\s+ok$/);
  assert.match(r.stdout, /^b: alpha \(claude\): the command is not installed or not executable$/m);
  assert.match(r.stdout, /^d: no ssh destination/m);
});

test("a remote host that really runs fleet doctor answers with its own servers and checks", () => {
  const log = join(tempDir(), "remote.log");
  const s = setupAll({}, { server: "ssh: me@server\n" });
  s.write("catalog/mcp.yaml", `servers:\n${stdioEntry("alpha", "ok", 4, "", `    env:\n      LOG: ${log}\n`)}`);
  publish(s.clone, "log the remote's server");
  const base = tempDir("fleet-machine-");
  const mhome = join(base, "home");
  mkdirSync(join(mhome, ".config/fleet"), { recursive: true });
  writeFileSync(join(mhome, ".config/fleet/host"), "server\n");
  writeFileSync(join(mhome, ".config/fleet/age.key"), "AGE-SECRET-KEY-placeholder\n");
  git(base, "clone", "--quiet", s.remote, "fleet");
  writeFileSync(join(mhome, ".config/fleet/config"), `${join(base, "fleet")}\n`);
  mkdirSync(join(mhome, ".local/bin"), { recursive: true });
  symlinkSync(join(base, "fleet/bin/fleet"), join(mhome, ".local/bin/fleet"));
  installStatusTools(mhome);
  installFakeSsh(s.home, { "me@server": { home: mhome } });

  const { r, doc } = s.all();
  assert.equal(r.code, EXIT.ok, r.stderr);
  const remote = (doc as unknown as { hosts: { host: string; result: string; doctor: Doc }[] }).hosts.find((h) => h.host === "server")!;
  assert.equal(remote.result, "ok");
  assert.deepEqual(remote.doctor.servers.map((x) => [x.server, x.tool, x.result, x.tools]), [["alpha", "claude", "ok", 4], ["alpha", "opencode", "ok", 4]]);
  assert.ok(readFileSync(log, "utf8").includes("initialize"), "the remote started the server itself");
});

// ---- the size of each server's tools, and the doctor result ----

const resultFile = (home: string) => join(home, ".local/state/fleet/doctor.json");
const savedBy = (s: { home: string }) => readDoctorResult(s.home)!;
const savedServer = (s: { home: string }, name: string, agent: string) => savedBy(s).servers.find((x) => x.name === name && x.agent === agent)!;

/** What `ok` mode's tools measure: the JSON of each one's name, description and schema, summed. */
const plainSize = (tools: number) => Array.from({ length: tools }, (_, i) => JSON.stringify({ name: `t${i}`, inputSchema: { type: "object" } }).length).reduce((a, b) => a + b, 0);

test("each server has tokens next to tools: the estimate of its summed tool definitions, and null when it did not answer", () => {
  const s = setup(stdioEntry("alpha", "ok", 5) + stdioEntry("dies", "exit3"));
  const { doc } = s.json();
  for (const tool of ["claude", "opencode"]) {
    const ok = s.find(doc, "alpha", tool);
    assert.equal(ok.tools, 5);
    assert.equal(ok.size, plainSize(5));
    assert.equal(ok.tokens, estimateTokens(plainSize(5)));
    const dead = s.find(doc, "dies", tool);
    assert.deepEqual([dead.tools, dead.size, dead.tokens], [null, null, null]);
  }
});

test("a tool's size is its name, description and input schema as JSON, over every page", () => {
  const TOKEN = "tok-for-sizing";
  const s = setup(stdioEntry("rich", "rich", 5, "", `    env:\n      TOKEN: ${TOKEN}\n`));
  const { doc } = s.json();
  const tool = (i: number) => ({ name: `marker-name-${i}`, description: `marker-description for ${TOKEN}`, inputSchema: { type: "object", properties: { "marker-prop": { type: "string", description: TOKEN } } } });
  assert.equal(s.find(doc, "rich", "claude").size, [0, 1, 2, 3, 4].map((i) => JSON.stringify(tool(i)).length).reduce((a, b) => a + b, 0));
});

test("the text form shows the estimate with a ~ beside the tool count", () => {
  const s = setup(stdioEntry("alpha", "ok", 3));
  const r = s.run([], { NO_COLOR: "1" });
  assert.match(r.stdout, new RegExp(`^ {2}alpha \\(claude, stdio\\): ok, 3 tools, ~${estimateTokens(plainSize(3))} tokens, \\d+ ms, MCP 2025-11-25$`, "m"));
  const failed = setup(stdioEntry("dies", "exit3")).run([], { NO_COLOR: "1" });
  assert.doesNotMatch(failed.stdout, /tokens/);
});

test("every doctor run saves the doctor result: mode 600, no temp file left, one record per server and tool", () => {
  const s = setup(stdioEntry("alpha", "ok", 4) + stdioEntry("dies", "exit3"));
  assert.equal(existsSync(resultFile(s.home)), false);
  const before = Date.now();
  s.json();
  assert.equal(statSync(resultFile(s.home)).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(s.home, ".local/state/fleet")).filter((f) => f.endsWith(".tmp")), []);
  const saved = savedBy(s);
  assert.deepEqual([saved.version, saved.host], [1, "laptop"]);
  assert.deepEqual(saved.servers.map((x) => [x.name, x.agent, x.result, x.tools, x.size]), [
    ["alpha", "claude", "ok", 4, plainSize(4)],
    ["alpha", "opencode", "ok", 4, plainSize(4)],
    ["dies", "claude", "exited", null, null],
    ["dies", "opencode", "exited", null, null],
  ]);
  const alpha = savedServer(s, "alpha", "claude");
  assert.ok(Date.parse(alpha.measuredAt!) >= before - 1000 && Date.parse(alpha.measuredAt!) <= Date.now());
  assert.match(alpha.definition!, /^[0-9a-f]{64}$/);
  assert.equal(savedServer(s, "dies", "claude").measuredAt, null, "a server that never answered has no time");
  assert.equal(savedServer(s, "dies", "claude").definition, null);
  // It is a file of its own: nothing of it is in the applied state.
  assert.equal(existsSync(join(s.home, ".local/state/fleet/applied.json")), false);
});

test("a server that fails this run keeps its last good measurement and time, and shows this run's failure", async () => {
  const gate = join(tempDir(), "down");
  const s = setup(stdioEntry("flaky", "gate", 3, gate) + stdioEntry("steady", "ok", 2));
  s.json();
  const first = savedServer(s, "flaky", "claude");
  const steadyFirst = savedServer(s, "steady", "claude");
  assert.equal(first.result, "ok");
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeFileSync(gate, "");
  const { doc } = s.json();
  assert.equal(s.find(doc, "flaky", "claude").result, "exited");
  const kept = savedServer(s, "flaky", "claude");
  assert.deepEqual({ ...kept, result: "" }, { ...first, result: "" }, "the measurement, its time and its hash are as they were");
  assert.equal(kept.result, "exited");
  assert.ok(savedServer(s, "steady", "claude").measuredAt! > steadyFirst.measuredAt!, "a server that answers is measured again");
  // It comes back, and is measured afresh.
  rmSync(gate);
  s.json();
  assert.equal(savedServer(s, "flaky", "claude").result, "ok");
  assert.ok(savedServer(s, "flaky", "claude").measuredAt! > first.measuredAt!);
});

test("a server no longer picked is dropped from the doctor result", () => {
  const s = setup(stdioEntry("alpha", "ok", 1) + stdioEntry("beta", "ok", 1));
  s.json();
  assert.deepEqual([...new Set(savedBy(s).servers.map((x) => x.name))], ["alpha", "beta"]);
  s.write("hosts/_defaults.yaml", "mcp:\n  include: [alpha]\n");
  publish(s.clone, "drop beta");
  s.json();
  assert.deepEqual([...new Set(savedBy(s).servers.map((x) => x.name))], ["alpha"]);
});

test("a run that could not start any server leaves the doctor result as it was", () => {
  const s = setup(stdioEntry("alpha", "ok", 1));
  s.json();
  const before = readFileSync(resultFile(s.home), "utf8");
  s.write("hosts/laptop.yaml", "ssh: me@laptop\nnot-a-key: 1\n");
  const r = s.run(["--json"]);
  assert.equal(r.code, EXIT.invalid);
  assert.equal(readFileSync(resultFile(s.home), "utf8"), before);
});

test("the doctor result holds no secret value and no tool name, description or schema text", () => {
  const TOKEN = "tok-plaintext-5d1-resultcheck";
  const s = setup(stdioEntry("rich", "rich", 3, "", `    env:\n      TOKEN: secret:API_TOKEN\n`), { hosts: { laptop: "admin: true\nssh: me@laptop\n" }, key: false });
  useSecrets(s, "API_TOKEN", TOKEN);
  const { doc } = s.json();
  assert.equal(s.find(doc, "rich", "claude").result, "ok");
  assert.equal(s.find(doc, "rich", "claude").tools, 3);
  const saved = readFileSync(resultFile(s.home), "utf8");
  assert.match(saved, /"size": [1-9]/, "it is a real measurement");
  for (const text of [TOKEN, "marker-description", "marker-name", "marker-prop", "object"]) assert.equal(saved.includes(text), false, text);
  assert.equal(saved.includes("secret:"), false, "not even the reference to a secret: the hash stands for the entry");
});

test("the definition hash changes when the catalog entry changes, and not when only a secret's value does", () => {
  const entry = (count: number) => stdioEntry("rich", "rich", count, "", `    env:\n      TOKEN: secret:API_TOKEN\n`);
  const s = setup(entry(3), { hosts: { laptop: "admin: true\nssh: me@laptop\n" }, key: false });
  useSecrets(s, "API_TOKEN", "first-value-aaaaaaaa");
  s.json();
  const first = ["claude", "opencode"].map((a) => savedServer(s, "rich", a).definition);
  assert.ok(first.every((h) => h !== null));
  setSecret(s, "API_TOKEN", "second-value-bbbbbbbb");
  s.json();
  assert.deepEqual(["claude", "opencode"].map((a) => savedServer(s, "rich", a).definition), first, "the secret's value is not in the hash");
  s.write("catalog/mcp.yaml", `servers:\n${entry(4)}`);
  publish(s.clone, "change the entry");
  s.json();
  const changed = ["claude", "opencode"].map((a) => savedServer(s, "rich", a).definition);
  assert.deepEqual(changed.map((h, i) => h !== first[i]), [true, true]);
});

test("doctor --all saves this host's own result and nothing for the other hosts", () => {
  const remote = JSON.parse(docOf()) as { servers: object[] };
  remote.servers = [{ server: "remote-only", tool: "claude", transport: "stdio", result: "ok", tools: 7, size: 4000, tokens: 1000, latencyMs: 40, protocol: "2025-11-25", detail: null, fails: false }];
  const s = setupAll({ "me@bee": { stdout: JSON.stringify({ ...JSON.parse(docOf()), servers: remote.servers }) } }, { bee: "ssh: me@bee\n" });
  const { doc } = s.all();
  const hosts = (doc as unknown as { hosts: { host: string; doctor: { servers: { server: string; tokens: number | null }[] } | null }[] }).hosts;
  assert.deepEqual(hosts.find((h) => h.host === "bee")!.doctor!.servers.map((x) => [x.server, x.tokens]), [["remote-only", 1000]], "a remote host's estimate is read through");
  const saved = savedBy(s);
  assert.equal(saved.host, "laptop");
  assert.deepEqual([...new Set(saved.servers.map((x) => x.name))], ["alpha"]);
  assert.equal(JSON.stringify(saved).includes("remote-only"), false);
});
