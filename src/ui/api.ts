import { readHostName } from "../host.ts";
import { LockedError, acquirePushLock } from "../lock.ts";
import { loadModel } from "../tui/model.ts";
import { readSecrets } from "../tui/reads.ts";
import { outsideChanges, plan, preview, WriteRefused, writeAndCommit } from "./edits.ts";
import { status } from "../status.ts";
import { BadRequest } from "./request.ts";
import { opsOf } from "./opsof.ts";
import { CloneStore } from "./clones.ts";
import { checkEntry } from "./probe.ts";
import { parseCatalog } from "../catalog.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findSkills, sourceDir } from "../sources.ts";
import { RealPusher } from "../tui/pusher.ts";
import { addHost, hostRequest } from "./hostinit.ts";
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
 *   GET  /api/skills   The skills found in the source clones fleet already has: name, source, and the bundle that holds it (or null).
 *   POST /api/catalog/clone    Body `{"repo": "...", "path": ".", "branch": "main"}` (path and branch optional). Shallow-clones the repo to a
 *                      temp directory and answers `id`, `commit` (the head, full sha), `branch`, `skills` and `problem`. The repo is
 *                      checked first (a URL, scp-style address or absolute path, never a leading `-`), and git gets it after `--`.
 *   POST /api/catalog/discard  Body `{"id": "..."}`. Deletes that temp clone. The server deletes the rest when it stops.
 *   POST /api/catalog/probe    Body `{"name": "...", "entry": {...}, "confirm": true}`. Doctor's probe on one catalog entry that is not on
 *                      disk, on this machine, with the secrets it can read: `result`, `tools`, `size`, `tokens`, `unset` (secret names with
 *                      no value here, left out). Refused unless `confirm` is true. No value is ever in the answer.
 *
 *   POST /api/hosts/init  Body `{"name": "...", "ssh": "user@host", "from": null | "<host>", "confirm": true}`. Not a held edit: writes
 *                      `hosts/<name>.yaml` and runs the real `fleet init <name>` as a child process, relaying its output lines as `init`
 *                      events and its end as `initend`, and answers when it has ended (`ok`, `code`, `exit`, `messages`, `removed`,
 *                      `kept`). `from` copies bundles, exclude, mcp, settings and vars of that host, never ssh, age or files. Refused,
 *                      writing nothing, without `confirm`, for a host that exists (409 `exists`), while a push or an init runs (409
 *                      `locked`), when the config repo has changes of its own (409 `outside-changes`) or when a host would not load
 *                      (422 `invalid`). When init fails before it committed anything, the host file is removed again.
 *
 * Edits are operations (`EditOp`) held by the page and replayed here: `add` and `remove` of a bundle or server for a host, and the
 * catalog additions `addServer`, `addSource` and `addBundle`. Each is checked by `opsOf`, with the loader's own rules.
 */

export type ApiResponse = { status: number; body: unknown };

export type ApiRequest = {
  /** The JSON body, or `undefined` when there is none. Throws `BadRequest` for one that is too big or not JSON. */
  json(): Promise<unknown>;
};

export { BadRequest };

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
  /** The temp clones of the Add-a-skill-source form; the server clears them when it stops. */
  clones: CloneStore;
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
      method: "GET",
      path: "/api/skills",
      handle: () => {
        // Read from the clones fleet already has; nothing is cloned or fetched here.
        const problems: string[] = [];
        const catalog = parseCatalog(deps.configDir, problems);
        const owner = new Map(catalog.bundles.entries().flatMap(([bundle, skills]) => skills.map((s) => [s, bundle] as const)));
        const skills = catalog.sources
          .filter((src) => existsSync(join(sourceDir(deps.home, src.name), ".git")))
          .flatMap((src) => [...findSkills(src, deps.home).dirs.keys()].map((name) => ({ name, source: src.name, bundle: owner.get(name) ?? null })));
        return { status: 200, body: { ok: true, skills, problems } };
      },
    },
    {
      method: "POST",
      path: "/api/catalog/clone",
      handle: async (req) => {
        const body = await req.json();
        if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequest("the body must be a JSON object");
        const { repo, path, branch } = body as Record<string, unknown>;
        if (typeof repo !== "string") throw new BadRequest("repo must be a string");
        if (path !== undefined && typeof path !== "string") throw new BadRequest("path must be a string");
        if (branch !== undefined && typeof branch !== "string") throw new BadRequest("branch must be a string");
        const done = deps.busy();
        try {
          return { status: 200, body: { ok: true, ...(await deps.clones.create(repo, path ?? ".", branch === undefined || branch === "" ? null : branch)) } };
        } catch (error) {
          if (error instanceof BadRequest) throw error;
          return refused(422, "clone-failed", (error as Error).message);
        } finally {
          done();
        }
      },
    },
    {
      method: "POST",
      path: "/api/catalog/discard",
      handle: async (req) => {
        const body = await req.json();
        const id = typeof body === "object" && body !== null ? (body as Record<string, unknown>).id : undefined;
        if (typeof id !== "string" || id.length > 100) throw new BadRequest("id must be a string");
        deps.clones.discard(id);
        return { status: 200, body: { ok: true } };
      },
    },
    {
      method: "POST",
      path: "/api/catalog/probe",
      handle: async (req) => {
        const body = await req.json();
        // The page asks first, naming the command; a call that did not is refused.
        if (typeof body !== "object" || body === null || (body as Record<string, unknown>).confirm !== true) throw new BadRequest("the check runs the server with real credentials: it must be confirmed");
        const op = opsOf({ ops: [{ op: "addServer", name: (body as Record<string, unknown>).name, entry: (body as Record<string, unknown>).entry }] })[0]!;
        if (op.op !== "addServer") throw new BadRequest("the check takes one server");
        const done = deps.busy();
        try {
          return { status: 200, body: { ok: true, ...(await checkEntry(deps.configDir, readHostName(deps.home), deps.home, op.name, op.entry)) } };
        } finally {
          done();
        }
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
      path: "/api/hosts/init",
      handle: async (req) => {
        const request = hostRequest(await req.json());
        const done = deps.busy();
        try {
          // The lock is held for the whole init: it does not take the push lock itself, and a push must not run under it.
          let release: () => void;
          try {
            release = acquirePushLock(deps.home);
          } catch (error) {
            if (error instanceof LockedError) return refused(409, "locked", error.message);
            throw error;
          }
          try {
            const out = await addHost(deps.configDir, deps.toolDir, deps.home, request, (text) => deps.broadcast("init", { text }));
            if ("refused" in out) return refused(out.refused.status, out.refused.code, out.refused.message, out.refused.extra);
            deps.broadcast("initend", out.doc);
            return { status: out.doc.exit === null ? 500 : 200, body: out.doc };
          } finally {
            release();
          }
        } finally {
          done();
        }
      },
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
const matrixDoc = (model: ReturnType<typeof loadModel>) => ({ self: model.self, hosts: model.hosts, bundles: model.bundles, servers: model.servers, sources: model.sources, problems: model.problems });

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
