import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentOf, AGENTS, having, skillTargets, SKILL_TARGETS } from "../src/agents/index.ts";
import type { Registered } from "../src/agents/index.ts";
import { leftOutNote, renderFor, takes } from "../src/mcp.ts";
import type { Server } from "../src/mcp.ts";
import { expandTarget } from "../src/plan.ts";
import { declareSettings } from "../src/settings.ts";
import { installFakeClaude, installFakeTool, makeClone, makeHome, makeSource, publish, runFleet } from "./helpers.ts";

/**
 * What every agent in the registry has to satisfy. The suite loops over `AGENTS`, so an agent gets all of it by
 * being registered. The apply tests need a fake binary: one that only prints is installed for each agent, and an
 * agent that sets `needsBinary` has to be given a fake of its own in `FAKES`.
 */

const NODE = "/usr/local/bin/node";
const server = (over: Partial<Server>): Server => ({ name: "conf", command: null, env: {}, transport: null, url: null, headers: {}, only: [], ...over });

const SERVERS = {
  stdio: server({ command: [NODE, "server.js", "--flag"], env: { MODE: "fast" } }),
  http: server({ transport: "http", url: "https://example.com/mcp", headers: { "X-Team": "platform" } }),
  sse: server({ transport: "sse", url: "https://example.com/sse" }),
};

for (const agent of AGENTS) {
  test(`${agent.id}: its identity is complete`, () => {
    assert.match(agent.id, /^[a-z][a-z0-9-]*$/);
    assert.notEqual(agent.name, "");
    assert.match(agent.binary, /^[a-z][a-z0-9-]*$/);
    assert.ok(agent.version.length > 0, "a version argument to print it with");
    assert.ok(agent.homes.length > 0 && agent.homes.every((h) => h.startsWith("~/")));
    assert.ok(agent.binDirs.every((d) => d.startsWith("~/")));
    for (const home of agent.homes) assert.equal(agentOf(home)?.id, agent.id, `${home} is owned by one agent only`);
  });

  if (agent.mcp !== undefined) {
    const mcp = agent.mcp;
    const has = agent as Registered & { mcp: NonNullable<Registered["mcp"]> };
    for (const [kind, s] of Object.entries(SERVERS)) {
      if (!takes(has, s)) {
        test(`${agent.id}: a ${kind} server is not rendered, and the host is told so once`, () => {
          assert.match(leftOutNote(has, [{ ...s, only: [agent.id] }])!, new RegExp(`^${agent.name} does not support ${kind} servers, so conf is left out of ${mcp.file}$`));
          assert.equal(leftOutNote(has, [s]), null, "a server that is not for this agent is not said to be left out");
        });
        continue;
      }
      test(`${agent.id}: a ${kind} server is rendered and read back`, () => {
        const entry = renderFor(has, s, NODE);
        assert.ok(!Object.values(entry).some((v) => (Array.isArray(v) ? v.length === 0 : v !== null && typeof v === "object" && Object.keys(v).length === 0)), "no empty list or map is written");
        const read = mcp.read(entry, "/work");
        assert.notEqual(read, null, "read understands what render made");
        const target = read!.target;
        if (s.command !== null) {
          assert.equal(read!.transport, "stdio");
          assert.equal(target.kind, "stdio");
          if (target.kind === "stdio") {
            assert.deepEqual(target.command, s.command);
            assert.deepEqual(target.env, s.env);
            assert.equal(target.cwd, "/work");
          }
          assert.equal(read!.credentials, false);
        } else {
          assert.equal(target.kind, "network");
          if (target.kind === "network") {
            assert.equal(target.url, s.url);
            assert.deepEqual(target.headers, s.headers);
          }
          assert.equal(read!.credentials, Object.keys(s.headers).length > 0, "headers are credentials");
          assert.equal(read!.transport === "remote" || read!.transport === s.transport, true);
        }
      });
    }

    test(`${agent.id}: an entry that is not its own shape reads as null`, () => {
      assert.equal(mcp.read({}, "/work"), null);
      assert.equal(mcp.read({ type: "nonsense", url: 1 }, "/work"), null);
    });
  }

  if (agent.settings !== undefined) {
    const settings = agent.settings;
    const declare = (path: string) => {
      const map: Record<string, unknown> = {};
      let at = map;
      const segments = path.split(".");
      segments.slice(0, -1).forEach((s) => (at = (at[s] = {}) as Record<string, unknown>));
      at[segments.at(-1)!] = 1;
      const problems: string[] = [];
      const declared = declareSettings(map, agent as Registered & { settings: typeof settings }, "host.yaml", problems);
      return { problems, declared };
    };

    test(`${agent.id}: a denied settings path is refused as it is, below it and above it`, () => {
      for (const denied of settings.denied) {
        assert.equal(declare(denied).problems.length, 1, `${denied} itself`);
        assert.equal(declare(`${denied}.child`).problems.length, 1, `below ${denied}`);
        const parts = denied.split(".");
        for (let n = 1; n < parts.length; n++) assert.equal(declare(parts.slice(0, n).join(".")).problems.length, 1, `above ${denied}`);
      }
      const ok = declare("fleetConformance.allowed");
      assert.deepEqual(ok.problems, []);
      assert.equal(ok.declared.length, 1);
    });
  }

  test(`${agent.id}: its locations are under its own homes, or a directory agents share`, () => {
    const SHARED = ["~/.agents", "~/.gemini/skills", "~/.gemini/AGENTS.md"];
    const own = (path: string, what: string) => {
      assert.ok(path.startsWith("~/"), `${what} ${path} is in ~/ form`);
      assert.equal(agentOf(path)?.id, agent.id, `${what} ${path} is under ${agent.id}'s homes`);
    };
    const readable = (path: string, what: string) => {
      assert.ok(path.startsWith("~/"), `${what} ${path} is in ~/ form`);
      assert.ok(agentOf(path) !== null || SHARED.some((s) => path === s || path.startsWith(`${s}/`)), `${what} ${path} is under some agent's homes or a shared directory`);
    };
    if (agent.settings !== undefined) {
      own(agent.settings.file, "settings file");
      if (agent.settings.alsoLoaded !== undefined) own(agent.settings.alsoLoaded, "older settings file");
    }
    if (agent.mcp !== undefined) own(agent.mcp.file, "MCP file");
    if (agent.instructions !== undefined) {
      own(agent.instructions.files[0]!, "instruction file fleet links into");
      agent.instructions.files.slice(1).forEach((f) => readable(f, "instruction file"));
      agent.instructions.dirs.forEach((d) => own(d, "instruction directory"));
      assert.ok(agent.instructions.setting === null || agent.instructions.setting === agent.settings?.file, "the instructions list is in the settings file");
    }
    if (agent.skills !== undefined) {
      if (agent.skills.target !== null) own(agent.skills.target, "skills target");
      agent.skills.dirs.forEach((d) => readable(d, "skills directory"));
      assert.ok(agent.skills.setting === null || agent.skills.setting === agent.settings?.file, "the skills list is in the settings file");
      assert.ok(agent.skills.target === null || agent.skills.dirs.includes(agent.skills.target), "it reads the directory fleet links into");
    }
  });
}

