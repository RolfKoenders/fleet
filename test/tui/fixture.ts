import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../../src/tui/app.ts";
import type { Msg, Options, State } from "../../src/tui/app.ts";
import { Headless } from "../../src/tui/headless.ts";
import { loadModel } from "../../src/tui/model.ts";
import { readingProbe } from "../../src/tui/probe.ts";
import type { ConflictsResult, HostResult, Probe, RemoteConflicts } from "../../src/tui/probe.ts";
import { sourceDir } from "../../src/sources.ts";
import { agentContext } from "../../src/context.ts";
import type { ContextItem, ContextKind, ContextReport } from "../../src/context.ts";
import type { HostContext } from "../../src/contextall.ts";
import type { Tool } from "../../src/settings.ts";
import type { StatusFields } from "../../src/status.ts";
import { makeHome, repoRoot, tempDir } from "../helpers.ts";

/** A config repo with four hosts: `laptop` (this one), `server` and `box` over ssh, and `edge` on its own timer. */
export function makeConfig(): string {
  const dir = tempDir("fleet-bridge-config-");
  cpSync(join(repoRoot, "examples"), dir, { recursive: true });
  const host = (name: string, text: string) => writeFileSync(join(dir, "hosts", `${name}.yaml`), text);
  host("server", "ssh: me@server\nexclude: [core]\nmcp:\n  exclude: [docs]\n");
  host("box", "ssh: me@box\nbundles: [extra]\nmcp:\n  include: [tracker-local]\n");
  host("edge", "mcp:\n  include: [tracker]\n");
  mkdirSync(join(dir, "hosts"), { recursive: true });
  return dir;
}

export const status = (over: Partial<StatusFields> = {}): StatusFields => ({
  repos: { fleet: { branch: "main", sha: "3f9a1c2d4e5f60718293a4b5c6d7e8f901234567", clean: true, ahead: 0, behind: 0 } },
  applied: { at: "2026-10-30T10:00:00Z", ageSeconds: 720, config: "c0ffee1" },
  timer: "active",
  pending: 0,
  conflicts: 0,
  conflictList: null,
  tools: { claude: "2.1.4", opencode: "1.4.2", sops: "3.13.3", node: "22.18.0", t3: "0.1.0" },
  ...over,
});

export const ok = (over: Partial<StatusFields> = {}): HostResult => ({ result: "ok", status: status(over) });

export const item = (kind: ContextKind, name: string, tokens: number | null, fromConfig = true, doctor: string | null = null): ContextItem => ({ kind, name, path: kind === "mcp" ? null : name, tokens, fromConfig, measurement: null, doctor });

/** A startup context made of the items of each agent. */
export const contextOf = (agents: Partial<Record<Tool, ContextItem[]>>): ContextReport => ({ agents: (Object.entries(agents) as [Tool, ContextItem[]][]).map(([agent, items]) => agentContext(agent, items, [])), notes: [] });

/**
 * Made-up startup contexts for the hosts of `makeConfig`: `laptop` is the heaviest and has a server nobody measured
 * and a skill fleet did not put there, `server` is light, `box` is on an older pin and `edge` has no ssh.
 */
export const CONTEXTS: Record<string, ContextReport | Exclude<HostContext["result"], "ok">> = {
  laptop: contextOf({
    claude: [item("instructions", "~/.claude/CLAUDE.md", 1240), item("skills", "review", 410), item("skills", "debug", 330), item("skills", "scratch", 180, false), item("mcp", "tracker", 14200), item("mcp", "docs", 3950), item("mcp", "analytics", null, false)],
    opencode: [item("instructions", "~/.config/opencode/AGENTS.md", 1240), item("skills", "review", 410), item("mcp", "tracker", null), item("mcp", "docs", 3950)],
  }),
  server: contextOf({ claude: [item("instructions", "~/.claude/CLAUDE.md", 980), item("skills", "debug", 330), item("mcp", "tracker", 14200)], opencode: [item("instructions", "~/.config/opencode/AGENTS.md", 980)] }),
  box: "old",
  edge: "timer",
};

export type Canned = { contexts?: Record<string, ContextReport | Exclude<HostContext["result"], "ok"> | "never">; remote?: Record<string, RemoteConflicts>; doctor?: Probe["doctor"]; hosts?: Record<string, HostResult | "never">; conflicts?: ConflictsResult; reads?: Pick<Probe, "history" | "commitDiff" | "secrets" | "catalog"> };

/** Reads that find nothing, for tests of other screens. */
export const noReads: NonNullable<Canned["reads"]> = {
  history: async () => ({ ok: false, detail: "no history in this test" }),
  commitDiff: async () => ({ ok: false, detail: "no history in this test" }),
  secrets: async () => ({ entries: [], hosts: [], problems: [] }),
  catalog: async () => ({ skills: [], servers: [], problems: [] }),
};

/** A probe that answers from a table. A host marked "never" is still being asked. */
export function cannedProbe(canned: Canned = {}): Probe {
  return {
    ...(canned.reads ?? noReads),
    async host(host, signal) {
      const r = canned.hosts?.[host.name];
      if (r === "never") return new Promise<HostResult>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
      return r ?? ok();
    },
    async conflicts() {
      return canned.conflicts ?? { ok: true, items: [] };
    },
    ...(canned.contexts
      ? {
          async context(host: { name: string }, signal: AbortSignal): Promise<HostContext> {
            const c = canned.contexts![host.name];
            if (c === "never") return new Promise<HostContext>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
            if (c === undefined || typeof c === "string") return { host: host.name, result: c ?? "old", context: null, ...(c === "unreachable" ? { detail: "ssh: connect to host box port 22: Connection timed out" } : {}) };
            return { host: host.name, result: "ok", context: c };
          },
        }
      : {}),
    ...(canned.remote ? { hostConflicts: async (host: { name: string }) => canned.remote![host.name] ?? { ok: false as const, reason: "error" as const, detail: "no canned answer" } } : {}),
    ...(canned.doctor ? { doctor: canned.doctor } : {}),
  };
}

