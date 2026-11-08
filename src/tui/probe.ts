import { spawn } from "node:child_process";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { CONTEXT_COMMAND, hostContextFrom } from "../contextall.ts";
import type { HostContext } from "../contextall.ts";
import { measureHere } from "../contextcmd.ts";
import { readHostName } from "../host.ts";
import { hostStatusFrom, printable, sshArguments } from "../status.ts";
import type { StatusFields } from "../status.ts";
import type { Conflict } from "../plan.ts";
import { findTool, probedNode } from "../tools.ts";
import { readDoctor } from "./doctorread.ts";
import type { DoctorResult } from "./doctorread.ts";
import type { HostInfo } from "./model.ts";
import type { Job } from "./worker.ts";
import { readCatalog, readCommitDiff, readHistory, readSecrets } from "./reads.ts";
import type { CatalogView, CommitDiff, History, SecretsView } from "./reads.ts";

/** What one host answered. `timer` is a host with no ssh destination, whose status cannot be asked. */
export type HostResult = {
  result: "ok" | "unreachable" | "error" | "timer";
  status: StatusFields | null;
  /** Why it is not ok, already cut down to printable text. */
  detail?: string;
};

export type ConflictsResult = { ok: true; items: Conflict[] } | { ok: false; detail: string };

/**
 * Another host's conflicts in full, from `fleet status --conflicts` over ssh. `old` is a host whose pinned fleet does not
 * know that option yet (it exits 2): not an error, the detail simply needs a newer pin.
 */
export type RemoteConflicts = { ok: true; items: Conflict[] } | { ok: false; reason: "old" | "error"; detail: string };

/** The questions the bridge asks. All read-only; tests and the frame tool supply their own. */
export type Probe = {
  host(host: HostInfo, signal: AbortSignal): Promise<HostResult>;
  /** The conflicts on this host, in full. */
  conflicts(signal: AbortSignal): Promise<ConflictsResult>;
  /**
   * The startup context of a host: this host measured in place, another over ssh with `fleet context --json`. It reads
   * files and starts no MCP server, so it is asked with the status.
   */
  context?(host: HostInfo, signal: AbortSignal): Promise<HostContext>;
  /** The conflicts on another host, in full, over ssh. Read-only there too: it neither clones nor fetches. */
  hostConflicts?(host: HostInfo, signal: AbortSignal): Promise<RemoteConflicts>;
  /** The config repo's history, one commit's changes, the secret names, and the catalog with the clones already on disk. None of them decrypts, clones, fetches or writes. */
  history(signal: AbortSignal): Promise<History>;
  commitDiff(sha: string, signal: AbortSignal): Promise<CommitDiff>;
  secrets(signal: AbortSignal): Promise<SecretsView>;
  catalog(signal: AbortSignal): Promise<CatalogView>;
  /**
   * `fleet doctor --json` (with `--all` for every host), run as a child. Unlike every other question this one starts
   * the MCP servers the hosts have picked, with their real credentials, so only a confirmed key press ever asks it.
   */
  doctor?(all: boolean, signal: AbortSignal): Promise<DoctorResult>;
};

/** The browsing questions answered from the files under `configDir` and the clones under `home`. */
export function readingProbe(configDir: string, home: string): Pick<Probe, "history" | "commitDiff" | "secrets" | "catalog"> {
  return {
    history: async () => readHistory(configDir, home),
    commitDiff: async (sha) => readCommitDiff(configDir, home, sha),
    secrets: async () => readSecrets(configDir, home),
    catalog: async () => readCatalog(configDir, home),
  };
}

function inWorker<T>(job: Job, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: job });
    const stop = () => void worker.terminate();
    signal.addEventListener("abort", stop, { once: true });
    worker.once("message", (m: T) => resolve(m));
    worker.once("error", reject);
    worker.once("exit", () => {
      signal.removeEventListener("abort", stop);
      resolve(undefined as T);
    });
  });
}

type Reply = { code: string; fields?: StatusFields | null; conflicts?: Conflict[]; messages?: string[] } | undefined;

const reason = (messages: string[] | undefined): string => printable((messages ?? []).map((m) => m.replace(/^fleet: /, "")).join("; ")) ?? "no reason given";

export const CONFLICTS_COMMAND = "~/.local/bin/fleet status --conflicts --json";
const MAX_CONFLICTS = 50;
const KINDS = ["link", "key", "repo", "removal"] as const;

/** Reads what a host printed for `status --conflicts --json`: only the four known fields of each conflict, as printable text. Null when it is not that document. */
export function readConflicts(stdout: string): Conflict[] | null {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null || (doc as { code?: unknown }).code !== "ok" || !Array.isArray((doc as { conflicts?: unknown }).conflicts)) return null;
  const items: Conflict[] = [];
  for (const c of (doc as { conflicts: unknown[] }).conflicts.slice(0, MAX_CONFLICTS)) {
    if (typeof c !== "object" || c === null) continue;
    const o = c as Record<string, unknown>;
    const kind = KINDS.find((k) => k === o.kind) ?? "link";
    items.push({ kind, path: printable(o.path) ?? "", detail: printable(o.detail) ?? "", fix: printable(o.fix) ?? "" });
  }
  return items;
}

