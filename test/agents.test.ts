import { test } from "node:test";
import assert from "node:assert/strict";
import { agentById, agentOf, AGENT_IDS, AGENTS, having, isAgentId, mcpEntryOf, mergedFiles, sayAgents, writtenByBinary } from "../src/agents/index.ts";
import type { Agent } from "../src/agents/index.ts";
import { onlyProblem } from "../src/mcp.ts";
import { declareSettings, settingsAgent } from "../src/settings.ts";

/** An agent that supports almost nothing: no settings file, no MCP servers, no skills. */
const stub: Agent<"stub"> = {
  id: "stub",
  name: "Stub Agent",
  binary: "stub",
  binDirs: ["~/.stub/bin"],
  version: ["-v"],
  homes: ["~/.stub"],
  instructions: { files: ["~/.stub/RULES.md"], dirs: [], setting: null },
};

/** An agent with a settings file that denies a nested path. */
const nested: Agent<"nested"> = {
  id: "nested",
  name: "Nested",
  binary: "nested",
  binDirs: [],
  version: ["--version"],
  homes: ["~/.nested"],
  settings: { file: "~/.nested/config.json", denied: ["ui.theme", "token"] },
};

const registry = [...AGENTS, stub, nested] as const;

test("the registry lists claude, opencode, then antigravity, and every part of them is reachable by id", () => {
  assert.deepEqual(AGENT_IDS, ["claude", "opencode", "antigravity"]);
  assert.equal(agentById("opencode")?.name, "opencode");
  assert.equal(agentById("nope"), undefined);
  assert.equal(isAgentId("claude"), true);
  assert.equal(isAgentId("stub"), false);
});

test("agentOf finds the agent whose home holds a path, and a prefix of a name is not inside it", () => {
  assert.equal(agentOf("~/.claude/skills/x")?.id, "claude");
  assert.equal(agentOf("~/.claude.json")?.id, "claude");
  assert.equal(agentOf("~/.claude")?.id, "claude");
  assert.equal(agentOf("~/.claude-other/x"), null);
  assert.equal(agentOf("~/.config/opencode/opencode.jsonc")?.id, "opencode");
  assert.equal(agentOf("~/.config/opencode"), agentOf("~/.config/opencode/AGENTS.md"));
  assert.equal(agentOf("~/.config/other"), null);
  assert.equal(agentOf("~/.stub/RULES.md", registry)?.id, "stub");
});

test("an `only` list names agents that can be given MCP servers, and the message is made from the registry", () => {
  assert.equal(onlyProblem(undefined), null);
  assert.equal(onlyProblem(["claude"]), null);
  assert.equal(onlyProblem(["claude", "opencode", "antigravity"]), null);
  assert.equal(onlyProblem([]), "'only' must be a list of claude, opencode, antigravity");
  assert.equal(onlyProblem("claude"), "'only' must be a list of claude, opencode, antigravity");
  assert.equal(onlyProblem(["gemini"]), "'only' must be a list of claude, opencode, antigravity");
});

test("`only` refuses an agent that has no MCP servers to give", () => {
  assert.equal(onlyProblem(["stub"], registry), "'only' names stub, which fleet cannot give MCP servers");
  assert.equal(onlyProblem(["claude", "stub"], registry), "'only' names stub, which fleet cannot give MCP servers");
  assert.equal(onlyProblem(["claude"], registry), null);
  assert.equal(onlyProblem(["gemini"], registry), "'only' must be a list of claude, opencode, antigravity", "the list leaves out the agents that cannot");
});

test("`settings.<agent>` refuses an agent with no settings file, and an agent fleet does not know", () => {
  assert.equal(settingsAgent("stub", registry), "'settings.stub': Stub Agent has no settings file fleet can merge");
  assert.equal(settingsAgent("gemini", registry), "unknown key 'settings.gemini'");
  assert.equal(typeof settingsAgent("claude"), "object");
  assert.equal(settingsAgent("stub"), "unknown key 'settings.stub'", "the real registry does not hold the stub");
});

