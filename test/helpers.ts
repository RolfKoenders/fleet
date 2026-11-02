import { spawnSync } from "node:child_process";
import { existsSync, chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LAUNCHD_LABEL } from "../src/scheduler.ts";
import { HOMEBREW_BIN, HOMEBREW_KEG_NODES } from "../src/tools.ts";

export const repoRoot = join(import.meta.dirname, "..");

export type Run = { code: number | null; stdout: string; stderr: string };

const tempDirs: string[] = [];

export function tempDir(prefix = "fleet-test-"): string {
  // The real path: on macOS the temp directory is behind a symlink (/var is /private/var), and git and
  // `readlink -f` print the real one.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

process.on("exit", () => {
  for (const dir of tempDirs) {
    // A test may leave a directory it locked, which rm alone cannot enter.
    spawnSync("chmod", ["-R", "u+rwx", dir]);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      process.stderr.write(`could not remove ${dir}: ${e}\n`);
    }
  }
});

export function makeHome(host?: string): string {
  const home = tempDir("fleet-home-");
  if (host !== undefined) {
    mkdirSync(join(home, ".config/fleet"), { recursive: true });
    writeFileSync(join(home, ".config/fleet/host"), `${host}\n`);
  }
  return home;
}

export function writeExecutable(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

const gitEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...gitEnv } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

export function pinText(repo: string, commit: string, track = "main"): string {
  return `tool:\n  repo: ${repo}\n  commit: ${commit}\n  track: ${track}\n`;
}

/**
 * A fleet clone in a temp dir that is both the tool and the config: the real wrapper and source, plus a
 * `fleet.yaml` whose pin is not a real commit, committed on `main` and pushed to a local bare repo standing in
 * for GitHub. Run from here, `fleet` is a development run (not the managed fleet clone) with
 * `FLEET_CONFIG` pointing back at the same directory.
 */
export function makeClone(): { clone: string; remote: string } {
  const base = tempDir("fleet-clone-");
  const remote = join(base, "remote.git");
  const clone = join(base, "fleet");
  git(base, "init", "--bare", "--initial-branch=main", remote);
  mkdirSync(clone);
  for (const entry of ["bin", "src", "vendor", "skills", "package.json"]) {
    cpSync(join(repoRoot, entry), join(clone, entry), { recursive: true });
  }
  writeFileSync(join(clone, "fleet.yaml"), pinText(remote, "a".repeat(40)));
  git(clone, "init", "--initial-branch=main");
  git(clone, "add", "-A");
  git(clone, "commit", "-m", "initial");
  git(clone, "remote", "add", "origin", remote);
  git(clone, "push", "-u", "origin", "main");
  return { clone, remote };
}

/**
 * The link to the tool's `fleet` skill that every apply makes, already in place on `home`. A test about something
 * else uses this so the link does not count among the changes it is counting.
 */
export function linkFleetSkill(home: string, tool: string): void {
  mkdirSync(join(home, ".claude/skills"), { recursive: true });
  symlinkSync(join(tool, "skills/fleet"), join(home, ".claude/skills/fleet"));
}

/**
 * Makes the pin in a clone's `fleet.yaml` a real commit, the clone's own HEAD, on the clone's own remote, and publishes it.
 * For tests where the clone is both the tool and the config, so a host that clones the pinned tool gets the
 * same code. Returns the pinned commit.
 */
export function pinToHead(clone: string): string {
  const commit = git(clone, "rev-parse", "HEAD");
  writeFileSync(join(clone, "fleet.yaml"), pinText(git(clone, "remote", "get-url", "origin"), commit));
  publish(clone, "pin the tool");
  return commit;
}

export function publish(clone: string, message = "edit"): void {
  if (git(clone, "status", "--porcelain") === "") return;
  git(clone, "add", "-A");
  git(clone, "commit", "-m", message);
  git(clone, "push", "--quiet");
}

export function runBin(bin: string, args: string[], opts: { home: string; env?: Record<string, string>; input?: string }): Run {
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    input: opts.input ?? "",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: opts.home,
      FLEET_NODE: process.execPath,
      ...gitEnv,
      ...opts.env,
    },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Run `bin/fleet` from a clone made by `makeClone`, which is both the tool and the config: a development run,
 * with `FLEET_CONFIG` pointing back at the clone unless the test says otherwise.
 */
