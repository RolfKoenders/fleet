import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { prompter } from "../src/prompt.ts";
import { rotate } from "../src/secretsrotate.ts";
import type { RotateOptions } from "../src/secretsrotate.ts";
import { gitEnv, git, publish, runFleet, tempDir } from "./helpers.ts";
import { identityOf, newIdentity, setup } from "./initworld.ts";
import { findTool } from "../src/tools.ts";
import type { S } from "./initworld.ts";
import { scriptedTerminal } from "./terminal.ts";

Object.assign(process.env, gitEnv);

/** `BOTH` is in the shared file and in server's own; `SHARED_ONLY` in shared; `OWN_ONLY` in server's. Two servers in the catalog use some of them. */
function world(): S {
  const s = setup();
  const done = s.json(["server"]);
  assert.equal(done.doc.ok, true, JSON.stringify(done.doc));
  s.setSecret("shared", "BOTH", "old-both-shared");
  s.setSecret("server", "BOTH", "old-both-own");
  s.setSecret("shared", "SHARED_ONLY", "old-shared-only");
  s.setSecret("server", "OWN_ONLY", "old-own-only");
  s.write("catalog/mcp.yaml", "servers:\n  alpha:\n    command: [alpha]\n    env:\n      TOKEN: secret:BOTH\n  beta:\n    command: [beta]\n    env:\n      KEY: secret:BOTH\n");
  publish(s.clone, "servers");
  return s;
}

const SOPS = findTool("sops");

const calls = { push: 0, doctor: 0 };
const fakes = (): Pick<RotateOptions, "push" | "doctor"> => ({
  push: async () => (calls.push++, { code: "ok" }),
  doctor: async () => (calls.doctor++, { code: "ok" }),
});

const run = (s: S, answers: (string | null)[], over: Partial<RotateOptions> = {}) => {
  const term = scriptedTerminal(answers);
  return rotate(s.clone, { home: s.home, prompt: prompter(term), ...fakes(), ...over }).then((result) => ({ result, term }));
};

test("a new value is set in every file that holds the secret, and never shown", async () => {
  const s = world();
  const NEW = "mock-NEW-both-9d1e";
  // value, push: y, doctor: y
  const { result, term } = await run(s, [`${NEW}\r`, "y", "y"], { names: ["BOTH"] });
  assert.equal(result.code, "ok", JSON.stringify(result));
  assert.equal(s.decrypt("shared", "BOTH", s.admin), NEW);
  const lab = identityOf(s.lab);
  assert.equal(s.decrypt("server", "BOTH", lab), NEW);
  assert.deepEqual((result.fields as any).rotated, [{ name: "BOTH", files: ["secrets/shared.enc.yaml", "secrets/server.enc.yaml"] }]);
  assert.match(term.shown(), /used by: alpha, beta/);
  assert.match(term.shown(), /set in: secrets\/shared\.enc\.yaml, secrets\/server\.enc\.yaml/);
  // One commit for the secrets files; the push and the check were offered and ran.
  assert.equal(git(s.clone, "log", "-1", "--format=%s"), "Rotate secret BOTH");
  assert.equal(git(s.clone, "status", "--porcelain"), "");
  assert.equal(calls.push > 0 && calls.doctor > 0, true);
  assert.match(result.text!, /committed and pushed/);
  assert.match(result.text!, /does not revoke the old token/);
  for (const where of [term.shown(), result.text!, JSON.stringify(result), git(s.clone, "log", "-p", "-1")]) assert.ok(!where.includes(NEW), "the value is nowhere");
});

test("a secret that is skipped is left as it was, and the summary lists it", async () => {
  const s = world();
  const before = ["shared", "server"].map((f) => s.read(`secrets/${f}.enc.yaml`));
  const head = git(s.clone, "rev-parse", "HEAD");
  const { result } = await run(s, ["\r"], { names: ["BOTH"] });
  assert.equal(result.code, "ok");
  assert.deepEqual(["shared", "server"].map((f) => s.read(`secrets/${f}.enc.yaml`)), before);
  assert.equal(git(s.clone, "rev-parse", "HEAD"), head, "nothing to commit");
  assert.deepEqual((result.fields as any).skipped, ["BOTH"]);
  assert.match(result.text!, /Skipped: BOTH\. Run `fleet secrets rotate`/);
});

