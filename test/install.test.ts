import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeClone, makeHome, publish, repoRoot, skipIfSystemWide, tempDir } from "./helpers.ts";
import { EXIT } from "../src/exit.ts";

const script = join(repoRoot, "install.sh");

/** A local bare repo standing in for GitHub, holding this working tree's tool and its examples. */
const { clone, remote } = makeClone();
cpSync(join(repoRoot, "examples"), join(clone, "examples"), { recursive: true });
publish(clone);

function setup(opts: { node?: boolean } = {}) {
  const home = makeHome();
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  if (opts.node !== false) symlinkSync(process.execPath, join(home, ".local/bin/node"));
  const env = { HOME: home, PATH: `${home}/.local/bin:/usr/bin:/bin`, GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", FLEET_INSTALL_REPO: remote };
  // As `curl ... | sh` runs it: from stdin, with no path to itself.
  const install = (extra: Record<string, string> = {}) => {
    const r = spawnSync("sh", [], { input: readFileSync(script, "utf8"), encoding: "utf8", cwd: home, env: { ...env, ...extra } });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const tool = join(home, ".local/share/fleet/fleet");
  const link = join(home, ".local/bin/fleet");
  const fleet = (args: string[], cwd: string = home) => {
    const r = spawnSync(link, args, { encoding: "utf8", cwd, env });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { home, tool, link, install, fleet };
}

test("the script clones the tool, links fleet and names the next step, and fleet then runs", () => {
  const s = setup();
  const r = s.install();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(existsSync(join(s.tool, ".git")), true);
  assert.equal(readlinkSync(s.link), join(s.tool, "bin/fleet"));
  assert.match(r.stdout, /fleet new ~\/fleet-config/);
  const help = s.fleet(["help"]);
  assert.equal(help.code, EXIT.ok, help.stderr);
  assert.match(help.stdout, /makes each host match its config/);
});

test("running the script again changes nothing", () => {
  const s = setup();
  assert.equal(s.install().code, 0);
  const before = statSync(join(s.tool, ".git/HEAD")).mtimeMs;
  const again = s.install();
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /already in/);
  assert.doesNotMatch(again.stdout, /Cloned|Linked/);
  assert.equal(statSync(join(s.tool, ".git/HEAD")).mtimeMs, before);
});

test("the script leaves a fleet it did not install alone, and clones nothing", () => {
  const s = setup();
  writeFileSync(s.link, "mine\n");
  const r = s.install();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /already exists and points somewhere else/);
  assert.equal(readFileSync(s.link, "utf8"), "mine\n");
  assert.equal(existsSync(s.tool), false);
});

test("the script stops at something in the tool's place", () => {
  const s = setup();
  mkdirSync(s.tool, { recursive: true });
  const r = s.install();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not a git clone/);
  assert.equal(existsSync(s.link), false);
});

test("the script stops without a usable Node, and clones nothing", { skip: skipIfSystemWide("node") }, () => {
  const s = setup({ node: false });
  const r = s.install();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Node 22\.18/);
  assert.equal(existsSync(s.tool), false);
});

test("the script says what is still missing and where to get it", { skip: skipIfSystemWide("sops", "age-keygen") }, () => {
  const r = setup().install();
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /You still need sops/);
  assert.match(r.stdout, /You still need age/);
});

test("the script says when ~/.local/bin is not on the PATH", () => {
  const r = setup().install({ PATH: "/usr/bin:/bin" });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Add ~\/\.local\/bin to your PATH/);
});

test("an installed fleet starts a config, and init finds it from the folder it runs in", () => {
  const s = setup();
  assert.equal(s.install().code, 0);
  const target = join(tempDir("fleet-install-"), "fleet-config");
  const made = s.fleet(["new", target]);
  assert.equal(made.code, EXIT.ok, made.stderr);
  assert.match(made.stdout, new RegExp(`cd ${target} && fleet init laptop`));
  // The new repo has no remote yet, and only init reading the repo can know that.
  const inside = s.fleet(["init", "laptop"], target);
  assert.equal(inside.code, EXIT.invalid);
  assert.match(inside.stderr, /no 'origin' remote/);
  const elsewhere = s.fleet(["init", "laptop"]);
  assert.equal(elsewhere.code, EXIT.invalid);
  assert.match(elsewhere.stderr, /no config repo is set/);
});

test("other commands do not take the config from the folder they run in", () => {
  const s = setup();
  assert.equal(s.install().code, 0);
  const target = join(tempDir("fleet-install-"), "fleet-config");
  assert.equal(s.fleet(["new", target]).code, EXIT.ok);
  const r = s.fleet(["diff"], target);
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /no config repo is set/);
});