test("every skills directory fleet links into is one an agent reads", () => {
  for (const dir of SKILL_TARGETS) assert.ok(having("skills").some((a) => a.skills.dirs.includes(dir)), dir);
});

test("an agent that reads another agent's skills has them linked where that agent's are, and one with its own target gets its own", () => {
  for (const agent of having("skills")) {
    const targets = skillTargets([agent]);
    if (agent.skills.target !== null) assert.deepEqual(targets, [agent.skills.target], agent.id);
    else assert.ok(targets.length > 0 && targets.every((dir) => agent.skills.dirs.includes(dir) && SKILL_TARGETS.includes(dir)), agent.id);
  }
});

// ---- apply, then take everything away ----

const FAKES: Record<string, (home: string) => void> = { claude: installFakeClaude };

const CATALOG = `servers:
  conf-stdio:
    command: [node, server.js]
    env:
      MODE: fast
  conf-http:
    transport: http
    url: https://example.com/mcp
  conf-sse:
    transport: sse
    url: https://example.com/sse
`;

const put = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

const present = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

test("apply gives every agent its config, and removing the config leaves no trace of fleet", () => {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  for (const agent of AGENTS) {
    const fake = FAKES[agent.id];
    if (fake !== undefined) fake(home);
    else {
      assert.equal(agent.mcp?.needsBinary, undefined, `${agent.id} writes through its binary, so give it a fake in FAKES`);
      installFakeTool(home, agent.binary, { stdout: "1.0.0" });
    }
  }
  const source = makeSource({ "skills/conf-skill/SKILL.md": "---\nname: conf-skill\ndescription: A skill for the conformance test.\n---\n" });
  put(clone, "catalog/mcp.yaml", CATALOG);
  put(clone, "catalog/skills.yaml", `sources:\n  mine:\n    repo: ${source.remote}\n    commit: ${source.first}\n    track: main\n    path: skills\nbundles:\n  conf: [conf-skill]\n`);
  put(clone, "config/AGENTS.md", "Instructions.\n");

  const targets = [...new Set(having("instructions").map((a) => a.instructions.files[0]!))];
  const settings = having("settings").map((a) => `  ${a.id}:\n    fleetConformance: true\n`).join("");
  put(clone, "hosts/_defaults.yaml", `bundles: [conf]\nmcp:\n  include: [conf-stdio, conf-http, conf-sse]\n${settings === "" ? "" : `settings:\n${settings}`}files:\n${targets.map((t) => `  - { source: config/AGENTS.md, target: ${t} }\n`).join("")}`);
  put(clone, "hosts/laptop.yaml", "{}\n");
  publish(clone);

  // Something of the user's in every file fleet merges into: it must survive.
  const merged = [...new Set([...having("settings").map((a) => a.settings.file), ...having("mcp").map((a) => a.mcp.file)])];
  for (const file of merged) put(home, file.slice(2), JSON.stringify({ handMade: { keep: true }, ...(having("mcp").find((a) => a.mcp.file === file) ? { [having("mcp").find((a) => a.mcp.file === file)!.mcp.key]: { mine: { type: "http", url: "https://mine.example.com" } } } : {}) }));

  const run = (...args: string[]) => runFleet(clone, args, { home });
  const first = run("apply");
  assert.equal(first.code, 0, first.stderr);
  // An agent that cannot take a transport leaves those servers out and says so in a warning, which is not a change.
  const changes = (stdout: string): string => stdout.split("\n").filter((l) => !l.startsWith("warning ")).join("\n").trim();
  assert.equal(changes(run("diff").stdout), "nothing to do");

  for (const agent of having("mcp")) {
    const doc = JSON.parse(readFileSync(expandTarget(agent.mcp.file, home), "utf8"));
    for (const name of ["conf-stdio", "conf-http", "conf-sse"]) {
      const left = name === "conf-sse" && !takes(agent as Registered & { mcp: NonNullable<Registered["mcp"]> }, SERVERS.sse);
      assert.equal(doc[agent.mcp.key][name] === undefined, left, `${agent.id} ${left ? "leaves out" : "has"} ${name}`);
    }
  }
  for (const target of targets) assert.ok(present(expandTarget(target, home)), `${target} is linked`);
  assert.ok(SKILL_TARGETS.every((dir) => present(expandTarget(`${dir}/conf-skill`, home))), "the skill is linked");

  put(clone, "hosts/_defaults.yaml", "{}\n");
  publish(clone, "take everything away");
  const second = run("apply");
  assert.equal(second.code, 0, second.stderr);
  assert.equal(changes(run("diff").stdout), "nothing to do");

  const state = JSON.parse(readFileSync(join(home, ".local/state/fleet/applied.json"), "utf8"));
  assert.deepEqual(state.keys, [], "no owned key is recorded");
  assert.deepEqual(state.links, [], "no link is recorded");
  for (const target of targets) assert.equal(present(expandTarget(target, home)), false, `${target} is gone`);
  assert.equal(SKILL_TARGETS.some((dir) => present(expandTarget(`${dir}/conf-skill`, home))), false, "the skill link is gone");
  for (const file of merged) {
    const text = readFileSync(expandTarget(file, home), "utf8");
    assert.doesNotMatch(text, /conf-(stdio|http|sse)|fleetConformance/, `${file} holds nothing of fleet's`);
    const doc = JSON.parse(text);
    assert.deepEqual(doc.handMade, { keep: true }, `${file} keeps what was there`);
  }
  for (const agent of having("mcp")) {
    const doc = JSON.parse(readFileSync(expandTarget(agent.mcp.file, home), "utf8"));
    assert.deepEqual(Object.keys(doc[agent.mcp.key]), ["mine"], `${agent.id}'s own server is left alone`);
  }
  assert.equal(existsSync(join(home, "ssh-calls.log")), false);
});