test("without names it lists every secret to pick from, and sets only the picked ones", async () => {
  const s = world();
  const { result, term } = await run(s, ["2\r", "mock-picked\r", "n"]);
  assert.equal(result.code, "ok", JSON.stringify(result));
  const names = ["BOTH", "OWN_ONLY", "SHARED_ONLY"];
  for (const n of names) assert.match(term.shown(), new RegExp(`\\d+\\. ${n}`));
  assert.deepEqual((result.fields as any).rotated.map((r: any) => r.name), ["OWN_ONLY"]);
  assert.equal(s.decrypt("shared", "SHARED_ONLY", s.admin), "old-shared-only");
  assert.ok(!term.shown().includes("mock-picked"));
});

test("a value too long, or blank, is asked for again without repeating it", async () => {
  const s = world();
  const { result, term } = await run(s, ["   \r", "mock-good\r", "n"], { names: ["SHARED_ONLY"] });
  assert.equal(result.code, "ok");
  assert.equal(s.decrypt("shared", "SHARED_ONLY", s.admin), "mock-good");
  assert.ok(term.asked() >= 3);
});

test("ctrl-c stops the rotation and keeps what was set", async () => {
  const s = world();
  const { result } = await run(s, ["mock-first\r", null], { names: ["BOTH", "SHARED_ONLY"] });
  assert.equal(result.code, "ok", JSON.stringify(result));
  assert.equal(s.decrypt("shared", "BOTH", s.admin), "mock-first");
  assert.equal(s.decrypt("shared", "SHARED_ONLY", s.admin), "old-shared-only");
  assert.deepEqual((result.fields as any).skipped, ["SHARED_ONLY"]);
  assert.equal(git(s.clone, "log", "-1", "--format=%s"), "Rotate secret BOTH");
});

test("when one file cannot take the value, the others are put back", async () => {
  const s = world();
  // server's own file is encrypted for a key this machine does not have: sops cannot open it.
  const other = newIdentity();
  const plain = join(tempDir("fleet-plain-"), "server.yaml");
  writeFileSync(plain, "BOTH: x\n");
  const sealed = spawnSync(SOPS!, ["encrypt", "--age", other.recipient, "--input-type", "yaml", "--output-type", "yaml", plain], { encoding: "utf8" });
  assert.equal(sealed.status, 0, sealed.stderr);
  writeFileSync(join(s.clone, "secrets/server.enc.yaml"), sealed.stdout);
  git(s.clone, "commit", "-qam", "server's file is for another key");
  const shared = s.read("secrets/shared.enc.yaml");
  const NEW = "mock-NEW-fail-55aa";
  const { result, term } = await run(s, [`${NEW}\r`], { names: ["BOTH"] });
  assert.notEqual(result.code, "ok", JSON.stringify(result));
  assert.equal(s.read("secrets/shared.enc.yaml"), shared, "the shared file is as it was");
  assert.match(term.shown(), /BOTH was not changed/);
  for (const where of [term.shown(), result.text ?? "", JSON.stringify(result)]) assert.ok(!where.includes(NEW));
});

test("a name that is not a secret is refused without being echoed", async () => {
  const s = world();
  const { result, term } = await run(s, [], { names: ["mock-pasted-value"] });
  assert.equal(result.code, "invalid");
  assert.ok(!JSON.stringify(result).includes("mock-pasted") && !term.shown().includes("mock-pasted"));
});

test("on the command line it needs a terminal, with or without --json, and says so without a value", () => {
  const s = world();
  for (const args of [["secrets", "rotate", "BOTH"], ["secrets", "rotate", "BOTH", "--json"]]) {
    const r = runFleet(s.clone, args, { home: s.home, input: "mock-typed-value\n" });
    assert.notEqual(r.code, 0);
    assert.match(r.stdout + r.stderr, /needs a terminal/);
    assert.ok(!(r.stdout + r.stderr).includes("mock-typed"));
  }
  assert.equal(s.decrypt("shared", "BOTH", s.admin), "old-both-shared");
});
