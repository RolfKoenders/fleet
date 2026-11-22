import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_IDS, AGENTS } from "../src/agents/index.ts";
import { InvalidConfigError, loadConfig } from "../src/config.ts";
import { referenceKeys } from "../src/configkeys.ts";
import type { ReferenceFile } from "../src/configkeys.ts";
import { load } from "../vendor/js-yaml.mjs";
import { repoRoot, tempDir } from "./helpers.ts";

const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

/** The reference page of each config file. */
const PAGE: Record<ReferenceFile, string> = {
  "fleet.yaml": "docs/reference-fleet-yaml.md",
  hosts: "docs/reference-hosts.md",
  "catalog/mcp.yaml": "docs/reference-catalog-mcp.md",
  "catalog/skills.yaml": "docs/reference-catalog-skills.md",
};
const FILES = Object.keys(PAGE) as ReferenceFile[];

type Entry = { key: string; text: string };

/** The keys a page documents: each `### \`key\`` heading and the text up to the next heading. */
function entries(page: string): Entry[] {
  const found: Entry[] = [];
  let at: Entry | null = null;
  for (const line of read(page).split("\n")) {
    const key = line.match(/^### `([^`]+)`$/);
    if (key !== null) found.push((at = { key: key[1]!, text: "" }));
    else if (/^#{1,3} /.test(line)) at = null;
    else if (at !== null) at.text += `${line}\n`;
  }
  return found;
}

test("reference: every key the loaders accept has an entry, and every entry names a key they accept", () => {
  for (const file of FILES) {
    const documented = entries(PAGE[file]).map((e) => e.key);
    const known = referenceKeys()[file];
    assert.deepEqual(
      known.filter((k) => !documented.includes(k)),
      [],
      `${PAGE[file]}: the loader accepts these keys and the page has no '### \`key\`' entry for them`,
    );
    assert.deepEqual(
      documented.filter((k) => !known.includes(k)),
      [],
      `${PAGE[file]}: these entries name keys the loader does not know`,
    );
    assert.equal(new Set(documented).size, documented.length, `${PAGE[file]}: a key has two entries`);
  }
});

test("reference: the key list is what the loaders accept", () => {
  const home = tempDir("fleet-reference-");
  // A value of null is the wrong type for every key, which is a different problem from an unknown key.
  const nest = (path: string): unknown => {
    const [head, ...rest] = path.split(".");
    const name = head!.replace("<name>", "x").replace("<agent>", "claude");
    if (name.endsWith("[]")) return { [name.slice(0, -2)]: [nest(rest.join("."))] };
    return { [name]: rest.length === 0 ? null : nest(rest.join(".")) };
  };
  const unknownKeys = (file: ReferenceFile, doc: unknown): string[] => {
    const config = tempDir("fleet-reference-config-");
    mkdirSync(join(config, "hosts"), { recursive: true });
    mkdirSync(join(config, "catalog"), { recursive: true });
    writeFileSync(join(config, "hosts/laptop.yaml"), "{}");
    // JSON is YAML. The host file and the defaults both get the keys of the hosts page.
    for (const path of file === "hosts" ? ["hosts/laptop.yaml", "hosts/_defaults.yaml"] : [file]) writeFileSync(join(config, path), JSON.stringify(doc));
    try {
      loadConfig(config, "laptop", { home, sources: "none" });
      return [];
    } catch (error) {
      if (!(error instanceof InvalidConfigError)) throw error;
      return error.problems.filter((p) => p.includes("unknown key"));
    }
  };
  for (const file of FILES) {
    for (const key of referenceKeys()[file]) {
      const problems = unknownKeys(file, nest(key));
      // A host-only key is unknown in the defaults, so the defaults are only probed with the keys they take.
      const ownFile = problems.filter((p) => file !== "hosts" || !p.includes("_defaults.yaml"));
      assert.deepEqual(ownFile, [], `${key}: the loader calls a key of the reference unknown`);
    }
    assert.notEqual(unknownKeys(file, { bogus: null }).length, 0, `${file}: the loader accepts a key that is not in the list`);
  }
});

test("reference: each entry has a type, a default, a description and an example that is YAML", () => {
  for (const file of FILES) {
    for (const { key, text } of entries(PAGE[file])) {
      const at = `${PAGE[file]} '${key}'`;
      assert.match(text, /^Type: .+\. Default: .+\./m, `${at}: no 'Type: ... Default: ...' line`);
      assert.match(text, /\n\n[A-Z`][^\n]+\n/, `${at}: no description`);
      const blocks = [...text.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!);
      assert.ok(blocks.length > 0, `${at}: no example`);
      for (const block of blocks) assert.doesNotThrow(() => load(block), `${at}: the example is not YAML`);
    }
  }
});

test("reference: a version an entry says added it is a released version, or not yet released", () => {
  const released = [...read("CHANGELOG.md").matchAll(/^## (\d+\.\d+\.\d+) - /gm)].map((m) => m[1]!);
  for (const file of FILES) {
    for (const { key, text } of entries(PAGE[file])) {
      const added = text.match(/Added in: ([^.]*(?:\.\d+)*)/)?.[1];
      if (added === undefined) continue;
      const versions = added.match(/\d+\.\d+\.\d+/g) ?? [];
      assert.ok(versions.length > 0 || added === "not yet released", `${PAGE[file]} '${key}': 'Added in' is neither a version nor 'not yet released'`);
      for (const v of versions) assert.ok(released.includes(v), `${PAGE[file]} '${key}': ${v} is not a release in CHANGELOG.md`);
    }
  }
});

test("reference: the pages name every agent where a list of agents is the value", () => {
  const hosts = entries(PAGE.hosts);
  const settings = hosts.find((e) => e.key === "settings.<agent>")!.text;
  for (const agent of AGENTS.filter((a) => a.settings !== undefined)) {
    assert.ok(settings.includes(`\`${agent.id}\``), `settings.<agent> does not name ${agent.id}`);
    assert.ok(settings.includes(agent.settings!.file), `settings.<agent> does not say where ${agent.id}'s settings file is`);
  }
  const agents = hosts.find((e) => e.key === "agents")!.text;
  for (const id of AGENT_IDS) assert.ok(agents.includes(`\`${id}\``), `agents does not name ${id}`);
  const only = entries(PAGE["catalog/mcp.yaml"]).find((e) => e.key === "servers.<name>.only")!.text;
  for (const agent of AGENTS.filter((a) => a.mcp !== undefined)) assert.ok(only.includes(`\`${agent.id}\``), `only does not name ${agent.id}`);
});
