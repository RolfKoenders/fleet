import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { currentDefinitions, definitionKey, measureContext } from "../src/context.ts";
import type { AgentContext, ContextReport } from "../src/context.ts";
import { renderContext, BAR_WIDTH, largestItems } from "../src/contextview.ts";
import { saveDoctorResult } from "../src/doctorresult.ts";
import { EXIT } from "../src/exit.ts";
import { writeState } from "../src/state.ts";
import { estimateTokens, formatTokens } from "../src/tokens.ts";
import { colorParams } from "../src/tui/color.ts";
import { theme } from "../src/tui/theme.ts";
import { makeClone, makeHome, publish, runFleet, writeExecutable } from "./helpers.ts";

const NOW = new Date("2026-11-07T12:00:00Z");
const DAY = 86400_000;

const put = (home: string, rel: string, text: string) => {
  mkdirSync(dirname(join(home, rel)), { recursive: true });
  writeFileSync(join(home, rel), text);
};
const skill = (home: string, dir: string, name: string, description: string, extra = "") =>
  put(home, `${dir}/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${"A long body that is never loaded up front. ".repeat(200)}\n`);
const agentOf = (report: ContextReport, name: "claude" | "opencode"): AgentContext => report.agents.find((a) => a.agent === name)!;
const item = (agent: AgentContext, kind: string, name: string) => agent.items.find((i) => i.kind === kind && i.name === name)!;

/** A host with a little of everything: some of it recorded as fleet's applied state, some of it not. */
function fixture() {
  const home = makeHome("laptop");
  put(home, ".claude/CLAUDE.md", "c".repeat(400));
  put(home, ".claude/rules/one.md", "r".repeat(40));
  put(home, ".claude/rules/deep/two.md", "r".repeat(80));
  put(home, ".claude/rules/notes.txt", "not markdown");
  skill(home, ".claude/skills", "managed", "Does a managed thing.");
  skill(home, ".claude/skills", "loose", "Does a loose thing.");
  skill(home, ".claude/skills", "quiet", "Only when asked.", "disable-model-invocation: true\n");
  put(home, ".config/opencode/AGENTS.md", "o".repeat(200));
  put(home, "shared/extra.md", "e".repeat(100));
  put(home, "shared/more/a.md", "a".repeat(20));
  put(home, "shared/more/b.md", "b".repeat(20));
  put(
    home,
    ".config/opencode/opencode.jsonc",
    `// a comment\n{\n  "instructions": ["~/shared/extra.md", "~/shared/more/*.md", "docs/relative.md", "https://example.com/rules.md"],\n  "skills": ["~/team-skills", "./relative-skills"],\n  "mcp": { "alpha": { "type": "local", "command": ["x"], "environment": { "TOKEN": "sk-secret-value" } }, "off": { "type": "remote", "url": "https://x", "enabled": false }, "beta": { "type": "remote", "url": "https://y" } }\n}\n`,
  );
  skill(home, "team-skills", "teamwork", "Shared by the team.");
  skill(home, ".config/opencode/skills", "loose", "A loose thing, replaced here by a longer description.");
  skill(home, ".agents/skills", "agentsy", "From the agents directory.");
  put(home, ".claude.json", JSON.stringify({ numStartups: 3, mcpServers: { alpha: { type: "stdio", command: "x", env: { TOKEN: "sk-secret-value" } }, beta: { type: "http", url: "https://y", headers: { Authorization: "Bearer sk-secret-value" } }, gamma: { type: "http", url: "https://z" } } }));
  writeState(
    {
      version: 1,
      host: "laptop",
      appliedAt: NOW.toISOString(),
      repos: {},
      links: [
        { target: "~/.claude/CLAUDE.md", source: "/c/CLAUDE.md" },
        { target: "~/.claude/rules", source: "/c/rules" },
        { target: "~/.claude/skills/managed", source: "/s/managed" },
        { target: "~/.config/opencode/AGENTS.md", source: "/c/AGENTS.md" },
      ],
      keys: [
        { file: "~/.claude.json", path: "mcpServers.alpha", desired: "x", actual: "x" },
        { file: "~/.claude.json", path: "mcpServers.beta", desired: "x", actual: "x" },
        { file: "~/.config/opencode/opencode.jsonc", path: "mcp.alpha", desired: "x", actual: "x" },
      ],
    },
    home,
  );
  return home;
}

