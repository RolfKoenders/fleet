import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, gitEnv, installFakeSsh, linkFleetSkill, makeClone, makeHome, makeSource, publish } from "./helpers.ts";
import { startUi } from "../src/ui/server.ts";
import type { UiServer } from "../src/ui/server.ts";

// The server commits in this process, so git needs an author here too.
Object.assign(process.env, gitEnv);

const applyOk = JSON.stringify({ ok: true, code: "ok", host: "remote", messages: [], created: [], updated: [], removed: [], conflicts: [] });
const skill = (n: string) => ({ [`skills/${n}/SKILL.md`]: `---\nname: ${n}\ndescription: ${n}\n---\n${n}\n` });
const MCP = `# Servers.
servers:
  docs:
    command: [npx, -y, "@example/docs-mcp@1.0.0"] # docs
    env:
      DOCS_TOKEN: secret:DOCS_TOKEN
      REGION: eu
  tracker:
    transport: http
    url: https://tracker.example.com/mcp
`;

function world() {
  const { clone, remote } = makeClone();
  const home = makeHome("laptop");
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(clone, rel)), { recursive: true });
    writeFileSync(join(clone, rel), content);
  };
  const src = makeSource(Object.assign({}, ...["review", "debug", "notes"].map(skill)));
  write("hosts/_defaults.yaml", "bundles: [core]\n");
  write("hosts/laptop.yaml", "# This machine.\nmcp:\n  include: [tracker]\n");
  write("hosts/remote.yaml", "ssh: alice@remote # the box\nmcp:\n  exclude: [docs]\n");
  write("catalog/mcp.yaml", MCP);
  write("catalog/skills.yaml", `sources:\n  local:\n    repo: ${src.remote}\n    commit: ${src.first}\n    track: main\n    path: skills # here\n    review: true\nbundles:\n  core:\n    - review # first\n    - debug\n  extra: [notes]\n`);
  publish(clone, "config");
  linkFleetSkill(home, clone);
  installFakeSsh(home, { "alice@remote": { stdout: applyOk } });
  return { clone, home, remote, src };
}

async function withServer(body: (s: UiServer, w: ReturnType<typeof world>) => Promise<void>) {
  const w = world();
  const server = await startUi({ toolDir: w.clone, configDir: w.clone, home: w.home });
  try {
    await body(server, w);
  } finally {
    await server.close();
  }
}

const base = (s: UiServer) => `http://127.0.0.1:${s.port}`;
const post = (s: UiServer, path: string, body: unknown) =>
  fetch(base(s) + path, { method: "POST", headers: { "x-fleet-token": s.token, origin: base(s), "content-type": "application/json" }, body: JSON.stringify(body) });
const postJson = async (s: UiServer, path: string, body: unknown) => (await post(s, path, body)).json() as Promise<any>;
const read = (w: { clone: string }, rel: string) => readFileSync(join(w.clone, rel), "utf8");
const entry = (s: UiServer, kind: string, name: string, ops: unknown[] = []) => postJson(s, "/api/entry", { kind, name, ops });
const file = (p: any, path: string) => p.files.find((f: any) => f.path === path);

test("entry: each kind is read as written, a secret stays a name, and a missing item is not found", async () => {
  await withServer(async (s) => {
    const docs = await entry(s, "server", "docs");
    assert.equal(docs.ok, true);
    assert.equal(docs.path, "catalog/mcp.yaml");
    assert.deepEqual(docs.value, { command: ["npx", "-y", "@example/docs-mcp@1.0.0"], env: { DOCS_TOKEN: "secret:DOCS_TOKEN", REGION: "eu" } });
    assert.deepEqual([docs.found, docs.editable, docs.reason, docs.text], [true, true, null, MCP]);
    const src = await entry(s, "source", "local");
    assert.equal(src.value.review, true);
    assert.equal(src.value.track, "main");
    assert.deepEqual((await entry(s, "bundle", "core")).value, ["review", "debug"]);
    assert.deepEqual((await entry(s, "host", "remote")).value, { ssh: "alice@remote" });
    assert.deepEqual((await entry(s, "host", "laptop")).value, {});
    const gone = await entry(s, "server", "nope");
    assert.deepEqual([gone.found, gone.value, gone.editable, gone.path], [false, null, false, "catalog/mcp.yaml"]);
    assert.equal((await entry(s, "host", "nobody")).found, false);
  });
});

