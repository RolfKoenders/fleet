import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeCalls, installFakeClaude, makeClone, makeHome, publish, runFleet, skipIfSystemWide } from "./helpers.ts";
import { EXIT } from "../src/exit.ts";
import { findTool } from "../src/tools.ts";

function setup(opts: { catalog: string; defaults?: string; host?: string; installClaude?: boolean }) {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  if (opts.installClaude !== false) installFakeClaude(home);
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(clone, rel)), { recursive: true });
    writeFileSync(join(clone, rel), text);
  };
  write("catalog/mcp.yaml", opts.catalog);
  write("hosts/_defaults.yaml", opts.defaults ?? "{}\n");
  write("hosts/laptop.yaml", opts.host ?? "{}\n");
  const run = (args: string[], o: { env?: Record<string, string>; input?: string } = {}) => (publish(clone), runFleet(clone, args, { home, ...o }));
  const json = (args: string[]) => {
    const r = run([...args, "--json"]);
    return { r, doc: JSON.parse(r.stdout) };
  };
  const readJson = (rel: string) => JSON.parse(readFileSync(join(home, rel), "utf8"));
  return { clone, home, write, run, json, readJson };
}

test("a network server renders to each tool's shape, with empty headers omitted", () => {
  const s = setup({
    catalog: `servers:
  analytics:
    transport: http
    url: https://analytics.example.com/mcp
  legacy:
    transport: sse
    url: https://legacy.example.com/sse
    headers:
      X-Team: tracker
`,
    host: "mcp:\n  include: [analytics, legacy]\n",
  });
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(s.readJson(".claude.json").mcpServers, {
    analytics: { type: "http", url: "https://analytics.example.com/mcp" },
    legacy: { type: "sse", url: "https://legacy.example.com/sse", headers: { "X-Team": "tracker" } },
  });
  assert.deepEqual(s.readJson(".config/opencode/opencode.jsonc").mcp, {
    analytics: { type: "remote", url: "https://analytics.example.com/mcp" },
    legacy: { type: "remote", url: "https://legacy.example.com/sse", headers: { "X-Team": "tracker" } },
  });
});

const NODE_DIR = dirname(process.execPath);

test("an npx server runs the npx beside Node, with a PATH that finds it; empty args are omitted", () => {
  const s = setup({
    catalog: `servers:
  components:
    command: [npx, -y, components@4.23.0, mcp]
  metrics:
    command: ["{{ vars.HOME }}/.local/bin/mcp-metrics"]
    env:
      METRICS_URL: "{{ vars.METRICS_URL }}"
`,
    host: "vars:\n  METRICS_URL: https://metrics.example.com:8443\nmcp:\n  include: [components, metrics]\n",
  });
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  const path = `${NODE_DIR}:/usr/local/bin:/usr/bin:/bin`;
  assert.deepEqual(s.readJson(".claude.json").mcpServers, {
    components: { type: "stdio", command: join(NODE_DIR, "npx"), args: ["-y", "components@4.23.0", "mcp"], env: { PATH: path } },
    metrics: { type: "stdio", command: join(s.home, ".local/bin/mcp-metrics"), env: { METRICS_URL: "https://metrics.example.com:8443" } },
  });
  assert.deepEqual(s.readJson(".config/opencode/opencode.jsonc").mcp, {
    components: { type: "local", command: [join(NODE_DIR, "npx"), "-y", "components@4.23.0", "mcp"], environment: { PATH: path } },
    metrics: { type: "local", command: [join(s.home, ".local/bin/mcp-metrics")], environment: { METRICS_URL: "https://metrics.example.com:8443" } },
  });
});

const BOTH = `servers:
  everywhere:
    transport: http
    url: https://a.example.com
  claude-only:
    transport: http
    url: https://b.example.com
    only: [claude]
  opencode-only:
    transport: http
    url: https://c.example.com
    only: [opencode]
  dropped:
    transport: http
    url: https://d.example.com
  host-only:
    transport: http
    url: https://e.example.com
`;

