import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { isObject } from "./yamlfile.ts";

/**
 * What `fleet doctor` says to one MCP server, in both eras of the protocol. It asks the modern way first:
 * `server/discover` (revision 2026-07-28 and later, which carries version and identity on every request),
 * then `tools/list`. A server that does not answer that as a modern one is taken to be a legacy one, and is
 * asked the initialize way (revision 2025-11-25): `initialize`, `notifications/initialized`, `tools/list`.
 * Nothing here prints; the caller decides what a person may see.
 */

export const PROTOCOL_VERSION = "2025-11-25";
export const MODERN_VERSION = "2026-07-28";

const VERSION = /^\d{4}-\d{2}-\d{2}$/;
/** JSON-RPC errors only a modern server sends: header mismatch, missing capability, unsupported version. */
const MODERN_ERRORS = [-32020, -32021, -32022];
const UNSUPPORTED_VERSION = -32022;

export type ProbeResult = "ok" | "auth-needed" | "unreachable" | "missing-binary" | "bad-response" | "exited" | "timeout";

/** What to start or call. `transport` is `remote` when the config does not say http or sse (opencode). */
export type ProbeTarget =
  | { kind: "stdio"; command: string[]; env: Record<string, string>; cwd: string }
  | { kind: "network"; transport: "http" | "sse" | "remote"; url: string; headers: Record<string, string> };

/**
 * `protocol` is the revision the server answered in, or null when it did not answer. `size` is the summed length
 * in characters of each tool's definition as JSON (see `definitionSize`), null when the server did not answer.
 */
export type Probed = { result: ProbeResult; tools: number | null; size: number | null; latencyMs: number | null; detail: string | null; protocol: string | null };

/** A way the handshake ended that is not success. `detail` is fixed text or a number: never server or config text. */
class ProbeError extends Error {
  result: ProbeResult;
  detail: string;
  /** The JSON-RPC error code the server sent, and the versions it listed with it. Used to decide what to try next, never shown. */
  code: number | null;
  supported: string[];
  constructor(result: ProbeResult, detail: string, code: number | null = null, supported: string[] = []) {
    super(detail);
    this.result = result;
    this.detail = detail;
    this.code = code;
    this.supported = supported;
  }
}

const isModernError = (error: unknown): error is ProbeError => error instanceof ProbeError && error.code !== null && MODERN_ERRORS.includes(error.code);

/** Both ends of the conversation, whatever carries it. */
type Channel = {
  /** `modern` is the revision of a modern request, which an HTTP channel sends as headers and sends without a session. */
  request(method: string, params: unknown, modern?: string): Promise<Record<string, unknown>>;
  notify(method: string): Promise<void>;
  /** The version the server chose, which an HTTP channel must send on later requests. */
  negotiated(version: string): void;
  close(): Promise<void>;
};

const MAX_PAGES = 20;
const MAX_BYTES = 4 * 1024 * 1024;

function rpcResult(message: unknown, id: number): Record<string, unknown> {
  if (!isObject(message)) throw new ProbeError("bad-response", "the answer was not a JSON-RPC message");
  if (isObject(message.error)) {
    const code = typeof message.error.code === "number" ? message.error.code : null;
    const data = message.error.data;
    const supported = isObject(data) && Array.isArray(data.supported) ? data.supported.filter((v): v is string => typeof v === "string" && VERSION.test(v)) : [];
    throw new ProbeError("bad-response", `the server answered with JSON-RPC error ${code ?? "?"}`, code, supported);
  }
  if (message.id !== id || !isObject(message.result)) throw new ProbeError("bad-response", "the answer was not a JSON-RPC result");
  return message.result;
}

const versionOf = (init: Record<string, unknown>): string | null => (typeof init.protocolVersion === "string" && VERSION.test(init.protocolVersion) ? init.protocolVersion : null);

/**
 * What a tool costs a model that is shown it: the length of the JSON of its name, description and input schema.
 * Only the length leaves this function, never the text.
 */
