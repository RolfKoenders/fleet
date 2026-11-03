import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeCalls, installFakeClaude, makeClone, makeHome, makeSource, publish, runFleet } from "./helpers.ts";
import { EXIT } from "../src/exit.ts";
import { hashValue } from "../src/keys.ts";
import { findTool } from "../src/tools.ts";

const STATE = ".local/state/fleet/applied.json";
/** Every apply links the tool's `fleet` skill too, which none of these tests is about. */
const notFleetSkill = (records: any[]): any[] => records.filter((r) => r.target !== "~/.claude/skills/fleet");
const CLAUDE_FILE = "~/.claude.json";
const OPENCODE_FILE = "~/.config/opencode/opencode.jsonc";

function setup(opts: { mcp?: string; skills?: string; defaults?: string; host?: string }) {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  installFakeClaude(home);
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(clone, rel)), { recursive: true });
    writeFileSync(join(clone, rel), text);
  };
  if (opts.mcp !== undefined) write("catalog/mcp.yaml", opts.mcp);
  if (opts.skills !== undefined) write("catalog/skills.yaml", opts.skills);
  write("hosts/_defaults.yaml", opts.defaults ?? "{}\n");
  write("hosts/laptop.yaml", opts.host ?? "{}\n");
  const run = (args: string[], o: { input?: string } = {}) => (publish(clone), runFleet(clone, args, { home, ...o }));
  const json = (args: string[]) => {
    const r = run([...args, "--json"]);
    return { r, doc: JSON.parse(r.stdout) };
  };
  const path = (rel: string) => join(home, rel);
  const put = (rel: string, doc: unknown) => {
    mkdirSync(dirname(path(rel)), { recursive: true });
    writeFileSync(path(rel), `${JSON.stringify(doc, null, 2)}\n`);
  };
  const read = (rel: string) => readFileSync(path(rel), "utf8");
  const state = () => JSON.parse(read(STATE));
  return { clone, home, write, run, json, path, put, read, state };
}

const NODE_FREE_CATALOG = `servers:
  metrics:
    command: ["{{ vars.HOME }}/.local/bin/mcp-metrics"]
    env:
      METRICS_URL: https://metrics.example.com
  stats:
    transport: http
    url: https://stats.example.com/mcp
  claude-side:
    transport: http
    url: https://c.example.com
    only: [claude]
`;

const PICK_ALL = "mcp:\n  include: [metrics, stats, claude-side]\n";

const metricsClaude = (home: string) => ({
  type: "stdio",
  command: join(home, ".local/bin/mcp-metrics"),
  env: { METRICS_URL: "https://metrics.example.com" },
});
const metricsOpencode = (home: string) => ({
  type: "local",
  command: [join(home, ".local/bin/mcp-metrics")],
  environment: { METRICS_URL: "https://metrics.example.com" },
});

