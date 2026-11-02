import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridgeFor, cloneSource, makeRepo, ok } from "./fixture.ts";
import { paintDiff } from "../../src/tui/buffer.ts";
import { bridge } from "../../src/tui/bridge.ts";
import { items, search } from "../../src/tui/palette.ts";
import { loadModel } from "../../src/tui/model.ts";
import { parseSopsText, readCatalog, readCommitDiff, readHistory, readSecrets } from "../../src/tui/reads.ts";
import { sourceDir } from "../../src/sources.ts";
import { makeHome, repoRoot, runFleet, makeClone } from "../helpers.ts";

const NEW = (shas: string[]) => ({
  laptop: ok({ applied: { at: "x", ageSeconds: 5, config: shas[4]! } }),
  server: ok({ applied: { at: "x", ageSeconds: 5, config: shas[2]!.slice(0, 12) } }),
  box: { result: "unreachable" as const, status: null, detail: "x" },
  edge: { result: "timer" as const, status: null },
});

async function open(clone = false) {
  const r = makeRepo();
  if (clone) cloneSource(r.home);
  const b = await bridgeFor(r.dir, { hosts: NEW(r.shas) }, { home: r.home });
  return { ...r, b };
}

const tree = (dir: string): string[] => readdirSync(dir, { recursive: true }).map(String).sort();

test("timeline: the history is listed newest first, with a marker where each host last applied", async () => {
  const { b } = await open();
  b.press("4");
  await b.settle();
  b.advance(100);
  const f = b.frame();
  assert.match(f, /5 commits in the config repo/);
  assert.match(f, /Edit the rules[^\n]*◆ laptop/);
  assert.match(f, /Rotate the tracker key[^\n]*◆ server/, "a shortened sha from a host still finds its commit");
  assert.match(f, /unknown: box \(no answer\), edge \(timer, no ssh destination\)/);
  assert.ok(f.indexOf("Edit the rules") < f.indexOf("Start the config"));
});

test("timeline: a host whose state predates the recorded commit, or whose commit is not in the history, is unknown", async () => {
  const r = makeRepo();
  const hosts = { ...NEW(r.shas), laptop: ok({ applied: { at: "x", ageSeconds: 5, config: null } }), server: ok({ applied: { at: "x", ageSeconds: 5, config: "deadbeefdeadbeef" } }) };
  const b = await bridgeFor(r.dir, { hosts }, { home: r.home });
  b.press("4");
  await b.settle();
  b.advance(100);
  const f = b.frame();
  assert.match(f, /laptop \(older apply, commit not recorded\)/);
  assert.match(f, /server \(not in the commits shown\)/);
  assert.doesNotMatch(f.split("\n").slice(5).join("\n"), /◆ (laptop|server)/);
});