export const definitionSize = (tool: unknown): number => {
  const { name, description, inputSchema } = isObject(tool) ? tool : ({} as Record<string, unknown>);
  return JSON.stringify({ name, description, inputSchema }).length;
};

type Listed = { tools: number; size: number };

/** What the server offers: `tools/list` page by page, counted and measured. `modern` adds the metadata that era wants to every request. */
async function listTools(channel: Channel, modern?: string): Promise<Listed> {
  const meta = modern === undefined ? {} : { _meta: modernMeta(modern) };
  let tools = 0;
  let size = 0;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    let result;
    try {
      result = await channel.request("tools/list", cursor === undefined ? meta : { ...meta, cursor }, modern);
    } catch (error) {
      // A server with no tools may not implement the method at all.
      if (error instanceof ProbeError && error.code === -32601 && page === 0) return { tools: 0, size: 0 };
      throw error;
    }
    if (!Array.isArray(result.tools)) throw new ProbeError("bad-response", "the tools/list answer has no tools list");
    tools += result.tools.length;
    for (const tool of result.tools) size += definitionSize(tool);
    if (typeof result.nextCursor !== "string" || result.nextCursor === "") return { tools, size };
    cursor = result.nextCursor;
  }
  return { tools, size };
}

/** The legacy way: `initialize`, then `notifications/initialized`, then the tools. */
async function legacyHandshake(channel: Channel): Promise<Answered> {
  const init = await channel.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "fleet-doctor", version: "1" },
  });
  if (typeof init.protocolVersion !== "string" || !isObject(init.capabilities)) {
    throw new ProbeError("bad-response", "the initialize answer has no protocolVersion and capabilities");
  }
  channel.negotiated(init.protocolVersion);
  await channel.notify("notifications/initialized");
  return { ...(await listTools(channel)), protocol: versionOf(init) };
}

const modernMeta = (version: string) => ({
  "io.modelcontextprotocol/protocolVersion": version,
  "io.modelcontextprotocol/clientInfo": { name: "fleet-doctor", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
});

/** The newest revision in `versions` that is modern, or null. */
const newestModern = (versions: string[]): string | null => [...versions].filter((v) => VERSION.test(v) && v >= MODERN_VERSION).sort().at(-1) ?? null;

/**
 * The modern way, first half: `server/discover`, giving the revision to use. Throws a `bad-response` for
 * anything that does not look like a modern server; the caller then tries the legacy way. A modern server's
 * own errors (`isModernError`) are not that: it is modern, and a version it will not speak is a failure to report.
 */
async function modernDiscover(channel: Channel, graceMs: number | null): Promise<string> {
  const discover = async (version: string): Promise<Record<string, unknown>> => {
    const asking = channel.request("server/discover", { _meta: modernMeta(version) }, version);
    if (graceMs === null) return asking;
    // stdio has no status code: a legacy server may stay silent, which the spec says to read as legacy.
    asking.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    const silent = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProbeError("bad-response", "no answer to server/discover")), graceMs);
    });
    try {
      return await Promise.race([asking, silent]);
    } finally {
      clearTimeout(timer);
    }
  };

  let version = MODERN_VERSION;
  let found: Record<string, unknown>;
  try {
    found = await discover(version);
  } catch (error) {
    if (!(error instanceof ProbeError) || error.code !== UNSUPPORTED_VERSION) throw error;
    // A modern server that does not speak ours: use the newest of its versions that is modern, once.
    const other = newestModern(error.supported);
    if (other === null) {
      if (error.supported.includes(PROTOCOL_VERSION)) throw new ProbeError("bad-response", "the server speaks only the initialize era", null);
      throw new ProbeError("bad-response", "the server speaks no protocol revision fleet speaks", UNSUPPORTED_VERSION);
    }
    version = other;
    found = await discover(version);
  }
  const supported = Array.isArray(found.supportedVersions) ? found.supportedVersions.filter((v): v is string => typeof v === "string") : null;
  if (supported === null || (found.resultType !== undefined && found.resultType !== "complete")) {
    throw new ProbeError("bad-response", "the server/discover answer has no supportedVersions");
  }
  const chosen = supported.includes(version) ? version : newestModern(supported);
  if (chosen === null) throw new ProbeError("bad-response", "the server/discover answer lists no modern revision");
  return chosen;
}

