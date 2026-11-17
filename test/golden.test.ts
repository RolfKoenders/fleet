import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeClaude, installFakeTool, installStatusTools, makeClone, makeHome, makeSource, publish, runFleet } from "./helpers.ts";
import type { Run } from "./helpers.ts";

/**
 * What `fleet diff`, `fleet context --json`, `fleet status --json` and `fleet apply` print for one representative
 * config on a host with both agents installed. The expected output is stored in `test/golden/`, so a refactor
 * that changes behaviour shows up as a diff. After a change that is meant to alter the output, rewrite the
 * stored files with `UPDATE_GOLDEN=1 npm test`, and read the diff before committing it.
 */

const GOLDEN = join(import.meta.dirname, "golden");

const put = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

const CATALOG = `servers:
  docs:
    command: [npx, -y, "@example/docs-mcp@1.0.0"]
    env:
      DOCS_BASE_URL: "{{ vars.DOCS_URL }}"
  tracker:
    transport: http
    url: https://tracker.example.com/mcp
    headers:
      X-Team: "{{ vars.TEAM }}"
  events:
    transport: sse
    url: https://events.example.com/sse
  local-tool:
    command: [/usr/local/bin/tool, --serve]
    env:
      MODE: fast
    only: [opencode]
  claude-only:
    command: [node, server.js]
    only: [claude]
  stale:
    transport: http
    url: https://stale.example.com/mcp
`;

const DEFAULTS = `vars:
  DOCS_URL: https://docs.example.com
  TEAM: platform
bundles: [core]
mcp:
  include: [docs, tracker, events, local-tool, claude-only, stale]
settings:
  claude:
    attribution:
      commit: ""
      pr: ""
    permissions:
      defaultMode: plan
    env:
      DISABLE_TELEMETRY: "1"
  opencode:
    autoupdate: false
    share: disabled
    permission:
      bash: ask
files:
  - { source: config/AGENTS.md, target: ~/.claude/CLAUDE.md }
  - { source: config/AGENTS.md, target: ~/.config/opencode/AGENTS.md }
  - { source: config/rules, target: ~/.claude/rules }
`;

/** A config repo and a host with both agents installed, a skill source, and a few things already in place by hand. */
function world() {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  const skill = (name: string) => ({ [`skills/${name}/SKILL.md`]: `---\nname: ${name}\ndescription: Does the ${name} thing.\n---\n\nBody.\n` });
  const source = makeSource({ ...skill("review"), ...skill("debug"), ...skill("notes") });
  put(clone, "catalog/mcp.yaml", CATALOG);
  put(clone, "catalog/skills.yaml", `sources:\n  mine:\n    repo: ${source.remote}\n    commit: ${source.first}\n    track: main\n    path: skills\nbundles:\n  core: [review, debug]\n  extra: [notes]\n`);
  put(clone, "hosts/_defaults.yaml", DEFAULTS);
  put(clone, "hosts/laptop.yaml", "bundles: [extra]\n");
  put(clone, "config/AGENTS.md", "Shared instructions.\n");
  put(clone, "config/rules/one.md", "A rule.\n");
  publish(clone);

  installFakeClaude(home);
  installFakeTool(home, "opencode", { stdout: "1.4.2", only: ["--version"] });
  put(home, ".claude/settings.json", JSON.stringify({ model: "opus", permissions: { allow: ["Bash(ls)"] } }, null, 2));
  put(home, ".claude/skills/loose/SKILL.md", "---\nname: loose\ndescription: A skill made by hand.\n---\n");
  put(home, ".config/opencode/opencode.jsonc", `{\n  "theme": "dark",\n  "mcp": { "mine": { "type": "local", "command": ["x"] }, "off": { "type": "remote", "url": "https://off.example.com", "enabled": false } }\n}\n`);
  put(home, ".config/opencode/skills/nested/group/SKILL.md", "---\nname: nested\ndescription: Below a grouping directory.\n---\n");
  put(home, ".claude.json", JSON.stringify({ numStartups: 3, mcpServers: { handmade: { type: "http", url: "https://hand.example.com" } } }));
  return { clone, home, source };
}

