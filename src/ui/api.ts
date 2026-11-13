import { readHostName } from "../host.ts";
import { LockedError, acquirePushLock } from "../lock.ts";
import { loadModel } from "../tui/model.ts";
import { readSecrets } from "../tui/reads.ts";
import type { EditOp } from "../edit/index.ts";
import { outsideChanges, plan, preview, WriteRefused, writeAndCommit } from "./edits.ts";
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
 *   GET  /api/matrix   What each host gets, from the files on disk: hosts, bundles (with their skills), servers, and the
 *                      cell of each host (`on`, `picked`, `excluded`), plus `outside`: uncommitted changes in the config repo.
 *   GET  /api/secrets  The secret names, which hosts can read each and which servers use it. Never a value.
 *   POST /api/preview  Body `{"ops": [...], "show": "hosts/box.yaml"}`. The edits are replayed on the files as they are now:
 *                      `files` (every changed file, before and after), `shown` (the file asked for), `dropped` (edits that no
 *                      longer apply, with the reason), `matrix` (the config after the edits), `checks` (per host: does the
 *                      config load, and what its picks change) and `outside`. Nothing is written.
 *   POST /api/plan     Body `{"ops": [...]}`. This host's full plan: `fleet diff` against the edited config, nothing written.
 *   POST /api/write    Body `{"ops": [...], "message": "..."}`. Writes the edited files, commits them, then runs the real
 *                      `fleet push` as `POST /api/push` does. Refuses, writing nothing, when a push is running (409 `locked`),
 *                      when the config repo has changes of its own (409 `outside-changes`), when an edit is stale (409 `stale`)
 *                      or when a host would not load (422 `invalid`).
 *   GET  /api/events   Server-Sent Events (served by the server itself, not here): `hello`, `push` (a fleet event) and
 *                      `pushend` (the end document). EventSource cannot send headers, so this one route also takes the
 *                      token as `?token=`.
 *
 * Edits are operations (`EditOp`, host picks only for now: `add` and `remove`), held by the page and replayed here.
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
        const message = messageOf(await req.json());
        const done = deps.busy();
        try {
          const end = await runPush(message);
          return { status: end.code === "locked" ? 409 : end.exit === null ? 500 : 200, body: pushDoc(end) };
        } finally {
          done();
        }
      },
    },
    {
      method: "GET",
      path: "/api/matrix",
      handle: () => {
        const model = loadModel(deps.configDir, readHostName(deps.home));
        return { status: 200, body: { ok: true, ...matrixDoc(model), outside: outside() } };
      },
    },
    {
      method: "GET",
      path: "/api/secrets",
      handle: () => {
        const view = readSecrets(deps.configDir, deps.home);
        return { status: 200, body: { ok: true, hosts: view.hosts, problems: view.problems, entries: view.entries.map((e) => ({ name: e.name, file: e.file, readers: e.readers, servers: e.servers })) } };
      },
    },
    {
      method: "POST",
      path: "/api/preview",
      handle: async (req) => {
        const body = await req.json();
        const p = preview(deps.configDir, readHostName(deps.home), opsOf(body), showOf(body));
        const { before: _before, after, ...rest } = p;
        return { status: 200, body: { ok: true, ...rest, matrix: matrixDoc(after), outside: outside() } };
      },
    },
    {
      method: "POST",
      path: "/api/plan",
      handle: async (req) => ({ status: 200, body: { ok: true, ...plan(deps.configDir, deps.home, opsOf(await req.json())) } }),
    },
    {
      method: "POST",
      path: "/api/write",
      handle: async (req) => {
        const body = await req.json();
        const ops = opsOf(body);
        const message = messageOf(body);
        if (message === undefined || message.trim() === "") throw new BadRequest("a commit message is required");
        const done = deps.busy();
        try {
          // The lock is held while the files are written and committed, so no push starts under it, and let go before
          // the real push, which takes it itself.
          let release: () => void;
          try {
            release = acquirePushLock(deps.home);
          } catch (error) {
            if (error instanceof LockedError) return refused(409, "locked", error.message);
            throw error;
          }
          let written: { files: string[]; commit: string };
          try {
            const found = outside();
            if (found.length > 0) return refused(409, "outside-changes", "the config repo has changes the page did not make: commit or discard them first", { outside: found });
            written = writeAndCommit(deps.configDir, ops, message.trim());
          } catch (error) {
            if (error instanceof WriteRefused) return refused(error.code === "invalid" ? 422 : error.code === "failed" ? 500 : 409, error.code, error.message, error.extra);
            throw error;
          } finally {
            release();
          }
          const end = await runPush(undefined);
          return { status: 200, body: { ok: end.code === "ok", code: end.code ?? "error", written, push: pushDoc(end) } };
        } finally {
          done();
        }
      },
    },
  ];

  function outside(): string[] {
    return outsideChanges(deps.configDir);
  }

  async function runPush(message: string | undefined): Promise<PushEnd> {
    const end = await new RealPusher(deps.toolDir, deps.configDir, deps.home, []).run((event: FleetEvent) => deps.broadcast("push", event), message);
    deps.broadcast("pushend", pushDoc(end));
    return end;
  }
}

const refused = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): ApiResponse => ({ status, body: { ok: false, code, messages: [`fleet: ${message}`], ...extra } });

/** The matrix as the page gets it: the bridge's model, without its directory. */
const matrixDoc = (model: ReturnType<typeof loadModel>) => ({ self: model.self, hosts: model.hosts, bundles: model.bundles, servers: model.servers, problems: model.problems });

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_OPS = 200;

/** The edits in a request body. The page may only pick: `add` and `remove` of a bundle or server for a host. */
function opsOf(body: unknown): EditOp[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequest("the body must be a JSON object");
  const list = (body as Record<string, unknown>).ops;
  if (!Array.isArray(list) || list.length > MAX_OPS) throw new BadRequest(`ops must be a list of at most ${MAX_OPS} edits`);
  return list.map((raw, i): EditOp => {
    const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const ok = (o.op === "add" || o.op === "remove") && (o.kind === "bundles" || o.kind === "mcp") && typeof o.host === "string" && NAME.test(o.host) && typeof o.name === "string" && NAME.test(o.name);
    if (!ok) throw new BadRequest(`ops[${i}] is not an add or remove of a bundle or server for a host`);
    return { op: o.op as "add" | "remove", host: o.host as string, kind: o.kind as "bundles" | "mcp", name: o.name as string };
  });
}

function showOf(body: unknown): string | null {
  const show = (body as Record<string, unknown>).show;
  if (show === undefined) return null;
  if (typeof show !== "string" || !/^hosts\/[A-Za-z0-9][A-Za-z0-9._-]*\.yaml$/.test(show)) throw new BadRequest("show must be a host file such as hosts/box.yaml");
  return show;
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