export function runFleet(
  clone: string,
  args: string[],
  opts: { home: string; env?: Record<string, string>; input?: string },
): Run {
  return runBin(join(clone, "bin/fleet"), args, { ...opts, env: { FLEET_CONFIG: clone, ...opts.env } });
}

export function bareToolPath(): string {
  const dir = tempDir("fleet-path-");
  for (const tool of ["readlink", "dirname"]) {
    symlinkSync(`/usr/bin/${tool}`, join(dir, tool));
  }
  return dir;
}

const FAKE_CLAUDE = `
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.HOME;
const file = path.join(home, ".claude.json");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(home, "claude-calls.log"), JSON.stringify(args) + "\\n");
const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {});
const write = (doc) => {
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), { mode: 0o644 });
  fs.chmodSync(file, parseInt(process.env.FAKE_CLAUDE_MODE || "644", 8));
};
const [group, verb, ...rest] = args;
if (group !== "mcp" || rest[0] !== "--scope" || rest[1] !== "user") process.exit(2);
const name = rest[2];
const doc = read();
doc.mcpServers = doc.mcpServers || {};
if (verb === "add-json") {
  const entry = JSON.parse(rest[3]);
  // Like the real tool, store defaults the caller left out.
  doc.mcpServers[name] = entry.type === "stdio" ? { type: "stdio", command: entry.command, args: entry.args || [], env: entry.env || {} } : entry;
  write(doc);
} else if (verb === "remove") {
  if (!(name in doc.mcpServers)) { console.error("No MCP server found with name: " + name); process.exit(1); }
  delete doc.mcpServers[name];
  write(doc);
} else process.exit(2);
`;

export function installFakeClaude(home: string): void {
  const script = join(home, ".fake-claude.js");
  writeFileSync(script, FAKE_CLAUDE);
  writeExecutable(join(home, ".local/bin/claude"), `#!/bin/sh\nexec ${process.execPath} ${script} "$@"\n`);
}

export function claudeCalls(home: string): string[][] {
  try {
    return readFileSync(join(home, "claude-calls.log"), "utf8").trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as string[]);
  } catch {
    return [];
  }
}

export function makeSource(files: Record<string, string>, branch = "main") {
  const base = tempDir("fleet-source-");
  const remote = join(base, "remote.git");
  const work = join(base, "work");
  git(base, "init", "--bare", `--initial-branch=${branch}`, remote);
  mkdirSync(work);
  git(work, "init", `--initial-branch=${branch}`);
  git(work, "remote", "add", "origin", remote);
  const commit = (more: Record<string, string>, message = "change") => {
    for (const [path, content] of Object.entries(more)) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), content);
    }
    git(work, "add", "-A");
    git(work, "commit", "-m", message);
    git(work, "push", "-u", "origin", branch);
    return git(work, "rev-parse", "HEAD");
  };
  const first = commit(files, "initial");
  return { remote, first, commit, work };
}

export type FakeToolSpec = {
  stdout?: string;
  exit?: number;
  /** The one argument list the fake answers to. Anything else is a usage error (exit 2), still logged. */
  only?: string[];
};

/**
 * A fake `name` in the host's `~/.local/bin`, which comes first on the probe path. Each call appends its
 * arguments, as JSON, to `~/<name>-calls.log`. The real tool is on the probe path too, so a test that can
 * reach one installs the fake first and checks the log to know the fake was the one found.
 */
export function installFakeTool(home: string, name: string, spec: FakeToolSpec = {}): void {
  const config = join(home, `.fake-${name}.json`);
  writeFileSync(config, JSON.stringify(spec));
  const script = join(home, `.fake-${name}.js`);
  writeFileSync(
    script,
    `const fs = require("node:fs");
const spec = JSON.parse(fs.readFileSync(${JSON.stringify(config)}, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(home, `${name}-calls.log`))}, JSON.stringify(args) + "\\n");
if (spec.only && JSON.stringify(spec.only) !== JSON.stringify(args)) { console.error("fake ${name}: unexpected arguments"); process.exit(2); }
if (spec.stdout !== undefined) process.stdout.write(spec.stdout + "\\n");
process.exit(spec.exit === undefined ? 0 : spec.exit);
`,
  );
  writeExecutable(join(home, ".local/bin", name), `#!/bin/sh\nexec ${process.execPath} ${script} "$@"\n`);
}

