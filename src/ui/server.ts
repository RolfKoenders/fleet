import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync, statSync, createReadStream } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { extname, join, sep } from "node:path";
import { BadRequest, routes } from "./api.ts";
import type { ApiResponse } from "./api.ts";

/**
 * The server behind `fleet ui`. It can write config and push, so it must be reachable by you and nothing else:
 *   - it binds 127.0.0.1 only, and there is no option to bind elsewhere;
 *   - a request whose Host is not `127.0.0.1:<port>` is refused (a DNS rebinding page reaches this socket under its own name);
 *   - a write must carry an Origin of exactly `http://127.0.0.1:<port>`;
 *   - every API call carries the random token, compared in constant time. There is no cookie, so nothing is sent by
 *     the browser on its own, and no CORS header is ever sent, so no other page may read an answer.
 * Static files are the only thing served without the token, and they hold no data of yours.
 * Nothing here logs a request: not its URL (the stream's token is in it), not its body.
 */

export type UiOptions = {
  toolDir: string;
  configDir: string;
  home: string;
  /** 0 (the default) takes a free port. */
  port?: number;
  /** How long with no open stream before the server stops itself. Default 10 minutes. */
  idleMs?: number;
  /** Where the page's files are. Default: `static/` beside this file. */
  staticDir?: string;
};

export type UiServer = {
  url: string;
  port: number;
  token: string;
  address: string;
  /** Resolves when the server has stopped: `idle` for the timeout, `closed` for `close()`. */
  stopped: Promise<"idle" | "closed">;
  close(): Promise<void>;
};

export const IDLE_MS = 10 * 60 * 1000;
const MAX_BODY = 64 * 1024;
const HEARTBEAT_MS = 15_000;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const digest = (s: string) => createHash("sha256").update(s).digest();
/** Constant time: both sides are hashed first, so the length of the secret does not show either. */
const sameToken = (given: string, token: string) => timingSafeEqual(digest(given), digest(token));

export async function startUi(options: UiOptions): Promise<UiServer> {
  const token = randomBytes(32).toString("base64url");
  const staticDir = options.staticDir ?? join(import.meta.dirname, "static");
  const idleMs = options.idleMs ?? IDLE_MS;
  const streams = new Set<ServerResponse>();
  let jobs = 0;
  let port = 0;
  let idleTimer: NodeJS.Timeout | null = null;
  let stop!: (why: "idle" | "closed") => void;
  const stopped = new Promise<"idle" | "closed">((resolve) => (stop = resolve));

  const broadcast = (event: string, data: unknown) => {
    for (const stream of streams) stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const api = routes({
    toolDir: options.toolDir,
    configDir: options.configDir,
    home: options.home,
    broadcast,
    busy: () => {
      jobs++;
      if (idleTimer) clearTimeout(idleTimer);
      return () => {
        jobs--;
        armIdle();
      };
    },
  });

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { ok: false, code: "error", messages: ["fleet: the page's request failed"] });
      else res.end();
    });
  });

  function armIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (streams.size > 0 || jobs > 0) return;
    idleTimer = setTimeout(() => void shutdown("idle"), idleMs);
    idleTimer.unref();
  }

  async function shutdown(why: "idle" | "closed"): Promise<void> {
    if (idleTimer) clearTimeout(idleTimer);
    for (const stream of streams) stream.end();
    streams.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    stop(why);
  }

  const send = (res: ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(text);
  };
  const refuse = (res: ServerResponse, status: number, code: string, message: string) => send(res, status, { ok: false, code, messages: [`fleet: ${message}`] });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = `http://127.0.0.1:${port}`;
    if (req.headers.host !== `127.0.0.1:${port}`) return refuse(res, 403, "forbidden", "the Host is not 127.0.0.1:" + port);
    const method = req.method ?? "GET";
    const write = method !== "GET" && method !== "HEAD";
    if (write && req.headers.origin !== origin) return refuse(res, 403, "forbidden", "a write must come from the page itself");
    const url = new URL(req.url ?? "/", origin);

    if (!url.pathname.startsWith("/api/")) return serveStatic(method, url.pathname, res);

    const given = url.pathname === "/api/events" ? (url.searchParams.get("token") ?? headerToken(req)) : headerToken(req);
    if (given === null || given === "") return refuse(res, 401, "unauthorized", "the token is missing");
    if (!sameToken(given, token)) return refuse(res, 403, "forbidden", "the token is wrong");

    if (method === "GET" && url.pathname === "/api/events") return openStream(req, res);
    const route = api.find((r) => r.path === url.pathname);
    if (!route) return refuse(res, 404, "invalid", "no such API route");
    if (route.method !== method) return refuse(res, 405, "invalid", `${url.pathname} does not take ${method}`);
    let answer: ApiResponse;
    try {
      answer = await route.handle({ json: () => readJson(req) });
    } catch (error) {
      if (error instanceof BadRequest) return refuse(res, 400, "invalid", error.message);
      throw error;
    }
    send(res, answer.status, answer.body);
  }

  function openStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-content-type-options": "nosniff" });
    res.write(`event: hello\ndata: ${JSON.stringify({ pushing: jobs > 0 })}\n\n`);
    streams.add(res);
    armIdle();
    const beat = setInterval(() => res.write(": keep-alive\n\n"), HEARTBEAT_MS);
    beat.unref();
    req.on("close", () => {
      clearInterval(beat);
      streams.delete(res);
      armIdle();
    });
  }

  function serveStatic(method: string, pathname: string, res: ServerResponse): void {
    if (method !== "GET" && method !== "HEAD") return refuse(res, 405, "invalid", "only GET is served here");
    const file = resolveStatic(staticDir, pathname);
    if (file === null) return refuse(res, 404, "invalid", "not found");
    res.writeHead(200, {
      "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": statSync(file).size,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    });
    if (method === "HEAD") return void res.end();
    createReadStream(file).pipe(res);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  server.removeAllListeners("error");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the server has no address");
  port = address.port;
  armIdle();
  return { url: `http://127.0.0.1:${port}/#t=${token}`, port, token, address: address.address, stopped, close: () => shutdown("closed") };
}

const headerToken = (req: IncomingMessage): string | null => {
  const v = req.headers["x-fleet-token"];
  return typeof v === "string" ? v : null;
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new BadRequest("the body must be application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new BadRequest("the body is too big");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadRequest("the body is not JSON");
  }
}

/**
 * The file a URL path names inside `root`, or null. Only a regular file that exists there: the path is decoded once,
 * refused when it holds a NUL, a backslash or a `..` segment, and the real path (symlinks followed) must still be
 * inside the real root.
 */
export function resolveStatic(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const parts = decoded.split("/").filter((p) => p !== "");
  if (parts.some((p) => p === ".." || p === ".")) return null;
  try {
    const base = realpathSync(root);
    const real = realpathSync(join(base, ...(parts.length === 0 ? ["index.html"] : parts)));
    if (!real.startsWith(base + sep) || !statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}