test("only, include and exclude decide which servers reach which tool", () => {
  const s = setup({
    catalog: BOTH,
    defaults: "mcp:\n  include: [everywhere, claude-only, dropped]\n",
    host: "mcp:\n  include: [opencode-only, host-only]\n  exclude: [dropped]\n",
  });
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(Object.keys(s.readJson(".claude.json").mcpServers).sort(), ["claude-only", "everywhere", "host-only"]);
  assert.deepEqual(Object.keys(s.readJson(".config/opencode/opencode.jsonc").mcp).sort(), ["everywhere", "host-only", "opencode-only"]);
});

test("a server the host does not pick is not written, and its unknown variable is no problem", () => {
  const s = setup({
    catalog: "servers:\n  picked:\n    transport: http\n    url: https://a.example.com\n  other:\n    transport: http\n    url: '{{ vars.NOPE }}'\n",
    host: "mcp:\n  include: [picked]\n",
  });
  assert.equal(s.run(["apply"]).code, EXIT.ok);
});

test("an unknown variable on a picked server exits 2 and writes nothing", () => {
  const s = setup({
    catalog: "servers:\n  home-hub:\n    transport: http\n    url: '{{ vars.HOME_HUB_URL }}'\n",
    host: "mcp:\n  include: [home-hub]\n",
  });
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /home-hub.*HOME_HUB_URL/);
  assert.deepEqual(claudeCalls(s.home), []);
});

test("including a server that is not in the catalog exits 2", () => {
  const s = setup({ catalog: BOTH, host: "mcp:\n  include: [nope]\n" });
  const r = s.run(["diff"]);
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /'nope'/);
});

test("a catalog entry that is neither stdio nor network, or puts a secret in its command, exits 2", () => {
  for (const [entry, pattern] of [
    ["x:\n    url: https://a.example.com\n", /exactly one of 'command'/],
    ["x:\n    command: [a]\n    transport: http\n    url: https://a.example.com\n", /exactly one of 'command'/],
    ["x:\n    command: [run, 'secret:TOKEN']\n", /cannot refer to a secret/],
    ["x:\n    transport: http\n", /needs a 'url'/],
    ["x:\n    transport: http\n    url: https://a.example.com\n    env: { A: b }\n", /'env' belongs to a stdio/],
    ["x:\n    transport: ws\n    url: https://a.example.com\n", /http or sse/],
    ["x:\n    transport: http\n    url: https://a.example.com\n    only: [vim]\n", /'only'/],
    ["x:\n    transport: http\n    url: https://a.example.com\n    colour: red\n", /unknown key 'colour'/],
    ["'a.b':\n    transport: http\n    url: https://a.example.com\n", /server name 'a.b'/],
  ] as const) {
    const s = setup({ catalog: `servers:\n  ${entry}` });
    const r = s.run(["diff"]);
    assert.equal(r.code, EXIT.invalid, entry);
    assert.match(r.stderr, pattern, entry);
  }
});

test("fleet writes Claude's entries itself under Claude's lock, and the file ends up mode 600", () => {
  const s = setup({ catalog: BOTH, host: "mcp:\n  include: [everywhere]\n" });
  writeFileSync(join(s.home, ".claude.json"), JSON.stringify({ numStartups: 3 }), { mode: 0o644 });
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(claudeCalls(s.home), [], "no claude mcp add-json");
  assert.deepEqual(s.readJson(".claude.json"), { numStartups: 3, mcpServers: { everywhere: { type: "http", url: "https://a.example.com" } } });
  assert.equal(lstatSync(join(s.home, ".claude.json")).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(s.home).filter((f) => f.startsWith(".claude.json") || f.startsWith("..claude.json")), [".claude.json"], "no lock or temp file is left");
});

test("dropping a server also leaves ~/.claude.json at mode 600", () => {
  const s = setup({ catalog: BOTH, host: "mcp:\n  include: [everywhere]\n" });
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  s.write("hosts/laptop.yaml", "{}\n");
  const r = s.run(["apply"], { env: { FAKE_CLAUDE_MODE: "644" } });
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(s.readJson(".claude.json").mcpServers, {});
  assert.equal(lstatSync(join(s.home, ".claude.json")).mode & 0o777, 0o600);
});