/** Paths and ids that differ per run or per machine, replaced by names. */
function normalize(text: string, w: { clone: string; home: string; source: { remote: string; first: string } }): string {
  const pairs: [string, string][] = [
    [w.source.remote, "<SOURCE>"],
    [w.source.first, "<SHA>"],
    [w.clone, "<CONFIG>"],
    [w.home, "<HOME>"],
    [dirname(process.execPath), "<NODE_BIN>"],
  ];
  let out = text;
  for (const [from, to] of pairs) out = out.split(from).join(to);
  return out
    .replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<TIME>")
    .replace(/"ageSeconds": \d+/g, '"ageSeconds": "<AGE>"')
    .replace(/\b[0-9a-f]{40}\b/g, "<SHA>")
    .replace(/\b[0-9a-f]{7,12}\b(?=[ ",)\n]|$)/g, (m) => (/\d/.test(m) && /[a-f]/.test(m) ? "<SHA>" : m));
}

/** The output of a run, as the golden file holds it. Everything that comes back, so a new stream shows up too. */
const shown = (name: string, r: Run, w: Parameters<typeof normalize>[1]): string => `$ ${name}\nexit ${r.code}\n--- stdout\n${normalize(r.stdout, w)}--- stderr\n${normalize(r.stderr, w)}`;

function check(file: string, actual: string): void {
  const path = join(GOLDEN, file);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  assert.ok(existsSync(path), `${file} is missing; write it with UPDATE_GOLDEN=1`);
  assert.equal(actual, readFileSync(path, "utf8"), `${file} changed`);
}

test("golden: a first apply, as fleet diff, apply, context and status show it", () => {
  const w = world();
  const run = (...args: string[]) => runFleet(w.clone, args, { home: w.home });
  const out: string[] = [];
  const step = (...args: string[]) => out.push(shown(`fleet ${args.join(" ")}`, run(...args), w));

  step("diff");
  step("diff", "--json");
  step("apply");
  step("diff");
  step("context", "--json");
  step("context");
  installStatusTools(w.home);
  step("status", "--json");
  check("first-apply.txt", out.join("\n"));
  // The files apply wrote, as a reader of the host would see them.
  check("first-apply-files.txt", ["~/.claude.json", "~/.claude/settings.json", "~/.config/opencode/opencode.jsonc"].map((f) => `=== ${f}\n${normalize(readFileSync(join(w.home, f.slice(2)), "utf8"), w)}\n`).join(""));
});

test("golden: a change to the config, as diff and apply show it, then a removal", () => {
  const w = world();
  const run = (...args: string[]) => runFleet(w.clone, args, { home: w.home });
  assert.equal(run("apply").code, 0);
  const out: string[] = [];
  const step = (...args: string[]) => out.push(shown(`fleet ${args.join(" ")}`, run(...args), w));

  put(w.clone, "catalog/mcp.yaml", CATALOG.replace("https://tracker.example.com/mcp", "https://tracker.example.com/v2/mcp").replace("only: [claude]", "only: [claude, opencode]"));
  put(w.clone, "hosts/_defaults.yaml", DEFAULTS.replace("include: [docs, tracker, events, local-tool, claude-only, stale]", "include: [docs, tracker, events, local-tool, claude-only]").replace("defaultMode: plan", "defaultMode: acceptEdits").replace("    share: disabled\n", "").replace(/files:[\s\S]*/, "files:\n  - { source: config/AGENTS.md, target: ~/.claude/CLAUDE.md }\n"));
  publish(w.clone);
  step("diff");
  step("diff", "--json");
  step("apply");
  step("diff");
  step("context", "--json");
  check("change-and-removal.txt", out.join("\n"));
  check("change-and-removal-files.txt", ["~/.claude.json", "~/.claude/settings.json", "~/.config/opencode/opencode.jsonc"].map((f) => `=== ${f}\n${normalize(readFileSync(join(w.home, f.slice(2)), "utf8"), w)}\n`).join(""));
});

test("golden: conflicts, a hand-made entry in the way, and the old opencode file", () => {
  const w = world();
  const run = (...args: string[]) => runFleet(w.clone, args, { home: w.home });
  put(w.home, ".claude.json", JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://other.example.com" } } }));
  put(w.home, ".config/opencode/opencode.json", "{}\n");
  put(w.home, ".config/opencode/opencode.jsonc", `// has a comment\n{ "autoupdate": true, "mcp": { "tracker": { "type": "remote", "url": "https://elsewhere" } } }\n`);
  put(w.home, ".claude/CLAUDE.md", "A plain file where fleet wants a link.\n");
  const out: string[] = [];
  const step = (...args: string[]) => out.push(shown(`fleet ${args.join(" ")}`, run(...args), w));
  step("diff");
  step("diff", "--json");
  step("apply");
  step("status", "--conflicts");
  check("conflicts.txt", out.join("\n"));
});
