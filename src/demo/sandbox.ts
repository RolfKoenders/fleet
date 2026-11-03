import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { MissingToolError } from "../git.ts";
import { setPinValue } from "../newconfig.ts";
import { findTool } from "../tools.ts";
import { CONFIG_DIR } from "../init.ts";

/**
 * The demo's world: a throwaway directory that holds every host's home, local bare repos standing in for GitHub,
 * and fakes for the tools that would reach outside it (`ssh`, `claude`, `opencode`, `sops`, `systemctl`, `launchctl`).
 * Nothing in it is derived from the real home: every path comes from `root`, and the environment a command
 * runs with is built here from a short allowlist, never from the caller's.
 */

export type DemoHost = { name: string; /** What the fake `ssh` is given to reach it; null for the host the demo runs on. */ ssh: string | null; home: string };

export type Sandbox = {
  root: string;
  /** The host the demo runs on: the first of `hosts`. */
  admin: DemoHost;
  hosts: DemoHost[];
  /** The admin host's config repo, where the demo's shell starts. */
  config: string;
};

const HOST_NAMES = [
  ["laptop", null],
  ["server", "me@server"],
  ["devbox", "me@devbox"],
] as const;

/** Ordinary commands the demo's shell can use. The real `ssh` and the rest of the system's tools are not on its PATH. */
const COMMANDS = ["sh", "bash", "git", "node", "ls", "cat", "grep", "sed", "awk", "head", "tail", "wc", "sort", "diff", "cmp", "tr", "cut", "find", "rm", "mkdir", "touch", "cp", "mv", "ln", "chmod", "pwd", "printf", "echo", "env", "date", "sleep", "readlink", "dirname", "basename", "tee", "test", "true", "false", "id", "uname", "clear", "less", "which"];

/** Variables of the caller that are passed on, because they only shape how output looks. */
const PASSED = ["TERM", "LANG", "LC_ALL", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "FLEET_NO_MOTION", "FLEET_THEME"];

export const fakeCallsLog = (root: string): string => join(root, "fake-calls.log");

/**
 * The whole environment of a command run for `home`. `config` is set for the admin host's own commands and left out
 * for a command run over the fake ssh, which, like a real remote shell, finds its config through its home.
 */
export function sandboxEnv(root: string, home: string, options: { config?: string; passthrough?: NodeJS.ProcessEnv } = {}): Record<string, string> {
  const source = options.passthrough ?? process.env;
  const env: Record<string, string> = {};
  for (const name of PASSED) if (source[name] !== undefined) env[name] = source[name]!;
  return {
    ...env,
    HOME: home,
    PATH: [join(home, ".local/bin"), join(root, "bin")].join(delimiter),
    ...(options.config === undefined ? {} : { FLEET_CONFIG: options.config }),
    FLEET_NODE: process.execPath,
    FLEET_DEMO_ROOT: root,
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    // Only local paths: git refuses https, ssh and the git protocol, so no remote can reach the network.
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
  };
}

const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

