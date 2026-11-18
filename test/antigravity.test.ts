import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { antigravity as agy } from "../src/agents/antigravity.ts";
import { FAKE_VERSIONS, fakeTimer, installFakeClaude, installFakeTool, installStatusTools, makeClone, makeHome, publish, removeAgent, runFleet } from "./helpers.ts";

/** What is particular to Antigravity CLI: the shape of its files, and its refusal of SSE. The conformance suite covers the rest. */

const put = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

const CATALOG = `servers:
  docs:
    command: [node, docs.js]
    env:
      MODE: fast
  tracker:
    transport: http
    url: https://tracker.example.com/mcp
    headers:
      X-Team: platform
  events:
    transport: sse
    url: https://events.example.com/sse
  more-events:
    transport: sse
    url: https://more.example.com/sse
`;

function world(catalog = CATALOG, withAgy = true) {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  if (!withAgy) removeAgent(home, agy.binary);
  else installFakeTool(home, "agy", { stdout: "1.5.10", only: ["--version"] });
  installFakeClaude(home);
  installFakeTool(home, "opencode", { stdout: FAKE_VERSIONS.opencode, only: ["--version"] });
  put(clone, "catalog/mcp.yaml", catalog);
  put(clone, "config/AGENTS.md", "Shared.\n");
  put(clone, "hosts/_defaults.yaml", `mcp:\n  include: [docs, tracker, events, more-events]\nfiles:\n  - { source: config/AGENTS.md, target: ~/.gemini/GEMINI.md }\n  - { source: config/AGENTS.md, target: ~/.claude/CLAUDE.md }\n`);
  put(clone, "hosts/laptop.yaml", "{}\n");
  publish(clone);
  return { clone, home, run: (...args: string[]) => runFleet(clone, args, { home }) };
}

test("antigravity: servers are written the way its docs show them, and without a type key", () => {
  const w = world();
  assert.equal(w.run("apply").code, 0);
  const doc = JSON.parse(readFileSync(join(w.home, ".gemini/config/mcp_config.json"), "utf8"));
  assert.deepEqual(doc.mcpServers.docs, { command: "node", args: ["docs.js"], env: { MODE: "fast" } });
  assert.deepEqual(doc.mcpServers.tracker, { serverUrl: "https://tracker.example.com/mcp", headers: { "X-Team": "platform" } });
  assert.equal(readFileSync(join(w.home, ".gemini/GEMINI.md"), "utf8"), "Shared.\n");
});

test("antigravity: an sse server for every agent is left out of its file, and the host is told once in one line", () => {
  const w = world();
  const diff = w.run("diff");
  assert.match(diff.stdout, /^warning Antigravity CLI does not support sse servers, so events, more-events are left out of ~\/\.gemini\/config\/mcp_config\.json$/m);
  assert.equal(diff.stdout.match(/Antigravity/g)?.length, 1);
  assert.doesNotMatch(diff.stdout, /create ~\/\.gemini\/config\/mcp_config\.json mcpServers\.(events|more-events)/);
  assert.match(diff.stdout, /create ~\/\.claude\.json mcpServers\.events/, "the agents that can take it still get it");
  const apply = w.run("apply");
  assert.match(apply.stdout, /^warning Antigravity CLI does not support sse servers/m);
  const doc = JSON.parse(readFileSync(join(w.home, ".gemini/config/mcp_config.json"), "utf8"));
  assert.deepEqual(Object.keys(doc.mcpServers), ["docs", "tracker"]);
});

test("antigravity: an sse server limited to it is a problem, and so is one whose list names it", () => {
  for (const only of ["[antigravity]", "[claude, antigravity]"]) {
    const w = world(CATALOG.replace("    url: https://events.example.com/sse\n", `    url: https://events.example.com/sse\n    only: ${only}\n`));
    const r = w.run("diff");
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /server 'events': 'only' names antigravity, which does not support sse servers/);
  }
  const w = world(CATALOG.replace("    url: https://events.example.com/sse\n", "    url: https://events.example.com/sse\n    only: [claude, opencode]\n"));
  assert.equal(w.run("diff").code, 0, "a list that leaves it out is fine");
});