// ---- stdio ----

const live = new Set<number>();
let hooked = false;

function killGroups(): void {
  for (const pid of live) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** Whatever happens to fleet, no server it started is left running. */
function hookExit(): void {
  if (hooked) return;
  hooked = true;
  process.on("exit", killGroups);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      killGroups();
      process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 })[signal]);
    });
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The program to run, or null when it is not there or not executable. A bare name is searched for in the entry's own `PATH`, then the probe path. */
export function resolveProgram(program: string, env: NodeJS.ProcessEnv, extraDirs: string[]): string | null {
  const executable = (path: string) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (program.includes("/")) return executable(program) ? program : null;
  for (const dir of [...(env.PATH ?? "").split(delimiter), ...extraDirs]) {
    if (dir !== "" && executable(join(dir, program))) return join(dir, program);
  }
  return null;
}

function stdioChannel(target: Extract<ProbeTarget, { kind: "stdio" }>, extraDirs: string[]): Channel {
  const env = { ...process.env, ...target.env };
  const program = resolveProgram(target.command[0]!, env, extraDirs);
  if (program === null) throw new ProbeError("missing-binary", "the command is not installed or not executable");

  hookExit();
  // Its own process group, so a server that starts helpers (npx does) is stopped with them. Its stderr is never read.
  const child = spawn(program, target.command.slice(1), { env, cwd: target.cwd, detached: true, stdio: ["pipe", "pipe", "ignore"] });
  const pid = child.pid;
  if (pid !== undefined) live.add(pid);

  let failure: ProbeError | null = null;
  let exited = false;
  const waiting = new Map<number, { resolve: (m: unknown) => void; reject: (e: ProbeError) => void }>();
  const fail = (error: ProbeError) => {
    failure ??= error;
    for (const w of waiting.values()) w.reject(error);
    waiting.clear();
  };
  child.on("error", (error: NodeJS.ErrnoException) => {
    fail(error.code === "ENOENT" || error.code === "EACCES" ? new ProbeError("missing-binary", "the command could not be started") : new ProbeError("exited", "the command could not be started"));
  });
  child.on("close", (code, signal) => {
    exited = true;
    fail(new ProbeError("exited", `the server exited before answering (${signal === null ? `exit code ${code}` : `signal ${signal}`})`));
  });
  child.stdin.on("error", () => {
    // The server closed its input; the exit is reported by 'close'.
  });

  let buffer = "";
  let bytes = 0;
  let junk = 0;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) return fail(new ProbeError("bad-response", "the server sent too much output"));
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line === "") continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        junk++;
        continue;
      }
      if (isObject(message) && typeof message.id === "number" && !("method" in message)) {
        waiting.get(message.id)?.resolve(message);
        waiting.delete(message.id);
      }
    }
  });

  let nextId = 1;
  const write = (message: object) => {
    if (failure !== null) throw failure;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  return {
    request(method, params) {
      const id = nextId++;
      // Text that is not JSON-RPC, then silence or an exit, is a bad answer, not just an exit.
      const named = (error: unknown): never => {
        if (junk > 0 && error instanceof ProbeError && error.result === "exited") throw new ProbeError("bad-response", "the server wrote text that is not JSON-RPC to its output and then exited");
        throw error;
      };
      const answer = new Promise<unknown>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
      });
      try {
        write({ id, method, params });
      } catch (error) {
        waiting.delete(id);
        answer.catch(() => {});
        return Promise.reject(error).catch(named);
      }
      return answer.then((message) => rpcResult(message, id), named);
    },
    async notify(method) {
      write({ method });
    },
    negotiated() {},
    async close() {
      child.stdin.end();
      if (!exited) {
        try {
          process.kill(-pid!, "SIGTERM");
        } catch {
          // already gone
        }
        await Promise.race([new Promise<void>((resolve) => child.once("close", () => resolve())), sleep(500)]);
      }
      // The leader may be gone while a helper it started is not.
      try {
        process.kill(-pid!, "SIGKILL");
      } catch {
        // nothing left
      }
      live.delete(pid!);
    },
  };
}