test("a declared settings path is refused when it equals a denied path, sits below it or sits above it", () => {
  const declare = (map: Record<string, unknown>) => {
    const problems: string[] = [];
    const declared = declareSettings(map, nested as Agent & { settings: NonNullable<Agent["settings"]> }, "host.yaml", problems);
    return { problems, declared };
  };
  assert.deepEqual(declare({ ui: { theme: "dark" } }).problems, ["host.yaml: settings.nested.ui.theme: not allowed, fleet never owns 'ui.theme'"]);
  assert.match(declare({ ui: { theme: { name: "x" } } }).problems[0]!, /fleet never owns 'ui\.theme'/, "below");
  assert.match(declare({ ui: "all" }).problems[0]!, /settings\.nested\.ui: .*holds 'ui\.theme'/, "above");
  assert.match(declare({ token: "x" }).problems[0]!, /fleet never owns 'token'/);
  assert.match(declare({ token: { a: 1 } }).problems[0]!, /fleet never owns 'token'/);
  assert.deepEqual(declare({ ui: { font: "mono" }, tokens: 1 }).problems, [], "a sibling and a name that only starts the same are allowed");
});

test("the denied keys that were top-level keys keep their effect", () => {
  const claude = settingsAgent("claude") as Agent & { settings: NonNullable<Agent["settings"]> };
  const opencode = settingsAgent("opencode") as Agent & { settings: NonNullable<Agent["settings"]> };
  const refused = (agent: typeof claude, map: Record<string, unknown>) => {
    const problems: string[] = [];
    declareSettings(map, agent, "h", problems);
    return problems.length;
  };
  for (const key of ["model", "modelSettings", "effortLevel", "advisorModel", "fastMode", "alwaysThinkingEnabled", "tui", "remoteControlAtStartup", "agentPushNotifEnabled", "skipDangerousModePermissionPrompt", "theme", "mcpServers"]) {
    assert.equal(refused(claude, { [key]: 1 }), 1, key);
    assert.equal(refused(claude, { [key]: { deeper: 1 } }), 1, `${key}.deeper`);
  }
  assert.equal(refused(claude, { attribution: { commit: "" } }), 0);
  assert.equal(refused(opencode, { $schema: "x" }), 1);
  assert.equal(refused(opencode, { mcp: { a: { b: 1 } } }), 1);
  assert.equal(refused(opencode, { autoupdate: false }), 0);
});

test("the files fleet merges are each agent's settings file and the files its servers are in, each once", () => {
  assert.deepEqual(mergedFiles(), ["~/.claude/settings.json", "~/.config/opencode/opencode.jsonc", "~/.gemini/antigravity-cli/settings.json", "~/.claude.json", "~/.gemini/config/mcp_config.json"]);
  assert.deepEqual(mergedFiles(registry), ["~/.claude/settings.json", "~/.config/opencode/opencode.jsonc", "~/.gemini/antigravity-cli/settings.json", "~/.nested/config.json", "~/.claude.json", "~/.gemini/config/mcp_config.json"]);
});

test("an owned key is an MCP entry of the agent whose file and key it is under", () => {
  assert.deepEqual([mcpEntryOf({ file: "~/.claude.json", path: "mcpServers.docs" })?.agent.id, mcpEntryOf({ file: "~/.claude.json", path: "mcpServers.docs" })?.name], ["claude", "docs"]);
  assert.equal(mcpEntryOf({ file: "~/.config/opencode/opencode.jsonc", path: "mcp.docs" })?.agent.id, "opencode");
  assert.equal(mcpEntryOf({ file: "~/.config/opencode/opencode.jsonc", path: "autoupdate" }), null);
  assert.equal(mcpEntryOf({ file: "~/.claude/settings.json", path: "mcpServers.docs" }), null);
});

test("a file written through the agent's binary is the claude one only", () => {
  assert.equal(writtenByBinary({ file: "~/.claude.json" }), true);
  assert.equal(writtenByBinary({ file: "~/.claude/settings.json" }), false);
  assert.equal(writtenByBinary({ file: "~/.config/opencode/opencode.jsonc" }), false);
});

test("an agent is asked only for the parts it has", () => {
  assert.deepEqual(having("mcp", registry).map((a) => a.id), ["claude", "opencode", "antigravity"]);
  assert.deepEqual(having("instructions", registry).map((a) => a.id), ["claude", "opencode", "antigravity", "stub"]);
  assert.deepEqual(having("skills", registry).map((a) => a.id), ["claude", "opencode", "antigravity"]);
});

test("agents are named for a sentence", () => {
  assert.equal(sayAgents((a) => a.binary), "claude, opencode or agy");
  assert.equal(sayAgents((a) => a.name, "and"), "Claude Code, opencode and Antigravity CLI");
  assert.equal(sayAgents((a) => a.id, "or", registry), "claude, opencode, antigravity, stub or nested");
  assert.equal(sayAgents((a) => a.id, "or", [stub]), "stub");
});
