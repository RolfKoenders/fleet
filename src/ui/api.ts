import { having } from "../agents/index.ts";
import type { AgentId } from "../agents/index.ts";
import { detectAgents } from "../hostagents.ts";
import { readCache } from "../tui/cache.ts";
import { readHostName } from "../host.ts";
import { LockedError, acquirePushLock } from "../lock.ts";
import { loadModel } from "../tui/model.ts";
import { readSecrets } from "../tui/reads.ts";
import { entryOf, outsideChanges, plan, preview, readFiles, secretOpProblem, WriteRefused, writeAndCommit } from "./edits.ts";
import type { StagedSkills } from "./edits.ts";
import { secretsTable } from "./secretsview.ts";
import { setRequest, setSecret } from "./secretset.ts";
import { status } from "../status.ts";
import { readCard } from "../card/data.ts";
import { previewText } from "../card/preview.ts";
import { shareText, SHOW_AND_TELL } from "../card/share.ts";
import { renderBadge, renderCard } from "../card/svg.ts";
import { isStyle, STYLES } from "../card/words.ts";
import { BadRequest } from "./request.ts";
import { opsOf } from "./opsof.ts";
import { CloneStore } from "./clones.ts";
import { checkEntry } from "./probe.ts";
import { parseCatalog } from "../catalog.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findSkills, sourceDir } from "../sources.ts";
import { RealPusher } from "../tui/pusher.ts";
import { realProbe } from "../tui/probe.ts";
import type { Probe } from "../tui/probe.ts";
import { FleetWatch } from "./fleet.ts";
import { yamlOf, yamlRequest } from "./yamlview.ts";
import { addHost, hostFields, hostRequest, previewHost } from "./hostinit.ts";
import { previewRemove, removeFields, removeHost, removeRefusal, removeRequest } from "./hostremove.ts";
import type { FleetEvent } from "../events.ts";
import type { PushEnd } from "../pushrun.ts";
import type { Job } from "./jobs.ts";

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
 *   GET  /api/matrix   What each host gets, from the files on disk: `agents` (`{id, name, used}` of each agent a server can be for, `used` when this host has it, the bridge's memory of another host's status reports it or a host file names it), hosts, bundles (with their skills), servers, and the
 *                      cell of each host (`on`, `picked`, `excluded`), plus `outside`: uncommitted changes in the config repo.
 *   GET  /api/secrets  The secret names, which hosts can read each and which servers use it, and `table`: each name against each host as
 *                      `set`, `missing` or `unused`. Never a value.
 *   POST /api/preview  Body `{"ops": [...], "show": "hosts/box.yaml"}`. The edits are replayed on the files as they are now:
 *                      `files` (every changed file, before and after), `shown` (the file asked for), `dropped` (edits that no
 *                      longer apply, with the reason), `matrix` (the config after the edits), `checks` (per host: does the
 *                      config load, and what its picks change) and `outside`. Nothing is written.
 *   POST /api/yaml     Body `{"kind": "server" | "source" | "bundle" | "host", "name": "..."}`. The file that item is written in, as it is on disk:
 *                      `{path, text}`. A path is never taken from the page, only a kind and a name; a host that is not there is 404.
 *   POST /api/entry    Body `{"ops": [...], "kind": "server" | "source" | "bundle" | "host", "name": "..."}`. What that item is after the held `ops`, for an
 *                      Edit dialog: `value` (the entry as written: a bundle's skills, a host's `{ssh}`; secrets as `secret:NAME`, never a value), `path`,
 *                      `found`, `editable` and, when it is not, `reason`, and `text`: the file it is in, as it would be after `ops`.
 *   POST /api/plan     Body `{"ops": [...]}`. This host's full plan: `fleet diff` against the edited config, nothing written.
 *   POST /api/write    Body `{"ops": [...], "message": "...", "staged": {...}}` (`staged` as for preview). Writes the edited files, commits them, then runs the real
 *                      `fleet push` as `POST /api/push` does. Refuses, writing nothing, when a push is running (409 `locked`),
 *                      when the config repo has changes of its own (409 `outside-changes`), when an edit is stale (409 `stale`)
 *                      or when a host would not load, the preview's skill check included (422 `invalid`).
 *   GET  /api/fleet    Every host of the config, this host first: what each last said (`status`, `context`, `conflicts`), whether that is from the
 *                      current run (`live`) or from the bridge's memory file (`seenSeconds` old, not live), and why a host did not answer (`result`,
 *                      `detail`). Nothing is asked: it answers at once from what is known.
 *   POST /api/fleet/refresh  Asks every host (status, startup context and, for a host with conflicts, the conflicts in full: the bridge's own
 *                      read-only questions, an ssh call each) as a job, sending the document as a `fleet` event each time a host answers, and
 *                      answers it when every host has. A host that answers is remembered in the bridge's own memory file (see `tui/cache.ts`);
 *                      one that does not keeps what was remembered. A second call while one runs waits for that one. Body: none.
 *   GET  /api/events   Server-Sent Events (served by the server itself, not here): `hello`, `push` (a fleet event),
 *                      `pushend` (the end document) and `fleet` (the document of `/api/fleet`, while hosts are being asked). EventSource cannot send headers, so this one route also takes the
 *                      token as `?token=`.
 *
 *   POST /api/card     Body `{"style": "machines" | "map", "names": false}` (both optional). The card of this fleet, drawn by the same code as `fleet card`,
 *                      from what fleet last saw of each host (nothing is asked over ssh): `svg`, `badge` (the README badge), `text` (what the terminal preview
 *                      prints), `unseen` (how many hosts the bridge never saw) and `share` (`title`, `body` and `url` of a new Show and tell discussion).
 *                      Hostnames are in it only with `names: true`. Never a server, skill, source or secret name.
 *   GET  /api/skills   The skills found in the source clones fleet already has: name, source, and the bundle that holds it (or null).
 *   POST /api/catalog/clone    Body `{"repo": "...", "path": ".", "branch": "main"}` (path and branch optional). Shallow-clones the repo to a
 *                      temp directory and answers `id`, `commit` (the head, full sha), `branch`, `skills` and `problem`. The repo is
 *                      checked first (a URL, scp-style address or absolute path, never a leading `-`), and git gets it after `--`.
 *   POST /api/catalog/discard  Body `{"id": "..."}`. Deletes that temp clone. The server deletes the rest when it stops.
 *   POST /api/catalog/probe    Body `{"name": "...", "entry": {...}, "confirm": true}`. Doctor's probe on one catalog entry that is not on
 *                      disk, on this machine, with the secrets it can read: `result`, `tools`, `size`, `tokens`, `unset` (secret names with
 *                      no value here, left out). Refused unless `confirm` is true. No value is ever in the answer.
 *
 *   POST /api/hosts/preview  Body `{"name": "...", "ssh": "user@host", "from": null | "<host>"}`: the host file `/api/hosts/init` would write, as
 *                      `{path, before, after}` (`before` is empty: the file is new). Nothing is written or run. 409 `stale` for a host that exists.
 *   POST /api/hosts/init  Body `{"name": "...", "ssh": "user@host", "from": null | "<host>", "confirm": true}`. Not a held edit: writes
 *                      `hosts/<name>.yaml` and runs the real `fleet init <name>` as a child process, relaying its output lines as `init`
 *                      events and its end as `initend`, and answers when it has ended (`ok`, `code`, `exit`, `messages`, `removed`,
 *                      `kept`). `from` copies bundles, exclude, mcp, settings and vars of that host, never ssh, age or files. Refused,
 *                      writing nothing, without `confirm`, for a host that exists (409 `exists`), while a push or an init runs (409
 *                      `locked`), when the config repo has changes of its own (409 `outside-changes`) or when a host would not load
 *                      (422 `invalid`). When init fails before it committed anything, the host file is removed again.
 *
 *   POST /api/hosts/remove/preview  Body `{"name": "..."}`: what removing the host would change: `files` (each as `{path, before, after}`: its host
 *                      file, its own secrets file by names only, and `.sops.yaml` as rekey will write it), `rekeyed` (the secrets files that
 *                      stop naming its key), and `readable` (the NAMES of the secrets the host could read, `shared` and `own`; never a value).
 *                      Nothing is written or run. 409 `self` for the host the page runs on, `admin` for the only admin host, `stale` for a host that is not there.
 *   POST /api/hosts/remove  Body `{"name": "...", "confirm": true}`. Not a held edit: deletes `hosts/<name>.yaml` and `secrets/<name>.enc.yaml`, runs the
 *                      real `fleet secrets rekey` as a child process, then commits and pushes the config repo, relaying the output lines as
 *                      `remove` events and the end as `removeend`, and answers when it has ended (`ok`, `code`, `exit`, `messages`, `removed`,
 *                      `restored`, `kept`). Refused, writing nothing, without `confirm`, for the refusals above, while a push or an init runs (409
 *                      `locked`) or when the config repo has changes of its own (409 `outside-changes`). When rekey or the commit fails, every
 *                      file is put back. When only the push fails, the commit stays (`kept`).
 *
 *   POST /api/secrets/set  Body `{"name": "TRACKER_API_KEY", "value": "...", "files": ["box", "shared"], "ops": [...held]}`. Encrypts one
 *                      value into the secrets file of each of `files` (`shared` or a host) with sops, in a private temp dir, and
 *                      answers the held edits that now carry those files: `{"ops": [{"op": "setSecret", ...}], "replaces": [paths]}`.
 *                      The page replaces its held `setSecret` edits for those paths with them. Nothing is written to the repo, and the
 *                      value is never in an answer, an error, a log or the stream: a failure is one of a few fixed messages (422
 *                      `no-recipient`, `needs-secret`, `sops-failed`, `recipients`, `invalid`; 409 `stale`).
 *
 * Edits are operations (`EditOp`) held by the page and replayed here: `add` and `remove` of a bundle or server for a host, the
 * catalog additions `addServer`, `addSource` and `addBundle`, the field changes `editServer`, `editSource`, `editBundle` and `editHost`
 * (each remembers what it changed from, so a file that moved on makes it stale), and `setSecret`, a secrets file already encrypted. Each is checked by `opsOf`, with the loader's own rules.
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
  /** Marks a long job as running, so the server does not stop itself under it, and tells the pages which one. Returns the call that says it ended. */
  busy(job: Job): () => void;
  /** The temp clones of the Add-a-skill-source form; the server clears them when it stops. */
  clones: CloneStore;
  /** What the hosts are asked with. Default: the bridge's own, over ssh. Tests supply their own. */
  probe?: Probe;
  /** Aborted when the server stops, so a question to a host does not outlive it. */
  signal?: AbortSignal;
};