const FAKE_ENC = (n: number) => `ENC[AES256_GCM,data:fake${n},iv:x,tag:y,type:str]`;

function sopsText(values: Record<string, number>, recipients: string[], mac = "m1"): string {
  const keys = Object.entries(values).map(([k, n]) => `${k}: ${FAKE_ENC(n)}\n`).join("");
  const rec = recipients.map((r) => `        - recipient: ${r}\n          enc: |\n            -----BEGIN AGE ENCRYPTED FILE-----\n            fake\n`).join("");
  return `${keys}sops:\n    age:\n${rec}    lastmodified: "2026-10-0${mac.slice(1)}T10:00:00Z"\n    mac: ENC[AES256_GCM,data:${mac},iv:x,tag:y,type:str]\n    version: 3.13.3\n`;
}

export const AGE = { laptop: "age1laptopaaaa", server: "age1serverbbbb", box: "age1boxcccc" };

/**
 * `makeConfig` as a git repository with a history: hosts with age recipients, two secrets files that hold only
 * made-up ciphertext (nothing here can be decrypted, which is the point), and a commit subject with an escape
 * sequence in it. `shas` runs from the oldest commit to the newest.
 */
// A commit can start git's maintenance in the background, which adds and removes files in .git while a test
// compares the tree before and after.
const NO_MAINTENANCE = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "maintenance.auto", GIT_CONFIG_VALUE_0: "false", GIT_CONFIG_KEY_1: "gc.auto", GIT_CONFIG_VALUE_1: "0" };

export function makeRepo(): { dir: string; home: string; shas: string[] } {
  const dir = makeConfig();
  const home = makeHome("laptop");
  const at = (n: number) => `2026-10-0${n}T10:00:00Z`;
  const git = (date: string, ...args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...NO_MAINTENANCE, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const put = (path: string, text: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const shas: string[] = [];
  const commit = (n: number, message: string) => {
    git(at(n), "add", "-A");
    git(at(n), "commit", "-q", "-m", message);
    shas.push(git(at(n), "rev-parse", "HEAD"));
  };
  git(at(1), "init", "-q", "--initial-branch=main");
  commit(1, "Start the config");
  const laptop = readFileSync(join(dir, "hosts/laptop.yaml"), "utf8").replace('age: ""', `age: ${AGE.laptop}`);
  const server = `${readFileSync(join(dir, "hosts/server.yaml"), "utf8")}age: ${AGE.server}\n`;
  put("hosts/laptop.yaml", laptop);
  put("hosts/server.yaml", server);
  put("hosts/box.yaml", `ssh: me@box\nage: ${AGE.box}\nbundles: [extra]\nmcp:\n  include: [tracker-local]\nsettings:\n  claude:\n    env:\n      PROXY_TOKEN: secret:PROXY_TOKEN\n`);
  put("secrets/shared.enc.yaml", sopsText({ TRACKER_API_KEY: 1, PROXY_TOKEN: 2 }, [AGE.laptop, AGE.server, AGE.box]));
  put("secrets/server.enc.yaml", sopsText({ DB_PASSWORD: 3 }, [AGE.laptop, AGE.server]));
  commit(2, "Add secrets and recipients");
  put("secrets/shared.enc.yaml", sopsText({ TRACKER_API_KEY: 4, PROXY_TOKEN: 2 }, [AGE.laptop, AGE.server, AGE.box], "m2"));
  commit(3, "Rotate the tracker key");
  put("secrets/shared.enc.yaml", sopsText({ TRACKER_API_KEY: 4, PROXY_TOKEN: 2 }, [AGE.laptop, AGE.server], "m3"));
  commit(4, "Stop sharing with box");
  put("config/AGENTS.md", `${readFileSync(join(dir, "config/AGENTS.md"), "utf8")}Be brief.\n`);
  commit(5, "Edit the rules \u001b[31mRED\u001b]0;pwned\u0007 end");
  return { dir, home, shas };
}

/** A clone of the example skill source in `home`, with a SKILL.md that holds escape sequences. */
export function cloneSource(home: string): string {
  const dir = sourceDir(home, "example-skills");
  mkdirSync(join(dir, "skills/review"), { recursive: true });
  writeFileSync(join(dir, "skills/review/SKILL.md"), "---\nname: review\n---\nReview the change.\n\u001b[2J\u001b]0;pwned\u0007Then stop.\n");
  const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, env: { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...NO_MAINTENANCE, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "skills");
  return dir;
}

/** The one file under the home that the bridge is allowed to write, relative to the home. */
export const CACHE_FILE = ".local/state/fleet/bridge-hosts.json";

export const SIZE = { cols: 100, rows: 32 };

export async function bridgeFor(configDir: string, canned: Canned = {}, options: { home?: string; size?: { cols: number; rows: number }; motion?: boolean; boot?: boolean; settle?: boolean; app?: Partial<Options> } = {}): Promise<Headless<State, Msg>> {
  const model = loadModel(configDir, "laptop");
  const reads = options.home === undefined ? canned.reads : readingProbe(configDir, options.home);
  const app = createApp({ model, probe: cannedProbe({ ...canned, ...(reads ? { reads } : {}) }), motion: options.motion ?? true, boot: options.boot ?? false, ...options.app });
  const h = new Headless(app, options.size ?? SIZE);
  if (options.settle !== false) await h.settle();
  h.advance(100);
  return h;
}