test("entry: it is the item after the held edits, so an Edit of an unpushed add starts from what was added", async () => {
  await withServer(async (s) => {
    const add = { op: "addServer", name: "fresh", entry: { command: ["node", "x.js"], only: ["claude"] } };
    assert.deepEqual((await entry(s, "server", "fresh", [add])).value, { command: ["node", "x.js"], only: ["claude"] });
    assert.equal((await entry(s, "server", "fresh")).found, false);
    assert.ok((await entry(s, "server", "fresh", [add])).text.includes("  fresh:\n"), "the text is the file after the held edits");
    const edit = { op: "editServer", name: "docs", changes: [{ key: "env", from: { DOCS_TOKEN: "secret:DOCS_TOKEN", REGION: "eu" }, to: null }] };
    assert.equal((await entry(s, "server", "docs", [edit])).value.env, undefined);
  });
});

test("entry: a shape fleet cannot change safely comes with the reason and the file, to show read-only", async () => {
  await withServer(async (s, w) => {
    writeFileSync(join(w.clone, "catalog/mcp.yaml"), "servers:\n  docs: &d\n    command: [a]\n  tracker:\n    transport: http\n    url: https://t.example/mcp\n");
    git(w.clone, "commit", "-qam", "anchor");
    const docs = await entry(s, "server", "docs");
    assert.equal(docs.found, true);
    assert.equal(docs.editable, false);
    assert.match(docs.reason, /anchor/);
    assert.equal(docs.path, "catalog/mcp.yaml");
    assert.match(docs.text, /docs: &d/);
    // The anchor is in the file, so every entry in it is as hard to splice safely.
    assert.equal((await entry(s, "server", "tracker")).editable, false);
    // An edit that is sent anyway is dropped, never forced.
    const p = await postJson(s, "/api/preview", { ops: [{ op: "editServer", name: "tracker", changes: [{ key: "url", from: "https://t.example/mcp", to: "https://t.example/v2" }] }] });
    assert.equal(p.dropped[0].why, "cannot-edit");
    assert.deepEqual(p.files, []);
  });
});

test("an edit of each kind is previewed as the lines that change, and the config still loads", async () => {
  await withServer(async (s, w) => {
    const sha = w.src.first;
    const ops = [
      { op: "editServer", name: "docs", changes: [{ key: "env", from: { DOCS_TOKEN: "secret:DOCS_TOKEN", REGION: "eu" }, to: { DOCS_TOKEN: "secret:OTHER_TOKEN", REGION: "eu" } }] },
      { op: "editSource", name: "local", changes: [{ key: "path", from: "skills", to: "skills" }, { key: "review", from: true, to: null }] },
      { op: "editBundle", name: "core", from: ["review", "debug"], to: ["review", "plan"] },
      { op: "editHost", host: "remote", from: "alice@remote", to: "alice@remote.lan" },
    ];
    const p = await postJson(s, "/api/preview", { ops });
    assert.deepEqual(p.dropped, []);
    assert.deepEqual(p.files.map((f: any) => f.path), ["catalog/mcp.yaml", "catalog/skills.yaml", "hosts/remote.yaml"]);
    assert.ok(file(p, "catalog/mcp.yaml").after.includes("      DOCS_TOKEN: secret:OTHER_TOKEN\n"));
    assert.ok(file(p, "catalog/mcp.yaml").after.includes("    command: [npx, -y, \"@example/docs-mcp@1.0.0\"] # docs\n"));
    const skills = file(p, "catalog/skills.yaml").after as string;
    assert.ok(skills.includes("    path: skills # here\n"));
    assert.ok(!skills.includes("review: true"));
    assert.ok(skills.includes("    - review # first\n    - plan\n"));
    assert.equal(file(p, "hosts/remote.yaml").after, "ssh: alice@remote.lan # the box\nmcp:\n  exclude: [docs]\n");
    assert.ok(p.checks.every((c: any) => c.loads), JSON.stringify(p.checks));
    assert.deepEqual(p.matrix.bundles.find((b: any) => b.name === "core").skills, ["review", "plan"]);
    assert.equal(p.matrix.sources[0].review, false);
    assert.equal(p.matrix.hosts.find((h: any) => h.name === "remote").ssh, "alice@remote.lan");
    assert.equal(sha.length, 40);
    assert.equal(read(w, "catalog/mcp.yaml"), MCP, "a preview writes nothing");
  });
});

