import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findTool } from "./tools.ts";
import type { Os } from "./scheduler.ts";

/**
 * The three ways an alert leaves a host. Each returns what happened as a word and, when it did not send, a
 * reason fleet wrote itself. A reason never holds a URL, a token or anything the other end said, since the
 * apply log and `fleet status` show it and a URL can be a secret.
 */

export type Event = "conflict" | "failed" | "ok";

/** One alert, as every channel gets it. `message` is the sentence; the webhook also gets the fields. */
export type Alert = {
  event: Event;
  host: string;
  message: string;
  conflict: { kind: string; path: string } | null;
  time: string;
  fleet: string;
  /** Set by `fleet notify --test`. */
  test?: true;
};

export type Outcome = { status: "sent" } | { status: "skipped"; reason: string } | { status: "failed"; reason: string };

/** A channel's outcome as one line: `sent`, `skipped: ...` or `failed: ...`. */
export const outcomeText = (o: Outcome): string => (o.status === "sent" ? "sent" : `${o.status}: ${o.reason}`);

export type Senders = {
  desktop: (alert: Alert) => Promise<Outcome>;
  ntfy: (url: string, token: string | null, alert: Alert) => Promise<Outcome>;
  webhook: (url: string, alert: Alert) => Promise<Outcome>;
};

const TIMEOUT_MS = 10_000;

/** Header values are Latin-1 and one line. */
const headerText = (text: string): string => text.replace(/[^\x20-\x7e]/g, "?");

async function post(url: string, headers: Record<string, string>, body: string): Promise<Outcome> {
  try {
    // A redirect is not followed: a token would go along to wherever it points.
    const r = await fetch(url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    await r.body?.cancel();
    return r.status >= 200 && r.status < 300 ? { status: "sent" } : { status: "failed", reason: `HTTP ${r.status}` };
  } catch (error) {
    const name = (error as Error).name;
    const code = ((error as Error).cause as NodeJS.ErrnoException | undefined)?.code;
    if (name === "TimeoutError" || name === "AbortError") return { status: "failed", reason: "timed out" };
    if (code === "ECONNREFUSED") return { status: "failed", reason: "connection refused" };
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { status: "failed", reason: "host not found" };
    if (code === ("ERR_INVALID_URL" as string)) return { status: "failed", reason: "not a valid URL" };
    return { status: "failed", reason: "could not connect" };
  }
}

const ntfy: Senders["ntfy"] = (url, token, alert) =>
  post(
    url,
    {
      Title: headerText(`fleet: ${alert.host}`),
      Priority: alert.event === "ok" ? "default" : "high",
      Tags: alert.event === "ok" ? "white_check_mark" : "warning",
      ...(token === null ? {} : { Authorization: `Bearer ${headerText(token)}` }),
    },
    alert.message,
  );

const webhook: Senders["webhook"] = (url, alert) => {
  const { event, host, message, conflict, time, fleet, test } = alert;
  return post(url, { "Content-Type": "application/json" }, JSON.stringify({ v: 1, host, event, message, conflict, time, fleet, ...(test ? { test: true } : {}) }));
};

type Ran = { status: number | null; stderr: string };

const run = (path: string, args: string[], env: NodeJS.ProcessEnv): Promise<Ran> =>
  new Promise((resolve) => {
    execFile(path, args, { env, timeout: TIMEOUT_MS, encoding: "utf8" }, (error, _stdout, stderr) => {
      const code = (error as (NodeJS.ErrnoException & { code?: unknown }) | null)?.code;
      resolve({ status: error === null ? 0 : typeof code === "number" ? code : 1, stderr });
    });
  });

/**
 * A desktop notification: `notify-send` on Linux, `osascript` on a Mac. A host with no desktop session is
 * skipped, never an error: a server has none, and a timer run on a laptop can start before the user has logged in.
 * The text goes in as arguments, never into a script.
 */
export function desktopSender(home: string, os: Os, env: NodeJS.ProcessEnv): Senders["desktop"] {
  return async (alert) => {
    const title = `fleet: ${alert.host}`;
    if (os === "darwin") {
      const path = findTool("osascript", env, home);
      if (path === null) return { status: "skipped", reason: "osascript is not installed" };
      const r = await run(path, ["-e", "on run argv", "-e", "display notification (item 1 of argv) with title (item 2 of argv)", "-e", "end run", alert.message, title], env);
      if (r.status === 0) return { status: "sent" };
      return /connection invalid|window server|no user interaction/i.test(r.stderr) ? { status: "skipped", reason: "no desktop session" } : { status: "failed", reason: "osascript failed" };
    }
    const path = findTool("notify-send", env, home);
    if (path === null) return { status: "skipped", reason: "notify-send is not installed" };
    const display = (env.DISPLAY ?? "") !== "" || (env.WAYLAND_DISPLAY ?? "") !== "";
    // A timer run has no display variable, but a user session has a bus, and notify-send finds it by this address.
    const bus = env.XDG_RUNTIME_DIR === undefined ? null : join(env.XDG_RUNTIME_DIR, "bus");
    const address = env.DBUS_SESSION_BUS_ADDRESS ?? (bus !== null && existsSync(bus) ? `unix:path=${bus}` : null);
    if (!display && address === null) return { status: "skipped", reason: "no desktop session" };
    const r = await run(path, ["--app-name=fleet", alert.event === "ok" ? "--urgency=normal" : "--urgency=critical", title, alert.message], { ...env, ...(address === null ? {} : { DBUS_SESSION_BUS_ADDRESS: address }) });
    if (r.status === 0) return { status: "sent" };
    return display ? { status: "failed", reason: "notify-send failed" } : { status: "skipped", reason: "no desktop session" };
  };
}

/** The senders a host really uses. */
export const realSenders = (home: string, os: Os, env: NodeJS.ProcessEnv): Senders => ({ desktop: desktopSender(home, os, env), ntfy, webhook });