/** Runs `ssh` without blocking, with the same arguments `fleet status --all` uses. */
function ssh(path: string, dest: string, home: string, signal: AbortSignal, command?: string): Promise<{ error?: Error; status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(path, command === undefined ? sshArguments(dest) : ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", dest, command], { stdio: ["ignore", "pipe", "pipe"], signal, timeout: 60_000, env: { ...process.env, HOME: home } });
    let [stdout, stderr] = ["", ""];
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.once("error", (error) => resolve({ error, status: null, stdout, stderr }));
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** The longest `fleet doctor --all` may take: every server of every host at its own timeout. */
const DOCTOR_LIMIT_MS = 15 * 60_000;

/** Runs `fleet doctor --json` in the tool at `toolDir` as `home`, and reads its document. The exit code is not looked at. */
function runDoctor(toolDir: string, configDir: string, home: string, self: string | null, all: boolean, signal: AbortSignal): Promise<DoctorResult> {
  return new Promise((resolve) => {
    const child = spawn(join(toolDir, "bin/fleet"), ["doctor", "--json", ...(all ? ["--all"] : [])], {
      stdio: ["ignore", "pipe", "ignore"],
      signal,
      timeout: DOCTOR_LIMIT_MS,
      env: { ...process.env, FLEET_EVENTS: "0", FLEET_NODE: probedNode(), FLEET_CONFIG: configDir, HOME: home },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.once("error", (error) => resolve({ ok: false, detail: `cannot run fleet doctor: ${printable(error.message) ?? "unknown error"}` }));
    child.once("close", () => resolve(readDoctor(stdout, self)));
  });
}

export function realProbe(toolDir: string, configDir: string, home: string): Probe {
  return {
    ...readingProbe(configDir, home),
    async host(host, signal) {
      if (host.self) {
        const r = await inWorker<Reply>({ op: "status", toolDir, configDir, home }, signal);
        if (r?.code === "ok" && r.fields) return { result: "ok", status: r.fields };
        return { result: "error", status: null, detail: reason(r?.messages ?? ["the local status could not be read"]) };
      }
      if (host.ssh === null) return { result: "timer", status: null };
      const path = findTool("ssh", process.env, home);
      if (path === null) return { result: "error", status: null, detail: "ssh is not installed" };
      const notes: string[] = [];
      const answer = hostStatusFrom(host.name, await ssh(path, host.ssh, home, signal), notes);
      // Everything that came from the host passes through `printable` on its way in; the notes are cut the same way.
      const detail = answer.detail ?? printable((notes[0] ?? "").replace(/^fleet: [^:]*: /, "")) ?? undefined;
      return { result: answer.result as HostResult["result"], status: answer.status, ...(answer.result === "ok" ? {} : { detail: detail ?? "" }) };
    },
    doctor: (all, signal) => runDoctor(toolDir, configDir, home, readHostName(home), all, signal),
    async context(host, signal) {
      if (host.self) return { host: host.name, result: "ok", context: measureHere(configDir, home, new Date()).report };
      if (host.ssh === null) return { host: host.name, result: "timer", context: null };
      const path = findTool("ssh", process.env, home);
      if (path === null) return { host: host.name, result: "error", context: null, detail: "ssh is not installed" };
      const notes: string[] = [];
      const answer = hostContextFrom(host.name, await ssh(path, host.ssh, home, signal, CONTEXT_COMMAND), notes);
      if (answer.result !== "unreachable") return answer;
      // The note carries the reason ssh gave, already cut to printable text.
      return { ...answer, detail: printable((notes[0] ?? "").replace(/^fleet: [^:]*: /, "")) ?? "unreachable over ssh" };
    },
    async hostConflicts(host, signal) {
      if (host.ssh === null) return { ok: false, reason: "error", detail: "no ssh destination" };
      const path = findTool("ssh", process.env, home);
      if (path === null) return { ok: false, reason: "error", detail: "ssh is not installed" };
      const r = await ssh(path, host.ssh, home, signal, CONFLICTS_COMMAND);
      if (r.error || r.status === 255) return { ok: false, reason: "error", detail: printable(r.error?.message ?? (r.stderr.trim().split("\n")[0] || "unreachable over ssh")) ?? "unreachable over ssh" };
      // An older pin does not know the option and exits 2, whatever it printed.
      if (r.status === 2) return { ok: false, reason: "old", detail: "detail needs a newer pin" };
      const items = readConflicts(r.stdout);
      return items === null ? { ok: false, reason: "error", detail: `its answer was not a conflicts document (exit ${r.status ?? "none"})` } : { ok: true, items };
    },
    async conflicts(signal) {
      const r = await inWorker<Reply>({ op: "conflicts", toolDir, configDir, home }, signal);
      if (r?.code === "ok" && r.conflicts) return { ok: true, items: r.conflicts };
      return { ok: false, detail: reason(r?.messages ?? ["the conflicts could not be read"]) };
    },
  };
}
