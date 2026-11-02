import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { hostStatusFrom, printable, sshArguments } from "../status.ts";
import type { StatusFields } from "../status.ts";
import type { Conflict } from "../plan.ts";
import { findTool } from "../tools.ts";
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

/** The questions the bridge asks. All read-only; tests and the frame tool supply their own. */
export type Probe = {
  host(host: HostInfo, signal: AbortSignal): Promise<HostResult>;
  /** The conflicts on this host, in full. Other hosts report a count only. */
  conflicts(signal: AbortSignal): Promise<ConflictsResult>;
  /** The config repo's history, one commit's changes, the secret names, and the catalog with the clones already on disk. None of them decrypts, clones, fetches or writes. */
  history(signal: AbortSignal): Promise<History>;
  commitDiff(sha: string, signal: AbortSignal): Promise<CommitDiff>;
  secrets(signal: AbortSignal): Promise<SecretsView>;
  catalog(signal: AbortSignal): Promise<CatalogView>;
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

/** Runs `ssh` without blocking, with the same arguments `fleet status --all` uses. */
function ssh(path: string, dest: string, home: string, signal: AbortSignal): Promise<{ error?: Error; status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(path, sshArguments(dest), { stdio: ["ignore", "pipe", "pipe"], signal, timeout: 60_000, env: { ...process.env, HOME: home } });
    let [stdout, stderr] = ["", ""];
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.once("error", (error) => resolve({ error, status: null, stdout, stderr }));
    child.once("close", (status) => resolve({ status, stdout, stderr }));
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
    async conflicts(signal) {
      const r = await inWorker<Reply>({ op: "conflicts", toolDir, configDir, home }, signal);
      if (r?.code === "ok" && r.conflicts) return { ok: true, items: r.conflicts };
      return { ok: false, detail: reason(r?.messages ?? ["the conflicts could not be read"]) };
    },
  };
}
