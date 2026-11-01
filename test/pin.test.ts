import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, makeHome, makeWorld, pinText, publish, runBin, tempDir } from "./helpers.ts";
import { EXIT } from "../src/exit.ts";

const NOT_ENFORCED = /pinned tool commit was not enforced/;
const stateFile = (home: string) => join(home, ".local/state/fleet/applied.json");
const head = (dir: string) => git(dir, "rev-parse", "HEAD");
const detached = (dir: string) => git(dir, "branch", "--show-current") === "";

/** A tool commit whose main.ts says so on stderr, so a run of that code can be told from a run of the old one. */
function markedCommit(w: ReturnType<typeof makeWorld>, marker = "running the new code"): string {
  const main = readFileSync(join(w.tool, "src/main.ts"), "utf8");
  return w.toolCommit({ "src/main.ts": `process.stderr.write("${marker}\\n");\n${main}` });
}

test("the config is read from ~/.config/fleet/config, and the tool's own directory is never read for one", () => {
  const w = makeWorld();
  // The tool in the managed clone holds invalid decoys of hosts/, catalog/ and secrets/; the real files are in the config.
  for (const decoy of ["hosts/laptop.yaml", "hosts/_defaults.yaml", "catalog/skills.yaml", "catalog/mcp.yaml", "secrets/shared.enc.yaml"]) assert.equal(existsSync(join(w.managed, decoy)), true, decoy);
  const r = w.run(["apply", "--json"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(JSON.parse(r.stdout).host, "laptop");
  assert.equal(readlinkSync(join(w.home, ".claude/skills/fleet")), join(w.managed, "skills/fleet"));
});

test("FLEET_CONFIG overrides the file", () => {
  const w = makeWorld();
  const other = tempDir("fleet-other-");
  mkdirSync(join(other, "hosts"));
  writeFileSync(join(other, "hosts/laptop.yaml"), "from-the-override: true\n");
  writeFileSync(join(other, "fleet.yaml"), pinText(w.toolRemote, w.first));
  const r = w.run(["diff"], { FLEET_CONFIG: other });
  assert.equal(r.code, EXIT.invalid, "the file's config is fine, so only the override can have made this invalid");
  assert.match(r.stderr, new RegExp(`${other}/hosts/laptop.yaml: unknown key 'from-the-override'`));
});

test("without a config repo set, a command that needs one exits 2 and says how to set it", () => {
  const w = makeWorld();
  rmSync(join(w.home, ".config/fleet/config"));
  for (const command of ["apply", "diff", "status", "push", "update"]) {
    const r = w.run([command]);
    assert.equal(r.code, EXIT.invalid, `${command}: ${r.stderr}`);
    assert.match(r.stderr, /no config repo is set.*FLEET_CONFIG/);
  }
  assert.equal(existsSync(stateFile(w.home)), false);
  assert.equal(w.run(["help"]).code, EXIT.ok, "help needs none");
  assert.equal(w.run(["agent"]).code, EXIT.ok, "agent says so instead of failing");
});

test("a config path that is relative, empty or not a directory exits 2", () => {
  const w = makeWorld();
  for (const text of ["relative/path\n", "\n", `${w.base}/nowhere\n`]) {
    writeFileSync(join(w.home, ".config/fleet/config"), text);
    const r = w.run(["diff"]);
    assert.equal(r.code, EXIT.invalid, `${JSON.stringify(text)}: ${r.stderr}`);
  }
});

test("a missing or invalid pin is exit 2, from apply, diff and a development run alike", () => {
  const bad: [string, string | null][] = [
    ["a missing file", null],
    ["a sha that is too short", pinText("https://example.invalid/fleet.git", "abc123")],
    ["a sha in capitals", pinText("https://example.invalid/fleet.git", "A".repeat(40))],
    ["no track", "tool:\n  repo: https://example.invalid/fleet.git\n  commit: " + "a".repeat(40) + "\n"],
    ["an unknown key", pinText("https://example.invalid/fleet.git", "a".repeat(40)) + "  extra: 1\n"],
    ["no tool map", "commit: " + "a".repeat(40) + "\n"],
  ];
  for (const [what, text] of bad) {
    const w = makeWorld();
    if (text === null) rmSync(join(w.config, "fleet.yaml"));
    else writeFileSync(join(w.config, "fleet.yaml"), text);
    publish(w.config, "bad pin");
    for (const [name, r] of [["apply", w.run(["apply"])], ["diff", w.run(["diff"])], ["dev apply", w.runDev(["apply"])]] as const) {
      assert.equal(r.code, EXIT.invalid, `${what}, ${name}: ${r.stderr}`);
      assert.match(r.stderr, /fleet\.yaml/, `${what}, ${name}`);
    }
    assert.equal(head(w.managed), w.first, `${what}: the fleet clone was not moved`);
    assert.equal(existsSync(stateFile(w.home)), false, `${what}: nothing written`);
  }
});

test("apply checks the pinned commit out in the fleet clone, detached, and the new code does the rest", () => {
  const w = makeWorld();
  const next = markedCommit(w);
  w.pin(next);
  const r = w.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(head(w.managed), next);
  assert.equal(detached(w.managed), true);
  assert.equal(r.stderr.match(/running the new code/g)?.length, 1, "the old code did not print it, the relaunched new code did, once");
  assert.equal(r.stderr.match(/the fleet clone moved/g)?.length, 1, "one relaunch, not a chain");
  assert.equal(JSON.parse(readFileSync(stateFile(w.home), "utf8")).repos.fleet, next, "state records the commit that applied");
});

test("under --json the relaunch still prints exactly one document, and its exit code passes through", () => {
  const w = makeWorld();
  w.pin(markedCommit(w));
  const ok = w.run(["apply", "--json"]);
  assert.equal(ok.code, EXIT.ok, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).code, "ok");

  const w2 = makeWorld();
  const next = markedCommit(w2);
  w2.pin(next);
  writeFileSync(join(w2.config, "hosts/laptop.yaml"), "nonsense: true\n");
  publish(w2.config, "break the host file");
  const bad = w2.run(["apply", "--json"]);
  assert.equal(bad.code, EXIT.invalid);
  assert.equal(JSON.parse(bad.stdout).code, "invalid");
  assert.equal(head(w2.managed), next, "the new code found the host file invalid, so the clone did move to the pin");
});

test("a fleet clone already at the pin is not fetched or relaunched", () => {
  const w = makeWorld();
  rmSync(w.toolRemote, { recursive: true });
  const r = w.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(r.stderr, "", "no relaunch message, no fetch error");
});

test("the pin is a commit, not the head of main: a later tool commit is not run until the pin moves", () => {
  const w = makeWorld();
  markedCommit(w);
  const r = w.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(head(w.managed), w.first);
  assert.doesNotMatch(r.stderr, /running the new code/);
});

test("the fleet clone is only moved under the lock", () => {
  const w = makeWorld();
  w.pin(markedCommit(w));
  const lock = join(w.home, ".local/state/fleet/lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "pid"), `${process.pid}\n`);
  const r = w.run(["apply"]);
  assert.equal(r.code, EXIT.locked, r.stderr);
  assert.equal(head(w.managed), w.first, "held lock: the clone did not move");
  rmSync(lock, { recursive: true });
  assert.equal(w.run(["apply"]).code, EXIT.ok);
  assert.notEqual(head(w.managed), w.first, "free lock: it moved");
});

test("diff and status never move the fleet clone", () => {
  const w = makeWorld();
  w.pin(markedCommit(w));
  assert.equal(w.run(["diff"]).code, EXIT.ok);
  assert.equal(w.run(["status"]).code, EXIT.ok);
  assert.equal(head(w.managed), w.first);
});

test("uncommitted changes in the fleet clone are a repo conflict: nothing moves and nothing is written", () => {
  const w = makeWorld();
  w.pin(markedCommit(w));
  writeFileSync(join(w.managed, "scratch.txt"), "half done");
  const r = w.run(["apply", "--json"]);
  const doc = JSON.parse(r.stdout);
  assert.equal(r.code, EXIT.conflict, r.stderr);
  assert.equal(doc.conflicts.length, 1);
  assert.equal(doc.conflicts[0].kind, "repo");
  assert.equal(doc.conflicts[0].path, w.managed);
  assert.match(doc.conflicts[0].detail, /uncommitted changes/);
  assert.match(doc.conflicts[0].fix, /separate checkout/);
  assert.equal(head(w.managed), w.first);
  assert.equal(existsSync(stateFile(w.home)), false);
});

test("local commits in the fleet clone are a repo conflict, even when the pin is unchanged elsewhere", () => {
  const w = makeWorld();
  writeFileSync(join(w.managed, "mine.txt"), "mine");
  git(w.managed, "add", "-A");
  git(w.managed, "commit", "-m", "local only");
  const mine = head(w.managed);
  w.pin(markedCommit(w));
  const r = w.run(["apply", "--json"]);
  const doc = JSON.parse(r.stdout);
  assert.equal(r.code, EXIT.conflict, r.stderr);
  assert.match(doc.conflicts[0].detail, /1 local commit/);
  assert.equal(head(w.managed), mine);
  assert.equal(existsSync(stateFile(w.home)), false);
});

test("a repo conflict on the fleet clone is shown in human output with its fix", () => {
  const w = makeWorld();
  w.pin(markedCommit(w));
  writeFileSync(join(w.managed, "scratch.txt"), "half done");
  const r = w.run(["apply"]);
  assert.equal(r.code, EXIT.conflict);
  assert.match(r.stdout, /conflict .*: .*uncommitted changes/);
  assert.match(r.stdout, /\n {2}fix: /);
});

test("a pinned commit that is not in the tool repo exits 2 and moves nothing", () => {
  const w = makeWorld();
  w.pin("b".repeat(40));
  const r = w.run(["apply"]);
  assert.equal(r.code, EXIT.invalid, r.stderr);
  assert.match(r.stderr, /pinned tool commit b{40} is not in/);
  assert.equal(head(w.managed), w.first);
});

test("a tool repo that cannot be fetched from exits 4 when the pin needs it", () => {
  const w = makeWorld();
  const next = markedCommit(w);
  w.pin(next);
  rmSync(w.toolRemote, { recursive: true });
  const r = w.run(["apply", "--json"]);
  assert.equal(r.code, EXIT.unreachable, r.stderr);
  assert.equal(JSON.parse(r.stdout).code, "unreachable");
  assert.equal(head(w.managed), w.first);
  assert.equal(existsSync(stateFile(w.home)), false);
});

test("a changed tool.repo takes effect: the fleet clone is pointed at the new repo", () => {
  const w = makeWorld();
  const mirror = join(w.base, "mirror.git");
  git(w.base, "clone", "--quiet", "--bare", w.toolRemote, mirror);
  const next = markedCommit(w);
  git(w.tool, "push", mirror, "main");
  rmSync(w.toolRemote, { recursive: true });
  w.pin(next, mirror);
  const r = w.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(git(w.managed, "remote", "get-url", "origin"), mirror);
  assert.equal(head(w.managed), next);
});

test("a pin change that is not yet in the config repo's remote is not run: local work in it is a conflict", () => {
  const w = makeWorld();
  const next = markedCommit(w);
  writeFileSync(join(w.config, "fleet.yaml"), pinText(w.toolRemote, next));
  const r = w.run(["apply", "--json"]);
  const doc = JSON.parse(r.stdout);
  assert.equal(r.code, EXIT.conflict, r.stderr);
  assert.equal(doc.conflicts[0].path, w.config);
  assert.equal(head(w.managed), w.first, "the tool stays where the published config pins it");
});

test("a run from a development checkout uses its own code and never fetches, moves or relaunches a tool clone", () => {
  const w = makeWorld();
  const next = markedCommit(w, "the pinned code ran");
  w.pin(next);
  // The dev checkout is behind the pin, dirty, and has a local commit; the tool repo is gone, so any fetch would fail.
  writeFileSync(join(w.dev, "mine.txt"), "mine");
  git(w.dev, "add", "-A");
  git(w.dev, "commit", "-m", "local only");
  writeFileSync(join(w.dev, "scratch.txt"), "half done");
  const devHead = head(w.dev);
  const devRefs = git(w.dev, "for-each-ref");
  rmSync(w.toolRemote, { recursive: true });

  const r = w.runDev(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(r.stderr.trim().split("\n").length, 1, `one line on stderr: ${r.stderr}`);
  assert.match(r.stderr, NOT_ENFORCED);
  assert.match(r.stderr, new RegExp(w.dev));
  assert.doesNotMatch(r.stderr, /pinned code ran|clone moved/);
  assert.equal(head(w.dev), devHead, "the dev checkout did not move");
  assert.equal(git(w.dev, "for-each-ref"), devRefs, "and nothing was fetched into it");
  assert.equal(readFileSync(join(w.dev, "scratch.txt"), "utf8"), "half done");
  assert.equal(head(w.managed), w.first, "the managed clone was not touched either");
  assert.equal(readlinkSync(join(w.home, ".claude/skills/fleet")), join(w.managed, "skills/fleet"), "the skill link is always the managed clone's");
});

test("a development run says the pin was not enforced under --json too, on stderr only", () => {
  const w = makeWorld();
  const r = w.runDev(["apply", "--json"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stderr, NOT_ENFORCED);
  assert.equal(JSON.parse(r.stdout).code, "ok");
  assert.equal(w.runDev(["diff"]).stderr, "", "only apply enforces the pin, so only apply says it did not");
});

test("every apply installs the fleet skill from the tool, with no files line", () => {
  const w = makeWorld();
  const r = w.run(["apply", "--json"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  const link = join(w.home, ".claude/skills/fleet");
  assert.equal(readlinkSync(link), join(w.managed, "skills/fleet"));
  assert.match(readFileSync(join(link, "SKILL.md"), "utf8"), /^name: fleet$/m);
  assert.equal(readFileSync(join(w.config, "hosts/laptop.yaml"), "utf8"), "{}\n", "the config says nothing about it");
  assert.deepEqual(JSON.parse(w.run(["apply", "--json"]).stdout).created, [], "and a second apply has nothing to do");
});

test("a config cannot pick the fleet skill's target for something else", () => {
  const w = makeWorld();
  writeFileSync(join(w.config, "hosts/laptop.yaml"), "files:\n  - { source: fleet.yaml, target: ~/.claude/skills/fleet }\n");
  publish(w.config, "try to take the skill's place");
  const r = w.run(["apply"]);
  assert.equal(r.code, EXIT.invalid, r.stderr);
  assert.match(r.stderr, /fleet skill, which every apply installs from the tool/);
  assert.equal(existsSync(join(w.home, ".claude/skills/fleet")), false);
});

test("a config cannot drop the fleet skill: no exclude, bundle or host file removes it", () => {
  const w = makeWorld();
  writeFileSync(join(w.config, "hosts/_defaults.yaml"), "exclude: [fleet]\n");
  publish(w.config, "try to drop it");
  const r = w.run(["apply"]);
  assert.equal(r.code, EXIT.invalid, "'exclude' names bundles, and there is none called fleet");
  assert.match(r.stderr, /names bundle 'fleet', which is not in catalog\/skills.yaml/);
  const bundle = makeWorld();
  mkdirSync(join(bundle.config, "catalog"));
  writeFileSync(join(bundle.config, "catalog/skills.yaml"), "bundles:\n  mine: [fleet]\n");
  publish(bundle.config, "bundle named fleet");
  const b = bundle.run(["apply"]);
  assert.equal(b.code, EXIT.invalid, b.stderr);
  assert.match(b.stderr, /'fleet' is a reserved name/);
});

test("push commits and pushes the config repo only, never the tool", () => {
  const w = makeWorld();
  // A development checkout with work in it, and the managed clone with a commit of its own.
  writeFileSync(join(w.dev, "scratch.txt"), "half done");
  writeFileSync(join(w.dev, "src/extra.ts"), "export {};\n");
  git(w.dev, "add", "src/extra.ts");
  git(w.dev, "commit", "-m", "work on the tool");
  writeFileSync(join(w.dev, "more.txt"), "uncommitted");
  const toolBefore = git(w.toolRemote, "rev-parse", "main");
  const devHead = head(w.dev);

  writeFileSync(join(w.config, "hosts/laptop.yaml"), "bundles: []\n");
  const r = w.runDev(["push", "-m", "describe"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(git(w.descRemote, "log", "-1", "--format=%s", "main"), "describe", "the config was committed and pushed");
  assert.equal(git(w.toolRemote, "rev-parse", "main"), toolBefore, "the tool's remote did not move");
  assert.equal(head(w.dev), devHead, "no commit was made in the tool");
  assert.equal(git(w.dev, "status", "--porcelain").split("\n").sort().join(), "?? more.txt,?? scratch.txt", "its work is still uncommitted and unstaged");
  assert.match(r.stderr, new RegExp(`committed 1 file in ${w.config}`));
  assert.doesNotMatch(r.stderr, new RegExp(`(committed|pushed).*${w.dev}`));
});

test("push from the managed clone publishes a moved pin, and a host that applies then runs that commit", () => {
  const w = makeWorld();
  const next = markedCommit(w);
  writeFileSync(join(w.config, "fleet.yaml"), pinText(w.toolRemote, next));
  const r = w.run(["push", "-m", "move the pin"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(git(w.descRemote, "show", "main:fleet.yaml"), new RegExp(next));
  assert.equal(head(w.managed), next, "the local apply moved the fleet clone to the pin it just published");
  assert.equal(git(w.toolRemote, "rev-parse", "main"), next, "and the tool remote is exactly where it was");
});

const pinFile = (w: ReturnType<typeof makeWorld>) => readFileSync(join(w.config, "fleet.yaml"), "utf8");

test("update moves the pin to the head of the tracked branch and nothing else: no commit, no apply, no clone moved", () => {
  const w = makeWorld();
  const next = w.toolCommit({ "notes.md": "x" });
  const commits = head(w.config);
  const r = w.run(["update", "--json"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.deepEqual([doc.from, doc.to, doc.updated], [w.first, next, true]);
  assert.equal(pinFile(w), pinText(w.toolRemote, next));
  assert.equal(head(w.config), commits, "nothing was committed");
  assert.equal(git(w.config, "status", "--porcelain"), "M fleet.yaml", "only fleet.yaml is dirty");
  assert.equal(git(w.descRemote, "rev-parse", "main"), commits, "nothing was pushed");
  assert.equal(head(w.managed), w.first, "the fleet clone did not move");
  assert.equal(existsSync(stateFile(w.home)), false, "no apply");
  assert.match(r.stderr, /Nothing was committed or applied/);
});

test("update changes only the commit line, byte for byte", () => {
  const w = makeWorld();
  const next = w.toolCommit({ "notes.md": "x" });
  const text = `# The pin. ${w.first} is mentioned here too, and must stay.\r\ntool:   # the tool\r\n  repo:    ${w.toolRemote}   # where from\r\n  commit:  "${w.first}"   # moved by fleet update\r\n  track: main\r\n\r\n# end\r\n`;
  writeFileSync(join(w.config, "fleet.yaml"), text);
  const r = w.run(["update"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(pinFile(w), text.replace(`commit:  "${w.first}"`, `commit:  "${next}"`));
});

test("update with the pin already at the head says so and writes nothing", () => {
  const w = makeWorld();
  const r = w.run(["update"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stdout, /up to date/);
  assert.equal(git(w.config, "status", "--porcelain"), "");
});

test("update follows the track branch, not main", () => {
  const w = makeWorld();
  git(w.tool, "checkout", "-b", "stable");
  const onStable = w.toolCommit({ "stable.md": "x" });
  git(w.tool, "push", "origin", "stable");
  git(w.tool, "checkout", "main");
  w.toolCommit({ "main-only.md": "y" });
  writeFileSync(join(w.config, "fleet.yaml"), pinText(w.toolRemote, w.first, "stable"));
  assert.equal(w.run(["update"]).code, EXIT.ok);
  assert.match(pinFile(w), new RegExp(`commit: ${onStable}`));
});

test("update exits 4 for a repo it cannot reach and 2 for a branch that is not there, writing nothing", () => {
  const w = makeWorld();
  writeFileSync(join(w.config, "fleet.yaml"), pinText(w.toolRemote, w.first, "nope"));
  publish(w.config, "track a branch that does not exist");
  const noBranch = w.run(["update"]);
  assert.equal(noBranch.code, EXIT.invalid, noBranch.stderr);
  assert.match(noBranch.stderr, /branch nope is not in/);

  writeFileSync(join(w.config, "fleet.yaml"), pinText(w.toolRemote, w.first));
  publish(w.config, "track main");
  rmSync(w.toolRemote, { recursive: true });
  const gone = w.run(["update", "--json"]);
  assert.equal(gone.code, EXIT.unreachable, gone.stderr);
  assert.equal(JSON.parse(gone.stdout).code, "unreachable");
  assert.equal(git(w.config, "status", "--porcelain"), "");
});

test("update refuses a pin it cannot edit exactly, and an invalid pin, with exit 2", () => {
  const w = makeWorld();
  w.toolCommit({ "notes.md": "x" });
  const flow = `tool: { repo: ${w.toolRemote}, commit: ${w.first}, track: main }\n`;
  writeFileSync(join(w.config, "fleet.yaml"), flow);
  const r = w.run(["update"]);
  assert.equal(r.code, EXIT.invalid, r.stderr);
  assert.match(r.stderr, /cannot find the 'commit:' line/);
  assert.equal(pinFile(w), flow);

  rmSync(join(w.config, "fleet.yaml"));
  assert.equal(w.run(["update"]).code, EXIT.invalid);
});

test("update works from a development checkout too, and takes no lock and no host name", () => {
  const w = makeWorld();
  const next = w.toolCommit({ "notes.md": "x" });
  rmSync(join(w.home, ".config/fleet/host"));
  const lock = join(w.home, ".local/state/fleet/lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "pid"), `${process.pid}\n`);
  const r = w.runDev(["update"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(pinFile(w), new RegExp(next));
});

test("managed apply, dev apply and managed apply all succeed with the skill link unchanged", () => {
  const w = makeWorld();
  const link = join(w.home, ".claude/skills/fleet");
  assert.equal(w.run(["apply"]).code, EXIT.ok);
  assert.equal(readlinkSync(link), join(w.managed, "skills/fleet"));
  const dev = w.runDev(["apply", "--json"]);
  assert.equal(dev.code, EXIT.ok, dev.stderr);
  assert.deepEqual(JSON.parse(dev.stdout).conflicts, []);
  assert.equal(readlinkSync(link), join(w.managed, "skills/fleet"));
  assert.equal(w.run(["apply"]).code, EXIT.ok);
  assert.equal(readlinkSync(link), join(w.managed, "skills/fleet"));
});

test("a dev push on a host the timer has applied does not conflict on the skill link", () => {
  const w = makeWorld();
  assert.equal(w.run(["apply"]).code, EXIT.ok);
  writeFileSync(join(w.config, "hosts/laptop.yaml"), "bundles: []\n");
  const r = w.runDev(["push", "-m", "describe"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(readlinkSync(join(w.home, ".claude/skills/fleet")), join(w.managed, "skills/fleet"));
});

test("a dev run on a host with no managed clone skips the skill link instead of making a dangling or self link", () => {
  const w = makeWorld();
  const fresh = makeHome(w.host);
  const r = runBin(join(w.dev, "bin/fleet"), ["apply"], { home: fresh, env: { FLEET_CONFIG: w.config } });
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(existsSync(join(fresh, ".claude/skills/fleet")), false);
  const d = runBin(join(w.dev, "bin/fleet"), ["diff"], { home: fresh, env: { FLEET_CONFIG: w.config } });
  assert.equal(d.code, EXIT.ok, d.stderr);
});
