import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENTS, agentById, hostAgents, leftAlone, skillTargets, SKILL_TARGETS } from "../src/agents/index.ts";
import type { Agent } from "../src/agents/index.ts";
import { loadConfig, InvalidConfigError } from "../src/config.ts";
import { detectAgents } from "../src/hostagents.ts";
import { FAKE_VERSIONS, NODE, fakeTimer, installFakeClaude, installFakeTool, installStatusTools, makeClone, makeHome, makeSource, publish, removeAgent, runFleet, skipIfSystemWide, writeExecutable } from "./helpers.ts";

/** Agents per host: a host gets the agents installed on it, unless its host file names them. */

const claude = agentById("claude")!;
const opencode = agentById("opencode")!;

const put = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

const SERVERS = `servers:
  everywhere:
    transport: http
    url: https://a.example.com/mcp
  code-only:
    transport: http
    url: https://b.example.com/mcp
    only: [opencode]
`;

const DEFAULTS = `bundles: [core]
mcp:
  include: [everywhere, code-only]
settings:
  claude:
    env:
      A: b
  opencode:
    share: disabled
files:
  - { source: config/AGENTS.md, target: ~/.claude/CLAUDE.md }
  - { source: config/AGENTS.md, target: ~/.config/opencode/AGENTS.md }
  - { source: config/notes.md, target: ~/notes.md }
`;

/** A config repo and a host with a fake `claude` and a fake `opencode`, a skill, and files for both agents and for neither. */
function world(host = "{}\n", defaults = DEFAULTS) {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  const source = makeSource({ "skills/review/SKILL.md": "---\nname: review\ndescription: Reviews.\n---\n" });
  put(clone, "catalog/mcp.yaml", SERVERS);
  put(clone, "catalog/skills.yaml", `sources:\n  mine:\n    repo: ${source.remote}\n    commit: ${source.first}\n    track: main\n    path: skills\nbundles:\n  core: [review]\n`);
  put(clone, "config/AGENTS.md", "Shared.\n");
  put(clone, "config/notes.md", "Notes.\n");
  put(clone, "hosts/_defaults.yaml", defaults);
  put(clone, "hosts/laptop.yaml", host);
  publish(clone);
  installFakeClaude(home);
  installFakeTool(home, "opencode", { stdout: FAKE_VERSIONS.opencode, only: ["--version"] });
  const run = (...args: string[]) => (publish(clone), runFleet(clone, args, { home }));
  const state = () => JSON.parse(readFileSync(join(home, ".local/state/fleet/applied.json"), "utf8")) as { keys: { file: string; path: string }[]; links: { target: string }[] };
  return { clone, home, run, state, edit: (rel: string, text: string) => put(clone, rel, text), exists: (rel: string) => existsSync(join(home, rel)) || isLink(join(home, rel)) };
}

const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

const NOT_INSTALLED = (name: string) => new RegExp(`warning ${name}: not installed, its config is left as is\\. Install it, or pin \`agents:\``);

// ---- resolution, in the small ----

test("hostAgents is the pin when there is one, else the detected agents, in registry order", () => {
  assert.deepEqual(hostAgents(null, [opencode, claude]).map((a) => a.id), ["claude", "opencode"]);
  assert.deepEqual(hostAgents(null, [opencode]).map((a) => a.id), ["opencode"]);
  assert.deepEqual(hostAgents(["opencode"], [claude]).map((a) => a.id), ["opencode"], "the pin wins, installed or not");
  assert.deepEqual(hostAgents(["opencode", "claude"], []).map((a) => a.id), ["claude", "opencode"]);
});

test("detection finds a binary in the Node install's directory, where npm -g puts agent CLIs", () => {
  const home = makeHome();
  for (const agent of AGENTS) removeAgent(home, agent.binary);
  assert.deepEqual(detectAgents(home, { PATH: "" }), []);
  const bin = join(dirname(NODE), claude.binary);
  writeExecutable(bin, "#!/bin/sh\nexit 0\n");
  try {
    assert.deepEqual(detectAgents(home, { PATH: "" }).map((a) => a.id), ["claude"]);
  } finally {
    rmSync(bin);
  }
});

