import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, gitEnv, installFakeSsh, linkFleetSkill, makeClone, makeHome, makeSource, publish } from "./helpers.ts";
import { sourceDir } from "../src/sources.ts";
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
  write("hosts/_defaults.yaml", "bundles: [core]\nmcp:\n  include: [docs]\n");
  write("hosts/laptop.yaml", "# This machine.\nmcp:\n  include: [tracker]\n");
  write("hosts/remote.yaml", "ssh: alice@remote # the box\nbundles: [extra]\nmcp:\n  exclude: [docs]\n");
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
const file = (p: any, path: string) => p.files.find((f: any) => f.path === path);

test("removing a server is previewed as every file it touches, the matrix loses it, and every host still loads", async () => {
  await withServer(async (s, w) => {
    const p = await postJson(s, "/api/preview", { ops: [{ op: "removeServer", name: "docs" }] });
    assert.deepEqual(p.dropped, []);
    assert.deepEqual(p.files.map((f: any) => f.path), ["catalog/mcp.yaml", "hosts/_defaults.yaml", "hosts/remote.yaml"]);
    assert.ok(!file(p, "catalog/mcp.yaml").after.includes("DOCS_TOKEN"));
    assert.ok(file(p, "catalog/mcp.yaml").after.includes("    url: https://tracker.example.com/mcp\n"));
    assert.equal(file(p, "hosts/_defaults.yaml").after, "bundles: [core]\nmcp:\n  include: []\n");
    assert.equal(file(p, "hosts/remote.yaml").after, "ssh: alice@remote # the box\nbundles: [extra]\nmcp:\n  exclude: []\n");
    assert.deepEqual(p.matrix.servers.map((x: any) => x.name), ["tracker"]);
    assert.ok(p.checks.every((c: any) => c.loads), JSON.stringify(p.checks));
    assert.equal(read(w, "catalog/mcp.yaml"), MCP, "a preview writes nothing");
  });
});

test("removing a bundle takes it from every host that picks it or excludes it", async () => {
  await withServer(async (s) => {
    const p = await postJson(s, "/api/preview", { ops: [{ op: "removeBundle", name: "extra" }, { op: "removeBundle", name: "core" }] });
    assert.deepEqual(p.dropped, []);
    assert.deepEqual(p.files.map((f: any) => f.path), ["catalog/skills.yaml", "hosts/_defaults.yaml", "hosts/remote.yaml"]);
    assert.equal(file(p, "hosts/remote.yaml").after, "ssh: alice@remote # the box\nbundles: []\nmcp:\n  exclude: [docs]\n");
    assert.deepEqual(p.matrix.bundles, []);
    assert.ok(p.checks.every((c: any) => c.loads));
  });
});

test("removing a skill source takes its skills out of the bundles, and a bundle left with none is kept and loads", async () => {
  await withServer(async (s) => {
    const p = await postJson(s, "/api/preview", { ops: [{ op: "removeSource", name: "local", skills: ["review", "debug", "notes"] }] });
    assert.deepEqual(p.dropped, []);
    assert.deepEqual(p.files.map((f: any) => f.path), ["catalog/skills.yaml"]);
    assert.equal(file(p, "catalog/skills.yaml").after, "sources: {}\nbundles:\n  core: []\n  extra: []\n");
    assert.deepEqual(p.matrix.sources, []);
    assert.deepEqual(p.matrix.bundles.map((b: any) => [b.name, b.skills]), [["core", []], ["extra", []]]);
    assert.ok(p.checks.every((c: any) => c.loads), JSON.stringify(p.checks));
  });
});

test("a removal of what is gone, or after another removal of it, is stale and writes nothing", async () => {
  await withServer(async (s, w) => {
    const p = await postJson(s, "/api/preview", { ops: [{ op: "removeServer", name: "nope" }, { op: "removeSource", name: "nope", skills: [] }, { op: "removeBundle", name: "extra" }, { op: "removeBundle", name: "extra" }] });
    assert.deepEqual(p.dropped.map((d: any) => [d.op.op, d.why]), [["removeServer", "stale"], ["removeSource", "stale"], ["removeBundle", "stale"]]);
    assert.match(p.dropped[0].reason, /'nope' is not in catalog\/mcp\.yaml/);
    const res = await post(s, "/api/write", { ops: [{ op: "removeServer", name: "nope" }], message: "x" });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as any).code, "stale");
    assert.equal(git(w.clone, "status", "--porcelain"), "");
  });
});

test("ops: a removal is checked strictly, and the page cannot send more than a name (and a source's skills)", async () => {
  await withServer(async (s) => {
    const bad: unknown[] = [
      { op: "removeServer", name: "../x" },
      { op: "removeServer", name: "a b" },
      { op: "removeServer" },
      { op: "removeServer", name: "x".repeat(65) },
      { op: "removeBundle", name: 3 },
      { op: "removeSource", name: "local" },
      { op: "removeSource", name: "local", skills: "review" },
      { op: "removeSource", name: "local", skills: ["a\nb"] },
      { op: "removeSource", name: "local", skills: ["../x"] },
      { op: "removeSource", name: "local", skills: Array.from({ length: 201 }, (_, i) => `s${i}`) },
    ];
    for (const op of bad) assert.equal((await post(s, "/api/preview", { ops: [op] })).status, 400, JSON.stringify(op));
    // Extra fields are not carried: a removal of a server is its name.
    const p = await postJson(s, "/api/preview", { ops: [{ op: "removeServer", name: "tracker", path: "/etc/passwd", files: ["x"] }] });
    assert.deepEqual(p.applied, [{ op: "removeServer", name: "tracker" }]);
  });
});