export function routes(deps: ApiDeps): Route[] {
  const fleet = new FleetWatch({ configDir: deps.configDir, home: deps.home, probe: deps.probe ?? realProbe(deps.toolDir, deps.configDir, deps.home), changed: (doc) => deps.broadcast("fleet", { ok: true, ...doc }) });
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
      method: "GET",
      path: "/api/fleet",
      handle: () => ({ status: 200, body: { ok: true, ...fleet.doc() } }),
    },
    {
      method: "POST",
      path: "/api/fleet/refresh",
      handle: async () => {
        const done = deps.busy({ kind: "fleet" });
        try {
          return { status: 200, body: { ok: true, ...(await fleet.refresh(deps.signal)) } };
        } finally {
          done();
        }
      },
    },
    {
      method: "POST",
      path: "/api/push",
      handle: async (req) => {
        const message = messageOf(await req.json());
        const done = deps.busy({ kind: "push" });
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
        return { status: 200, body: { ok: true, ...matrixDoc(model, inUse(model)), outside: outside() } };
      },
    },
    {
      method: "GET",
      path: "/api/secrets",
      handle: () => {
        const view = readSecrets(deps.configDir, deps.home);
        const table = secretsTable(deps.configDir, loadModel(deps.configDir, readHostName(deps.home)), readFiles(deps.configDir));
        return { status: 200, body: { ok: true, hosts: view.hosts, problems: view.problems, entries: view.entries.map((e) => ({ name: e.name, file: e.file, readers: e.readers, servers: e.servers })), table } };
      },
    },
    {
      method: "POST",
      path: "/api/card",
      handle: async (req) => {
        const body = await req.json();
        const doc = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
        const style = doc.style ?? "machines";
        if (!isStyle(style)) throw new BadRequest(`style must be ${STYLES.join(" or ")}`);
        if (doc.names !== undefined && typeof doc.names !== "boolean") throw new BadRequest("names must be true or false");
        const names = doc.names === true;
        const data = readCard(deps.configDir, deps.home);
        const share = shareText(data);
        const url = `${SHOW_AND_TELL}&title=${encodeURIComponent(share.title)}&body=${encodeURIComponent(share.body)}`;
        return { status: 200, body: { ok: true, style, names, svg: renderCard(data, style, names), badge: renderBadge(data), text: previewText(data, names, false), unseen: data.hosts.filter((h) => !h.seen).length, hosts: data.hosts.length, share: { ...share, url } } };
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
        const done = deps.busy({ kind: "clone" });
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
        const done = deps.busy({ kind: "check", name: op.name });
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
        const p = preview(deps.configDir, readHostName(deps.home), heldOps(body), showOf(body), { home: deps.home, staged: stagedOf(body) });
        const { before: _before, after, edited, ...rest } = p;
        return { status: 200, body: { ok: true, ...rest, matrix: matrixDoc(after, inUse(after)), secrets: secretsTable(deps.configDir, after, edited), outside: outside() } };
      },
    },
    {
      method: "POST",
      path: "/api/yaml",
      handle: async (req) => {
        const file = yamlOf(deps.configDir, yamlRequest(await req.json()));
        return file === null ? refused(404, "not-found", "there is no such host") : { status: 200, body: { ok: true, ...file } };
      },
    },
    {
      method: "POST",
      path: "/api/entry",
      handle: async (req) => {
        const body = await req.json();
        const { kind, name } = yamlRequest(body);
        const doc = entryOf(deps.configDir, heldOps(body), kind, name);
        return { status: 200, body: { ok: true, ...doc } };
      },
    },
    {
      method: "POST",
      path: "/api/plan",
      handle: async (req) => ({ status: 200, body: { ok: true, ...plan(deps.configDir, deps.home, heldOps(await req.json())) } }),
    },
    {
      method: "POST",
      path: "/api/hosts/preview",
      handle: async (req) => {
        const out = previewHost(deps.configDir, hostFields(await req.json()));
        if ("refused" in out) return refused(out.refused.status, out.refused.code, out.refused.message);
        return { status: 200, body: { ok: true, ...out.doc } };
      },
    },
    {
      method: "POST",
      path: "/api/hosts/init",
      handle: async (req) => {
        const request = hostRequest(await req.json());
        const done = deps.busy({ kind: "init", name: request.name });
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
      path: "/api/hosts/remove/preview",
      handle: async (req) => {
        const { name } = removeFields(await req.json());
        const no = removeRefusal(deps.configDir, readHostName(deps.home), name);
        if (no !== null) return refused(no.status, no.code, no.message);
        return { status: 200, body: { ok: true, ...previewRemove(deps.configDir, name) } };
      },
    },
    {
      method: "POST",
      path: "/api/hosts/remove",
      handle: async (req) => {
        const request = removeRequest(await req.json());
        const done = deps.busy({ kind: "remove", name: request.name });
        try {
          // The lock is held for the whole removal: rekey does not take it, and a push must not run under it.
          let release: () => void;
          try {
            release = acquirePushLock(deps.home);
          } catch (error) {
            if (error instanceof LockedError) return refused(409, "locked", error.message);
            throw error;
          }
          try {
            const out = await removeHost(deps.configDir, deps.toolDir, deps.home, readHostName(deps.home), request, (text) => deps.broadcast("remove", { text }));
            if ("refused" in out) return refused(out.refused.status, out.refused.code, out.refused.message, out.refused.extra);
            deps.broadcast("removeend", out.doc);
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
      path: "/api/secrets/set",
      handle: async (req) => {
        // The body holds a secret's value. It is read here and handed to `setSecret`, and goes nowhere else: not a log, not an
        // error message, not the event stream, not the answer, which holds the encrypted file and nothing more.
        const request = setRequest(await req.json(), deps.configDir);
        const done = deps.busy({ kind: "secret", name: request.name });
        try {
          const out = setSecret(deps.configDir, deps.home, request);
          if ("refused" in out) return refused(out.refused.status, out.refused.code, out.refused.message, out.refused.extra);
          return { status: 200, body: { ok: true, ops: out.ops, replaces: out.replaces } };
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
        const ops = heldOps(body);
        const message = messageOf(body);
        if (message === undefined || message.trim() === "") throw new BadRequest("a commit message is required");
        const done = deps.busy({ kind: "push" });
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
            written = writeAndCommit(deps.configDir, ops, message.trim(), { home: deps.home, staged: stagedOf(body) });
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

  /** The edits in a body, checked as text and against the recipients of the secrets files they hold. */
  function heldOps(body: unknown) {
    const ops = opsOf(body);
    const unfit = secretOpProblem(deps.configDir, ops);
    if (unfit !== null) throw new BadRequest(unfit);
    return ops;
  }

  /**
   * The agents a server form offers: those this host has, those another host last reported (the bridge's memory of its status) and
   * those a host file names. With none known, every agent.
   */
  function inUse(model: ReturnType<typeof loadModel>): Set<AgentId> {
    const used = new Set<AgentId>(detectAgents(deps.home).map((a) => a.id));
    for (const { result } of Object.values(readCache(deps.home))) for (const a of result.status?.agents ?? []) if (a.active) used.add(a.id);
    for (const host of model.hosts) for (const id of host.agents ?? []) used.add(id);
    return used.size > 0 ? used : new Set(having("mcp").map((a) => a.id));
  }

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
const matrixDoc = (model: ReturnType<typeof loadModel>, used: ReadonlySet<AgentId>) => ({ agents: having("mcp").map((a) => ({ id: a.id, name: a.name, used: used.has(a.id) })), self: model.self, hosts: model.hosts, bundles: model.bundles, servers: model.servers, sources: model.sources, problems: model.problems });

function showOf(body: unknown): string | null {
  const show = (body as Record<string, unknown>).show;
  if (show === undefined) return null;
  if (typeof show !== "string" || !/^hosts\/[A-Za-z0-9][A-Za-z0-9._-]*\.yaml$/.test(show)) throw new BadRequest("show must be a host file such as hosts/box.yaml");
  return show;
}

/** The skills of the sources the page added and has not pushed, by source: what it saw when it looked at them. Names only, a bounded amount. */
function stagedOf(body: unknown): StagedSkills {
  const raw = (body as Record<string, unknown>).staged;
  if (raw === undefined) return {};
  const ok = typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.keys(raw).length <= 50 && Object.entries(raw).every(([k, v]) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(k) && Array.isArray(v) && v.length <= 1000 && v.every((s) => typeof s === "string" && s.length <= 200));
  if (!ok) throw new BadRequest("staged must be a map of source names to lists of skill names");
  return raw as StagedSkills;
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