test("a skill is linked into the directory of each agent on the host that has its own, and into the one opencode reads, once", () => {
  const other: Agent = { ...claude, id: "other", name: "Other", binary: "other", skills: { target: "~/.other/skills", dirs: ["~/.other/skills"], setting: null } };
  assert.deepEqual(SKILL_TARGETS, ["~/.claude/skills"]);
  assert.deepEqual(skillTargets([claude]), ["~/.claude/skills"]);
  assert.deepEqual(skillTargets([opencode]), ["~/.claude/skills"], "opencode reads Claude's directory, so that is where its skills go");
  assert.deepEqual(skillTargets([claude, opencode]), ["~/.claude/skills"], "one set for the two");
  assert.deepEqual(skillTargets([opencode, other]), ["~/.claude/skills", "~/.other/skills"], "an agent with its own target adds a directory");
  assert.deepEqual(skillTargets([]), []);
});

test("a path is left alone when its agent is not on the host, unless an agent that is reads it as a skill directory", () => {
  assert.equal(leftAlone("~/.claude/settings.json", [opencode]), true);
  assert.equal(leftAlone("~/.claude.json", [opencode]), true);
  assert.equal(leftAlone("~/.claude/skills/review", [opencode]), false, "opencode reads it");
  assert.equal(leftAlone("~/.claude/skills/review", []), true);
  assert.equal(leftAlone("~/.config/opencode/opencode.jsonc", [claude]), true);
  assert.equal(leftAlone("~/notes.md", []), false, "no agent owns it");
  assert.equal(leftAlone("~/.claude/settings.json", [claude]), false);
});

test("loadConfig drops config for an agent the host does not get only when it is given the agents, and checks all of it otherwise", () => {
  const w = world();
  const load = (agents?: Agent[]) => loadConfig(w.clone, "laptop", { home: w.home, sources: "none", ...(agents ? { agents } : {}) });
  const files = (agents?: Agent[]) => load(agents).files.map((f) => f.target).sort();
  const whole = load();
  assert.deepEqual(whole.agents.map((a) => a.id), ["claude", "opencode"]);
  assert.equal(whole.keys.some((k) => k.file === "~/.config/opencode/opencode.jsonc"), true);
  assert.deepEqual(load([claude, opencode]).keys, whole.keys, "every agent installed: the same as unfiltered");

  const onlyClaude = load([claude]);
  assert.deepEqual(onlyClaude.agents.map((a) => a.id), ["claude"]);
  assert.equal(onlyClaude.keys.some((k) => k.file === "~/.config/opencode/opencode.jsonc"), false);
  assert.equal(files([claude]).includes("~/.config/opencode/AGENTS.md"), false);
  assert.equal(files([claude]).includes("~/notes.md"), true, "a path no agent owns always applies");
  assert.equal(load([]).keys.length, 0);
});

// ---- pin ----

test("agents: names the agents the host gets; a host file's list replaces the defaults', and an unknown id is a problem", () => {
  const w = world("agents: [opencode]\n", `${DEFAULTS}agents: [claude]\n`);
  const config = loadConfig(w.clone, "laptop", { home: w.home, sources: "none", agents: [claude] });
  assert.deepEqual(config.pin, ["opencode"]);
  assert.deepEqual(config.agents.map((a) => a.id), ["opencode"]);

  for (const [text, message] of [
    ["agents: [codex]\n", /hosts\/laptop\.yaml: 'agents' names 'codex', which fleet does not know \(claude, opencode\)/],
    ["agents: claude\n", /'agents' must be a list of claude, opencode/],
    ["agents: []\n", /'agents' must be a list of claude, opencode/],
  ] as const) {
    w.edit("hosts/laptop.yaml", text);
    for (const args of [["diff"], ["apply"]]) {
      const r = w.run(...args);
      assert.equal(r.code, 2, r.stdout);
      assert.match(r.stderr, message);
    }
  }
  assert.throws(() => loadConfig(w.clone, "laptop", { home: w.home, sources: "none" }), InvalidConfigError, "a validation without agents finds it too");
});

// ---- apply ----