test("write: a removal is one commit with every file it touched, then a push", async () => {
  await withServer(async (s, w) => {
    const res = await post(s, "/api/write", { ops: [{ op: "removeServer", name: "docs" }], message: "Remove docs" });
    const doc = (await res.json()) as any;
    assert.equal(res.status, 200, JSON.stringify(doc));
    assert.equal(doc.push.code, "ok", JSON.stringify(doc.push));
    assert.deepEqual([...doc.written.files].sort(), ["catalog/mcp.yaml", "hosts/_defaults.yaml", "hosts/remote.yaml"]);
    assert.ok(!read(w, "catalog/mcp.yaml").includes("docs"));
    assert.equal(git(w.clone, "log", "-1", "--format=%s"), "Remove docs");
    assert.equal(git(w.clone, "status", "--porcelain"), "");
    assert.equal(git(w.clone, "rev-parse", "HEAD"), git(w.clone, "rev-parse", "origin/main"));
  });
});

test("the check catches a bundle that names a skill no known source provides, from the clones here and from the skills the page staged", async () => {
  await withServer(async (s, w) => {
    const op = { op: "editBundle", name: "extra", from: ["notes"], to: ["notes", "ghost"] };
    // The source is not cloned here and the page staged nothing: nothing is known, so nothing is said.
    assert.ok((await postJson(s, "/api/preview", { ops: [op] })).checks.every((c: any) => c.loads));
    // The page looked at the source when it added it: its skills are known, and `remote` gets `extra`.
    const staged = await postJson(s, "/api/preview", { ops: [op], staged: { local: ["review", "debug", "notes"] } });
    const bad = staged.checks.filter((c: any) => !c.loads);
    assert.deepEqual(bad.map((c: any) => c.host), ["laptop", "remote"].filter((h) => h === "remote"));
    assert.deepEqual(bad[0].problems, ["skill 'ghost' is in no source: no directory 'ghost/' with a SKILL.md under any source path"]);
    // A skill that the source has is fine.
    const fine = await postJson(s, "/api/preview", { ops: [{ ...op, to: ["notes", "debug2"] }, { op: "editBundle", name: "core", from: ["review", "debug"], to: ["review"] }], staged: { local: ["review", "debug", "notes", "debug2"] } });
    assert.ok(fine.checks.every((c: any) => c.loads), JSON.stringify(fine.checks));
    // The clone here is as good as staged skills.
    git(w.home, "clone", "-q", w.src.remote, sourceDir(w.home, "local"));
    const cloned = await postJson(s, "/api/preview", { ops: [op] });
    assert.deepEqual(cloned.checks.filter((c: any) => !c.loads).map((c: any) => c.host), ["remote"]);
    // Write runs the same check: the bundle is refused, and nothing is written or committed.
    const head = git(w.clone, "rev-parse", "HEAD");
    const refused = await post(s, "/api/write", { ops: [op], message: "Add ghost" });
    assert.equal(refused.status, 422);
    const why = (await refused.json()) as any;
    assert.equal(why.code, "invalid");
    assert.match(JSON.stringify(why.problems), /skill 'ghost' is in no source/);
    assert.equal(git(w.clone, "rev-parse", "HEAD"), head);
    assert.equal(git(w.clone, "status", "--porcelain"), "");
    // Removing the source leaves bundles that name nothing the page can find: they lose their skills, so nothing is missing.
    const gone = await postJson(s, "/api/preview", { ops: [{ op: "removeSource", name: "local", skills: ["review", "debug", "notes"] }] });
    assert.ok(gone.checks.every((c: any) => c.loads), JSON.stringify(gone.checks));
    // A bundle that still lists a skill of a source that is gone is the finding.
    const left = await postJson(s, "/api/preview", { ops: [{ op: "removeSource", name: "local", skills: ["review"] }] });
    assert.deepEqual(left.checks.filter((c: any) => !c.loads).map((c: any) => c.host).sort(), ["laptop", "remote"]);
    assert.match(left.checks[0].problems.join(" ") + left.checks[1].problems.join(" "), /skill 'debug' is in no source/);
  });
});

test("staged skills are checked as names", async () => {
  await withServer(async (s) => {
    for (const staged of [[], "x", { "a b": [] }, { local: "review" }, { local: [3] }, { local: Array.from({ length: 1001 }, (_, i) => `s${i}`) }]) {
      assert.equal((await post(s, "/api/preview", { ops: [], staged })).status, 400, JSON.stringify(staged).slice(0, 40));
    }
  });
});