// ---- HTTP ----

type SseEvent = { event: string; data: string };

/** Events of an SSE body, as they arrive. */
async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      bytes += value.length;
      if (bytes > MAX_BYTES) throw new ProbeError("bad-response", "the server sent too much output");
      text += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      for (let at = text.indexOf("\n\n"); at >= 0; at = text.indexOf("\n\n")) {
        const block = text.slice(0, at);
        text = text.slice(at + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        yield { event, data: data.join("\n") };
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

const NETWORK_CODES = /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_[A-Z_]+|(?:ERR_)?(?:TLS|SSL|CERT)[A-Z_]*|[A-Z_]*CERT[A-Z_]*)$/;

/** A failed fetch as a probe error. The message is never used: it can carry the URL, and a URL can carry a secret. */
function fetchFailure(error: unknown, signal: AbortSignal): ProbeError {
  if (error instanceof ProbeError) return error;
  if (signal.aborted) return new ProbeError("timeout", "no answer in time");
  const code = (error as { cause?: { code?: unknown } }).cause?.code;
  if (typeof code === "string" && NETWORK_CODES.test(code)) return new ProbeError("unreachable", `the connection failed (${code})`);
  if (error instanceof TypeError && /header/i.test(String((error as Error).message))) return new ProbeError("bad-response", "a configured header is not valid");
  return new ProbeError("unreachable", "the connection failed");
}

function checkStatus(response: Response, hasCredentials: boolean): void {
  if (response.status === 401 || response.status === 403) {
    throw new ProbeError(
      "auth-needed",
      hasCredentials
        ? `the server rejected the configured credentials (HTTP ${response.status})`
        : `the server wants a login (HTTP ${response.status}); fleet cannot tell whether one was done`,
    );
  }
  if (!response.ok) throw new ProbeError("bad-response", `HTTP ${response.status}`);
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ProbeError("bad-response", "the answer was not JSON");
  }
}

function checkedUrl(url: string): URL {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new ProbeError("bad-response", "the configured url is not a URL");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") throw new ProbeError("bad-response", "the configured url is not http or https");
  return parsedUrl;
}

/** A response body as text, cut off at the size limit. */
async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (let bytes = 0; bytes <= MAX_BYTES; ) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}

