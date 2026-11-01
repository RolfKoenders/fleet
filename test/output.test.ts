import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installStatusTools, makeClone, makeHome, publish, runFleet } from "./helpers.ts";

const ESC = "\u001b[";

function setup(host?: string) {
  const { clone } = makeClone();
  const home = makeHome(host);
  // `status` runs claude, opencode, sops and systemctl: always the fakes, never the real ones on the probe path.
  installStatusTools(home);
  if (host !== undefined) {
    mkdirSync(join(clone, "hosts"), { recursive: true });
    writeFileSync(join(clone, "hosts", `${host}.yaml`), "{}\n");
    publish(clone);
  }
  return (args: string[], env?: Record<string, string>) => runFleet(clone, args, { home, env });
}

test("--json prints exactly one document with ok, code, host and messages", () => {
  const r = setup("laptop")(["status", "--json"]);
  const doc = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(doc).slice(0, 4), ["ok", "code", "host", "messages"]);
  assert.equal(doc.ok, true);
  assert.equal(doc.code, "ok");
  assert.equal(doc.host, "laptop");
  assert.deepEqual(doc.messages, []);
});

test("messages go to stderr, and into the document under --json", () => {
  const run = setup();
  const human = run(["status"]);
  assert.match(human.stderr, /no host name/);
  assert.doesNotMatch(human.stdout, /no host name/);

  const json = run(["status", "--json"]);
  assert.match(json.stderr, /no host name/);
  assert.match(JSON.parse(json.stdout).messages[0], /no host name/);
});

test("a bad argument under --json is still one document, with ok false", () => {
  const r = setup("laptop")(["bogus", "--json"]);
  assert.equal(r.code, 2);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.ok, false);
  assert.equal(doc.code, "invalid");
  assert.match(doc.messages[0], /unknown command/);
  assert.match(r.stderr, /unknown command/);
});

test("an unknown flag under --json is also one document", () => {
  const r = setup("laptop")(["status", "--nope", "--json"]);
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.stdout).code, "invalid");
});

test("help --json lists the commands", () => {
  const doc = JSON.parse(setup("laptop")(["help", "--json"]).stdout);
  assert.ok(doc.commands.some((c: { name: string }) => c.name === "status"));
});

test("no color without a terminal", () => {
  assert.doesNotMatch(setup("laptop")(["status"]).stdout, /\u001b/);
});

test("color can be forced, and NO_COLOR wins over it", () => {
  const run = setup("laptop");
  assert.ok(run(["status"], { FORCE_COLOR: "1" }).stdout.includes(ESC));
  assert.ok(!run(["status"], { FORCE_COLOR: "1", NO_COLOR: "1" }).stdout.includes(ESC));
});

test("--json never contains color codes", () => {
  assert.ok(!setup("laptop")(["status", "--json"], { FORCE_COLOR: "1" }).stdout.includes(ESC));
});