test("with only claude installed, apply writes nothing under ~/.config/opencode and nothing anywhere mentions opencode, though the config names it", { skip: skipIfSystemWide("opencode") }, () => {
  const w = world();
  installStatusTools(w.home);
  removeAgent(w.home, "opencode");
  const r = w.run("apply");
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /not installed/, "an agent this host never had is not worth a word");
  assert.equal(w.exists(".config/opencode"), false);
  assert.equal(w.exists(".claude/CLAUDE.md"), true);
  assert.equal(w.exists("notes.md"), true);
  assert.equal(JSON.parse(readFileSync(join(w.home, ".claude.json"), "utf8")).mcpServers.everywhere.url, "https://a.example.com/mcp");
  assert.equal(w.state().keys.some((k) => k.file.startsWith("~/.config/opencode")), false);
  const diff = w.run("diff");
  assert.doesNotMatch(diff.stdout + diff.stderr, /not installed/);
  assert.deepEqual(JSON.parse(w.run("diff", "--json").stdout).warnings ?? [], []);
  const status = w.run("status");
  assert.doesNotMatch(status.stderr, /not installed/);
  assert.match(status.stdout, /^agents: claude 2\.1\.4 \(opencode not installed\)$/m, "the agents line still says what is installed");
  assert.deepEqual(JSON.parse(w.run("status", "--json").stdout).notInstalled, []);
});

test("installing opencode makes the next apply set it up", { skip: skipIfSystemWide("opencode") }, () => {
  const w = world();
  removeAgent(w.home, "opencode");
  assert.equal(w.run("apply").code, 0);
  assert.equal(w.exists(".config/opencode"), false);
  installFakeTool(w.home, "opencode", { stdout: FAKE_VERSIONS.opencode, only: ["--version"] });
  assert.match(w.run("diff").stdout, /create ~\/\.config\/opencode\/opencode\.jsonc mcp\.everywhere/);
  const r = w.run("apply");
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /not installed/);
  const text = readFileSync(join(w.home, ".config/opencode/opencode.jsonc"), "utf8");
  assert.match(text, /"share": "disabled"/);
  assert.match(text, /code-only/);
  assert.equal(isLink(join(w.home, ".config/opencode/AGENTS.md")), true);
  assert.equal(w.run("diff").stdout.trim(), "nothing to do");
});

test("removing a binary leaves its files and applied state alone, with the warning, and they are cleaned up once it is back", { skip: skipIfSystemWide("opencode") }, () => {
  const w = world();
  assert.equal(w.run("apply").code, 0);
  const file = join(w.home, ".config/opencode/opencode.jsonc");
  const before = readFileSync(file, "utf8");
  const stateBefore = w.state();
  assert.equal(stateBefore.keys.some((k) => k.file === "~/.config/opencode/opencode.jsonc"), true);

  removeAgent(w.home, "opencode");
  // Everything of opencode's leaves the config: the settings, the servers that are only for it and its instructions link.
  w.edit("catalog/mcp.yaml", SERVERS.replace("code-only", "gone"));
  w.edit("hosts/_defaults.yaml", "bundles: [core]\nmcp:\n  include: [everywhere]\nsettings:\n  claude:\n    env:\n      A: b\nfiles:\n  - { source: config/AGENTS.md, target: ~/.claude/CLAUDE.md }\n  - { source: config/notes.md, target: ~/notes.md }\n");
  const diff = w.run("diff");
  assert.equal(diff.code, 0, diff.stderr);
  assert.doesNotMatch(diff.stdout, /remove /, "nothing is planned for removal");
  assert.match(diff.stdout, NOT_INSTALLED("opencode"), "it is said, because applied state is held for opencode");
  assert.deepEqual(JSON.parse(w.run("diff", "--json").stdout).warnings, ["opencode: not installed, its config is left as is. Install it, or pin `agents:`"]);
  const r = w.run("apply");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, NOT_INSTALLED("opencode"));
  assert.equal(readFileSync(file, "utf8"), before, "the file is as it was");
  assert.equal(isLink(join(w.home, ".config/opencode/AGENTS.md")), true, "the link is still there");
  assert.deepEqual(w.state().keys.filter((k) => k.file.startsWith("~/.config/opencode")), stateBefore.keys.filter((k) => k.file.startsWith("~/.config/opencode")), "the applied state keeps what it had");
  assert.deepEqual(w.state().links.filter((l) => l.target.startsWith("~/.config/opencode")), stateBefore.links.filter((l) => l.target.startsWith("~/.config/opencode")));

  installFakeTool(w.home, "opencode", { stdout: FAKE_VERSIONS.opencode, only: ["--version"] });
  const back = w.run("apply");
  assert.equal(back.code, 0, back.stderr);
  assert.match(back.stdout, /removed ~\/\.config\/opencode\/AGENTS\.md/, "with opencode back, removal cleans up");
  assert.doesNotMatch(readFileSync(file, "utf8"), /code-only|share/);
  assert.equal(isLink(join(w.home, ".config/opencode/AGENTS.md")), false);
});

