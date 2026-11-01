import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { planCounts } from "./apply.ts";
import { MissingToolError, repoState } from "./git.ts";
import type { RepoState } from "./git.ts";
import { readHostName } from "./host.ts";
import { paint } from "./output.ts";
import type { Result } from "./output.ts";
import { SOPS_VERSION_ARGS } from "./sops.ts";
import { readState } from "./state.ts";
import { hostTargets } from "./targets.ts";
import { findTool } from "./tools.ts";
import { isObject } from "./yamlfile.ts";
import type { Obj } from "./yamlfile.ts";

/** A version fleet could read, or null. The Node that runs fleet is `node`; `t3` is the newest installed T3 Code. */
export type ToolVersions = { claude: string | null; opencode: string | null; sops: string | null; node: string | null; t3: string | null };

/** What `fleet status --json` reports about one host, besides `host`. Null is "could not be read". */
export type StatusFields = {
  repos: { fleet: RepoState };
  applied: { at: string | null; ageSeconds: number | null };
  /** What `systemctl --user is-active fleet.timer` printed. */
  timer: string | null;
  /** Links and keys apply would create, update or remove. */
  pending: number | null;
  conflicts: number | null;
  tools: ToolVersions;
};

const TOOL_NAMES = ["claude", "opencode", "sops", "node", "t3"] as const;
const TIMEOUT_MS = 15_000;

/** The first dotted version in a tool's output, such as `2.1.4` from `2.1.4 (Claude Code)`. */
function parseVersion(output: string): string | null {
  return /\d+\.\d+\.\d+[0-9A-Za-z.+-]*/.exec(output)?.[0] ?? null;
}

