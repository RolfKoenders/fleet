import { test } from "node:test";
import assert from "node:assert/strict";
import { makeClone, makeHome, runFleet } from "./helpers.ts";
import { EXIT } from "../src/exit.ts";

const commands = ["status", "diff", "apply", "push", "adopt", "secrets", "skills", "init", "agent", "help"];

function setup(host: string | undefined = "laptop") {
  const { clone } = makeClone();
  const home = makeHome(host);
  return { clone, home, run: (args: string[], env?: Record<string, string>) => runFleet(clone, args, { home, env }) };
}

test("exit code names and numbers are fixed", () => {
  assert.deepEqual(EXIT, {
    ok: 0,
    error: 1,
    invalid: 2,
    conflict: 3,
    unreachable: 4,
    "needs-secret": 5,
    "missing-prerequisite": 6,
    locked: 7,
  });
});

for (const form of [["help"], ["--help"], []]) {
  test(`fleet ${form.join(" ") || "(no arguments)"} lists the commands and exits 0`, () => {
    const r = setup().run(form);
    assert.equal(r.code, 0);
    for (const name of commands) assert.match(r.stdout, new RegExp(`^  ${name}\\b`, "m"));
    assert.match(r.stdout, /--json/);
  });
}

test("an unknown command exits 2 and says so on stderr", () => {
  const r = setup().run(["frobnicate"]);
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /unknown command.*frobnicate/);
  assert.equal(r.stdout, "");
});

test("an unknown flag exits 2", () => {
  const r = setup().run(["status", "--nope"]);
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /--nope/);
});

test("a stray argument exits 2", () => {
  const r = setup().run(["status", "extra"]);
  assert.equal(r.code, EXIT.invalid);
});