test("timeline: selecting a commit shows its diff, and a secrets file is named, not diffed", async () => {
  const { b } = await open();
  b.press("4");
  await b.settle();
  assert.match(b.frame(), /\+Be brief\./);
  b.press("down", "down");
  await b.settle();
  b.advance(100);
  const f = b.frame();
  assert.match(f, /secrets changed \(names only/);
  assert.match(f, /secrets\/shared\.enc\.yaml: changed TRACKER_API_KEY/);
  assert.doesNotMatch(f, /ENC\[|AES256|BEGIN AGE/);
  b.press("up");
  await b.settle();
  b.advance(100);
  assert.match(b.frame(), /recipients changed/);
});

test("reads: a commit that adds secrets lists the names added, and no ciphertext reaches the patch", () => {
  const r = makeRepo();
  const d = readCommitDiff(r.dir, r.home, r.shas[1]!);
  assert.ok(d.ok);
  assert.deepEqual(d.secrets.map((s) => [s.file, s.added]), [["secrets/server.enc.yaml", ["DB_PASSWORD"]], ["secrets/shared.enc.yaml", ["PROXY_TOKEN", "TRACKER_API_KEY"]]]);
  assert.ok(d.patch.every((l) => !/ENC\[|enc\.yaml/.test(l)));
  assert.ok(d.patch.some((l) => l.includes("PROXY_TOKEN")), "the host file that names the secret is still diffed");
  assert.equal(readCommitDiff(r.dir, r.home, "--output=/tmp/x").ok, false, "a sha is checked before it reaches git");
});

test("reads: sops mac and lastmodified are not names, and recipients are read from the sops block", () => {
  const file = parseSopsText("A: ENC[x]\nB: ENC[y]\nsops:\n    age:\n        - recipient: age1abc\n          enc: |\n            z\n    lastmodified: x\n    mac: ENC[m]\n    version: 3\n");
  assert.deepEqual([...file.entries.keys()], ["A", "B"]);
  assert.deepEqual(file.recipients, ["age1abc"]);
});

test("secrets: names with the file, the hosts that can decrypt, the users, and the last change of that name alone", async () => {
  const { b } = await open();
  b.press("5");
  await b.settle();
  let f = b.frame();
  assert.match(f, /3 secret names in the encrypted files/);
  assert.match(f, /PROXY_TOKEN +shared +2 hosts +2026-10-02/);
  assert.match(f, /TRACKER_API_KEY +shared +2 hosts +2026-10-03/, "only the rotated name moved");
  assert.match(f, /hosts that can decrypt it: laptop, server/);
  assert.match(f, /settings: hosts\/box\.yaml/);
  b.press("down");
  assert.match(b.frame(), /servers: tracker-local/);
  assert.doesNotMatch(f, /ENC\[/);
});

test("secrets: a host shows what it can read, as what to rotate if it were lost", async () => {
  const { b } = await open();
  b.press("5", "v");
  await b.settle();
  b.press("down", "down");
  const f = b.frame();
  assert.match(f, /laptop +3 secret names/);
  assert.match(f, /box +0 secret names/, "box was removed from the shared file");
  assert.match(f, /if you lost laptop, rotate these 3/);
  assert.match(f, /DB_PASSWORD +server/);
});

test("secrets: the screen never reaches sops or a key", () => {
  const text = readFileSync(join(repoRoot, "src/tui/reads.ts"), "utf8");
  assert.doesNotMatch(text, /from "\.\.\/(sops|secrets|secretscli)\.ts"/);
  const r = makeRepo();
  const view = readSecrets(r.dir, r.home);
  assert.deepEqual(view.entries.map((e) => e.name), ["PROXY_TOKEN", "TRACKER_API_KEY", "DB_PASSWORD"]);
  assert.deepEqual(view.entries.find((e) => e.name === "DB_PASSWORD")!.readers, ["laptop", "server"]);
});

test("catalog: a source that is not cloned says so, and looking never clones it", async () => {
  const { b, home } = await open();
  b.press("6");
  await b.settle();
  const f = b.frame();
  assert.match(f, /source: not cloned \(example-skills\)/);
  assert.match(f, /size: unknown/);
  assert.equal(existsSync(sourceDir(home, "example-skills")), false);
  assert.equal(existsSync(join(home, ".local/share/fleet")), false);
});

test("catalog: a cloned skill shows SKILL.md, its source and pin, bundle, hosts and a size estimate", async () => {
  const { b } = await open(true);
  b.press("6");
  await b.settle();
  const f = b.frame();
  assert.match(f, /bundle: core/);
  assert.match(f, /source: example-skills, pinned 1234567 \(tracks main\), clone at [0-9a-f]{7}/);
  assert.match(f, /hosts that get it: laptop, box, edge/);
  assert.match(f, /size: about \d+ tokens \(an estimate: characters \/ 4\)/);
  assert.match(f, /Review the change\./);
  assert.match(f, /debug +not found/);
});

test("catalog: the size is characters over four, rounded up", () => {
  const r = makeRepo();
  const dir = cloneSource(r.home);
  const chars = readFileSync(join(dir, "skills/review/SKILL.md"), "utf8").length;
  const skill = readCatalog(r.dir, r.home).skills.find((s) => s.name === "review")!;
  assert.equal(skill.tokens, Math.ceil(chars / 4));
});

test("catalog: f filters by fuzzy match across skills and servers, enter keeps it, esc clears it", async () => {
  const { b } = await open();
  b.press("6", "f");
  b.type("trk");
  let f = b.frame();
  assert.match(f, /filter trk/);
  assert.match(f, /server tracker/);
  assert.doesNotMatch(f, /skill +review/);
  b.type("q");
  assert.match(b.frame(), /nothing matches/);
  b.press("backspace", "enter");
  assert.equal((b.state as { screen: string }).screen, "catalog", "q typed in the filter did not quit and a later enter kept it");
  b.press("escape");
  f = b.frame();
  assert.match(f, /skill +review/);
  assert.equal((b.state as { screen: string }).screen, "catalog", "the first escape only clears the filter");
  b.press("escape");
  assert.equal((b.state as { screen: string }).screen, "home");
});

test("catalog: a server shows its transport, the secret names it uses and the hosts that get it", async () => {
  const { b } = await open();
  b.press("6", "f");
  b.type("tracker-l");
  b.press("enter");
  const f = b.frame();
  assert.match(f, /transport: stdio, only for claude/);
  assert.match(f, /secret names: TRACKER_API_KEY/);
  assert.match(f, /hosts that get it: box/);
});

test("text from outside cannot reach the terminal as an escape sequence: a commit message and a SKILL.md", async () => {
  const { b } = await open(true);
  const bytes: string[] = [];
  for (const keys of [["4"], ["6"]]) {
    b.press(...keys);
    await b.settle();
    b.advance(100);
    const frame = b.frame();
    assert.doesNotMatch(frame, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    bytes.push(paintDiff(null, b.buffer(), "truecolor"));
  }
  const out = bytes.join("");
  const known = out.replace(/\u001b\[[0-9;]*[mHJ]/g, "");
  assert.doesNotMatch(known, /[\u001b\u0007\u009b\u009d]/, "every escape in the output is one the screen wrote itself");
  assert.match(bytes[0]!, /Edit the rules \?\[31mRED\?\]0;pwned\? end/);
  assert.match(bytes[1]!, /\?\[2J\?\]0;pwned\?Then stop\./);
});

test("the three screens are in navigation and the palette", async () => {
  const { b } = await open();
  const state = () => (b.state as { screen: string }).screen;
  b.press("4");
  assert.equal(state(), "timeline");
  b.press("tab");
  assert.equal(state(), "secrets");
  b.press("tab");
  assert.equal(state(), "catalog");
  b.press("tab");
  assert.equal(state(), "home");
  const all = items(loadModel(makeRepo().dir, "laptop"));
  for (const name of ["Timeline", "Secrets", "Catalog"]) assert.equal(search(all, name.toLowerCase())[0]!.item.label, name);
  b.press("ctrl+k");
  b.type("secr");
  b.press("enter");
  assert.equal(state(), "secrets");
});

test("the header fits all six tabs and the read-only pill at 100 columns", async () => {
  const { b } = await open();
  assert.match(b.frame().split("\n")[0]!, /1 Home +2 Matrix +3 Conflicts +4 Timeline +5 Secrets +6 Catalog +read-only/);
});

test("browsing writes nothing: the config repo and the home are as they were", async () => {
  const r = makeRepo();
  cloneSource(r.home);
  const before = { config: tree(r.dir), home: tree(r.home), status: spawnSync("git", ["status", "--porcelain"], { cwd: r.dir, encoding: "utf8" }).stdout };
  const b = await bridgeFor(r.dir, { hosts: NEW(r.shas) }, { home: r.home });
  for (const k of ["4", "down", "down", "pagedown", "5", "v", "down", "6", "f"]) b.press(k);
  b.type("rev");
  b.press("enter", "r");
  await b.settle();
  readHistory(r.dir, r.home);
  assert.deepEqual({ config: tree(r.dir), home: tree(r.home), status: spawnSync("git", ["status", "--porcelain"], { cwd: r.dir, encoding: "utf8" }).stdout }, before);
});

test("bridge without a terminal points at fleet status --all before it looks for a config", async () => {
  let looked = false;
  const r = await bridge(repoRoot, () => ((looked = true), "/nonexistent"), false, {}, makeHome("laptop"));
  assert.equal(looked, false);
  assert.match(((r as { messages?: string[] }).messages ?? []).join(), /needs a terminal.*fleet status --all/);
  const { clone } = makeClone();
  const run = runFleet(clone, ["bridge"], { home: makeHome("laptop"), env: { FLEET_CONFIG: "/nonexistent" } });
  assert.match(run.stderr, /needs a terminal.*fleet status --all/);
});

test("history of a directory that is not a repository is an explained failure", () => {
  const r = makeRepo();
  const h = readHistory(join(r.home), r.home);
  assert.equal(h.ok, false);
});