/** Runs `name` by absolute path and reads a version from what it prints. A tool that fails or prints none is null. */
function toolVersion(name: string, args: string[], home: string): string | null {
  const path = findTool(name, process.env, home);
  if (path === null) return null;
  const r = spawnSync(path, args, { encoding: "utf8", timeout: TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
  if (r.error || r.status !== 0) return null;
  return parseVersion(r.stdout);
}

const VERSION_DIR = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const byVersion = (a: string, b: string): number => {
  const core = (v: string) => v.split(/[-+]/)[0]!.split(".").map(Number);
  const [x, y] = [core(a), core(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return a.localeCompare(b);
};

/**
 * The newest name that looks like a version among the directories in `~/.t3/runtime/versions/`. Only that
 * listing is read: not what is inside the directories, and nothing else under `~/.t3`.
 */
function t3Version(home: string): string | null {
  let entries;
  try {
    entries = readdirSync(join(home, ".t3/runtime/versions"), { withFileTypes: true });
  } catch {
    return null;
  }
  return entries.filter((e) => e.isDirectory() && VERSION_DIR.test(e.name)).map((e) => e.name).sort(byVersion).at(-1) ?? null;
}

export function timerState(home: string): string | null {
  const path = findTool("systemctl", process.env, home);
  if (path === null) return null;
  const r = spawnSync(path, ["--user", "is-active", "fleet.timer"], { encoding: "utf8", timeout: TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
  if (r.error) return null;
  const word = (r.stdout ?? "").trim().split("\n")[0] ?? "";
  return /^[a-z-]+$/.test(word) ? word : null;
}

function appliedAge(home: string, messages: string[]): StatusFields["applied"] {
  const none = { at: null, ageSeconds: null };
  try {
    const at = readState(home)?.appliedAt;
    const time = typeof at === "string" ? Date.parse(at) : Number.NaN;
    if (Number.isNaN(time)) return none;
    return { at: at as string, ageSeconds: Math.max(0, Math.floor((Date.now() - time) / 1000)) };
  } catch (error) {
    messages.push(`fleet: the applied state cannot be read: ${(error as Error).message}`);
    return none;
  }
}

const reasons = (result: Result): string => {
  const all = (result.messages ?? []).map((m) => m.replace(/^fleet: /, ""));
  return `${all.slice(0, 3).join("; ")}${all.length > 3 ? ` (and ${all.length - 3} more)` : ""}`;
};

function changeCounts(configDir: string, home: string, host: string | null, messages: string[]): { pending: number | null; conflicts: number | null } {
  const unknown = { pending: null, conflicts: null };
  if (host === null) return unknown; // already said: no host name
  try {
    const counts = planCounts(configDir, home);
    if (!("code" in counts)) return counts;
    messages.push(`fleet: pending changes and conflicts are unknown: ${reasons(counts)}`);
  } catch (error) {
    messages.push(`fleet: pending changes and conflicts are unknown: ${(error as Error).message}`);
  }
  return unknown;
}

const ago = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 48 * 3600) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};

/** The lines of one host's status, after its name. `clone` is the path of the fleet clone when it is known. */
function lines(fields: StatusFields, color: boolean, clone: string | null): string[] {
  const { fleet } = fields.repos;
  const shown = (value: unknown) => (value === null ? "unknown" : String(value));
  const timer = fields.timer === null ? "unknown" : paint(color, fields.timer === "active" ? "green" : "yellow", fields.timer);
  return [
    `fleet clone:${clone === null ? "" : ` ${clone}`}`,
    `  branch: ${fleet.branch ?? "(detached)"}`,
    `  sha: ${fleet.sha}`,
    `  clean: ${fleet.clean ? paint(color, "green", "yes") : paint(color, "yellow", "no")}`,
    `  ahead: ${fleet.ahead ?? "n/a"}`,
    `  behind: ${fleet.behind ?? "n/a"}`,
    fields.applied.at === null ? "applied: never" : `applied: ${ago(fields.applied.ageSeconds ?? 0)} (${fields.applied.at})`,
    `timer: ${timer}`,
    `pending: ${shown(fields.pending)}`,
    `conflicts: ${fields.conflicts === null || fields.conflicts === 0 ? shown(fields.conflicts) : paint(color, "yellow", String(fields.conflicts))}`,
    "tools:",
    ...TOOL_NAMES.map((name) => `  ${name}: ${shown(fields.tools[name])}`),
  ];
}

/** Reads this host. Writes nothing and uses no network. */
function collect(toolDir: string, configDir: string, home: string, host: string | null, messages: string[]): StatusFields | Result {
  let fleet: RepoState;
  try {
    fleet = repoState(toolDir);
  } catch (error) {
    if (error instanceof MissingToolError) return { code: "missing-prerequisite", messages: [`fleet: ${error.message}`] };
    throw error;
  }
  return {
    repos: { fleet },
    applied: appliedAge(home, messages),
    timer: timerState(home),
    ...changeCounts(configDir, home, host, messages),
    tools: {
      claude: toolVersion("claude", ["--version"], home),
      opencode: toolVersion("opencode", ["--version"], home),
      sops: toolVersion("sops", SOPS_VERSION_ARGS, home),
      node: parseVersion(process.version),
      t3: t3Version(home),
    },
  };
}

/** Read-only and offline. */
export function status(toolDir: string, configDir: string, color: boolean, home: string = homedir()): Result {
  const messages: string[] = [];
  const host = readHostName(home);
  if (host === null) messages.push("fleet: no host name set; `fleet init <host>` writes one");

  const fields = collect(toolDir, configDir, home, host, messages);
  if ("code" in fields) return fields;
  const text = [`host: ${host ?? "(unknown)"}`, ...lines(fields, color, toolDir)].join("\n");
  return { code: "ok", text, messages, fields: { ...fields } };
}

/** One host's answer. `timer` is a host with no `ssh` destination, which applies on its own schedule. */
type HostStatus = {
  host: string;
  result: "ok" | "unreachable" | "timer" | "error";
  status: StatusFields | null;
  /** Why an `error` was one. */
  detail?: string;
};

export const printable = (value: unknown): string | null => (typeof value === "string" ? value.slice(0, 200).replace(/[^\x20-\x7e]/g, "?") : null);
export const count = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);

/**
 * A remote host's status, cut down to the fields fleet knows and to printable text, because it is shown on a
 * terminal and a host can be wrong. Null when the document has no fleet clone state, such as a failed status.
 */
function fromDocument(doc: Obj): StatusFields | null {
  const repos = isObject(doc.repos) ? doc.repos : {};
  const fleet = repos.fleet;
  if (!isObject(fleet) || typeof fleet.clean !== "boolean") return null;
  const applied = isObject(doc.applied) ? doc.applied : {};
  const tools = isObject(doc.tools) ? doc.tools : {};
  return {
    repos: { fleet: { branch: printable(fleet.branch), sha: printable(fleet.sha) ?? "", clean: fleet.clean, ahead: count(fleet.ahead), behind: count(fleet.behind) } },
    applied: { at: printable(applied.at), ageSeconds: count(applied.ageSeconds) },
    timer: printable(doc.timer),
    pending: count(doc.pending),
    conflicts: count(doc.conflicts),
    tools: Object.fromEntries(TOOL_NAMES.map((name) => [name, printable(tools[name])])) as ToolVersions,
  };
}

const REMOTE_COMMAND = "~/.local/bin/fleet status --json";

/** Runs `fleet status --json` on one host, as `push` runs `apply` there. ssh exiting 255 is unreachable. */
function ask(ssh: string, dest: string, host: string, notes: string[]): HostStatus {
  const r = spawnSync(ssh, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", dest, REMOTE_COMMAND], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  const firstLine = (r.stderr ?? "").trim().split("\n")[0] ?? "";
  if (r.error || r.status === 255) {
    notes.push(`fleet: ${host}: unreachable over ssh (${r.error?.message ?? (firstLine || "no reason given")})`);
    return { host, result: "unreachable", status: null };
  }
  let doc: Obj | null = null;
  try {
    const parsed: unknown = JSON.parse(r.stdout);
    doc = isObject(parsed) ? parsed : null;
  } catch {
    // not a document
  }
  const fields = doc === null ? null : fromDocument(doc);
  if (fields !== null) return { host, result: "ok", status: fields };
  const detail =
    doc !== null && typeof doc.code === "string"
      ? `its status gave ${printable(doc.code)}${Array.isArray(doc.messages) && typeof doc.messages[0] === "string" ? `: ${printable(doc.messages[0])}` : ""}`
      : `its output was not a fleet status document (exit ${r.status ?? "none"})`;
  notes.push(`fleet: ${host}: ${detail}`);
  return { host, result: "error", status: null, detail };
}

const EXIT_ORDER = ["unreachable", "error"] as const;

/** `fleet status --all`: this host in place, every other host with an `ssh` destination over ssh. */
export function statusAll(toolDir: string, configDir: string, color: boolean, home: string = homedir()): Result {
  const here = status(toolDir, configDir, color, home);
  if (here.code !== "ok") return here;
  const self = readHostName(home);

  const problems: string[] = [];
  const targets = hostTargets(configDir, self, problems);
  if (problems.length > 0) return { code: "invalid", messages: problems.map((p) => `fleet: ${p}`) };
  const ssh = findTool("ssh", process.env, home);
  if (ssh === null && targets.some((t) => t.ssh !== null)) {
    return { code: "missing-prerequisite", messages: ["fleet: ssh is not installed, and a host has an 'ssh' destination"] };
  }

  const notes = [...(here.messages ?? [])];
  const records: HostStatus[] = targets.map((t) => (t.ssh === null ? { host: t.host, result: "timer", status: null } : ask(ssh!, t.ssh, t.host, notes)));
  if (self !== null) records.push({ host: self, result: "ok", status: here.fields as unknown as StatusFields });
  records.sort((a, b) => a.host.localeCompare(b.host));

  const blocks = records.map((record) => {
    const name = record.host === self ? `${record.host} (this host)` : record.host;
    const shown = record.result === "ok" ? paint(color, "green", "ok") : record.result === "timer" ? "timer (no ssh destination; it applies on its own schedule)" : paint(color, "yellow", record.result);
    const body = record.status === null ? [] : lines(record.status, color, record.host === self ? toolDir : null).map((l) => `  ${l}`);
    return [`${name}: ${shown}${record.detail === undefined ? "" : ` (${record.detail})`}`, ...body].join("\n");
  });
  const worst = EXIT_ORDER.find((result) => records.some((r) => r.result === result));
  return { code: worst ?? "ok", text: blocks.join("\n\n"), messages: notes, fields: { ...here.fields, hosts: records } };
}
