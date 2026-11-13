import { readHostName } from "../host.ts";
import { status } from "../status.ts";
import { RealPusher } from "../tui/pusher.ts";
import type { FleetEvent } from "../events.ts";
import type { PushEnd } from "../pushrun.ts";

/**
 * The page's API. Every route is JSON under `/api/`, behind the server's checks (Host, Origin on a write, the token),
 * so a handler here never has to ask who is calling. A value from a secrets file is never in a response: nothing
 * here reads one. Request bodies are parsed and used, never logged.
 *
 * Routes:
 *   GET  /api/status   What `fleet status --json` knows about this host: the same document, no secret values.
 *   POST /api/push     Runs the real `fleet push` (the push lock is taken by that process), relaying its events to every
 *                      open stream as `push` events, and answers when it has ended. Body: `{}` or `{"message": "..."}`.
 *                      When another push is running it answers 409 with code `locked` and "a push is already running (pid N)".
 *   GET  /api/events   Server-Sent Events (served by the server itself, not here): `hello`, `push` (a fleet event) and
 *                      `pushend` (the end document). EventSource cannot send headers, so this one route also takes the
 *                      token as `?token=`.
 *
 * Config editing slots in as more entries of `routes`.
 */

export type ApiResponse = { status: number; body: unknown };

export type ApiRequest = {
  /** The JSON body, or `undefined` when there is none. Throws `BadRequest` for one that is too big or not JSON. */
  json(): Promise<unknown>;
};

export class BadRequest extends Error {}

export type Route = {
  method: "GET" | "POST";
  path: string;
  handle(req: ApiRequest): Promise<ApiResponse> | ApiResponse;
};

export type ApiDeps = {
  toolDir: string;
  configDir: string;
  home: string;
  /** Sends one Server-Sent Event to every open stream. */
  broadcast(event: string, data: unknown): void;
  /** Marks a long job as running, so the server does not stop itself under it. Returns the call that says it ended. */
  busy(): () => void;
};

export function routes(deps: ApiDeps): Route[] {
  return [
    {
      method: "GET",
      path: "/api/status",
      handle: () => {
        const result = status(deps.toolDir, deps.configDir, false, deps.home);
        return { status: 200, body: { ok: result.code === "ok", code: result.code, messages: result.messages ?? [], host: readHostName(deps.home), ...result.fields } };
      },
    },
    {
      method: "POST",
      path: "/api/push",
      handle: async (req) => {
        const body = await req.json();
        const message = messageOf(body);
        const done = deps.busy();
        try {
          const end = await new RealPusher(deps.toolDir, deps.configDir, deps.home, []).run((event: FleetEvent) => deps.broadcast("push", event), message);
          deps.broadcast("pushend", pushDoc(end));
          return { status: end.code === "locked" ? 409 : end.exit === null ? 500 : 200, body: pushDoc(end) };
        } finally {
          done();
        }
      },
    },
  ];
}

function messageOf(body: unknown): string | undefined {
  if (body === undefined) return undefined;
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequest("the body must be a JSON object");
  const message = (body as Record<string, unknown>).message;
  if (message === undefined) return undefined;
  if (typeof message !== "string" || message.length > 1000) throw new BadRequest("message must be a string of at most 1000 characters");
  return message;
}

/** A push's end as the page gets it. `code` is the push's own (`ok`, `conflict`, `locked`, ...) or `error` when it did not run. */
const pushDoc = (end: PushEnd) => ({ ok: end.code === "ok", code: end.code ?? "error", exit: end.exit, messages: end.messages, hosts: end.hosts, conflicts: end.conflicts });
