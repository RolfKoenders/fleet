import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, gitEnv, installFakeSsh, linkFleetSkill, makeClone, makeHome, publish } from "./helpers.ts";
import { acquirePushLock } from "../src/lock.ts";
import { startUi } from "../src/ui/server.ts";
import type { UiServer } from "../src/ui/server.ts";

// The server commits in this process, so git needs an author here too.
Object.assign(process.env, gitEnv);

const applyOk = JSON.stringify({ ok: true, code: "ok", host: "remote", messages: [], created: [], updated: [], removed: [], conflicts: [] });

const LAPTOP = "# This machine. Keep this comment.\nmcp:\n  include: [tracker]\n";
const REMOTE = "ssh: alice@remote\nmcp:\n  exclude: [docs]\n";

/**
 * A config clone (also the tool) with hosts laptop (this one) and remote (over the fake ssh). With `bundles`, the
 * defaults pick bundle `core`, laptop adds `extra` and remote excludes `core`: no skill source exists, so a push of
 * that world cannot run, and only the tests that never push use it.
 */
function world(bundles = false) {
  const { clone, remote } = makeClone();
  const home = makeHome("laptop");
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(clone, rel)), { recursive: true });
    writeFileSync(join(clone, rel), content);
  };
  write("hosts/_defaults.yaml", `# Every host.\n${bundles ? "bundles: [core]\n" : ""}mcp:\n  include: [docs]\n`);
  write("hosts/laptop.yaml", bundles ? `${LAPTOP}bundles: [extra]\n` : LAPTOP);
  write("hosts/remote.yaml", bundles ? `${REMOTE}exclude: [core]\n` : REMOTE);
  write("catalog/mcp.yaml", "servers:\n  docs:\n    command: [npx, -y, \"@example/docs-mcp@1.0.0\"]\n  tracker:\n    transport: http\n    url: https://tracker.example.com/mcp\n  extra-server:\n    transport: http\n    url: https://extra.example.com/mcp\n");
  write("catalog/skills.yaml", "sources: {}\nbundles:\n  core: [review, debug]\n  extra: [notes, deploy]\n");
  publish(clone, "config");
  linkFleetSkill(home, clone);
  installFakeSsh(home, { "alice@remote": { stdout: applyOk } });
  return { clone, home, remote };
}

async function withServer(options: { bundles?: boolean }, body: (s: UiServer, w: ReturnType<typeof world>) => Promise<void>) {
  const w = world(options.bundles ?? false);
  const server = await startUi({ toolDir: w.clone, configDir: w.clone, home: w.home });
  try {
    await body(server, w);
  } finally {
    await server.close();
  }
}

const base = (s: UiServer) => `http://127.0.0.1:${s.port}`;
const get = async (s: UiServer, path: string) => (await fetch(base(s) + path, { headers: { "x-fleet-token": s.token } })).json() as Promise<any>;
const post = (s: UiServer, path: string, body: unknown) =>
  fetch(base(s) + path, { method: "POST", headers: { "x-fleet-token": s.token, origin: base(s), "content-type": "application/json" }, body: JSON.stringify(body) });
const postJson = async (s: UiServer, path: string, body: unknown) => (await post(s, path, body)).json() as Promise<any>;
const read = (w: { clone: string }, rel: string) => readFileSync(join(w.clone, rel), "utf8");
const add = (host: string, name: string, kind = "mcp") => ({ op: "add", host, kind, name });
const remove = (host: string, name: string, kind = "mcp") => ({ op: "remove", host, kind, name });

const cell = (doc: any, list: "bundles" | "servers", name: string, host: string) => doc[list].find((r: any) => r.name === name).cells[host];

test("matrix: one row per bundle and server, one cell per host, saying defaults, added, excluded or off", async () => {
  await withServer({ bundles: true }, async (s) => {
    const m = await get(s, "/api/matrix");
    assert.deepEqual(m.hosts.map((h: any) => [h.name, h.self]), [["laptop", true], ["remote", false]]);
    assert.deepEqual(m.bundles.map((b: any) => [b.name, b.skills]), [["core", ["review", "debug"]], ["extra", ["notes", "deploy"]]]);
    assert.deepEqual(m.servers.map((r: any) => r.name), ["docs", "tracker", "extra-server"]);
    assert.deepEqual(cell(m, "servers", "docs", "laptop"), { on: true, picked: "defaults", excluded: null });
    assert.deepEqual(cell(m, "servers", "tracker", "laptop"), { on: true, picked: "host", excluded: null });
    assert.deepEqual(cell(m, "servers", "docs", "remote"), { on: false, picked: "defaults", excluded: "host" });
    assert.deepEqual(cell(m, "servers", "extra-server", "remote"), { on: false, picked: null, excluded: null });
    assert.deepEqual(cell(m, "bundles", "core", "laptop"), { on: true, picked: "defaults", excluded: null });
    assert.deepEqual(cell(m, "bundles", "extra", "laptop"), { on: true, picked: "host", excluded: null });
    assert.deepEqual(cell(m, "bundles", "core", "remote"), { on: false, picked: "defaults", excluded: "host" });
    assert.deepEqual(m.outside, []);
  });
});