test("an edit that leaves a host unable to load is flagged by the checks, and write refuses it", async () => {
  await withServer(async (s, w) => {
    // `remote` excludes docs; the bundle that goes empty is not an edit the page can make, but a skill held by two bundles is.
    const ops = [{ op: "editBundle", name: "extra", from: ["notes"], to: ["notes", "review"] }];
    const p = await postJson(s, "/api/preview", { ops });
    assert.ok(p.checks.some((c: any) => !c.loads));
    const res = await post(s, "/api/write", { ops, message: "x" });
    assert.equal(res.status, 422);
    assert.equal(git(w.clone, "status", "--porcelain"), "");
  });
});

test("ops: edits are checked strictly, field by field, with the loader's words", async () => {
  await withServer(async (s) => {
    const server = (changes: unknown) => ({ op: "editServer", name: "docs", changes });
    const source = (changes: unknown) => ({ op: "editSource", name: "local", changes });
    const bad: unknown[] = [
      server([]),
      server([{ key: "command", to: ["a"] }]),
      server([{ key: "name", from: null, to: "x" }]),
      server([{ key: "command", from: ["a"], to: ["b"] }, { key: "command", from: ["a"], to: ["c"] }]),
      server([{ key: "command", from: ["a"], to: [] }]),
      server([{ key: "command", from: ["a"], to: ["npx", "--token", "secret:X"] }]),
      server([{ key: "command", from: ["a"], to: ["a\nb"] }]),
      server([{ key: "transport", from: null, to: "ws" }]),
      server([{ key: "url", from: null, to: "https://u:p@x.example/mcp" }]),
      server([{ key: "env", from: null, to: { "bad name": "x" } }]),
      server([{ key: "only", from: null, to: ["vim"] }]),
      server([{ key: "command", from: { deep: { deeper: { deepest: { x: 1 } } } }, to: ["a"] }]),
      { op: "editServer", name: "../x", changes: [{ key: "only", from: null, to: ["claude"] }] },
      source([{ key: "repo", from: "https://a.example/r.git", to: "https://b.example/r.git" }]),
      source([{ key: "path", from: "skills", to: "../x" }]),
      source([{ key: "path", from: "skills", to: "/abs" }]),
      source([{ key: "branch", from: null, to: "--upload-pack=x" }]),
      source([{ key: "commit", from: null, to: "abc" }]),
      source([{ key: "review", from: true, to: "no" }]),
      { op: "editBundle", name: "core", from: ["a"], to: [] },
      { op: "editBundle", name: "core", from: ["a"], to: ["fleet"] },
      { op: "editBundle", name: "core", from: "a", to: ["b"] },
      { op: "editBundle", name: "core", from: ["a"], to: ["b", "b"] },
      { op: "editHost", host: "remote", from: "a@b", to: "-oProxyCommand=x" },
      { op: "editHost", host: "remote", from: "a@b", to: "a@b:2222" },
      { op: "editHost", host: "remote", from: 5, to: "a@b" },
      { op: "editHost", host: "../remote", from: null, to: "a@b" },
      { op: "editHost", host: "remote", from: null },
    ];
    for (const op of bad) assert.equal((await post(s, "/api/preview", { ops: [op] })).status, 400, JSON.stringify(op));
    const good = [
      server([{ key: "command", from: ["npx", "-y", "@example/docs-mcp@1.0.0"], to: ["npx", "-y", "@example/docs-mcp@1.1.0"] }, { key: "only", from: null, to: ["claude"] }]),
      source([{ key: "commit", from: "a".repeat(40), to: "b".repeat(40) }, { key: "track", from: "main", to: "release/1" }]),
      { op: "editBundle", name: "core", from: ["review", "debug"], to: ["review"] },
      { op: "editHost", host: "remote", from: "alice@remote", to: "bob@remote" },
    ];
    const ok = await post(s, "/api/preview", { ops: good });
    assert.equal(ok.status, 200);
    const doc = (await ok.json()) as any;
    // The commit is not the file's, so that edit is stale; the others apply.
    assert.deepEqual(doc.dropped.map((d: any) => d.op.op), ["editSource"]);
    assert.equal(doc.dropped[0].why, "stale");
  });
});