function git(root: string, cwd: string, ...args: string[]): string {
  const path = findTool("git");
  if (path === null) throw new MissingToolError("git is not installed");
  return execFileSync(path, args, { cwd, env: sandboxEnv(root, root), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Runs the sandbox's own `fleet` as a host, the way its timer would. */
function fleet(sandbox: Sandbox, host: DemoHost, args: string[]): void {
  const config = host === sandbox.admin ? sandbox.config : join(host.home, CONFIG_DIR);
  try {
    execFileSync(join(host.home, ".local/bin/fleet"), args, { cwd: config, env: sandboxEnv(sandbox.root, host.home, { config }), stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = String((error as { stderr?: Buffer }).stderr ?? "").trim();
    throw new Error(`the demo could not set up ${host.name} with 'fleet ${args.join(" ")}': ${stderr.split("\n")[0] ?? (error as Error).message}`);
  }
}

function writeAll(base: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(base, path, ".."), { recursive: true });
    writeFileSync(join(base, path), text);
  }
}

/** A repo with one commit of `files`, published as a bare repo at `bare`. Returns that commit. */
function publishNew(root: string, bare: string, files: (dir: string) => void): string {
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  files(work);
  git(root, work, "init", "--quiet", "--initial-branch=main");
  git(root, work, "add", "-A");
  git(root, work, "commit", "--quiet", "-m", "Start");
  const commit = git(root, work, "rev-parse", "HEAD");
  git(root, root, "clone", "--quiet", "--bare", work, bare);
  rmSync(work, { recursive: true, force: true });
  return commit;
}

const SKILLS = ["review", "debug", "notes", "triage"];

/** Fakes live in `fakes/`; each host gets links to them in its `~/.local/bin`, which fleet searches first. */
function installFakes(sandbox: Sandbox, toolDir: string): void {
  const dir = join(sandbox.root, "fakes");
  mkdirSync(dir, { recursive: true });
  for (const name of ["ssh", "claude", "opencode", "sops", "systemctl", "launchctl"]) {
    const script = join(dir, name);
    writeFileSync(script, `#!/bin/sh\nFLEET_DEMO_ROOT=${quote(sandbox.root)} exec ${quote(process.execPath)} ${quote(join(toolDir, "src/demo/fakes.ts"))} ${name} "$@"\n`);
    chmodSync(script, 0o755);
    for (const host of sandbox.hosts) {
      mkdirSync(join(host.home, ".local/bin"), { recursive: true });
      symlinkSync(script, join(host.home, ".local/bin", name));
    }
  }
  const bin = join(sandbox.root, "bin");
  mkdirSync(bin);
  const searched = (process.env.PATH ?? "").split(delimiter).filter((d) => d !== "");
  for (const name of COMMANDS) {
    const found = name === "node" ? process.execPath : searched.map((d) => join(d, name)).find((p) => existsSync(p));
    if (found !== undefined && !existsSync(join(bin, name))) symlinkSync(found, join(bin, name));
  }
  const table = Object.fromEntries(sandbox.hosts.filter((h) => h.ssh !== null).map((h) => [h.ssh, h.home]));
  writeFileSync(join(sandbox.root, "ssh-hosts.json"), JSON.stringify(table));
}

/**
 * Builds the sandbox from the tool at `toolDir`: its code goes into a local repo that every host clones as its
 * fleet clone, the examples become the config repo (with their skill source swapped for a local repo), and each host
 * applies once. Then two things are left to find: a change waiting to be pushed, and a conflict on `server`.
 */
export function buildSandbox(toolDir: string): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-demo-")));
  try {
    const hosts = HOST_NAMES.map(([name, ssh]): DemoHost => ({ name, ssh, home: join(root, name) }));
    const sandbox: Sandbox = { root, admin: hosts[0]!, hosts, config: join(hosts[0]!.home, CONFIG_DIR) };
    writeFileSync(join(root, "gitconfig"), "[user]\n\tname = Fleet Demo\n\temail = demo@example.invalid\n[advice]\n\tdetachedHead = false\n");
    installFakes(sandbox, toolDir);

    const remotes = join(root, "remotes");
    const tool = publishNew(root, join(remotes, "tool.git"), (dir) => {
      for (const entry of ["bin", "src", "vendor", "skills", "package.json"]) cpSync(join(toolDir, entry), join(dir, entry), { recursive: true });
    });
    const skills = publishNew(root, join(remotes, "skills.git"), (dir) => {
      writeAll(dir, Object.fromEntries(SKILLS.map((s) => [`skills/${s}/SKILL.md`, `---\nname: ${s}\ndescription: A made-up skill called ${s}.\n---\n`])));
    });
    publishNew(root, join(remotes, "config.git"), (dir) => {
      cpSync(join(toolDir, "examples"), dir, { recursive: true });
      const pin = readFileSync(join(dir, "fleet.yaml"), "utf8");
      const pinned = setPinValue(setPinValue(pin, "repo", join(remotes, "tool.git"))!, "commit", tool)!;
      writeFileSync(join(dir, "fleet.yaml"), pinned);
      const catalog = readFileSync(join(dir, "catalog/skills.yaml"), "utf8");
      writeFileSync(join(dir, "catalog/skills.yaml"), catalog.replace("https://github.com/example/skills.git", join(remotes, "skills.git")).replace("1234567890abcdef1234567890abcdef12345678", skills));
      writeAll(dir, { "hosts/devbox.yaml": "ssh: me@devbox\n" });
    });

    for (const host of hosts) {
      const managed = join(host.home, ".local/share/fleet/fleet");
      git(root, root, "clone", "--quiet", join(remotes, "tool.git"), managed);
      git(root, managed, "checkout", "--quiet", "--detach", tool);
      symlinkSync(join(managed, "bin/fleet"), join(host.home, ".local/bin/fleet"));
      git(root, root, "clone", "--quiet", join(remotes, "config.git"), join(host.home, CONFIG_DIR));
      writeAll(host.home, { ".config/fleet/host": `${host.name}\n`, ".config/fleet/config": `${join(host.home, CONFIG_DIR)}\n` });
      fleet(sandbox, host, ["apply"]);
    }

    // The conflict: someone typed into the file fleet links on `server`.
    const server = hosts[1]!;
    rmSync(join(server.home, ".claude/rules/host.md"));
    writeFileSync(join(server.home, ".claude/rules/host.md"), "Notes typed in by hand on this host.\n");
    // The change to push: one more skill in the `core` bundle, edited and not yet committed.
    const catalog = join(sandbox.config, "catalog/skills.yaml");
    writeFileSync(catalog, readFileSync(catalog, "utf8").replace("core: [review, debug]", "core: [review, debug, triage]"));
    return sandbox;
  } catch (error) {
    destroy(root);
    throw error;
  }
}

/** Deletes a sandbox. Refuses anything that is not a directory this module made in the temp directory. */
export function destroy(root: string): void {
  const base = root.split(sep).at(-1) ?? "";
  if (!base.startsWith("fleet-demo-") || !root.startsWith(realpathSync(tmpdir()) + sep)) throw new Error(`refusing to delete ${root}: it is not a fleet demo sandbox`);
  rmSync(root, { recursive: true, force: true });
}