export function toolCalls(home: string, name: string): string[][] {
  try {
    return readFileSync(join(home, `${name}-calls.log`), "utf8").trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as string[]);
  } catch {
    return [];
  }
}

export const FAKE_VERSIONS = { claude: "2.1.4", opencode: "1.4.2", sops: "3.13.3" };

/**
 * The tools `fleet status` runs, faked: versions for `claude`, `opencode` and `sops` (the way each prints
 * it), and an active `fleet.timer`. Each fake answers only to the exact arguments status should use.
 */
export function installStatusTools(home: string): void {
  installFakeTool(home, "claude", { stdout: `${FAKE_VERSIONS.claude} (Claude Code)`, only: ["--version"] });
  installFakeTool(home, "opencode", { stdout: FAKE_VERSIONS.opencode, only: ["--version"] });
  installFakeTool(home, "sops", { stdout: `sops ${FAKE_VERSIONS.sops}`, only: ["--version", "--disable-version-check"] });
  fakeTimer(home, "active");
}

/**
 * The timer in `state`, as both schedulers report it: `systemctl` prints the word, and `launchctl print`
 * finds the agent loaded only when it is `active`. Status asks whichever the OS running the tests has.
 */
export function fakeTimer(home: string, state: string): void {
  installFakeTool(home, "systemctl", { stdout: state, exit: state === "active" ? 0 : 3, only: ["--user", "is-active", "fleet.timer"] });
  installFakeTool(home, "launchctl", { exit: state === "active" ? 0 : 113, only: ["print", `gui/${process.getuid?.()}/${LAUNCHD_LABEL}`] });
}

/** A reason to skip a test about Linux's scheduler or its absence of a macOS log, or false on Linux. */
export const linuxOnly: string | false = process.platform === "linux" ? false : "the tests run on macOS, and this one is about Linux";

export type SshPlan = { home?: string; exit?: number; stdout?: string; stderr?: string };

const FAKE_SSH = `
const fs = require("node:fs");
const cp = require("node:child_process");
const home = process.env.HOME;
const args = process.argv.slice(2);
fs.appendFileSync(home + "/ssh-calls.log", JSON.stringify(args) + "\\n");
const plans = JSON.parse(fs.readFileSync(home + "/fake-ssh.json", "utf8"));
const plan = plans[args[args.length - 2]] || { exit: 255, stderr: "ssh: Could not resolve hostname" };
if (plan.home) {
  // A real remote shell has only its own environment, not the caller's.
  const env = { ...process.env, HOME: plan.home };
  delete env.FLEET_CONFIG;
  const r = cp.spawnSync("sh", ["-c", args[args.length - 1]], { env, stdio: ["ignore", "inherit", "inherit"] });
  process.exit(r.status === null ? 1 : r.status);
}
if (plan.stdout) process.stdout.write(plan.stdout);
if (plan.stderr) process.stderr.write(plan.stderr + "\\n");
process.exit(plan.exit === undefined ? 0 : plan.exit);
`;

export function installFakeSsh(home: string, plans: Record<string, SshPlan>): void {
  const script = join(home, ".fake-ssh.js");
  writeFileSync(script, FAKE_SSH);
  writeExecutable(join(home, ".local/bin/ssh"), `#!/bin/sh\nexec ${process.execPath} ${script} "$@"\n`);
  writeFileSync(join(home, "fake-ssh.json"), JSON.stringify(plans));
}

const TOOL_ENTRIES = ["bin", "src", "vendor", "skills", "examples", "package.json"];

/**
 * The tool and the config as two repos with two bare remotes standing in for GitHub, and a host that runs
 * the way a real one does: the managed fleet clone in `~/.local/share/fleet/fleet`, `~/.local/bin/fleet` pointing
 * into it, and `~/.config/fleet/config` naming the config repo. The tool also holds decoys of every
 * config file (`hosts/`, `catalog/`, `config/`, `secrets/`, `.sops.yaml`) that must never be read. `dev` is a separate checkout of the tool, for runs that are not the managed clone.
 */