test("a second apply changes nothing", () => {
  const s = setup({
    catalog: "servers:\n  tool:\n    command: [run-it]\n",
    host: "mcp:\n  include: [tool]\n",
  });
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.deepEqual(s.readJson(".claude.json").mcpServers.tool, { type: "stdio", command: "run-it" });
  const calls = claudeCalls(s.home).length;

  const again = s.json(["apply"]);
  assert.equal(again.r.code, EXIT.ok, again.r.stderr);
  assert.deepEqual(again.doc.created, []);
  assert.deepEqual(again.doc.updated, []);
  assert.equal(claudeCalls(s.home).length, calls);
});

test("servers added by hand beside fleet's are left alone in both tools", () => {
  const s = setup({ catalog: BOTH, host: "mcp:\n  include: [everywhere]\n" });
  writeFileSync(join(s.home, ".claude.json"), JSON.stringify({ numStartups: 7, mcpServers: { mine: { type: "http", url: "https://mine.example.com" } } }));
  mkdirSync(join(s.home, ".config/opencode"), { recursive: true });
  writeFileSync(join(s.home, ".config/opencode/opencode.jsonc"), JSON.stringify({ theme: "x", mcp: { mine: { type: "remote", url: "https://mine.example.com" } } }));

  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  const claude = s.readJson(".claude.json");
  assert.deepEqual(Object.keys(claude.mcpServers).sort(), ["everywhere", "mine"]);
  assert.equal(claude.numStartups, 7);
  assert.deepEqual(claudeCalls(s.home), []);
  const opencode = s.readJson(".config/opencode/opencode.jsonc");
  assert.deepEqual(Object.keys(opencode.mcp).sort(), ["everywhere", "mine"]);
  assert.equal(opencode.theme, "x");
});

test("changing a server replaces its entry in Claude, and dropping it removes it from both tools", () => {
  const s = setup({ catalog: BOTH, host: "mcp:\n  include: [everywhere, host-only]\n" });
  assert.equal(s.run(["apply"]).code, EXIT.ok);

  s.write("catalog/mcp.yaml", BOTH.replace("https://a.example.com", "https://a2.example.com"));
  s.write("hosts/laptop.yaml", "mcp:\n  include: [everywhere]\n");
  const before = claudeCalls(s.home).length;
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);

  assert.deepEqual(claudeCalls(s.home).slice(before), [["mcp", "remove", "--scope", "user", "host-only"]]);
  assert.deepEqual(s.readJson(".claude.json").mcpServers, { everywhere: { type: "http", url: "https://a2.example.com" } });
  assert.deepEqual(s.readJson(".config/opencode/opencode.jsonc").mcp, { everywhere: { type: "remote", url: "https://a2.example.com" } });
});

test("an entry changed by hand in ~/.claude.json is a conflict, and nothing is written", () => {
  const s = setup({ catalog: BOTH, host: "mcp:\n  include: [everywhere]\n" });
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  const doc = s.readJson(".claude.json");
  doc.mcpServers.everywhere.url = "https://edited.example.com";
  writeFileSync(join(s.home, ".claude.json"), JSON.stringify(doc));
  const calls = claudeCalls(s.home).length;

  const { r, doc: out } = s.json(["apply"]);
  assert.equal(r.code, EXIT.conflict);
  assert.equal(out.conflicts[0].kind, "key");
  assert.match(out.conflicts[0].path, /\.claude\.json mcpServers\.everywhere/);
  assert.equal(claudeCalls(s.home).length, calls);
});

test("a project-scoped server with the same name is a warning that names the project, not a conflict", () => {
  const s = setup({ catalog: BOTH, host: "mcp:\n  include: [everywhere]\n" });
  writeFileSync(
    join(s.home, ".claude.json"),
    JSON.stringify({ projects: { "/work/tracker": { mcpServers: { everywhere: { type: "http", url: "https://theirs.example.com" } } }, "/work/other": { mcpServers: { unrelated: {} } } } }),
  );
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(doc.warnings.length, 1);
  assert.match(doc.warnings[0], /\/work\/tracker/);
  assert.match(doc.warnings[0], /'everywhere'/);

  const diff = s.run(["diff"]);
  assert.equal(diff.code, EXIT.ok);
  assert.match(diff.stdout, /warning .*\/work\/tracker/);
});