/** Streamable HTTP: each message is a POST, answered by JSON or by an SSE stream. */
function httpChannel(target: Extract<ProbeTarget, { kind: "network" }>, signal: AbortSignal): Channel {
  const url = checkedUrl(target.url);
  const credentials = Object.keys(target.headers).length > 0;
  let session: string | null = null;
  let version: string | null = null;
  let nextId = 1;

  const post = async (message: { method: string; id?: number; params?: unknown }, modern?: string): Promise<Response> => {
    const headers: Record<string, string> = { ...target.headers, "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (modern !== undefined) {
      // The modern era has no session: each request names its revision and method.
      headers["mcp-protocol-version"] = modern;
      headers["mcp-method"] = message.method;
    } else {
      if (session !== null) headers["mcp-session-id"] = session;
      if (version !== null) headers["mcp-protocol-version"] = version;
    }
    let response;
    try {
      response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...message }), signal, redirect: "follow" });
    } catch (error) {
      throw fetchFailure(error, signal);
    }
    // A modern server explains a 400 in the body, which tells it from a legacy server that just refuses.
    if (modern !== undefined && !response.ok && response.status !== 401 && response.status !== 403) {
      const text = await boundedText(response);
      let message: unknown = null;
      try {
        message = JSON.parse(text);
      } catch {
        // not JSON: not a modern error
      }
      if (isObject(message) && isObject(message.error) && typeof message.error.code === "number" && MODERN_ERRORS.includes(message.error.code)) rpcResult(message, -1);
      throw new ProbeError("bad-response", `HTTP ${response.status}`);
    }
    checkStatus(response, credentials);
    return response;
  };

  return {
    async request(method, params, modern) {
      const id = nextId++;
      const response = await post({ id, method, params }, modern);
      if (modern === undefined) session ??= response.headers.get("mcp-session-id");
      try {
        if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
          if (response.body === null) throw new ProbeError("bad-response", "the answer had no body");
          for await (const event of events(response.body)) {
            if (event.data === "") continue;
            const message = parsed(event.data);
            if (isObject(message) && message.id === id) return rpcResult(message, id);
          }
          throw new ProbeError("bad-response", "the stream ended without an answer");
        }
        return rpcResult(parsed(await response.text()), id);
      } catch (error) {
        throw fetchFailure(error, signal);
      }
    },
    async notify(method) {
      const response = await post({ method });
      await response.body?.cancel().catch(() => {});
    },
    negotiated(v) {
      version = v;
    },
    async close() {
      if (session === null || signal.aborted) return;
      const headers: Record<string, string> = { ...target.headers, "mcp-session-id": session };
      if (version !== null) headers["mcp-protocol-version"] = version;
      await fetch(url, { method: "DELETE", headers, signal: AbortSignal.timeout(1500) }).then((r) => r.body?.cancel()).catch(() => {});
    },
  };
}