test("agents: [opencode] overrides detection: claude's config is left alone with no warning, and a pinned agent that is missing is still set up", { skip: skipIfSystemWide("opencode", "claude") }, () => {
  const w = world("agents: [opencode]\n");
  const r = w.run("apply");
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /not installed/, "claude is installed and left out on purpose; nothing to say");
  assert.equal(w.exists(".claude.json"), false);
  assert.equal(w.exists(".claude/settings.json"), false);
  assert.equal(w.exists(".claude/CLAUDE.md"), false);
  assert.equal(w.exists(".config/opencode/opencode.jsonc"), true);

  removeAgent(w.home, "opencode");
  w.edit("hosts/laptop.yaml", "agents: [opencode]\nsettings:\n  opencode:\n    autoupdate: false\n");
  const again = w.run("apply");
  assert.equal(again.code, 0, again.stderr);
  assert.match(readFileSync(join(w.home, ".config/opencode/opencode.jsonc"), "utf8"), /"autoupdate": false/, "the binary is gone and its settings are still written");
});

test("a host that names claude and opencode gets both, installed or not, and a host that pins claude out leaves what it applied before", { skip: skipIfSystemWide("opencode", "claude") }, () => {
  const w = world();
  assert.equal(w.run("apply").code, 0);
  const settings = readFileSync(join(w.home, ".claude/settings.json"), "utf8");
  w.edit("hosts/laptop.yaml", "agents: [opencode]\n");
  w.edit("hosts/_defaults.yaml", "bundles: [core]\nmcp:\n  include: [code-only]\n");
  const r = w.run("apply");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(join(w.home, ".claude/settings.json"), "utf8"), settings, "claude is pinned out, so what it has is left alone");
  assert.equal(w.state().keys.some((k) => k.file === "~/.claude/settings.json"), true);
});

// ---- skills ----

test("a skill is linked while any agent that reads its directory is on the host", { skip: skipIfSystemWide("opencode", "claude") }, () => {
  const w = world();
  removeAgent(w.home, "claude");
  assert.equal(w.run("apply").code, 0);
  assert.equal(isLink(join(w.home, ".claude/skills/review")), true, "opencode reads it");

  removeAgent(w.home, "opencode");
  const r = w.run("apply");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(isLink(join(w.home, ".claude/skills/review")), true, "with no agent left it is left alone, not removed");
  assert.match(r.stdout, NOT_INSTALLED("Claude Code"));
});

test("a host with neither agent gets no skill link, and an upgrade with both changes no link", { skip: skipIfSystemWide("opencode", "claude") }, () => {
  const w = world();
  removeAgent(w.home, "claude");
  removeAgent(w.home, "opencode");
  assert.equal(w.run("apply").code, 0);
  assert.equal(w.exists(".claude/skills"), false);
  installFakeClaude(w.home);
  installFakeTool(w.home, "opencode", { stdout: FAKE_VERSIONS.opencode, only: ["--version"] });
  assert.equal(w.run("apply").code, 0);
  assert.equal(isLink(join(w.home, ".claude/skills/review")), true);
  assert.equal(w.run("diff").stdout.trim(), "nothing to do");
});

// ---- status, doctor, context ----