test("preview: an edit returns the spliced file and a diff that touches only the right lines", async () => {
  await withServer({}, async (s, w) => {
    const before = read(w, "hosts/laptop.yaml");
    const p = await postJson(s, "/api/preview", { ops: [remove("laptop", "docs")], show: "hosts/laptop.yaml" });
    assert.deepEqual(p.files.map((f: any) => f.path), ["hosts/laptop.yaml"]);
    assert.equal(p.files[0].before, before);
    assert.equal(p.files[0].after, "# This machine. Keep this comment.\nmcp:\n  include: [tracker]\n  exclude: [docs]\n");
    assert.deepEqual(p.shown, p.files[0]);
    assert.equal(cell(p.matrix, "servers", "docs", "laptop").on, false);
    assert.equal(cell(p.matrix, "servers", "docs", "laptop").excluded, "host");
    assert.equal(read(w, "hosts/laptop.yaml"), before, "a preview writes nothing");
    // Taking back an exclude writes only the removal of that one line.
    const back = await postJson(s, "/api/preview", { ops: [add("remote", "docs")] });
    assert.equal(back.files[0].after, "ssh: alice@remote\nmcp:\n  exclude: []\n");
    assert.equal(back.files.length, 1);
    // A host file the edits do not change can still be shown.
    const shown = await postJson(s, "/api/preview", { ops: [], show: "hosts/remote.yaml" });
    assert.deepEqual(shown.files, []);
    assert.equal(shown.shown.after, REMOTE);
  });
});

test("preview: an edit that no longer applies is dropped with its reason, and the rest still apply", async () => {
  await withServer({}, async (s) => {
    const p = await postJson(s, "/api/preview", { ops: [add("laptop", "docs"), remove("laptop", "tracker")] });
    assert.equal(p.dropped.length, 1);
    assert.deepEqual(p.dropped[0].op, add("laptop", "docs"));
    assert.equal(p.dropped[0].why, "stale");
    assert.match(p.dropped[0].reason, /already picked by laptop/);
    assert.deepEqual(p.applied, [remove("laptop", "tracker")]);
    assert.deepEqual(p.files.map((f: any) => f.path), ["hosts/laptop.yaml"]);
  });
});

test("preview: every host is checked, with what its picks change", async () => {
  await withServer({ bundles: true }, async (s) => {
    const p = await postJson(s, "/api/preview", { ops: [add("remote", "docs"), add("remote", "core", "bundles"), remove("laptop", "tracker")] });
    const [laptop, remote] = p.checks;
    assert.equal(laptop.host, "laptop");
    assert.equal(laptop.self, true);
    assert.equal(laptop.loads, true);
    assert.deepEqual(laptop.changes, { skills: { added: [], removed: [] }, servers: { added: [], removed: ["tracker"] } });
    assert.equal(remote.loads, true);
    assert.deepEqual(remote.changes, { skills: { added: ["debug", "review"], removed: [] }, servers: { added: ["docs"], removed: [] } });
  });
});

test("preview: an edit that makes a host fail to load shows that host's problems", async () => {
  await withServer({}, async (s) => {
    const p = await postJson(s, "/api/preview", { ops: [add("remote", "nope", "bundles")] });
    const remote = p.checks.find((c: any) => c.host === "remote");
    assert.equal(remote.loads, false);
    assert.ok(remote.problems.some((t: string) => t.includes("bundle 'nope'")), remote.problems.join("|"));
    assert.equal(p.checks.find((c: any) => c.host === "laptop").loads, true);
  });
});

test("plan: this host's plan comes from fleet diff on the edited config, and nothing is written", async () => {
  await withServer({}, async (s, w) => {
    const tree = git(w.clone, "status", "--porcelain");
    const head = git(w.clone, "rev-parse", "HEAD");
    const none = await postJson(s, "/api/plan", { ops: [] });
    const some = await postJson(s, "/api/plan", { ops: [add("laptop", "extra-server")] });
    assert.equal(some.ok, true);
    assert.equal(some.code, "ok");
    assert.match(some.text, /extra-server/);
    assert.equal(none.text.includes("extra-server"), false, "the plan without the edit does not have it");
    assert.equal(git(w.clone, "status", "--porcelain"), tree);
    assert.equal(git(w.clone, "rev-parse", "HEAD"), head);
    assert.equal(read(w, "hosts/laptop.yaml"), LAPTOP);
  });
});