export function makeWorld(host = "laptop") {
  const base = tempDir("fleet-world-");
  const toolRemote = join(base, "tool.git");
  const tool = join(base, "tool");
  git(base, "init", "--bare", "--initial-branch=main", toolRemote);
  mkdirSync(tool);
  for (const entry of TOOL_ENTRIES) cpSync(join(repoRoot, entry), join(tool, entry), { recursive: true });
  for (const [path, text] of [
    [`hosts/${host}.yaml`, "decoy: the tool's own directory is not a config\n"],
    ["hosts/_defaults.yaml", "decoy: true\n"],
    ["catalog/skills.yaml", "decoy: true\n"],
    ["catalog/mcp.yaml", "servers: not-a-map\n"],
    ["config/AGENTS.md", "decoy\n"],
    ["secrets/shared.enc.yaml", "DECOY: plaintext\n"],
    [".sops.yaml", "decoy: true\n"],
  ] as const) {
    mkdirSync(dirname(join(tool, path)), { recursive: true });
    writeFileSync(join(tool, path), text);
  }
  git(tool, "init", "--initial-branch=main");
  git(tool, "add", "-A");
  git(tool, "commit", "-m", "tool");
  git(tool, "remote", "add", "origin", toolRemote);
  git(tool, "push", "-u", "origin", "main");
  const first = git(tool, "rev-parse", "HEAD");
  const toolCommit = (files: Record<string, string>, message = "tool change"): string => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(tool, path)), { recursive: true });
      writeFileSync(join(tool, path), content);
    }
    git(tool, "add", "-A");
    git(tool, "commit", "-m", message);
    git(tool, "push", "origin", "main");
    return git(tool, "rev-parse", "HEAD");
  };

  const descRemote = join(base, "config.git");
  const config = join(base, "config");
  git(base, "init", "--bare", "--initial-branch=main", descRemote);
  mkdirSync(join(config, "hosts"), { recursive: true });
  writeFileSync(join(config, "hosts", `${host}.yaml`), "{}\n");
  writeFileSync(join(config, "fleet.yaml"), pinText(toolRemote, first));
  git(config, "init", "--initial-branch=main");
  git(config, "remote", "add", "origin", descRemote);
  git(config, "add", "-A");
  git(config, "commit", "-m", "config");
  git(config, "push", "-u", "origin", "main");
  const pin = (commit: string, repo = toolRemote): void => {
    writeFileSync(join(config, "fleet.yaml"), pinText(repo, commit));
    publish(config, "pin");
  };

  const home = makeHome(host);
  const managed = join(home, ".local/share/fleet/fleet");
  git(base, "clone", "--quiet", toolRemote, managed);
  git(managed, "checkout", "--quiet", "--detach", first);
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  symlinkSync(join(managed, "bin/fleet"), join(home, ".local/bin/fleet"));
  writeFileSync(join(home, ".config/fleet/config"), `${config}\n`);

  const dev = join(base, "dev");
  git(base, "clone", "--quiet", toolRemote, dev);
  const run = (args: string[], env: Record<string, string> = {}): Run => runBin(join(home, ".local/bin/fleet"), args, { home, env });
  const runDev = (args: string[], env: Record<string, string> = {}): Run => runBin(join(dev, "bin/fleet"), args, { home, env: { FLEET_CONFIG: config, ...env } });
  return { base, home, host, tool, toolRemote, toolCommit, first, config, descRemote, pin, managed, dev, run, runDev };
}

/**
 * A reason to skip a test that needs `tools` to be absent, or false when it can run. Fleet also looks in the
 * system directories, so a test cannot hide a tool installed there.
 */
export function skipIfSystemWide(...tools: string[]): string | false {
  const found = tools.filter((tool) => ["/usr/bin", "/bin", "/usr/local/bin", HOMEBREW_BIN].some((dir) => existsSync(join(dir, tool))) || (tool === "node" && HOMEBREW_KEG_NODES.some((p) => existsSync(p))));
  return found.length > 0 ? `${found.join(" and ")} installed system-wide` : false;
}