// ---- what is counted ----

test("instructions count in full: the file, the rules below it at any depth, and nothing that is not markdown", () => {
  const claude = agentOf(measureContext(fixture(), { now: NOW }), "claude");
  assert.equal(item(claude, "instructions", "~/.claude/CLAUDE.md").tokens, estimateTokens(400));
  assert.equal(item(claude, "instructions", "~/.claude/rules/one.md").tokens, estimateTokens(40));
  assert.equal(item(claude, "instructions", "~/.claude/rules/deep/two.md").tokens, estimateTokens(80));
  assert.equal(claude.instructions.count, 3);
  assert.equal(claude.instructions.tokens, estimateTokens(400) + estimateTokens(40) + estimateTokens(80));
});

test("a skill counts its name and description only, never its body, and one the model may not invoke counts nothing", () => {
  const claude = agentOf(measureContext(fixture(), { now: NOW }), "claude");
  assert.equal(item(claude, "skills", "managed").tokens, estimateTokens("managed".length + "Does a managed thing.".length));
  assert.equal(claude.skills.count, 2, "the skill with disable-model-invocation is not offered");
});

test("opencode reads its instructions setting (paths and globs), both skill directories and its skills setting, and says what it did not count", () => {
  const report = measureContext(fixture(), { now: NOW });
  const opencode = agentOf(report, "opencode");
  assert.deepEqual(opencode.items.filter((i) => i.kind === "instructions").map((i) => i.name).sort(), ["~/.config/opencode/AGENTS.md", "~/shared/extra.md", "~/shared/more/a.md", "~/shared/more/b.md"]);
  assert.deepEqual(opencode.items.filter((i) => i.kind === "skills").map((i) => i.name).sort(), ["agentsy", "loose", "managed", "teamwork"]);
  // The same name in a later directory replaces the earlier skill: opencode's own directory beats Claude's.
  assert.equal(item(opencode, "skills", "loose").tokens, estimateTokens("loose".length + "A loose thing, replaced here by a longer description.".length));
  assert.equal(item(opencode, "skills", "loose").path, "~/.config/opencode/skills/loose");
  assert.equal(opencode.notes.length, 3);
  assert.match(opencode.notes.join("\n"), /docs\/relative\.md is relative to a project/);
  assert.match(opencode.notes.join("\n"), /rules\.md is a URL/);
  assert.match(opencode.notes.join("\n"), /relative-skills/);
});

test("opencode offers no skill without a description, and skips a server that is switched off", () => {
  const home = fixture();
  put(home, ".claude/skills/bare/SKILL.md", "---\nname: bare\n---\nbody\n");
  const opencode = agentOf(measureContext(home, { now: NOW }), "opencode");
  assert.equal(opencode.items.some((i) => i.name === "bare"), false);
  assert.deepEqual(opencode.items.filter((i) => i.kind === "mcp").map((i) => i.name), ["alpha", "beta"]);
  assert.equal(agentOf(measureContext(home, { now: NOW }), "claude").items.some((i) => i.name === "bare"), true, "Claude takes it");
});

test("a description with a colon in it still counts", () => {
  const home = makeHome("laptop");
  put(home, ".claude/skills/odd/SKILL.md", "---\nname: odd\ndescription: Use when: the user says so\n---\n");
  assert.equal(item(agentOf(measureContext(home, { now: NOW }), "claude"), "skills", "odd").tokens, estimateTokens("odd".length + "Use when: the user says so".length));
});