test("outside changes are listed, and a write refuses while there are any, changing nothing", async () => {
  await withServer({}, async (s, w) => {
    writeFileSync(join(w.clone, "notes.txt"), "mine\n");
    writeFileSync(join(w.clone, "hosts/laptop.yaml"), LAPTOP + "# edited by hand\n");
    const m = await get(s, "/api/matrix");
    assert.deepEqual(m.outside.map((l: string) => l.slice(3)).sort(), ["hosts/laptop.yaml", "notes.txt"]);
    const p = await postJson(s, "/api/preview", { ops: [] });
    assert.equal(p.outside.length, 2);
    const head = git(w.clone, "rev-parse", "HEAD");
    const res = await post(s, "/api/write", { ops: [add("remote", "docs")], message: "x" });
    assert.equal(res.status, 409);
    const doc = (await res.json()) as any;
    assert.equal(doc.code, "outside-changes");
    assert.equal(doc.outside.length, 2);
    assert.equal(read(w, "hosts/remote.yaml"), REMOTE);
    assert.equal(git(w.clone, "rev-parse", "HEAD"), head);
  });
});

test("write: writes the edited files, commits them with the message, runs the real push and relays its events", async () => {
  await withServer({}, async (s, w) => {
    const stream = await fetch(`${base(s)}/api/events?token=${s.token}`);
    const reader = stream.body!.getReader();
    let seen = "";
    const reading = (async () => {
      const decoder = new TextDecoder();
      while (!seen.includes("event: pushend")) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += decoder.decode(value);
      }
      await reader.cancel();
    })();
    const res = await post(s, "/api/write", { ops: [add("remote", "docs")], message: "Give remote the docs server" });
    assert.equal(res.status, 200);
    const doc = (await res.json()) as any;
    assert.equal(doc.ok, true);
    assert.deepEqual(doc.written.files, ["hosts/remote.yaml"]);
    assert.equal(doc.push.code, "ok");
    assert.deepEqual(doc.push.hosts.map((h: any) => h.host).sort(), ["laptop", "remote"]);
    assert.equal(read(w, "hosts/remote.yaml"), "ssh: alice@remote\nmcp:\n  exclude: []\n");
    assert.equal(git(w.clone, "log", "-1", "--format=%s"), "Give remote the docs server");
    assert.equal(git(w.clone, "show", "--name-only", "--format=", "HEAD"), "hosts/remote.yaml");
    assert.equal(git(w.clone, "status", "--porcelain"), "");
    assert.equal(git(w.clone, "rev-parse", "HEAD"), git(w.clone, "rev-parse", "origin/main"), "the push published it");
    await reading;
    assert.match(seen, /"event":"host","host":"remote","state":"done"/);
    assert.match(seen, /event: pushend/);
  });
});

test("write: refuses while the push lock is held, before writing anything", async () => {
  await withServer({}, async (s, w) => {
    const head = git(w.clone, "rev-parse", "HEAD");
    const release = acquirePushLock(w.home);
    try {
      const res = await post(s, "/api/write", { ops: [add("remote", "docs")], message: "x" });
      assert.equal(res.status, 409);
      const doc = (await res.json()) as any;
      assert.equal(doc.code, "locked");
      assert.ok(doc.messages.some((m: string) => m.includes(`a push is already running (pid ${process.pid})`)), doc.messages.join("|"));
      assert.equal(read(w, "hosts/remote.yaml"), REMOTE);
      assert.equal(git(w.clone, "rev-parse", "HEAD"), head);
    } finally {
      release();
    }
  });
});

test("write: a stale edit, an edit that breaks a host, and nothing to write are refused without writing", async () => {
  await withServer({}, async (s, w) => {
    const head = git(w.clone, "rev-parse", "HEAD");
    const stale = await post(s, "/api/write", { ops: [add("laptop", "docs")], message: "x" });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as any).code, "stale");
    const broken = await post(s, "/api/write", { ops: [add("remote", "nope", "bundles")], message: "x" });
    assert.equal(broken.status, 422);
    assert.equal(((await broken.json()) as any).code, "invalid");
    const nothing = await post(s, "/api/write", { ops: [], message: "x" });
    assert.equal(nothing.status, 409);
    assert.equal(read(w, "hosts/remote.yaml"), REMOTE);
    assert.equal(git(w.clone, "rev-parse", "HEAD"), head);
    assert.equal(git(w.clone, "status", "--porcelain"), "");
  });
});

test("write and preview refuse bad bodies, and the page may only add or remove picks", async () => {
  await withServer({}, async (s) => {
    for (const body of [{}, { ops: "x" }, { ops: [{ op: "addServer", name: "x", entry: {} }] }, { ops: [{ op: "add", host: "../x", kind: "mcp", name: "docs" }] }, { ops: [add("laptop", "docs", "files")] }]) {
      assert.equal((await post(s, "/api/preview", body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await post(s, "/api/preview", { ops: [], show: "../etc/passwd" })).status, 400);
    assert.equal((await post(s, "/api/write", { ops: [add("remote", "docs")] })).status, 400, "a message is required");
  });
});

test("discard: edits are only held by the page, so a preview of no edits leaves the repo as it was", async () => {
  await withServer({}, async (s, w) => {
    await postJson(s, "/api/preview", { ops: [remove("laptop", "docs")] });
    const p = await postJson(s, "/api/preview", { ops: [] });
    assert.deepEqual(p.files, []);
    assert.equal(git(w.clone, "status", "--porcelain"), "");
  });
});
