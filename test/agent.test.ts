import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FAKE_VERSIONS, git, installStatusTools, makeClone, makeHome, repoRoot, runFleet, toolCalls } from "./helpers.ts";
import { EXIT } from "../src/exit.ts";

const EM_DASH = String.fromCharCode(0x2014);

function setup() {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  installStatusTools(home);
  const run = (args: string[] = []) => runFleet(clone, ["agent", ...args], { home });
  return { clone, home, run };
}

const section = (markdown: string, heading: string): string => {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  assert.notEqual(start, -1, `no '## ${heading}' section`);
  const rest = markdown.slice(start + 1);
  const next = rest.indexOf("\n## ", 1);
  return next === -1 ? rest : rest.slice(0, next);
};

test("fleet agent prints Markdown, exits 0, and writes nothing to stderr", () => {
  const s = setup();
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stdout, /^# fleet$/m);
  for (const heading of ["Terms", "Commands", "Pushing", "Clearing a conflict", "Recipes", "Exit codes", "This host"]) {
    assert.match(r.stdout, new RegExp(`^## ${heading}$`, "m"));
  }
  assert.equal(r.stderr, "");
});

test("every command fleet has is in the primer, once, as read-only or as changing things", () => {
  const s = setup();
  const help = JSON.parse(runFleet(s.clone, ["help", "--json"], { home: s.home }).stdout) as { commands: { name: string }[] };
  const commands = section(s.run().stdout, "Commands");
  const readOnly = commands.slice(0, commands.indexOf("### Changes things"));
  const changing = commands.slice(commands.indexOf("### Changes things"));
  assert.match(readOnly, /^### Read-only$/m);
  const listed = (text: string) => [...text.matchAll(/^- `fleet ([a-z]+)/gm)].map((m) => m[1]);
  assert.deepEqual([...listed(readOnly), ...listed(changing)].sort(), help.commands.map((c) => c.name).sort());
  assert.deepEqual(listed(readOnly).sort(), ["agent", "demo", "diff", "help", "status"]);
  assert.deepEqual(listed(changing).sort(), ["adopt", "apply", "bridge", "doctor", "init", "new", "push", "secrets", "skills", "update"]);
});

test("the exit codes are the ones the code defines, with their numbers", () => {
  const s = setup();
  const table = section(s.run().stdout, "Exit codes");
  const rows = [...table.matchAll(/^\| (\d+) \| (\S+) \| (.+) \|$/gm)].map((m) => [Number(m[1]), m[2], m[3]!.length > 0] as const);
  assert.deepEqual(rows, Object.entries(EXIT).map(([name, code]) => [code, name, true]));
});

test("each term of the glossary is in the primer with a one line definition, and nothing else is", () => {
  const glossary = readFileSync(join(repoRoot, "GLOSSARY.md"), "utf8");
  const terms = [...glossary.matchAll(/^\*\*(.+?)\*\*:$/gm)].map((m) => m[1]!);
  assert.ok(terms.length >= 14);
  const body = section(setup().run().stdout, "Terms");
  const lines = body.split("\n").filter((l) => l.startsWith("- "));
  assert.deepEqual(lines.map((l) => /^- \*\*(.+?)\*\*: .+/.exec(l)?.[1]), terms);
});

test("the primer states the push rule, and how to clear a conflict", () => {
  const out = setup().run().stdout;
  const pushing = section(out, "Pushing");
  assert.match(pushing, /Never run `fleet push`, `fleet apply`, or a command that changes secrets unless the user asked for that action in this turn\./);
  const clearing = section(out, "Clearing a conflict");
  assert.match(clearing, /no force flag/i);
  assert.match(clearing, /fleet diff/);
  assert.match(clearing, /fleet adopt/);
  assert.match(clearing, /claude mcp remove --scope user/);
});

test("the primer ends with this host's current status, from the same code as fleet status", () => {
  const s = setup();
  const out = s.run().stdout;
  const status = runFleet(s.clone, ["status"], { home: s.home }).stdout;
  const here = section(out, "This host");
  assert.ok(here.includes(status.trimEnd()), "the status text is in the section as fleet status prints it");
  assert.match(here, new RegExp(`claude: ${FAKE_VERSIONS.claude}`));
  assert.match(here, new RegExp(`sha: ${git(s.clone, "rev-parse", "HEAD")}`));
  assert.equal(out.indexOf("## This host") > out.indexOf("## Exit codes"), true);
});

test("when status cannot be computed the primer says so and still exits 0", () => {
  const s = setup();
  rmSync(join(s.clone, ".git"), { recursive: true });
  const status = runFleet(s.clone, ["status"], { home: s.home });
  assert.notEqual(status.code, 0, "the premise: status itself fails here");
  const r = s.run();
  assert.equal(r.code, EXIT.ok, r.stderr);
  const here = section(r.stdout, "This host");
  assert.match(here, /Status could not be computed:/);
  assert.match(r.stdout, /^## Commands$/m, "the rest of the primer is still there");
  assert.equal(JSON.parse(s.run(["--json"]).stdout).ok, true);
});

test("fleet agent --json carries the Markdown and the status fields", () => {
  const s = setup();
  const r = s.run(["--json"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.ok, true);
  assert.equal(doc.host, "laptop");
  assert.equal(doc.markdown, s.run().stdout);
  assert.equal(doc.status.tools.claude, FAKE_VERSIONS.claude);
});

test("fleet agent calls the fake tools it was given, not real ones", () => {
  const s = setup();
  s.run();
  assert.deepEqual(toolCalls(s.home, "claude"), [["--version"]]);
  assert.deepEqual(toolCalls(s.home, "systemctl"), [["--user", "is-active", "fleet.timer"]]);
  assert.deepEqual(toolCalls(s.home, "sops"), [["--version", "--disable-version-check"]]);
});

test("fleet agent takes no flags beyond the globals", () => {
  const s = setup();
  for (const args of [["--all"], ["-m", "x"], ["extra"]]) {
    const r = s.run(args);
    assert.equal(r.code, EXIT.invalid, `${args.join(" ")}: ${r.stderr}`);
  }
});

test("the primer has no em dash", () => {
  assert.equal(setup().run().stdout.includes(EM_DASH), false);
});

test("the primer names the config repo and the fleet clone separately, and says how the tool version moves", () => {
  const s = setup();
  const out = s.run().stdout;
  assert.match(out, new RegExp(`kept here at \`${s.clone}\``), "this is a development run with both in one directory, but they are named apart");
  assert.match(out, new RegExp(`fleet clone at \`${s.clone}\``));
  assert.match(out, /pins in `fleet\.yaml`/);
  const version = section(out, "The tool version");
  assert.match(version, /`fleet update` moves the pin/);
  assert.match(version, /no commit, no apply/);
  assert.match(section(out, "Pushing"), /never the tool/);
});

test("without a config repo the primer says so and still exits 0", () => {
  const s = setup();
  const r = runFleet(s.clone, ["agent"], { home: s.home, env: { FLEET_CONFIG: "" } });
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stdout, /which is not set on this machine yet/);
  assert.match(section(r.stdout, "This host"), /Status could not be computed: there is no config repo to read/);
});

