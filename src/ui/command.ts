import { spawn } from "node:child_process";
import type { Result } from "../output.ts";
import { startUi } from "./server.ts";

export type Opener = (url: string) => void;

/** The browser opener: `xdg-open` on Linux, `open` on macOS. Failing to open is not an error: the URL is printed. */
export const openBrowser: Opener = (url) => {
  const child = spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
};

export type UiCommand = {
  toolDir: string;
  configDir: () => string;
  home: string;
  json: boolean;
  port?: number | undefined;
  /** False for `--no-open`. */
  open: boolean;
  env?: NodeJS.ProcessEnv;
  idleMs?: number;
  opener?: Opener;
  /** Where the URL and the notes go. Default: stdout. */
  out?: (text: string) => void;
  /** Stops the server (ctrl-c). */
  signal?: AbortSignal;
};

/**
 * `fleet ui`: starts the local server, prints its URL, opens the browser (not with `--no-open`, not in an ssh
 * session), and returns when it is stopped: ctrl-c, or no page connected for the idle time.
 */
export async function ui(c: UiCommand): Promise<Result> {
  if (c.json) return { code: "invalid", messages: ["fleet: 'ui' is a page in a browser and has no --json form; use 'fleet status --json'"] };
  const out = c.out ?? ((text: string) => void process.stdout.write(text));
  const env = c.env ?? process.env;
  let server;
  try {
    server = await startUi({ toolDir: c.toolDir, configDir: c.configDir(), home: c.home, ...(c.port === undefined ? {} : { port: c.port }), ...(c.idleMs === undefined ? {} : { idleMs: c.idleMs }) });
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    return { code: "error", messages: [e.code === "EADDRINUSE" ? `fleet: port ${c.port} is already in use` : `fleet: cannot start the server: ${e.message}`] };
  }
  out(`fleet ui: ${server.url}\n`);
  const remote = (env.SSH_CONNECTION ?? "") !== "";
  if (c.open && !remote) (c.opener ?? openBrowser)(server.url);
  else if (remote) out(`This looks like an ssh session. From your own machine: ssh -L ${server.port}:127.0.0.1:${server.port} <this host>, then open the URL above there.\n`);
  out("Press ctrl-c to stop.\n");
  const abort = () => void server.close();
  if (c.signal?.aborted) abort();
  c.signal?.addEventListener("abort", abort, { once: true });
  const why = await server.stopped;
  c.signal?.removeEventListener("abort", abort);
  return { code: "ok", text: why === "idle" ? "fleet ui stopped: no page was connected for a while" : "fleet ui stopped" };
}