test("every item says whether fleet put it there, from the applied state", () => {
  const report = measureContext(fixture(), { now: NOW });
  const claude = agentOf(report, "claude");
  assert.equal(item(claude, "instructions", "~/.claude/CLAUDE.md").fromConfig, true);
  assert.equal(item(claude, "instructions", "~/.claude/rules/deep/two.md").fromConfig, true, "a linked directory covers what is in it");
  assert.equal(item(claude, "skills", "managed").fromConfig, true);
  assert.equal(item(claude, "skills", "loose").fromConfig, false);
  assert.equal(item(claude, "mcp", "alpha").fromConfig, true);
  assert.equal(item(claude, "mcp", "gamma").fromConfig, false);
  const opencode = agentOf(report, "opencode");
  assert.equal(item(opencode, "mcp", "alpha").fromConfig, true);
  assert.equal(item(opencode, "mcp", "beta").fromConfig, false, "fleet put beta in Claude's file, not in opencode's");
  assert.equal(item(opencode, "instructions", "~/shared/extra.md").fromConfig, false);
});

test("a host that was never applied has nothing from config", () => {
  const home = makeHome("laptop");
  put(home, ".claude/CLAUDE.md", "x");
  const claude = agentOf(measureContext(home, { now: NOW }), "claude");
  assert.deepEqual(claude.items.map((i) => i.fromConfig), [false]);
});

// ---- MCP servers ----

function measured(home: string, definition: string | null = "d1") {
  saveDoctorResult(
    "laptop",
    [
      { name: "alpha", agent: "claude", result: "ok", tools: 52, size: 28_400 * 4, definition: definition ?? "" },
      { name: "alpha", agent: "opencode", result: "ok", tools: 52, size: 28_400 * 4, definition: definition ?? "" },
    ],
    home,
    new Date(NOW.getTime() - 2 * DAY),
  );
}

test("a server's size comes from the doctor result, with its tools and age; an unmeasured one is unknown and makes the total incomplete", () => {
  const home = fixture();
  measured(home);
  const claude = agentOf(measureContext(home, { now: NOW }), "claude");
  const alpha = item(claude, "mcp", "alpha");
  assert.equal(alpha.tokens, 28_400);
  assert.equal(alpha.measurement?.tools, 52);
  assert.equal(alpha.measurement?.ageSeconds, 2 * 86400);
  assert.equal(alpha.measurement?.measuredAt, new Date(NOW.getTime() - 2 * DAY).toISOString());
  const beta = item(claude, "mcp", "beta");
  assert.equal(beta.tokens, null);
  assert.equal(beta.measurement, null);
  assert.deepEqual(claude.mcp, { tokens: 28_400, count: 3, unmeasured: 2 });
  assert.equal(claude.complete, false);
  assert.equal(claude.tokens, claude.instructions.tokens + claude.skills.tokens + 28_400);
});

test("a measurement is current when the definition hash matches, changed when it does not, and unknown when the config's is not known", () => {
  const home = fixture();
  measured(home, "d1");
  const current = (definitions: Map<string, string> | null) => item(agentOf(measureContext(home, { now: NOW, definitions }), "claude"), "mcp", "alpha").measurement!.current;
  assert.equal(current(new Map([[definitionKey("claude", "alpha"), "d1"]])), true);
  assert.equal(current(new Map([[definitionKey("claude", "alpha"), "d2"]])), false);
  assert.equal(current(new Map()), null);
  assert.equal(current(null), null);
});

test("a server that failed since keeps its last measurement", () => {
  const home = fixture();
  measured(home);
  saveDoctorResult("laptop", [{ name: "alpha", agent: "claude", result: "timeout", tools: null, size: null, definition: "d9" }], home, NOW);
  assert.equal(item(agentOf(measureContext(home, { now: NOW }), "claude"), "mcp", "alpha").tokens, 28_400);
});