test("without claude, apply sets up opencode and warns, and the first apply after claude is installed adds its servers", { skip: skipIfSystemWide("claude") }, () => {
  const s = setup({ catalog: BOTH, host: "mcp:\n  include: [everywhere]\n", installClaude: false });
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stdout, /claude is not installed, so 1 MCP server is left out/);
  assert.ok(s.readJson(".config/opencode/opencode.jsonc").mcp.everywhere);
  assert.throws(() => readFileSync(join(s.home, ".claude.json")));
  assert.match(s.run(["diff"]).stdout, /claude is not installed/);

  installFakeClaude(s.home);
  const after = s.run(["apply"]);
  assert.equal(after.code, EXIT.ok, after.stderr);
  assert.doesNotMatch(after.stdout, /claude is not installed/);
  assert.ok(s.readJson(".claude.json").mcpServers.everywhere);
});

test("a server fleet added stays recorded when claude goes away, and nothing fails", { skip: skipIfSystemWide("claude") }, () => {
  const s = setup({ catalog: BOTH, host: "mcp:\n  include: [everywhere]\n" });
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  rmSync(join(s.home, ".local/bin/claude"));
  s.write("hosts/laptop.yaml", "{}\n");
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  const state = s.readJson(".local/state/fleet/applied.json");
  assert.ok(state.keys.some((k: { path: string }) => k.path === "mcpServers.everywhere"));
});

const TOKEN = "tok-plaintext-9f3";

function withSecret() {
  const s = setup({
    catalog: `servers:
  tracker:
    command: [npx, -y, "@example/tracker-mcp@1.0.2"]
    env:
      TRACKER_API_KEY: secret:TRACKER_API_KEY
  github:
    transport: http
    url: https://api.githubcopilot.com/mcp/
    headers:
      Authorization: Bearer secret:TRACKER_API_KEY
`,
  });
  const keygen = findTool("age-keygen")!;
  mkdirSync(join(s.home, ".local/bin"), { recursive: true });
  for (const [name, path] of [["sops", findTool("sops")!], ["age-keygen", keygen]] as const) symlinkSync(path, join(s.home, ".local/bin", name));
  const key = spawnSync(keygen, [], { encoding: "utf8" }).stdout;
  const recipient = spawnSync(keygen, ["-y"], { encoding: "utf8", input: key }).stdout.trim();
  mkdirSync(join(s.home, ".config/fleet"), { recursive: true });
  writeFileSync(join(s.home, ".config/fleet/age.key"), key, { mode: 0o600 });
  s.write("hosts/laptop.yaml", `admin: true\nage: ${recipient}\nmcp:\n  include: [tracker, github]\n`);
  assert.equal(s.run(["secrets", "set", "shared", "TRACKER_API_KEY"], { input: TOKEN }).code, EXIT.ok);
  return s;
}

test("secrets are rendered into both tools; diff, output and applied state show none of them", () => {
  const s = withSecret();
  const diff = s.run(["diff"]);
  assert.equal(diff.code, EXIT.ok, diff.stderr);
  assert.match(diff.stdout, /create ~\/\.claude\.json mcpServers\.github = \{"type":"http","url":"https:\/\/api\.githubcopilot\.com\/mcp\/","headers":\{"Authorization":"Bearer \*\*\*"\}\}/);

  const apply = s.run(["apply"]);
  assert.equal(apply.code, EXIT.ok, apply.stderr);
  for (const text of [diff.stdout + diff.stderr, apply.stdout + apply.stderr, readFileSync(join(s.home, ".local/state/fleet/applied.json"), "utf8")]) {
    assert.equal(text.includes(TOKEN), false);
  }
  const claude = s.readJson(".claude.json").mcpServers;
  assert.equal(claude.tracker.env.TRACKER_API_KEY, TOKEN);
  assert.equal(claude.github.headers.Authorization, `Bearer ${TOKEN}`);
  const opencode = s.readJson(".config/opencode/opencode.jsonc").mcp;
  assert.equal(opencode.tracker.environment.TRACKER_API_KEY, TOKEN);
  assert.equal(opencode.github.headers.Authorization, `Bearer ${TOKEN}`);
  // The command line of the server itself never carries the secret.
  assert.equal(JSON.stringify(claude.tracker.args).includes(TOKEN), false);
});

