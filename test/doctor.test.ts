import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, installFakeSsh, installFakeTool, installStatusTools, makeClone, makeHome, publish, runFleet, tempDir, toolCalls } from "./helpers.ts";
import type { SshPlan } from "./helpers.ts";
import { EXIT } from "../src/exit.ts";
import { findTool } from "../src/tools.ts";

// ---- fake MCP servers, as separate processes so the blocking runs of fleet never starve them ----

const STDIO_SERVER = `
const fs = require("node:fs");
const cp = require("node:child_process");
const [mode, count, extra] = process.argv.slice(2);
const log = process.env.LOG;
const note = (text) => log && fs.appendFileSync(log, text + "\\n");
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
if (mode === "exit3") process.exit(3);
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
    if (m.method === "initialize") {
      if (mode === "leak") {
        process.stderr.write("secret on stderr: " + process.env.TOKEN + "\\n");
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "bad token " + process.env.TOKEN } }) + "\\n");
        return;
      }
      reply(m.id, { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
    } else if (m.method === "tools/list") {
      const start = m.params && m.params.cursor ? Number(m.params.cursor) : 0;
      const end = Math.min(start + 2, Number(count));
      const tools = []; for (let i = start; i < end; i++) tools.push({ name: "t" + i, inputSchema: { type: "object" } });
      reply(m.id, end < Number(count) ? { tools, nextCursor: String(end) } : { tools });
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
type Server = { server: string; tool: string; transport: string; result: string; tools: number | null; latencyMs: number | null; detail: string | null; fails: boolean };

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
  if (opts.timer !== undefined) installFakeTool(home, "systemctl", { stdout: opts.timer });
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
  assert.match(r.stdout, /^ {2}alpha \(claude, stdio\): ok, 1 tool, \d+ ms$/m);
  assert.match(r.stdout, /^ {2}alpha \(opencode, stdio\): ok, 1 tool, \d+ ms$/m);
});

test("a missing program, a server that exits, and one that writes text that is not JSON-RPC are told apart, and exit 1", () => {
  const s = setup(
    [
      `  gone:\n    command: ["/nonexistent/dir/mcp-gone"]\n`,
      `  bare:\n    command: [definitely-not-installed-mcp]\n`,
      stdioEntry("dies", "exit3"),
      stdioEntry("noisy", "junk"),
    ].join(""),
  );
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.error);
  assert.equal(doc.code, "error");
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
  assert.equal(r.code, EXIT.error);
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
  assert.equal(r.code, EXIT.error);
  assert.equal(doc.servers.some((x) => x.detail?.includes("127.0.0.1")), false, "no url is printed");
});

test("only an expected login is left out of the exit code", async (t) => {
  const http = await startHttp();
  t.after(http.stop);
  const s = setup(`  login:\n    transport: http\n    url: http://127.0.0.1:${http.port}/auth\n`);
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stdout + r.stderr);
  assert.match(r.stdout, /login \(claude, http\): auth-needed/);
});

// ---- secrets ----