test("each server carries what the last doctor run found, and null when doctor has not checked it", () => {
  const home = fixture();
  saveDoctorResult("laptop", [{ name: "alpha", agent: "claude", result: "ok", tools: 2, size: 800, definition: "d1" }, { name: "beta", agent: "claude", result: "auth-needed", tools: null, size: null, definition: "d2" }], home, NOW);
  const claude = agentOf(measureContext(home, { now: NOW }), "claude");
  assert.equal(item(claude, "mcp", "alpha").doctor, "ok");
  assert.equal(item(claude, "mcp", "beta").doctor, "auth-needed");
  assert.equal(item(claude, "mcp", "beta").tokens, null);
  assert.equal(item(claude, "mcp", "gamma").doctor, null);
  assert.equal(item(claude, "skills", "managed").doctor, null, "only a server has a doctor result");
});

// ---- drawing ----

const ESC = String.fromCharCode(27);
const strip = (text: string) => text.replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

/** A report in the shape of the story's example, built by hand so the numbers are plain. */
function report(): ContextReport {
  const at = (days: number, current: boolean | null) => ({ tools: 52, measuredAt: new Date(NOW.getTime() - days * DAY).toISOString(), ageSeconds: days * 86400, current });
  const make = (agent: "claude" | "opencode", servers: number): AgentContext => {
    const items: AgentContext["items"] = [
      { kind: "instructions", name: "~/.claude/CLAUDE.md", path: "~/.claude/CLAUDE.md", tokens: 1900, fromConfig: true, measurement: null, doctor: null },
      { kind: "skills", name: "smallskill", path: "~/.claude/skills/smallskill", tokens: 400, fromConfig: false, measurement: null, doctor: null },
      { kind: "skills", name: "tdd", path: "~/.claude/skills/tdd", tokens: 4800, fromConfig: true, measurement: null, doctor: null },
      { kind: "mcp", name: "bigserver", path: null, tokens: 28_400, fromConfig: true, measurement: at(2, true), doctor: "ok" },
      { kind: "mcp", name: "midserver", path: null, tokens: 4100, fromConfig: true, measurement: at(1, false), doctor: "ok" },
      { kind: "mcp", name: "docs", path: null, tokens: null, fromConfig: true, measurement: null, doctor: null },
      { kind: "mcp", name: "stray", path: null, tokens: null, fromConfig: false, measurement: null, doctor: null },
    ].slice(0, 3 + servers) as AgentContext["items"];
    const sum = (kind: string) => items.filter((i) => i.kind === kind).reduce((n, i) => n + (i.tokens ?? 0), 0);
    const count = (kind: string) => items.filter((i) => i.kind === kind).length;
    const unmeasured = items.filter((i) => i.tokens === null).length;
    const part = (kind: string) => ({ tokens: sum(kind), count: count(kind), unmeasured: items.filter((i) => i.kind === kind && i.tokens === null).length });
    return { agent, tokens: sum("instructions") + sum("skills") + sum("mcp"), complete: unmeasured === 0, instructions: part("instructions"), skills: part("skills"), mcp: part("mcp"), items, notes: [] };
  };
  return { agents: [make("claude", 4), make("opencode", 1)], notes: [] };
}

test("the colours are the bridge's, one per part, and each bar is as wide as the largest agent's share", () => {
  const out = renderContext(report(), "truecolor");
  for (const colour of [theme.brand, theme.info, theme.warn]) assert.ok(out.includes(`${ESC}[${colorParams(colour, "truecolor", false)}m`), `colour ${colour.toString(16)}`);
  const [claude, opencode] = strip(out).split("\n");
  const bar = (line: string) => line.slice(10, 10 + BAR_WIDTH);
  assert.equal(bar(claude!).trimEnd().length, BAR_WIDTH, "the largest agent fills the bar");
  assert.equal(bar(opencode!).trimEnd().length, Math.round((BAR_WIDTH * 35_500) / 39_600), "the smaller one is scaled to it");
});