test("status text and JSON name the host's agents, and `tools` is as it was", { skip: skipIfSystemWide("opencode") }, () => {
  const w = world();
  installStatusTools(w.home);
  assert.equal(w.run("apply").code, 0);
  const both = JSON.parse(w.run("status", "--json").stdout);
  assert.deepEqual(both.agents, [
    { id: "claude", version: FAKE_VERSIONS.claude, active: true, pinned: false },
    { id: "opencode", version: FAKE_VERSIONS.opencode, active: true, pinned: false },
  ]);
  assert.equal(both.tools.opencode, FAKE_VERSIONS.opencode);
  assert.deepEqual(both.notInstalled, []);
  assert.match(w.run("status").stdout, /^agents: claude 2\.1\.4, opencode 1\.4\.2$/m);

  removeAgent(w.home, "opencode");
  const one = JSON.parse(w.run("status", "--json").stdout);
  assert.deepEqual(one.agents, [
    { id: "claude", version: FAKE_VERSIONS.claude, active: true, pinned: false },
    { id: "opencode", version: null, active: false, pinned: false },
  ]);
  assert.equal(one.tools.opencode, null);
  assert.deepEqual(one.notInstalled, ["opencode"], "ids, so the reader words it itself; opencode was applied before, so it is named");
  const text = w.run("status");
  assert.match(text.stdout, /^agents: claude 2\.1\.4 \(opencode not installed\)$/m);
  assert.match(text.stderr, /fleet: opencode: not installed, its config is left as is\. Install it, or pin `agents:`/, "the warning is loud in status too");

  w.edit("hosts/laptop.yaml", "agents: [claude, opencode]\n");
  publish(w.clone);
  const pinned = JSON.parse(w.run("status", "--json").stdout);
  assert.deepEqual(pinned.agents.map((a: { id: string; active: boolean; pinned: boolean }) => [a.id, a.active, a.pinned]), [["claude", true, true], ["opencode", true, true]]);
  assert.deepEqual(pinned.notInstalled, []);
  assert.match(w.run("status").stdout, /^agents: claude 2\.1\.4, opencode not installed \(pinned\)$/m);

  w.edit("hosts/laptop.yaml", "agents: [claude]\n");
  installFakeTool(w.home, "opencode", { stdout: FAKE_VERSIONS.opencode, only: ["--version"] });
  assert.match(w.run("status").stdout, /^agents: claude 2\.1\.4 \(pinned\) \(opencode pinned out\)$/m);
});

test("fleet context lists only the agents the host has", { skip: skipIfSystemWide("opencode") }, () => {
  const w = world();
  assert.deepEqual(JSON.parse(w.run("context", "--json").stdout).agents.map((a: { agent: string }) => a.agent), ["claude", "opencode"]);
  removeAgent(w.home, "opencode");
  assert.deepEqual(JSON.parse(w.run("context", "--json").stdout).agents.map((a: { agent: string }) => a.agent), ["claude"]);
  assert.doesNotMatch(w.run("context").stdout, /opencode/);
});

test("doctor leaves out the servers of an agent the host does not have", { skip: skipIfSystemWide("opencode") }, () => {
  const w = world();
  removeAgent(w.home, "opencode");
  // The timer check asks the OS scheduler; a running one keeps the exit code about the servers.
  fakeTimer(w.home, "active");
  w.edit("catalog/mcp.yaml", "servers:\n  only-for-opencode:\n    transport: http\n    url: http://127.0.0.1:9/mcp\n    only: [opencode]\n");
  w.edit("hosts/_defaults.yaml", "mcp:\n  include: [only-for-opencode]\n");
  const r = w.run("doctor", "--json");
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).servers, []);
});

// ---- init ----

test("the files fleet validates for push are not filtered: a config naming an agent the machine lacks is still checked in full", () => {
  const w = world();
  w.edit("catalog/mcp.yaml", SERVERS.replace("only: [opencode]", "only: [opencode, nothing-like-it]"));
  assert.throws(() => loadConfig(w.clone, "laptop", { home: w.home, sources: "none" }), InvalidConfigError);
  assert.throws(() => loadConfig(w.clone, "laptop", { home: w.home, sources: "none", agents: [] }), InvalidConfigError, "and when filtering");
});