test("no decrypted secret is ever on a command line, where any user on the host can read it", () => {
  const s = withSecret();
  // A shim in front of sops logs its arguments; the fake claude logs its own.
  const sops = findTool("sops")!;
  rmSync(join(s.home, ".local/bin/sops"));
  writeFileSync(join(s.home, ".local/bin/sops"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$HOME/sops-calls.log"\nexec ${sops} "$@"\n`, { mode: 0o755 });
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.equal(s.run(["secrets", "set", "shared", "TRACKER_API_KEY"], { input: `${TOKEN}-v2` }).code, EXIT.ok);
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(s.readJson(".claude.json").mcpServers.github.headers.Authorization, `Bearer ${TOKEN}-v2`, "the secret did reach the file");
  const logs = readdirSync(s.home).filter((f) => f.endsWith("-calls.log"));
  assert.ok(logs.includes("sops-calls.log"));
  for (const log of logs) assert.equal(readFileSync(join(s.home, log), "utf8").includes(TOKEN), false, log);
});

test("rotating a secret replaces the entry in Claude", () => {
  const s = withSecret();
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.equal(s.run(["secrets", "set", "shared", "TRACKER_API_KEY"], { input: `${TOKEN}-v2` }).code, EXIT.ok);
  const before = claudeCalls(s.home).length;
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(claudeCalls(s.home).slice(before), []);
  assert.equal(s.readJson(".claude.json").mcpServers.github.headers.Authorization, `Bearer ${TOKEN}-v2`);
});

// ---- Claude's lock ----

const LOCK = ".claude.json.lock";

test("apply waits for Claude's lock and reads the file again inside it, so a save Claude makes meanwhile is kept", () => {
  const s = setup({ catalog: BOTH, host: "mcp:\n  include: [everywhere]\n" });
  writeFileSync(join(s.home, ".claude.json"), JSON.stringify({ numStartups: 1 }));
  mkdirSync(join(s.home, LOCK));
  // Stands in for a running Claude: it holds the lock, saves, then lets go.
  const claude = spawn(process.execPath, ["-e", `
    const fs = require("node:fs");
    setTimeout(() => {
      fs.writeFileSync(${JSON.stringify(join(s.home, ".claude.json"))}, JSON.stringify({ numStartups: 2 }));
      fs.rmdirSync(${JSON.stringify(join(s.home, LOCK))});
    }, 800);`]);
  const r = s.run(["apply"]);
  claude.kill();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(s.readJson(".claude.json"), { numStartups: 2, mcpServers: { everywhere: { type: "http", url: "https://a.example.com" } } });
  assert.equal(existsSync(join(s.home, LOCK)), false);
});

test("a lock Claude still holds after the wait stops apply with a message, and the file is not written", () => {
  const s = setup({ catalog: BOTH, host: "mcp:\n  include: [everywhere]\n" });
  writeFileSync(join(s.home, ".claude.json"), JSON.stringify({ numStartups: 1 }));
  mkdirSync(join(s.home, LOCK));
  const r = s.run(["apply"]);
  assert.notEqual(r.code, EXIT.ok);
  assert.match(r.stderr, /~\/\.claude\.json is locked by a running Claude; apply again in a moment/);
  assert.deepEqual(s.readJson(".claude.json"), { numStartups: 1 });
  assert.equal(existsSync(join(s.home, LOCK)), true, "a lock that is not fleet's is left alone");
});

test("a lock left behind by a Claude that died is cleared, and apply goes on", () => {
  const s = setup({ catalog: BOTH, host: "mcp:\n  include: [everywhere]\n" });
  mkdirSync(join(s.home, LOCK));
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(s.home, LOCK), old, old);
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(s.readJson(".claude.json").mcpServers, { everywhere: { type: "http", url: "https://a.example.com" } });
  assert.equal(existsSync(join(s.home, LOCK)), false);
});