test("with 256 colours the same parts use the nearest palette entries", () => {
  const out = renderContext(report(), "256");
  assert.ok(out.includes(`${ESC}[${colorParams(theme.brand, "256", false)}m`));
  assert.ok(colorParams(theme.brand, "256", false).startsWith("38;5;"));
});

test("without colour the layout is the same, the parts have their own characters and nothing is escaped", () => {
  const plain = renderContext(report(), "none");
  const coloured = renderContext(report(), "truecolor");
  assert.equal(plain.includes(ESC), false);
  const mapped = (text: string) => strip(text).replaceAll(/[▓░]/g, "█");
  assert.equal(mapped(plain), mapped(coloured), "same layout, character for character apart from the bar glyphs");
  const [claude] = plain.split("\n");
  assert.match(claude!, /█+▓+░+/);
});

test("each agent's line has its total and the three parts; the largest items are named", () => {
  const out = strip(renderContext(report(), "none"));
  const [claude, opencode] = out.split("\n");
  assert.match(claude!, /^claude {4}\S+ +~39\.6k\+ +instructions ~1\.9k · skills ~5\.2k \(2\) · mcp up to ~32\.5k \(4, 2 not measured\)$/);
  assert.match(opencode!, /^opencode {2}\S+ +~35\.5k +instructions ~1\.9k · skills ~5\.2k \(2\) · mcp up to ~28\.4k \(1\)$/);
  assert.match(out, /^largest +bigserver ~28\.4k \(52 tools, measured 2d ago\) {3}tdd skill ~4\.8k {3}midserver ~4\.1k \(52 tools, measured before the last change\)$/m);
  assert.equal(largestItems(report()).length, 3);
});

test("the total says it is incomplete, and what was not measured is named with what to do", () => {
  const out = strip(renderContext(report(), "none"));
  assert.match(out, /^not measured +docs \(run fleet doctor\) {3}stray \(not from config, doctor does not measure it\)$/m);
  assert.match(out, /total is incomplete/);
  assert.doesNotMatch(strip(renderContext({ agents: [report().agents[1]!], notes: [] }, "none")), /incomplete|not measured/);
});

test("a server that wants a login says doctor cannot list its tools, not to run doctor again", () => {
  const withServers = (servers: [string, string | null][]): ContextReport => {
    const r = report();
    const claude = r.agents[0]!;
    const items = [...claude.items.filter((i) => i.kind !== "mcp"), ...servers.map(([name, doctor]) => ({ kind: "mcp" as const, name, path: null, tokens: null, fromConfig: true, measurement: null, doctor }))];
    return { agents: [{ ...claude, items, complete: false }], notes: [] };
  };
  const many = strip(renderContext(withServers([["issues", "auth-needed"], ["metrics", "auth-needed"], ["docs", null], ["flaky", "timeout"]]), "none"));
  assert.match(many, /^not measured +issues, metrics \(need a login, so doctor cannot list their tools\) {3}docs \(run fleet doctor\) {3}flaky \(the last doctor run gave timeout\)$/m);
  const one = strip(renderContext(withServers([["issues", "auth-needed"]]), "none"));
  assert.match(one, /^not measured +issues \(needs a login, so doctor cannot list its tools\)$/m);
  assert.doesNotMatch(one, /run fleet doctor/);
});

test("a measurement from before the last change says so, and the text marks what is not from config", () => {
  const out = strip(renderContext(report(), "none"));
  assert.match(out, /^out of date +midserver \(measured before the last change; run fleet doctor\)$/m);
  assert.match(out, /^not from config +smallskill skill ~400 {3}stray mcp$/m);
});

test("sizes read like the rest of fleet: a tilde, and k above a thousand", () => {
  assert.equal(formatTokens(28_400), "~28.4k");
  assert.equal(formatTokens(412), "~412");
});

