import { spawn } from "node:child_process";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { parseEvent } from "../events.ts";
import type { FleetEvent } from "../events.ts";
import { probedNode } from "../tools.ts";
import { describeRunning, finish, readEnd, reduce, startRun } from "./pushrun.ts";
import type { PushEnd, PushRun } from "./pushrun.ts";
import type { HostInfo } from "./model.ts";
import type { Job, Preview } from "./worker.ts";

export type PreviewResult = { ok: true; preview: Preview } | { ok: false; detail: string };

/**
 * What the bridge needs to push. `preview` only reads. `run` is the one thing that changes anything, and it is the real
 * `fleet push` as a child process: the bridge has no push of its own.
 */
export type Pusher = {
  preview(signal: AbortSignal): Promise<PreviewResult>;
  /** Runs the push, reporting each event as it arrives, and resolves when it has ended. */
  run(onEvent: (event: FleetEvent) => void): Promise<PushEnd>;
  /** What a push still in flight is doing, or null. After the screen is gone this is what is left to say. */
  running(): string | null;
  whenDone(): Promise<PushEnd> | null;
};

export class RealPusher implements Pusher {
  private readonly follow = new Tracker();
  private ended: Promise<PushEnd> | null = null;
  private readonly toolDir: string;
  private readonly configDir: string;
  private readonly home: string;
  private readonly hosts: HostInfo[];
  constructor(toolDir: string, configDir: string, home: string, hosts: HostInfo[]) {
    [this.toolDir, this.configDir, this.home, this.hosts] = [toolDir, configDir, home, hosts];
  }

  preview(signal: AbortSignal): Promise<PreviewResult> {
    return new Promise((resolve) => {
      const job: Job = { op: "preview", toolDir: this.toolDir, configDir: this.configDir, home: this.home };
      const worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: job });
      const stop = () => void worker.terminate();
      signal.addEventListener("abort", stop, { once: true });
      let answered = false;
      worker.once("message", (m: { code: string; preview?: Preview; messages?: string[] }) => {
        answered = true;
        resolve(m.preview ? { ok: true, preview: m.preview } : { ok: false, detail: (m.messages ?? []).join("; ") || "the preview could not be read" });
      });
      worker.once("error", (e) => resolve({ ok: false, detail: e.message }));
      worker.once("exit", () => {
        signal.removeEventListener("abort", stop);
        if (!answered) resolve({ ok: false, detail: "the preview was stopped" });
      });
    });
  }

  run(onEvent: (event: FleetEvent) => void): Promise<PushEnd> {
    this.follow.start(this.hosts);
    this.ended = new Promise((resolve) => {
      // Its own session: a Ctrl-C or a closed terminal aimed at the bridge does not reach it half way through a push.
      const child = spawn(join(this.toolDir, "bin/fleet"), ["push", "--json"], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FLEET_EVENTS: "1", FLEET_NODE: probedNode(), FLEET_CONFIG: this.configDir, HOME: this.home },
      });
      let [stdout, pending] = ["", ""];
      const take = (line: string) => {
        const event = parseEvent(line);
        this.follow.see(event);
        onEvent(event);
      };
      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => {
        pending += d;
        for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
          const line = pending.slice(0, at);
          pending = pending.slice(at + 1);
          if (line.trim() !== "") take(line);
        }
      });
      const end = (e: PushEnd) => {
        this.follow.finished(e);
        resolve(e);
      };
      child.once("error", (error) => end({ ...readEnd(null, ""), messages: [`fleet: cannot run fleet push: ${error.message}`] }));
      child.once("close", (code) => {
        if (pending.trim() !== "") take(pending);
        end(readEnd(code, stdout));
      });
    });
    return this.ended;
  }

  /** What the push in flight is doing, or null when none is. */
  running(): string | null {
    return this.follow.running;
  }

  /** Resolves with the push's end when one is in flight, else null. */
  whenDone(): Promise<PushEnd> | null {
    return this.follow.running === null ? null : this.ended;
  }
}

/** Follows a push from outside the screen, so that what is still running can be said after the screen is gone. */
class Tracker {
  run: PushRun | null = null;
  end: PushEnd | null = null;
  start(hosts: HostInfo[]): void {
    this.run = startRun(hosts, 0);
    this.end = null;
  }
  see(event: FleetEvent): void {
    if (this.run) this.run = reduce(this.run, event);
  }
  finished(end: PushEnd): void {
    this.end = end;
    if (this.run) this.run = finish(this.run, end);
  }
  get running(): string | null {
    return this.run !== null && this.end === null ? describeRunning(this.run) : null;
  }
}