test("a secret is delivered to the server and never printed, in text, JSON or errors", async (t) => {
  const TOKEN = "tok-plaintext-9f3-leakcheck";
  const http = await startHttp();
  t.after(http.stop);
  const sops = findTool("sops");
  const keygen = findTool("age-keygen");
  assert.ok(sops && keygen);
  const seen = join(tempDir(), "seen.log");
  const s = setup(
    [
      stdioEntry("echoes", "leak", 1, "", `    env:\n      TOKEN: secret:API_TOKEN\n`),
      stdioEntry("checks", "tokencheck", 1, "", `    env:\n      TOKEN: secret:API_TOKEN\n      LOG: ${seen}\n`),
      `  remote:\n    transport: http\n    url: http://127.0.0.1:${http.port}/auth\n    headers:\n      Authorization: Bearer secret:API_TOKEN\n`,
    ].join(""),
    { hosts: { laptop: "admin: true\nssh: me@laptop\n" }, key: false },
  );
  mkdirSync(join(s.home, ".local/bin"), { recursive: true });
  for (const [name, path] of [["sops", sops], ["age-keygen", keygen]] as const) {
    rmSync(join(s.home, ".local/bin", name), { force: true });
    symlinkSync(path, join(s.home, ".local/bin", name));
  }
  const key = spawnSync(keygen, [], { encoding: "utf8" }).stdout;
  const recipient = spawnSync(keygen, ["-y"], { encoding: "utf8", input: key }).stdout.trim();
  mkdirSync(join(s.home, ".config/fleet"), { recursive: true });
  writeFileSync(join(s.home, ".config/fleet/age.key"), key, { mode: 0o600 });
  s.write("hosts/laptop.yaml", `admin: true\nage: ${recipient}\nssh: me@laptop\n`);
  publish(s.clone, "age");
  assert.equal(runFleet(s.clone, ["secrets", "set", "shared", "API_TOKEN"], { home: s.home, input: TOKEN }).code, EXIT.ok);

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

test("a dangling skill link, a stopped timer and a missing age key are problems, and exit 1", () => {
  const s = setup("", { key: false, timer: "inactive" });
  mkdirSync(join(s.home, ".claude/skills"), { recursive: true });
  symlinkSync("/nonexistent/skills/gone", join(s.home, ".claude/skills/gone"));
  mkdirSync(join(s.home, ".local/state/fleet"), { recursive: true });
  writeFileSync(
    join(s.home, ".local/state/fleet/applied.json"),
    JSON.stringify({ version: 1, host: "laptop", appliedAt: "2026-10-30T10:00:00Z", repos: {}, links: [{ target: "~/.claude/skills/gone", source: "/nonexistent/skills/gone" }], keys: [] }),
  );
  const { r, doc } = s.json();
  assert.equal(r.code, EXIT.error);
  const by = Object.fromEntries(doc.checks.map((c) => [c.name, c]));
  assert.equal(by["timer"]!.result, "problem");
  assert.equal(by["timer"]!.detail, "inactive");
  assert.equal(by["age-key"]!.result, "problem");
  assert.match(by["age-key"]!.detail!, /~\/\.config\/fleet\/age\.key/);
  assert.equal(by["skill-links"]!.result, "problem");
  assert.match(by["skill-links"]!.detail!, /~\/\.claude\/skills\/gone/);
  assert.deepEqual(doc.servers, []);
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
  assert.doesNotMatch(agent.slice(0, agent.indexOf("### Changes things")), /fleet doctor/);
});

test("doctor never writes fleet's state or the tools' files", () => {
  const s = setup(stdioEntry("alpha", "ok", 1));
  assert.equal(s.run().code, EXIT.ok);
  for (const rel of [".local/state/fleet", ".claude.json", ".claude", ".config/opencode"]) assert.equal(existsSync(join(s.home, rel)), false, rel);
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
    servers: [{ server: "alpha", tool: "claude", transport: "stdio", result: "ok", tools: 7, latencyMs: 40, detail: null, fails: false }],
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

test("--timeout is passed on to the other hosts", () => {
  const s = setupAll({ "me@bee": { stdout: docOf() } }, { bee: "ssh: me@bee\n" });
  s.all(["--timeout", "5"]);
  assert.equal(toolCalls(s.home, "ssh")[0]![5], `${REMOTE_COMMAND} --timeout 5`);
});

test("--all: an unreachable host exits 4, a host with no ssh is timer, and a host with problems or a bad answer exits 1", () => {
  const unreachable = setupAll({ "me@a": { stdout: docOf() }, "me@b": UNREACHABLE }, { a: "ssh: me@a\n", b: "ssh: me@b\n", quiet: "{}\n" });
  const first = unreachable.all();
  const records = (first.doc as unknown as { hosts: { host: string; result: string }[] }).hosts;
  assert.equal(first.r.code, EXIT.unreachable);
  assert.deepEqual(records.map((h) => [h.host, h.result]), [["a", "ok"], ["b", "unreachable"], ["laptop", "ok"], ["quiet", "timer"]]);
  assert.match(first.r.stderr, /b: unreachable over ssh/);

  const bad = setupAll({ "me@a": { stdout: docOf({ ok: false, code: "error", servers: [{ server: "alpha", tool: "claude", transport: "stdio", result: "timeout", tools: null, latencyMs: null, detail: "no answer in time", fails: true }] }), exit: 1 }, "me@b": { stdout: "garbage", exit: 1 } }, { a: "ssh: me@a\n", b: "ssh: me@b\n" });
  const second = bad.all();
  const recs = (second.doc as unknown as { hosts: { host: string; result: string; detail?: string }[] }).hosts;
  assert.equal(second.r.code, EXIT.error);
  assert.deepEqual(recs.map((h) => [h.host, h.result]), [["a", "problems"], ["b", "error"], ["laptop", "ok"]]);
  assert.match(recs[1]!.detail!, /not a fleet doctor document/);

  const mixed = setupAll({ "me@a": { stdout: docOf({ ok: false, code: "error" }), exit: 1 }, "me@b": UNREACHABLE }, { a: "ssh: me@a\n", b: "ssh: me@b\n" });
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
      "me@b": { stdout: docOf({ ok: false, code: "error", servers: [{ server: "alpha", tool: "claude", transport: "stdio", result: "missing-binary", tools: null, latencyMs: null, detail: "the command is not installed or not executable", fails: true }] }), exit: 1 },
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