// ---- the command ----

/** A config repo with one server whose command would leave a marker if it ever ran, and a secret it would need. */
function guarded() {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  const marker = join(home, "server-started");
  const server = join(home, "server.js");
  writeFileSync(server, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started");\n`);
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(clone, rel)), { recursive: true });
    writeFileSync(join(clone, rel), text);
  };
  write("catalog/mcp.yaml", `servers:\n  guarded:\n    command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(server)}]\n    env:\n      TOKEN: secret:API_TOKEN\n`);
  write("hosts/_defaults.yaml", "mcp:\n  include: [guarded]\n");
  write("hosts/laptop.yaml", "ssh: me@laptop\n");
  publish(clone, "config");
  // Anything that decrypts has to run sops, and this one records that it was asked.
  const sopsLog = join(home, "sops-called");
  writeExecutable(join(home, ".local/bin/sops"), `#!/bin/sh\necho "$@" >> ${sopsLog}\nexit 1\n`);
  mkdirSync(join(home, ".config/fleet"), { recursive: true });
  writeFileSync(join(home, ".config/fleet/age.key"), "AGE-SECRET-KEY-placeholder\n");
  put(home, ".claude.json", JSON.stringify({ mcpServers: { guarded: { type: "stdio", command: process.execPath, args: [server], env: { TOKEN: "sk-the-secret-value" } } } }));
  writeState({ version: 1, host: "laptop", appliedAt: NOW.toISOString(), repos: {}, links: [], keys: [{ file: "~/.claude.json", path: "mcpServers.guarded", desired: "x", actual: "x" }] }, home);
  return { clone, home, marker, sopsLog };
}

test("it starts no MCP server and decrypts no secret, even for a server whose entry needs one", () => {
  const s = guarded();
  const definition = currentDefinitions(s.clone, "laptop", s.home).get(definitionKey("claude", "guarded"));
  assert.ok(definition);
  saveDoctorResult("laptop", [{ name: "guarded", agent: "claude", result: "ok", tools: 3, size: 4000, definition }], s.home, new Date());
  for (const args of [["context"], ["context", "--json"]]) {
    const r = runFleet(s.clone, args, { home: s.home });
    assert.equal(r.code, EXIT.ok, r.stderr);
    assert.equal(existsSync(s.marker), false, "the server was started");
    assert.equal(existsSync(s.sopsLog), false, "sops was run");
    assert.equal((r.stdout + r.stderr).includes("sk-the-secret-value"), false, "a secret value was shown");
  }
  const doc = JSON.parse(runFleet(s.clone, ["context", "--json"], { home: s.home }).stdout);
  const guardedItem = doc.agents[0].items.find((i: { name: string }) => i.name === "guarded");
  assert.equal(guardedItem.tokens, 1000);
  assert.equal(guardedItem.measurement.current, true, "the hash was made from the entry before any secret was filled in");
});

test("a server whose catalog entry changed since it was measured says so", () => {
  const s = guarded();
  saveDoctorResult("laptop", [{ name: "guarded", agent: "claude", result: "ok", tools: 3, size: 4000, definition: "0".repeat(64) }], s.home, new Date());
  const r = runFleet(s.clone, ["context"], { home: s.home });
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stdout, /guarded ~1\.0k \(3 tools, measured before the last change\)/);
  assert.equal(existsSync(s.marker), false);
});

test("it is a report: exit 0 on a host with nothing, with no config repo and with a broken config", () => {
  const home = makeHome();
  const r = runFleet(makeClone().clone, ["context"], { home, env: { FLEET_CONFIG: join(home, "missing") } });
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stdout, /^claude {2}/m);
  assert.match(r.stdout, /^opencode {2}/m);
  const broken = guarded();
  writeFileSync(join(broken.clone, "catalog/mcp.yaml"), "servers: [not a map\n");
  const b = runFleet(broken.clone, ["context"], { home: broken.home });
  assert.equal(b.code, EXIT.ok, b.stderr);
  assert.match(b.stderr, /config could not be read/);
});