test("adopt mcp records matching entries in both tools without changing either file; the next apply does nothing", () => {
  const s = setup({ mcp: NODE_FREE_CATALOG, host: PICK_ALL });
  // As `claude mcp add` leaves it: defaults the catalog omits are stored (`args: []`).
  s.put(".claude.json", { numStartups: 3, mcpServers: { metrics: { ...metricsClaude(s.home), args: [] }, mine: { type: "http", url: "https://mine.example.com" } } });
  s.put(".config/opencode/opencode.jsonc", { theme: "dark", mcp: { metrics: metricsOpencode(s.home), mine: { type: "remote", url: "https://mine.example.com" } } });
  const claudeBefore = s.read(".claude.json");
  const opencodeBefore = s.read(".config/opencode/opencode.jsonc");

  const r = s.run(["adopt", "mcp", "metrics"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stdout, /adopted ~\/\.claude\.json mcpServers\.metrics/);
  assert.match(r.stdout, /adopted ~\/\.config\/opencode\/opencode\.jsonc mcp\.metrics/);
  assert.equal(s.read(".claude.json"), claudeBefore);
  assert.equal(s.read(".config/opencode/opencode.jsonc"), opencodeBefore);
  assert.deepEqual(claudeCalls(s.home), []);

  const { keys, links } = s.state();
  assert.deepEqual(links, []);
  assert.deepEqual(keys, [
    { file: CLAUDE_FILE, path: "mcpServers.metrics", desired: hashValue(metricsClaude(s.home)), actual: hashValue({ ...metricsClaude(s.home), args: [] }) },
    { file: OPENCODE_FILE, path: "mcp.metrics", desired: hashValue(metricsOpencode(s.home)), actual: hashValue(metricsOpencode(s.home)) },
  ]);
  assert.equal(statSyncMode(s.path(STATE)), 0o600);

  const { doc } = s.json(["apply"]);
  assert.equal(doc.code, "ok");
  assert.deepEqual(notFleetSkill(doc.created).map((c: { path: string }) => c.path).sort(), ["mcp.stats", "mcpServers.claude-side", "mcpServers.stats"]);
  assert.deepEqual(doc.updated, []);
  assert.deepEqual(doc.removed, []);
  assert.equal(doc.unchanged.length, 2);
  assert.equal(JSON.parse(s.read(".claude.json")).mcpServers.mine.url, "https://mine.example.com");
  assert.equal(claudeCalls(s.home).some((c) => c.includes("metrics")), false);
  assert.deepEqual(s.json(["diff"]).doc.created, []);
});

const statSyncMode = (path: string) => lstatSync(path).mode & 0o777;

test("adopt mcp is a no-op for the next apply and diff when nothing else is pending", () => {
  const s = setup({ mcp: NODE_FREE_CATALOG, host: "mcp:\n  include: [stats]\n" });
  s.put(".claude.json", { mcpServers: { stats: { type: "http", url: "https://stats.example.com/mcp" } } });
  s.put(".config/opencode/opencode.jsonc", { mcp: { stats: { type: "remote", url: "https://stats.example.com/mcp" } } });
  assert.equal(s.run(["adopt", "mcp", "stats"]).code, EXIT.ok);
  const adopted = s.state();
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(r.stdout.trim(), "nothing to do");
  // The first apply records which config commit it saw; it changes nothing else.
  assert.deepEqual({ ...s.state(), appliedAt: "", repos: {} }, { ...adopted, appliedAt: "", repos: {} });
  const stateBefore = s.read(STATE);
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.equal(s.read(STATE), stateBefore);
  assert.deepEqual(claudeCalls(s.home), []);
  assert.equal(s.run(["adopt", "mcp", "stats"]).code, EXIT.ok);
  assert.deepEqual(s.state().keys.length, 2);
});

test("adopt mcp leaves state from an earlier apply alone", () => {
  const s = setup({ mcp: NODE_FREE_CATALOG, host: "mcp:\n  include: [stats, claude-side]\n" });
  s.put(".claude.json", { mcpServers: { "claude-side": { type: "http", url: "https://c.example.com" } } });
  assert.equal(s.run(["adopt", "mcp", "claude-side"]).code, EXIT.ok);
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  const before = s.state();
  assert.equal(before.keys.length, 3);
  assert.equal(s.run(["adopt", "mcp", "claude-side"]).code, EXIT.ok);
  assert.deepEqual(s.state().keys, before.keys);
});

test("adopt mcp for a server the host does not pick, or that is not in the catalog, exits 2 and writes nothing", () => {
  const s = setup({ mcp: NODE_FREE_CATALOG, host: "mcp:\n  include: [stats]\n  exclude: []\n" });
  s.put(".claude.json", { mcpServers: { metrics: { ...metricsClaude(s.home), args: [] } } });
  for (const name of ["metrics", "nope"]) {
    const r = s.run(["adopt", "mcp", name]);
    assert.equal(r.code, EXIT.invalid);
    assert.match(r.stderr, new RegExp(`'${name}'.*not picked by this host`));
  }
  assert.equal(existsSync(s.path(STATE)), false);
});

test("adopt mcp for a server excluded by the host exits 2", () => {
  const s = setup({ mcp: NODE_FREE_CATALOG, defaults: "mcp:\n  include: [stats]\n", host: "mcp:\n  exclude: [stats]\n" });
  s.put(".claude.json", { mcpServers: { stats: { type: "http", url: "https://stats.example.com/mcp" } } });
  assert.equal(s.run(["adopt", "mcp", "stats"]).code, EXIT.invalid);
  assert.equal(existsSync(s.path(STATE)), false);
});

test("adopt mcp with a differing entry exits 3, names the fields, and writes nothing, not even the tool that matched", () => {
  const s = setup({ mcp: NODE_FREE_CATALOG, host: "mcp:\n  include: [stats]\n" });
  s.put(".claude.json", { mcpServers: { stats: { type: "http", url: "https://stats.example.com/mcp" } } });
  s.put(".config/opencode/opencode.jsonc", { mcp: { stats: { type: "remote", url: "https://old.example.com/mcp", headers: { "X-Team": "tracker" } } } });
  const claudeBefore = s.read(".claude.json");
  const opencodeBefore = s.read(".config/opencode/opencode.jsonc");

  const r = s.run(["adopt", "mcp", "stats"]);
  assert.equal(r.code, EXIT.conflict);
  assert.match(r.stdout, /conflict ~\/\.config\/opencode\/opencode\.jsonc mcp\.stats/);
  assert.match(r.stdout, /url: expected "https:\/\/stats\.example\.com\/mcp", found "https:\/\/old\.example\.com\/mcp"/);
  assert.match(r.stdout, /headers\.X-Team/);
  assert.doesNotMatch(r.stdout, /tracker/, "a value under headers is never shown from the host's side");
  assert.match(r.stderr, /nothing was written/);
  assert.equal(existsSync(s.path(STATE)), false);
  assert.equal(s.read(".claude.json"), claudeBefore);
  assert.equal(s.read(".config/opencode/opencode.jsonc"), opencodeBefore);

  const { doc } = s.json(["adopt", "mcp", "stats"]);
  assert.equal(doc.code, "conflict");
  assert.equal(doc.conflicts.length, 1);
  assert.equal(doc.conflicts[0].kind, "key");
});

test("adopt mcp treats a field that is missing and one that is the wrong type as differences", () => {
  const s = setup({ mcp: NODE_FREE_CATALOG, host: "mcp:\n  include: [metrics]\n" });
  s.put(".claude.json", { mcpServers: { metrics: { type: "stdio", command: "/elsewhere/mcp-metrics", args: ["--read-only"], env: {} } } });
  s.put(".config/opencode/opencode.jsonc", { mcp: { metrics: "not a map" } });
  const r = s.run(["adopt", "mcp", "metrics"]);
  assert.equal(r.code, EXIT.conflict);
  assert.match(r.stdout, /command: expected ".*mcp-metrics", found "\/elsewhere\/mcp-metrics"/);
  assert.match(r.stdout, /args: expected \(absent\), found \["--read-only"\]/);
  assert.match(r.stdout, /env\.METRICS_URL: expected "https:\/\/metrics\.example\.com", found \(absent\)/);
  assert.match(r.stdout, /mcp\.metrics differs from the config: the entry is not a map/);
  assert.equal(existsSync(s.path(STATE)), false);
});

test("adopt mcp adopts the tool that has the entry and leaves the other to apply, but needs at least one entry", () => {
  const s = setup({ mcp: NODE_FREE_CATALOG, host: "mcp:\n  include: [stats]\n" });
  const none = s.run(["adopt", "mcp", "stats"]);
  assert.equal(none.code, EXIT.invalid);
  assert.match(none.stderr, /nothing to adopt/);
  assert.equal(existsSync(s.path(STATE)), false);

  s.put(".claude.json", { mcpServers: { stats: { type: "http", url: "https://stats.example.com/mcp" } } });
  assert.equal(s.run(["adopt", "mcp", "stats"]).code, EXIT.ok);
  assert.deepEqual(s.state().keys.map((k: { file: string }) => k.file), [CLAUDE_FILE]);
  const { doc } = s.json(["apply"]);
  assert.deepEqual(notFleetSkill(doc.created).map((c: { file: string }) => c.file), [OPENCODE_FILE]);
  assert.deepEqual(claudeCalls(s.home), []);
});

test("adopt mcp reports an unreadable settings file as a conflict", () => {
  const s = setup({ mcp: NODE_FREE_CATALOG, host: "mcp:\n  include: [stats]\n" });
  s.put(".claude.json", { mcpServers: { stats: { type: "http", url: "https://stats.example.com/mcp" } } });
  mkdirSync(dirname(s.path(".config/opencode/opencode.jsonc")), { recursive: true });
  writeFileSync(s.path(".config/opencode/opencode.jsonc"), "{ nope");
  const r = s.run(["adopt", "mcp", "stats"]);
  assert.equal(r.code, EXIT.conflict);
  assert.match(r.stdout, /opencode\.jsonc cannot be read as settings/);
  assert.equal(existsSync(s.path(STATE)), false);
});

test("adopt mcp is refused while another apply holds the lock", () => {
  const s = setup({ mcp: NODE_FREE_CATALOG, host: "mcp:\n  include: [stats]\n" });
  s.put(".claude.json", { mcpServers: { stats: { type: "http", url: "https://stats.example.com/mcp" } } });
  mkdirSync(s.path(".local/state/fleet/lock"), { recursive: true });
  writeFileSync(s.path(".local/state/fleet/lock/pid"), `${process.pid}\n`);
  assert.equal(s.run(["adopt", "mcp", "stats"]).code, EXIT.locked);
  assert.equal(existsSync(s.path(STATE)), false);
});

const TOKEN = "tok-plaintext-9f3";
const OLD_TOKEN = "old-value";

function withSecret() {
  const s = setup({
    mcp: `servers:
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

const githubEntry = (token: string, url = "https://api.githubcopilot.com/mcp/") => ({ type: "http", url, headers: { Authorization: `Bearer ${token}` } });
const githubOpencode = (token: string) => ({ type: "remote", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: `Bearer ${token}` } });

test("a mismatch on a secret-bearing entry shows the fields with secrets masked; no secret reaches stdout, stderr or state", () => {
  const s = withSecret();
  const url = `https://api.githubcopilot.com/mcp/?key=${TOKEN}`;
  s.put(".claude.json", {
    mcpServers: {
      github: {
        ...githubEntry(OLD_TOKEN, url),
        headers: { Authorization: `Bearer ${OLD_TOKEN}`, "X-Other": `leftover-${TOKEN}` },
      },
    },
  });
  s.put(".config/opencode/opencode.jsonc", { mcp: { github: githubOpencode(TOKEN) } });

  for (const args of [["adopt", "mcp", "github"], ["adopt", "mcp", "github", "--json"]]) {
    const r = s.run(args);
    assert.equal(r.code, EXIT.conflict, r.stderr);
    for (const text of [r.stdout, r.stderr]) {
      assert.equal(text.includes(TOKEN), false);
      assert.equal(text.includes(OLD_TOKEN), false);
    }
    const shown = args.includes("--json") ? (JSON.parse(r.stdout).conflicts as { detail: string }[]).map((c) => c.detail).join("\n") : r.stdout;
    assert.match(shown, /headers\.Authorization: expected "Bearer \*\*\*", found "\*\*\*"/);
    assert.match(shown, /headers\.X-Other: expected \(absent\), found "\*\*\*"/);
    assert.match(shown, /url: expected "https:\/\/api\.githubcopilot\.com\/mcp\/", found "https:\/\/api\.githubcopilot\.com\/mcp\/\?key=\*\*\*"/);
  }
  assert.equal(existsSync(s.path(STATE)), false);
  assert.deepEqual(claudeCalls(s.home), []);
});

test("adopting a secret-bearing entry that matches records hashes only", () => {
  const s = withSecret();
  s.put(".claude.json", { mcpServers: { github: githubEntry(TOKEN) } });
  s.put(".config/opencode/opencode.jsonc", { mcp: { github: githubOpencode(TOKEN) } });
  const r = s.run(["adopt", "mcp", "github"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  for (const text of [r.stdout, r.stderr, s.read(STATE)]) assert.equal(text.includes(TOKEN), false);
  assert.deepEqual(s.state().keys.map((k: { desired: string }) => k.desired), [hashValue(githubEntry(TOKEN)), hashValue(githubOpencode(TOKEN))]);

  const apply = s.run(["apply"]);
  assert.equal(apply.code, EXIT.ok, apply.stderr);
  assert.equal(claudeCalls(s.home).some((c) => c.includes("github")), false);
  assert.equal(JSON.parse(s.read(".config/opencode/opencode.jsonc")).mcp.github.headers.Authorization, `Bearer ${TOKEN}`);
});

test("adopt mcp needs the secrets it renders: a missing name exits 5 and writes nothing", () => {
  const s = withSecret();
  rmSync(s.path(".config/fleet/age.key"));
  s.put(".claude.json", { mcpServers: { github: githubEntry(TOKEN) } });
  const r = s.run(["adopt", "mcp", "github"]);
  assert.equal(r.code, EXIT["needs-secret"]);
  assert.equal(r.stdout.includes(TOKEN) || r.stderr.includes(TOKEN), false);
  assert.equal(existsSync(s.path(STATE)), false);
});

const skill = (name: string) => ({ [`${name}/SKILL.md`]: `---\nname: ${name}\n---\n` });

function withSkills(pick = "core") {
  const src = makeSource({ ...skill("tdd"), ...skill("planning"), ...skill("spare"), ...skill("other") });
  const s = setup({
    skills: `sources:\n  mine:\n    repo: ${src.remote}\n    path: .\n    branch: main\nbundles:\n  core: [tdd, planning]\n  extra: [other]\n`,
    host: `bundles: [${pick}]\n`,
  });
  const sourceDir = (name: string) => join(s.home, ".local/share/fleet/sources/mine", name);
  const link = (name: string) => join(s.home, ".claude/skills", name);
  assert.equal(s.run(["diff"]).code, EXIT.ok);
  return { ...s, sourceDir, link };
}

test("adopt skill records the correct symlink without touching it; the next apply links only the rest", () => {
  const s = withSkills();
  mkdirSync(dirname(s.link("tdd")), { recursive: true });
  symlinkSync(s.sourceDir("tdd"), s.link("tdd"));

  const r = s.run(["adopt", "skill", "tdd"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stdout, /adopted ~\/\.claude\/skills\/tdd/);
  assert.equal(readlinkSync(s.link("tdd")), s.sourceDir("tdd"));
  assert.deepEqual(s.state().links, [{ target: "~/.claude/skills/tdd", source: s.sourceDir("tdd") }]);
  assert.deepEqual(s.state().keys, []);
  assert.equal(existsSync(s.link("planning")), false);

  const { doc } = s.json(["apply"]);
  assert.equal(doc.code, "ok");
  assert.deepEqual(notFleetSkill(doc.created).map((c: { target: string }) => c.target), ["~/.claude/skills/planning"]);
  assert.deepEqual(doc.unchanged, ["~/.claude/skills/tdd"]);
  assert.equal(readlinkSync(s.link("tdd")), s.sourceDir("tdd"));
});

test("adopt skill keeps the links and keys an earlier apply recorded", () => {
  const s = withSkills();
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  rmSync(s.link("planning"));
  symlinkSync(s.sourceDir("planning"), s.link("planning"));
  const before = s.state();
  assert.equal(s.run(["adopt", "skill", "planning"]).code, EXIT.ok);
  assert.deepEqual(s.state().links, before.links);
  assert.equal(s.run(["apply"]).stdout.trim(), "nothing to do");
});

test("adopt skill for a skill outside every picked bundle exits 2 and writes nothing", () => {
  const s = withSkills("core");
  for (const name of ["other", "spare", "nope"]) {
    mkdirSync(dirname(s.link(name)), { recursive: true });
    if (name !== "nope") symlinkSync(s.sourceDir(name), s.link(name));
    const r = s.run(["adopt", "skill", name]);
    assert.equal(r.code, EXIT.invalid, name);
    assert.match(r.stderr, new RegExp(`'${name}'.*not in a bundle this host picks`));
  }
  assert.equal(existsSync(s.path(STATE)), false);
});

test("adopt skill with a symlink elsewhere or a real directory exits 3 and changes nothing", () => {
  const s = withSkills();
  mkdirSync(s.link("tdd"), { recursive: true });
  writeFileSync(join(s.link("tdd"), "SKILL.md"), "mine");
  const elsewhere = join(s.home, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, s.link("planning"));

  const dir = s.run(["adopt", "skill", "tdd"]);
  assert.equal(dir.code, EXIT.conflict);
  assert.match(dir.stdout, /conflict ~\/\.claude\/skills\/tdd: .*is a directory/);
  assert.equal(readFileSync(join(s.link("tdd"), "SKILL.md"), "utf8"), "mine");

  const wrong = s.run(["adopt", "skill", "planning"]);
  assert.equal(wrong.code, EXIT.conflict);
  assert.match(wrong.stdout, new RegExp(`symlink to ${elsewhere}, not to ${s.sourceDir("planning")}`));
  assert.equal(readlinkSync(s.link("planning")), elsewhere);

  assert.equal(existsSync(s.path(STATE)), false);
  assert.equal(s.json(["adopt", "skill", "tdd"]).doc.conflicts[0].kind, "link");
});

test("adopt skill with nothing at the path exits 2: there is nothing to adopt", () => {
  const s = withSkills();
  const r = s.run(["adopt", "skill", "tdd"]);
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /nothing to adopt/);
  assert.equal(existsSync(s.link("tdd")), false);
  assert.equal(existsSync(s.path(STATE)), false);
});

test("adopt with a missing or unknown kind exits 2", () => {
  const s = setup({});
  for (const args of [["adopt"], ["adopt", "mcp"], ["adopt", "thing", "x"]]) {
    const r = s.run(args);
    assert.equal(r.code, EXIT.invalid, args.join(" "));
    assert.match(r.stderr, /usage: fleet adopt mcp\|skill <name>/);
  }
  assert.equal(existsSync(s.path(STATE)), false);
});
