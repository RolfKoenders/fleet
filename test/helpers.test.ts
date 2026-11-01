import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { repoRoot } from "./helpers.ts";

/** Runs `body` in a new process with `helpers.ts` imported as `h`, and returns what it left behind. */
function leftovers(body: string): { code: number | null; stderr: string; left: string[] } {
  const parent = mkdtempSync(join(tmpdir(), "fleet-leak-"));
  const script = `import * as h from ${JSON.stringify(join(repoRoot, "test/helpers.ts"))};\nimport * as fs from "node:fs";\n${body}`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TMPDIR: parent }, encoding: "utf8" });
  const left = readdirSync(parent);
  spawnSync("chmod", ["-R", "u+rwx", parent]);
  rmSync(parent, { recursive: true, force: true });
  return { code: r.status, stderr: r.stderr, left };
}

test("temp directories are gone when the test process ends", () => {
  const r = leftovers(`const d = h.tempDir(); fs.writeFileSync(d + "/f", "x"); h.makeHome("laptop");`);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.left, []);
});

test("a read-only directory inside a temp directory does not stop the clean-up", () => {
  const r = leftovers(`const d = h.tempDir(); fs.mkdirSync(d + "/locked"); fs.writeFileSync(d + "/locked/f", "x"); fs.chmodSync(d + "/locked", 0o000);`);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.left, []);
});

test("a failing test process still cleans up", () => {
  const r = leftovers(`h.tempDir(); process.exitCode = 1;`);
  assert.equal(r.code, 1);
  assert.deepEqual(r.left, []);
});