test("an edit made from a value the file has since changed is stale: dropped by preview, refused by write, and nothing is written", async () => {
  await withServer(async (s, w) => {
    const op = { op: "editServer", name: "docs", changes: [{ key: "env", from: { DOCS_TOKEN: "secret:DOCS_TOKEN", REGION: "eu" }, to: { REGION: "us" } }] };
    // Someone else changes the file before the page writes.
    writeFileSync(join(w.clone, "catalog/mcp.yaml"), MCP.replace("REGION: eu", "REGION: ap"));
    git(w.clone, "commit", "-qam", "elsewhere");
    const p = await postJson(s, "/api/preview", { ops: [op] });
    assert.equal(p.dropped.length, 1);
    assert.equal(p.dropped[0].why, "stale");
    assert.match(p.dropped[0].reason, /servers\.docs\.env.*changed in the file/);
    const res = await post(s, "/api/write", { ops: [op], message: "x" });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as any).code, "stale");
    assert.ok(read(w, "catalog/mcp.yaml").includes("REGION: ap"), "the newer value is never overwritten");
    assert.equal(git(w.clone, "status", "--porcelain"), "");
  });
});

test("write: edits of the four kinds are one commit and a push, and the page reads them back", async () => {
  await withServer(async (s, w) => {
    const ops = [
      { op: "editServer", name: "tracker", changes: [{ key: "url", from: "https://tracker.example.com/mcp", to: "https://tracker.example.com/v2/mcp" }, { key: "headers", from: null, to: { "X-Region": "eu" } }] },
      { op: "editBundle", name: "extra", from: ["notes"], to: ["notes", "plan"] },
      { op: "editHost", host: "remote", from: "alice@remote", to: "alice@remote" },
    ];
    const res = await post(s, "/api/write", { ops: ops.slice(0, 2), message: "Edit tracker and extra" });
    const doc = (await res.json()) as any;
    assert.equal(res.status, 200, JSON.stringify(doc));
    assert.equal(doc.push.code, "ok", JSON.stringify(doc.push));
    assert.deepEqual(doc.written.files, ["catalog/mcp.yaml", "catalog/skills.yaml"]);
    assert.ok(read(w, "catalog/mcp.yaml").endsWith("    url: https://tracker.example.com/v2/mcp\n    headers:\n      X-Region: eu\n"));
    assert.ok(read(w, "catalog/skills.yaml").includes("  extra: [notes, plan]\n"));
    assert.equal(git(w.clone, "log", "-1", "--format=%s"), "Edit tracker and extra");
    assert.equal(git(w.clone, "status", "--porcelain"), "");
    assert.equal(git(w.clone, "rev-parse", "HEAD"), git(w.clone, "rev-parse", "origin/main"));
    assert.deepEqual((await entry(s, "server", "tracker")).value.headers, { "X-Region": "eu" });
    // A change that changes nothing is nothing to write.
    assert.equal((await post(s, "/api/write", { ops: ops.slice(2), message: "x" })).status, 409);
  });
});