test("antigravity: its settings keep their mode, and the keys it owns itself cannot be declared", () => {
  const w = world();
  put(w.clone, "hosts/_defaults.yaml", `settings:\n  antigravity:\n    verbosity: high\n    notifications: true\n`);
  publish(w.clone);
  assert.equal(w.run("apply").code, 0);
  const file = join(w.home, ".gemini/antigravity-cli/settings.json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { verbosity: "high", notifications: true });
  assert.equal(statSync(file).mode & 0o777, 0o600);

  put(w.clone, "hosts/_defaults.yaml", `settings:\n  antigravity:\n    trustedWorkspaces: [/tmp]\n`);
  publish(w.clone);
  const r = w.run("diff");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /trustedWorkspaces/);
});

test("antigravity: a host without it gets nothing under ~/.gemini and no word about it", () => {
  const w = world(CATALOG, false);
  put(w.clone, "hosts/_defaults.yaml", `mcp:\n  include: [docs, tracker, events]\nfiles:\n  - { source: config/AGENTS.md, target: ~/.gemini/GEMINI.md }\n  - { source: config/AGENTS.md, target: ~/.claude/CLAUDE.md }\nsettings:\n  claude:\n    env:\n      A: b\n`);
  publish(w.clone);
  installStatusTools(w.home);
  fakeTimer(w.home, "active");
  const out = [w.run("diff"), w.run("apply"), w.run("diff"), w.run("status"), w.run("status", "--json"), w.run("context", "--json")];
  for (const r of out) assert.doesNotMatch(r.stdout + r.stderr, /antigravity|agy\b|gemini/i);
  assert.equal(existsSync(join(w.home, ".gemini")), false);
  assert.equal(out[0]!.code, 0);
});

test("antigravity: a disabled server is not counted, and both url spellings are read", () => {
  assert.equal(agy.mcp!.skip!({ command: "x", disabled: true }), true);
  assert.equal(agy.mcp!.skip!({ command: "x", disabled: false }), false);
  assert.equal(agy.mcp!.read({ url: "https://x.example.com/mcp" }, "/w")?.transport, "http");
  assert.equal(agy.mcp!.read({ serverUrl: "https://x.example.com/mcp", headers: { A: "b" } }, "/w")?.credentials, true);
});

test("antigravity: a skill without a description is not offered, as its docs require one", () => {
  assert.equal(agy.skills!.hidden!({ name: "x" }), true);
  assert.equal(agy.skills!.hidden!({ name: "x", description: "Does x." }), false);
});

test("antigravity: a host that has it shows it in status, a host that does not has no word of it, and one that applied for it earlier is told it is gone", () => {
  const w = world();
  installStatusTools(w.home);
  installFakeTool(w.home, "agy", { stdout: "1.5.10", only: ["--version"] });
  const doc = JSON.parse(w.run("status", "--json").stdout);
  assert.deepEqual(doc.agents.find((a: { id: string }) => a.id === "antigravity"), { id: "antigravity", version: "1.5.10", active: true, pinned: false });
  assert.equal(doc.tools.antigravity, "1.5.10");
  assert.match(w.run("status").stdout, /^agents: claude 2\.1\.4, opencode 1\.4\.2, antigravity 1\.5\.10$/m);

  assert.equal(w.run("apply").code, 0);
  removeAgent(w.home, agy.binary);
  const gone = w.run("status");
  assert.match(gone.stdout, /\(antigravity not installed\)/);
  assert.match(gone.stderr, /Antigravity CLI: not installed, its config is left as is/);
  assert.equal(existsSync(join(w.home, ".gemini/config/mcp_config.json")), true, "what was applied stays");
});
