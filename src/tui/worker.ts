import { parentPort, workerData } from "node:worker_threads";
import { planConflicts } from "../apply.ts";
import { status } from "../status.ts";

/** Runs one read-only question off the main thread, so the screen keeps moving while it is asked. */
export type Job = { op: "status" | "conflicts"; toolDir: string; configDir: string; home: string };

const job = workerData as Job;
try {
  if (job.op === "status") {
    const r = status(job.toolDir, job.configDir, false, job.home);
    parentPort!.postMessage({ code: r.code, fields: r.fields ?? null, messages: r.messages ?? [] });
  } else {
    const r = planConflicts(job.configDir, job.home);
    parentPort!.postMessage(Array.isArray(r) ? { code: "ok", conflicts: r } : { code: r.code, messages: r.messages ?? [] });
  }
} catch (error) {
  parentPort!.postMessage({ code: "error", messages: [(error as Error).message] });
}
