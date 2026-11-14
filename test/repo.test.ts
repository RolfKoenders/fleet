import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { repoRoot, tempDir } from "./helpers.ts";

test("vendor/README.md records the version and sha256 of vendor/js-yaml.mjs", () => {
  const readme = readFileSync(join(repoRoot, "vendor/README.md"), "utf8");
  const hash = createHash("sha256").update(readFileSync(join(repoRoot, "vendor/js-yaml.mjs"))).digest("hex");
  assert.match(readme, /\| version \| 5\.5\.0 \|/);
  assert.ok(readme.includes(`| sha256 | ${hash} |`), "README hash does not match the vendored file");
});

/** One line per `.js` file under `dir`, sorted by path: `<path> <sha256>`. Hashed, that is what vendor/README.md records for `yaml/`. */
function treeHash(dir: string): string {
  const lines = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".js"))
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
    .sort()
    .map((path) => `${path} ${createHash("sha256").update(readFileSync(join(dir, path))).digest("hex")}\n`);
  return createHash("sha256").update(lines.join("")).digest("hex");
}

test("vendor/README.md records the version and tree hash of vendor/yaml, and its LICENSE is there", () => {
  const readme = readFileSync(join(repoRoot, "vendor/README.md"), "utf8");
  assert.match(readme, /\| version \| 2\.9\.1 \|/);
  assert.ok(readme.includes(`| tree sha256 | ${treeHash(join(repoRoot, "vendor/yaml"))} |`), `README hash does not match vendor/yaml, which is ${treeHash(join(repoRoot, "vendor/yaml"))}`);
  assert.match(readFileSync(join(repoRoot, "vendor/yaml/LICENSE"), "utf8"), /ISC|Permission to use, copy, modify/);
});

test("the type-check rejects non-erasable syntax", () => {
  const dir = tempDir("fleet-tsc-");
  writeFileSync(join(dir, "bad.ts"), "export enum Color { Red }\n");
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ extends: join(repoRoot, "tsconfig.json"), include: ["bad.ts"] }),
  );
  const tsc = join(repoRoot, "node_modules/typescript/bin/tsc");
  const r = spawnSync(process.execPath, [tsc, "-p", dir], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /TS1294/);
});
