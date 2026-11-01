import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "../vendor/js-yaml.mjs";
import { makeClone, makeHome, publish, repoRoot, runFleet } from "./helpers.ts";
import { EXIT } from "../src/exit.ts";

const EM_DASH = String.fromCharCode(0x2014);
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

const SKILL = [
  "---",
  "name: fleet",
  "description: Use when changing agent config, skills, MCP servers, settings or secrets on this machine, or when asked about fleet, its status, a conflict or a push.",
  "---",
  "",
  "This machine's agent setup is managed by fleet. Run `fleet agent` for the concepts, commands and current state. Pass `--json` when you will read the output.",
  "",
  "`fleet status` and `fleet diff` are always safe.",
  "",
  "Never run `fleet push`, `fleet apply`, or a command that changes secrets unless the user asked for that action in this turn.",
  "",
].join("\n");

test("skills/fleet/SKILL.md is exactly the pinned text", () => {
  assert.equal(read("skills/fleet/SKILL.md"), SKILL);
});

function frontmatter(text: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, "no frontmatter");
  return load(match[1]!) as Record<string, unknown>;
}

test("the fleet skill is valid for Claude and for opencode", () => {
  const meta = frontmatter(read("skills/fleet/SKILL.md"));
  // Both read `name` and `config`. opencode also requires the name to be its directory's, lowercase with single hyphens, 1 to 64 characters.
  assert.deepEqual(Object.keys(meta).sort(), ["description", "name"]);
  assert.equal(meta.name, "fleet");
  assert.match(String(meta.name), /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(String(meta.name).length <= 64);
  assert.equal(typeof meta.description, "string");
  const config = meta.description as string;
  assert.ok(config.length >= 1 && config.length <= 1024, `config is ${config.length} characters`);
  assert.equal(config.includes("\n"), false);
  // Model-invocable: the body carries the push rule, so the skill must not opt out of model invocation.
  assert.equal("disable-model-invocation" in meta, false);
  assert.match(read("skills/fleet/SKILL.md"), /Never run `fleet push`, `fleet apply`, or a command that changes secrets unless the user asked for that action in this turn\./);
  assert.ok(existsSync(join(repoRoot, "skills/fleet/SKILL.md")));
});

test("the skill has no em dash", () => {
  assert.equal(read("skills/fleet/SKILL.md").includes(EM_DASH), false);
});

test("a host with an empty config still gets the skill linked by apply, and a second apply is a no-op", () => {
  const fleetOnly = "{}\n";

  const { clone } = makeClone();
  cpSync(join(repoRoot, "skills"), join(clone, "skills"), { recursive: true });
  mkdirSync(join(clone, "hosts"), { recursive: true });
  writeFileSync(join(clone, "hosts/_defaults.yaml"), fleetOnly);
  for (const host of ["laptop", "server"]) writeFileSync(join(clone, "hosts", `${host}.yaml`), "{}\n");
  publish(clone);

  for (const host of ["laptop", "server"]) {
    const home = makeHome(host);
    const managed = join(home, ".local/share/fleet/fleet");
    cpSync(join(repoRoot, "skills"), join(managed, "skills"), { recursive: true });
    const first = runFleet(clone, ["apply", "--json"], { home });
    assert.equal(first.code, EXIT.ok, first.stderr);
    const link = join(home, ".claude/skills/fleet");
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readlinkSync(link), join(managed, "skills/fleet"));
    assert.equal(readFileSync(join(link, "SKILL.md"), "utf8"), SKILL, "the skill is readable through the link");
    const second = JSON.parse(runFleet(clone, ["apply", "--json"], { home }).stdout);
    assert.deepEqual([second.created, second.updated, second.removed], [[], [], []]);
  }
});