/** The deprecated HTTP+SSE transport: a GET stream that names an endpoint, POSTs there, answers on the stream. */
async function sseChannel(target: Extract<ProbeTarget, { kind: "network" }>, signal: AbortSignal): Promise<Channel> {
  const url = checkedUrl(target.url);
  const credentials = Object.keys(target.headers).length > 0;
  let response;
  try {
    response = await fetch(url, { headers: { ...target.headers, accept: "text/event-stream" }, signal });
  } catch (error) {
    throw fetchFailure(error, signal);
  }
  checkStatus(response, credentials);
  if (response.body === null || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    throw new ProbeError("bad-response", "the url did not open an event stream");
  }

  const stream = events(response.body)[Symbol.asyncIterator]();
  const waiting = new Map<number, { resolve: (m: unknown) => void; reject: (e: ProbeError) => void }>();
  const endpoint: { found: (url: URL) => void } = { found: () => {} };
  const endpointReady = new Promise<URL>((resolve) => {
    endpoint.found = resolve;
  });
  let ended: ProbeError | null = null;
  const end = (error: ProbeError) => {
    ended ??= error;
    for (const w of waiting.values()) w.reject(error);
    waiting.clear();
  };
  void (async () => {
    try {
      for (;;) {
        const next = await stream.next();
        if (next.done) return end(new ProbeError("bad-response", "the event stream ended"));
        const event = next.value;
        if (event.event === "endpoint") {
          const where = new URL(event.data.trim(), url);
          if (where.origin !== url.origin) return end(new ProbeError("bad-response", "the stream named an endpoint on another host"));
          endpoint.found(where);
        } else if (event.event === "message" && event.data !== "") {
          const message = parsed(event.data);
          if (isObject(message) && typeof message.id === "number") {
            waiting.get(message.id)?.resolve(message);
            waiting.delete(message.id);
          }
        }
      }
    } catch (error) {
      end(fetchFailure(error, signal));
    }
  })();

  const where = await Promise.race([
    endpointReady,
    new Promise<never>((_, reject) => {
      const stop = () => reject(ended ?? new ProbeError("timeout", "no answer in time"));
      signal.addEventListener("abort", stop, { once: true });
      const poll = setInterval(() => {
        if (ended !== null) {
          clearInterval(poll);
          stop();
        }
      }, 20);
      poll.unref();
    }),
  ]);

  let nextId = 1;
  const send = async (message: object) => {
    let r;
    try {
      r = await fetch(where, { method: "POST", headers: { ...target.headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", ...message }), signal });
    } catch (error) {
      throw fetchFailure(error, signal);
    }
    checkStatus(r, credentials);
    await r.body?.cancel().catch(() => {});
  };
  return {
    async request(method, params) {
      const id = nextId++;
      const answer = new Promise<unknown>((resolve, reject) => {
        if (ended !== null) return reject(ended);
        waiting.set(id, { resolve, reject });
      });
      await send({ id, method, params });
      return rpcResult(await answer, id);
    },
    notify: (method) => send({ method }),
    negotiated() {},
    async close() {
      // The stream ends when the caller aborts the signal.
    },
  };
}

/** Starts a channel; a `remote` server is tried as Streamable HTTP and, if the url refuses a POST that way, as the old SSE transport. */
async function open(target: ProbeTarget, signal: AbortSignal, extraDirs: string[]): Promise<{ channel: Channel; fallback: (() => Promise<Channel>) | null; modern: boolean }> {
  if (target.kind === "stdio") return { channel: stdioChannel(target, extraDirs), fallback: null, modern: true };
  // The old SSE transport predates the modern era and never carries it.
  if (target.transport === "sse") return { channel: await sseChannel(target, signal), fallback: null, modern: false };
  return { channel: httpChannel(target, signal), fallback: target.transport === "remote" ? () => sseChannel(target, signal) : null, modern: true };
}

type Answered = Listed & { protocol: string | null };

/** Modern first, then legacy when the server did not answer as a modern one. */
async function handshake(channel: Channel, target: ProbeTarget, modern: boolean, timeoutMs: number): Promise<Answered> {
  if (modern) {
    let version: string;
    try {
      // On stdio a legacy server may never answer; half the time left is the most that is waited before reading that as legacy.
      version = await modernDiscover(channel, target.kind === "stdio" ? Math.round(timeoutMs / 2) : null);
    } catch (error) {
      if (!(error instanceof ProbeError) || error.result !== "bad-response" || isModernError(error)) throw error;
      return legacyHandshake(channel);
    }
    return { ...(await listTools(channel, version)), protocol: version };
  }
  return legacyHandshake(channel);
}

/**
 * Runs the handshake with one hard deadline for all of it, both eras included. Whatever it started is stopped
 * before this returns, and no text from the server or the config is in the result.
 */
export async function probe(target: ProbeTarget, timeoutMs: number, extraDirs: string[] = []): Promise<Probed> {
  const started = performance.now();
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), timeoutMs);
  const deadline = new Promise<never>((_, reject) => {
    control.signal.addEventListener("abort", () => reject(new ProbeError("timeout", "no answer in time")), { once: true });
  });
  deadline.catch(() => {});
  const opened: Channel[] = [];
  try {
    const { channel, fallback, modern } = await Promise.race([open(target, control.signal, extraDirs), deadline]);
    opened.push(channel);
    let answered: Answered;
    try {
      answered = await Promise.race([handshake(channel, target, modern, timeoutMs), deadline]);
    } catch (error) {
      const refused = error instanceof ProbeError && error.result === "bad-response" && /^HTTP (400|404|405)$/.test(error.detail);
      if (!refused || fallback === null) throw error;
      const second = await Promise.race([fallback(), deadline]);
      opened.push(second);
      answered = await Promise.race([legacyHandshake(second), deadline]);
    }
    return { result: "ok", tools: answered.tools, size: answered.size, latencyMs: Math.round(performance.now() - started), detail: null, protocol: answered.protocol };
  } catch (error) {
    const e = fetchFailure(error, control.signal);
    return { result: e.result, tools: null, size: null, latencyMs: null, detail: e.detail, protocol: null };
  } finally {
    clearTimeout(timer);
    // HTTP closes its session while the signal is live; aborting after that is what ends an SSE stream.
    await Promise.all(opened.map((c) => c.close().catch(() => {})));
    control.abort();
  }
}