test("--json has the numbers, the item lists and each measurement's age; colour follows the terminal", () => {
  const s = guarded();
  saveDoctorResult("laptop", [{ name: "guarded", agent: "claude", result: "ok", tools: 3, size: 4000, definition: "x" }], s.home, new Date(Date.now() - 3600_000));
  const doc = JSON.parse(runFleet(s.clone, ["context", "--json"], { home: s.home }).stdout);
  assert.equal(doc.ok, true);
  assert.deepEqual(doc.agents.map((a: AgentContext) => a.agent), ["claude", "opencode"]);
  const guardedItem = doc.agents[0].items.find((i: { name: string }) => i.name === "guarded");
  assert.deepEqual(Object.keys(guardedItem).sort(), ["doctor", "fromConfig", "kind", "measurement", "name", "path", "tokens"]);
  assert.ok(guardedItem.measurement.ageSeconds >= 3600 && guardedItem.measurement.ageSeconds < 3700);
  assert.equal(guardedItem.fromConfig, true);
  assert.equal(doc.agents[0].mcp.count, 1);

  const piped = runFleet(s.clone, ["context"], { home: s.home });
  assert.equal(piped.stdout.includes(ESC), false, "not a terminal: no colour");
  assert.equal(runFleet(s.clone, ["context"], { home: s.home, env: { FORCE_COLOR: "1", COLORTERM: "truecolor", TERM: "xterm-256color" } }).stdout.includes(`${ESC}[38;2;63;185;80m`), true);
  assert.equal(runFleet(s.clone, ["context"], { home: s.home, env: { FORCE_COLOR: "1", NO_COLOR: "1" } }).stdout.includes(ESC), false, "NO_COLOR wins");
});

test("it is in fleet help, in the primer as read-only, and in the README", () => {
  const s = guarded();
  const help = JSON.parse(runFleet(s.clone, ["help", "--json"], { home: s.home }).stdout) as { commands: { name: string }[] };
  assert.ok(help.commands.some((c) => c.name === "context"));
  assert.match(runFleet(s.clone, ["help"], { home: s.home }).stdout, /^ {2}context /m);
  const primer = runFleet(s.clone, ["agent"], { home: s.home }).stdout;
  const readOnly = primer.slice(primer.indexOf("### Read-only"), primer.indexOf("### Changes things"));
  assert.match(readOnly, /^- `fleet context( \[--all\])?`/m);
  assert.match(readFileSync(join(import.meta.dirname, "../README.md"), "utf8"), /^\| `fleet context` \|/m);
});

test("symlinks are followed: a skill that is a link to a directory counts", () => {
  const home = makeHome("laptop");
  skill(home, "elsewhere", "linked", "Linked in.");
  mkdirSync(join(home, ".claude/skills"), { recursive: true });
  symlinkSync(join(home, "elsewhere/linked"), join(home, ".claude/skills/linked"));
  assert.equal(item(agentOf(measureContext(home, { now: NOW }), "claude"), "skills", "linked").tokens, estimateTokens("linked".length + "Linked in.".length));
});

test("the code that measures imports nothing that starts a process or reads a secret", () => {
  for (const file of ["context.ts", "contextcmd.ts", "contextread.ts", "contextview.ts", "agentpaths.ts"]) {
    const imports = [...readFileSync(join(import.meta.dirname, "../src", file), "utf8").matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]);
    for (const forbidden of ["node:child_process", "./mcpprobe.ts", "./secrets.ts", "./sops.ts", "./secretscli.ts", "./doctor.ts"]) {
      assert.equal(imports.includes(forbidden), false, `${file} imports ${forbidden}`);
    }
  }
});