const recipes = (out: string) => section(out, "Recipes");

const blocks = (out: string): Map<string, string> => {
  const body = recipes(out);
  return new Map(body.split(/\n(?=### )/).filter((b) => b.startsWith("### ")).map((b) => [b.split("\n")[0]!.slice(4), b]));
};

/** A usage from the command table as a regular expression over the words after `fleet`: `<x>` is any word, `a|b` one of them, `[...]` optional, ` | ` between whole forms. */
function usagePattern(usage: string): RegExp {
  const [name, ...rest] = usage.split(" ");
  const word = (w: string) => `(?:${w.split("|").map((alt) => (/^<.+>$/.test(alt) ? "\\S+" : alt.replace(/[.*+?^${}()\\]/g, "\\$&"))).join("|")})`;
  const form = (words: string) =>
    (words.match(/\[[^\]]*\]|\S+/g) ?? []).map((piece) => (piece.startsWith("[") ? `(?: ${(piece.slice(1, -1).match(/\S+/g) ?? []).map(word).join(" ")})?` : ` ${word(piece)}`)).join("");
  const forms = rest.length === 0 ? [""] : rest.join(" ").split(" | ").map(form);
  return new RegExp(`^${name}(?:${forms.join("|")})$`);
}

function commandTable(out: string): { name: string; usage: string }[] {
  const body = section(out, "Commands");
  return [...body.matchAll(/^- `fleet (([a-z]+)[^`]*)`:/gm)].map((m) => ({ name: m[2]!, usage: m[1]! }));
}

const mentions = (out: string): string[] => [...recipes(out).matchAll(/`fleet ([^`]+)`/g)].map((m) => m[1]!);

test("the primer has a Recipes section with the six jobs, in the JSON as well", () => {
  const s = setup();
  const out = s.run().stdout;
  assert.deepEqual([...blocks(out).keys()], [
    "Add an MCP server",
    "Add a skill",
    "Add a secret",
    "Adopt what already exists",
    "Set up this machine (onboarding)",
    "Move the tool pin",
  ]);
  const doc = JSON.parse(s.run(["--json"]).stdout);
  assert.deepEqual(doc.recipes.map((r: { title: string }) => r.title), [...blocks(out).keys()]);
  assert.ok(doc.markdown.includes(recipes(out)));
});

test("every recipe names its files, its steps, its check and where it stops", () => {
  for (const [title, block] of blocks(setup().run().stdout)) {
    for (const part of ["Edit:", "Steps:", "Check:", "Stop and hand over:"]) assert.ok(block.includes(`\n${part}\n`), `${title} lacks ${part}`);
    assert.match(block, /`fleet diff`/, `${title} does not check with fleet diff`);
    const edit = block.slice(block.indexOf("Edit:"), block.indexOf("Steps:"));
    assert.match(edit, /\.yaml|\.md|`fleet adopt /, `${title} names no file`);
  }
});

test("every fleet command a recipe mentions is in the command table, with its real usage", () => {
  const out = setup().run().stdout;
  const table = commandTable(out);
  assert.ok(table.length >= 11);
  const seen = new Set<string>();
  for (const mention of mentions(out)) {
    const name = mention.split(" ")[0]!;
    const entry = table.find((c) => c.name === name);
    assert.ok(entry, `\`fleet ${mention}\` is not a command`);
    assert.match(mention, usagePattern(entry.usage), `\`fleet ${mention}\` does not follow \`fleet ${entry.usage}\``);
    seen.add(name);
  }
  for (const name of ["diff", "adopt", "secrets", "update", "new", "init", "push", "apply"]) assert.ok(seen.has(name), `no recipe mentions ${name}`);
});

test("the usage matcher accepts the forms the table has and rejects the ones it does not", () => {
  assert.ok(usagePattern("secrets edit <file> | set <file> <NAME> | rekey").test("secrets set shared TRACKER_API_KEY"));
  assert.ok(usagePattern("secrets edit <file> | set <file> <NAME> | rekey").test("secrets rekey"));
  assert.equal(usagePattern("secrets edit <file> | set <file> <NAME> | rekey").test("secrets set shared"), false);
  assert.ok(usagePattern("adopt mcp|skill <name>").test("adopt skill review"));
  assert.equal(usagePattern("adopt mcp|skill <name>").test("adopt mcp"), false);
  assert.equal(usagePattern("adopt mcp|skill <name>").test("adopt secret x"), false);
  assert.ok(usagePattern("push [-m <message>]").test("push"));
  assert.ok(usagePattern("push [-m <message>]").test("push -m hello"));
  assert.equal(usagePattern("diff").test("diff --all"), false);
});

test("a recipe never sends a secret value through an agent, and says so plainly", () => {
  const out = setup().run().stdout;
  const rules = recipes(out);
  assert.match(rules, /Never see a secret value/);
  assert.match(rules, /do not pipe a value into `fleet secrets set <host> <NAME>`/);
  assert.match(rules, /do not ask for one in chat/);
  const secret = blocks(out).get("Add a secret")!;
  assert.match(secret, /ask the user to run `fleet secrets set <host> <NAME>` themselves, in their own terminal/);
  assert.match(secret, /Do not pipe a value in, do not run it for them, and do not ask for the value in chat/);
  for (const mention of mentions(out).filter((m) => m.startsWith("secrets"))) {
    assert.match(mention, /^secrets (set <host> <NAME>|edit <file>|rekey|set shared \S+)$/, `\`fleet ${mention}\` could carry a value`);
    assert.doesNotMatch(mention, /[|=]/);
  }
  assert.doesNotMatch(recipes(out), /echo |printf |<<</, "no recipe shows a value being piped");
});

test("recipes only run what the push rule allows: push, apply, init and secrets are the user's, and each recipe ends by saying what to ask for", () => {
  const out = setup().run().stdout;
  assert.match(recipes(out), /`fleet push`, `fleet apply`, `fleet init <host>` and every command that changes secrets are not: run them only when the user asked for that action in this turn/);
  assert.match(recipes(out), /Each recipe ends by telling the user what to ask for, not by running it/);
  // Any line that names one of those commands must put it in the user's hands.
  const lines = recipes(out).split("\n").filter((l) => /`fleet (push|apply|init|secrets)\b/.test(l));
  assert.ok(lines.length > 6);
  for (const line of lines) assert.match(line, /\b(ask|asks|asked|themselves|user|users|theirs|never|not)\b/i, `unguarded: ${line}`);
  for (const [title, block] of blocks(out)) {
    const stop = block.slice(block.indexOf("Stop and hand over:"));
    assert.match(stop, /ask for `fleet (push|apply)`|ask the user to run `fleet init <host>`|ask the user to run `fleet secrets set/, `${title} does not end with what to ask for`);
    assert.doesNotMatch(stop, /\bRun `fleet (push|apply)/, `${title} runs push or apply itself`);
  }
});

test("onboarding reads config by key names, keeps tokens out of the config and ends with the user's review", () => {
  const onboard = blocks(setup().run().stdout).get("Set up this machine (onboarding)")!;
  assert.match(onboard, /by key names, not values/);
  assert.match(onboard, /~\/\.claude\.json/);
  assert.match(onboard, /opencode\.jsonc/);
  assert.match(onboard, /Anything secret-looking .* becomes a `secret:NAME` reference, and you never copy the value/);
  assert.match(onboard, /Do not print `~\/\.claude\.json` or `opencode\.jsonc`: they hold tokens/);
  assert.match(onboard, /`fleet diff`/);
  assert.match(onboard, /`fleet adopt mcp <name>`/);
  assert.match(onboard, /`fleet adopt skill <name>`/);
  assert.match(onboard, /reviews the draft in full before anything is pushed/);
});

test("the recipes hold no email address, tailnet name or private address, and use laptop and server", () => {
  const text = recipes(setup().run().stdout);
  assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[a-z]{2,}|\.ts\.net\b|\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+/i);
  assert.match(text, /`laptop`, `server`/);
});
