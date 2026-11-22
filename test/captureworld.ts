/** The world the capture tests run in: one host that can hold secrets, two agents, and a small catalog. */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { capture } from "../src/capturecmd.ts";
import type { CaptureOptions } from "../src/capturecmd.ts";
import type { Result } from "../src/output.ts";
import { git, gitEnv, installFakeClaude, linkFleetSkill, makeClone, makeHome, publish, tempDir, writeExecutable } from "./helpers.ts";
import { newIdentity } from "./initworld.ts";
import type { Identity } from "./initworld.ts";
import { findTool } from "../src/tools.ts";

// The command commits in this process, so git needs an author here too.
Object.assign(process.env, gitEnv);

export const SOPS = findTool("sops")!;

/** Values no other text in a test may contain: every result, report and file the config repo holds is searched for them. */
export const TOKEN = "CANARY-tok-91ae33f0-do-not-leak";
export const HEADER_TOKEN = `Bearer ${TOKEN}-header`;
export const OTHER = "CANARY-other-5b7c-do-not-leak";

const CATALOG = `servers:
  metrics:
    command: ["mcp-metrics"]
  stats:
    transport: http
    url: https://stats.example.com/mcp
`;

/** A host that can hold secrets, with two agents, a catalog of two servers and nothing from config on it yet. */
export function world(opts: { host?: (id: Identity) => string; catalog?: string } = {}) {
  const id: Identity = newIdentity();
  const { clone, remote } = makeClone();
  const home = makeHome("laptop");
  installFakeClaude(home);
  for (const tool of ["sops", "age-keygen"]) writeExecutable(join(home, ".local/bin", tool), `#!/bin/sh\nexec '${findTool(tool)}' "$@"\n`);
  mkdirSync(join(home, ".config/fleet"), { recursive: true });
  writeFileSync(join(home, ".config/fleet/age.key"), id.key, { mode: 0o600 });
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(clone, rel)), { recursive: true });
    writeFileSync(join(clone, rel), text);
  };
  write("hosts/_defaults.yaml", "vars:\n  EXAMPLE: one\n");
  write("hosts/laptop.yaml", opts.host?.(id) ?? `admin: true\nage: ${id.recipient}\n`);
  write("catalog/mcp.yaml", opts.catalog ?? CATALOG);
  write("catalog/skills.yaml", "sources: {}\nbundles: {}\n");
  publish(clone, "config");
  linkFleetSkill(home, clone);
  const put = (rel: string, doc: unknown) => {
    mkdirSync(dirname(join(home, rel)), { recursive: true });
    writeFileSync(join(home, rel), `${JSON.stringify(doc, null, 2)}\n`);
  };
  const claude = (servers: Record<string, unknown>) => put(".claude.json", { numStartups: 3, mcpServers: servers });
  const opencode = (servers: Record<string, unknown>) => put(".config/opencode/opencode.jsonc", { mcp: servers });
  const read = (rel: string) => readFileSync(join(clone, rel), "utf8");
  const decrypt = (file: string, name: string): string | null => {
    const keyPath = join(tempDir("fleet-key-"), "key");
    writeFileSync(keyPath, id.key, { mode: 0o600 });
    const out = spawnSync(SOPS, ["decrypt", "--extract", `["${name}"]`, join(clone, "secrets", `${file}.enc.yaml`)], { encoding: "utf8", env: { ...process.env, SOPS_AGE_KEY_FILE: keyPath } });
    return out.status === 0 ? out.stdout : null;
  };
  const run = (args: string[], o: CaptureOptions = {}) => capture(clone, clone, args, { home, noPush: true, ...o });
  return { id, clone, remote, home, write, put, claude, opencode, read, decrypt, run };
}
export type W = ReturnType<typeof world>;

/** A terminal whose user types `lines`, and everything the command writes to it. */
export function terminal(lines: string[]) {
  const stdin = new PassThrough();
  const out: string[] = [];
  stdin.end(lines.map((l) => `${l}\n`).join(""));
  return { io: { stdin, stdout: { write: (text: string) => void out.push(text) } }, out };
}

/** Every file under the config repo, other than .git, and the history of all of them: the places a value must never be. */
export function repoText(dir: string): string {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === ".git" || name === "node_modules" || name === "vendor") continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(join(dir, "catalog"));
  walk(join(dir, "hosts"));
  try {
    walk(join(dir, "secrets"));
  } catch {
    // no secrets file yet
  }
  return [...files.map((f) => readFileSync(f, "utf8")), git(dir, "log", "-p", "--all", "--", "catalog", "hosts", "secrets")].join("\n");
}

/** Everything a result says, in one string. */
export const everything = (r: Result): string => JSON.stringify(r) + (r.text ?? "") + (r.messages ?? []).join("\n");

