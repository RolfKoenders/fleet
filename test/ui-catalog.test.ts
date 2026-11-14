import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, gitEnv, installFakeSsh, linkFleetSkill, makeClone, makeHome, makeSource, publish, runFleet, tempDir } from "./helpers.ts";
import { EXIT } from "../src/exit.ts";
import { sourceDir } from "../src/sources.ts";
import { findTool } from "../src/tools.ts";
import { startUi } from "../src/ui/server.ts";
import type { UiServer } from "../src/ui/server.ts";

// The server commits in this process, so git needs an author here too.
Object.assign(process.env, gitEnv);
import { COMMAND_SECRET } from "../src/ui/static/catalog.js";

// The server makes its temp clones under the temp directory: keep them in one this file owns, so they can be counted.
const TMP = tempDir("fleet-ui-tmp-");
process.env.TMPDIR = TMP;
const clones = () => readdirSync(tmpdir()).filter((n) => n.startsWith("fleet-ui-clone-"));

const applyOk = JSON.stringify({ ok: true, code: "ok", host: "remote", messages: [], created: [], updated: [], removed: [], conflicts: [] });
const LAPTOP = "# This machine.\nmcp:\n  include: [tracker]\n";
const REMOTE = "ssh: alice@remote\nmcp:\n  exclude: [docs]\n";
const skill = (n: string) => ({ [`skills/${n}/SKILL.md`]: `---\nname: ${n}\ndescription: ${n}\n---\n${n}\n` });

// A stdio MCP server as a separate process: three tools, or four when API_KEY is in its environment.
const FAKE = `
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") reply(m.id, { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
  else if (m.method === "tools/list") reply(m.id, { tools: Array.from({ length: process.env.API_KEY ? 4 : 3 }, (_, i) => ({ name: "t" + i, inputSchema: { type: "object" } })) });
  else if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } }) + "\\n");
});
`;
const fakeScript = join(tempDir("fleet-fake-"), "server.cjs");
writeFileSync(fakeScript, FAKE);
const fakeEntry = (extra: Record<string, unknown> = {}) => ({ command: [process.execPath, fakeScript], ...extra });

function world() {
  const { clone, remote } = makeClone();
  const home = makeHome("laptop");
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(clone, rel)), { recursive: true });
    writeFileSync(join(clone, rel), content);
  };
  const src = makeSource(Object.assign({}, ...["review", "debug", "notes"].map(skill)));
  write("hosts/_defaults.yaml", "# Every host.\nmcp:\n  include: [docs]\n");
  write("hosts/laptop.yaml", LAPTOP);
  write("hosts/remote.yaml", REMOTE);
  write("catalog/mcp.yaml", "servers:\n  docs:\n    command: [npx, -y, \"@example/docs-mcp@1.0.0\"]\n  tracker:\n    transport: http\n    url: https://tracker.example.com/mcp\n");
  write("catalog/skills.yaml", `sources:\n  local:\n    repo: ${src.remote}\n    branch: main\n    path: skills\nbundles:\n  core: [review]\n`);
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
const get = async (s: UiServer, path: string) => (await fetch(base(s) + path, { headers: { "x-fleet-token": s.token } })).json() as Promise<any>;
const post = (s: UiServer, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base(s) + path, { method: "POST", headers: { "x-fleet-token": s.token, origin: base(s), "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const postJson = async (s: UiServer, path: string, body: unknown) => (await post(s, path, body)).json() as Promise<any>;
const read = (w: { clone: string }, rel: string) => readFileSync(join(w.clone, rel), "utf8");
const addServer = (name: string, entry: Record<string, unknown>) => ({ op: "addServer", name, entry });

test("addServer: an unpinned npx command is only a warning of the page, so the server takes it and shows the file", async () => {
  await withServer(async (s, w) => {
    const before = read(w, "catalog/mcp.yaml");
    const p = await postJson(s, "/api/preview", { ops: [addServer("fresh", { command: ["npx", "some-package"], env: { API_KEY: "secret:API_KEY" }, only: ["claude"] })] });
    assert.deepEqual(p.dropped, []);
    assert.deepEqual(p.files.map((f: any) => f.path), ["catalog/mcp.yaml"]);
    assert.equal(p.files[0].before, before);
    assert.equal(p.files[0].after, `${before}  fresh:\n    command: [npx, some-package]\n    env:\n      API_KEY: secret:API_KEY\n    only: [claude]\n`);
    assert.ok(p.checks.every((c: any) => c.loads));
    // The new server is a row of the matrix, off for every host: adding it gives it to nobody.
    const row = p.matrix.servers.find((r: any) => r.name === "fresh");
    assert.deepEqual(Object.values(row.cells).map((c: any) => c.on), [false, false]);
    assert.equal(read(w, "catalog/mcp.yaml"), before, "a preview writes nothing");
  });
});

test("addServer: a secret in the command is refused with the loader's message, by preview, write and check", async () => {
  await withServer(async (s, w) => {
    const op = addServer("bad", { command: ["npx", "-y", "pkg@1.0.0", "--token", "secret:API_KEY"] });
    for (const [path, body] of [["/api/preview", { ops: [op] }], ["/api/write", { ops: [op], message: "x" }], ["/api/catalog/probe", { name: "bad", entry: op.entry, confirm: true }]] as const) {
      const res = await post(s, path, body);
      assert.equal(res.status, 400, path);
      const doc = (await res.json()) as any;
      assert.ok(doc.messages[0].includes(COMMAND_SECRET), doc.messages[0]);
    }
    // The page's text is the loader's, word for word.
    {
      const { clone } = makeClone();
      mkdirSync(join(clone, "hosts"), { recursive: true });
      mkdirSync(join(clone, "catalog"), { recursive: true });
      writeFileSync(join(clone, "catalog/mcp.yaml"), "servers:\n  bad:\n    command: [npx, \"secret:X\"]\n");
      writeFileSync(join(clone, "hosts/laptop.yaml"), "mcp:\n  include: [bad]\n");
      const { loadConfig } = await import("../src/config.ts");
      assert.throws(() => loadConfig(clone, "laptop", { sources: "none" }), (e: any) => e.problems.some((p: string) => p.endsWith(COMMAND_SECRET)));
    }
    assert.equal(git(w.clone, "status", "--porcelain"), "");
  });
});

test("ops: every shape is checked strictly, so the page can add to the catalog and do nothing else", async () => {
  await withServer(async (s) => {
    const bad: unknown[] = [
      { op: "addServer", name: "x" },
      { op: "addServer", name: "x", entry: [] },
      { op: "addServer", name: "has.dot", entry: fakeEntry() },
      { op: "addServer", name: "-lead", entry: fakeEntry() },
      { op: "addServer", name: "x", entry: fakeEntry({ extra: "key" }) },
      { op: "addServer", name: "x", entry: { command: ["a", 1] } },
      { op: "addServer", name: "x", entry: { command: ["a\nb"] } },
      { op: "addServer", name: "x", entry: { command: ["a"], url: "https://x.example" } },
      { op: "addServer", name: "x", entry: { transport: "ws", url: "https://x.example" } },
      { op: "addServer", name: "x", entry: { transport: "http", url: "https://x.example", env: { A: "b" } } },
      { op: "addServer", name: "x", entry: { command: ["a"], env: { "bad name": "b" } } },
      { op: "addServer", name: "x", entry: { command: ["a"], only: ["vim"] } },
      { op: "addSource", name: "x", entry: { repo: "-oProxyCommand=evil", branch: "main", path: "." } },
      { op: "addSource", name: "x", entry: { repo: "ext::sh -c evil", branch: "main", path: "." } },
      { op: "addSource", name: "x", entry: { repo: "relative/path", branch: "main", path: "." } },
      { op: "addSource", name: "x", entry: { repo: "https://x.example/a b.git", branch: "main", path: "." } },
      { op: "addSource", name: "x", entry: { repo: "https://x.example/a.git", branch: "--upload-pack=x", path: "." } },
      { op: "addSource", name: "x", entry: { repo: "https://x.example/a.git", branch: "main", path: "../x" } },
      { op: "addSource", name: "x", entry: { repo: "https://x.example/a.git", branch: "main", path: ".", review: true } },
      { op: "addSource", name: "x", entry: { repo: "https://x.example/a.git", commit: "abc", track: "main", path: "." } },
      { op: "addSource", name: "x", entry: { repo: "https://x.example/a.git", commit: "a".repeat(40), track: "main", path: ".", review: "yes" } },
      { op: "addSource", name: "x", entry: { repo: "https://x.example/a.git", branch: "main", path: ".", surprise: 1 } },
      { op: "addSource", name: "bad name", entry: { repo: "https://x.example/a.git", branch: "main", path: "." } },
      { op: "addBundle", name: "x", skills: [] },
      { op: "addBundle", name: "x", skills: ["fleet"] },
      { op: "addBundle", name: "x", skills: ["a/b"] },
      { op: "addBundle", name: "x", skills: ["a", "a"] },
      { op: "addBundle", name: "x", skills: "a" },
      { op: "addBundle", name: "x", skills: [1] },
      { op: "addBundle", name: "../x", skills: ["a"] },
      { op: "setEverything", name: "x" },
    ];
    for (const op of bad) {
      const res = await post(s, "/api/preview", { ops: [op] });
      assert.equal(res.status, 400, JSON.stringify(op));
    }
    // Shapes that are right are taken, and nothing but the known fields gets through.
    const good = [
      addServer("a-b_c", { transport: "sse", url: "https://x.example/sse", headers: { Authorization: "Bearer secret:TOKEN" } }),
      { op: "addSource", name: "s.1", entry: { repo: "git@github.com:you/skills.git", commit: "a".repeat(40), track: "main", path: "skills", review: true } },
      { op: "addSource", name: "s2", entry: { repo: "https://x.example/a.git", branch: "main", path: "." } },
      { op: "addBundle", name: "b", skills: ["one", "two.x"] },
    ];
    const p = await postJson(s, "/api/preview", { ops: good });
    assert.equal(p.dropped.length, 0, JSON.stringify(p.dropped));
    assert.equal(p.applied.length, 4);
    assert.equal((await post(s, "/api/preview", { ops: Array(201).fill(good[3]) })).status, 400);
  });
});

test("addSource and addBundle: the files are spliced like the entries before, and a name that exists is dropped as stale", async () => {
  await withServer(async (s, w) => {
    const entry = { repo: "https://github.com/you/skills.git", commit: "a".repeat(40), track: "main", path: "skills", review: true };
    const p = await postJson(s, "/api/preview", { ops: [{ op: "addSource", name: "mine", entry }, { op: "addBundle", name: "extra", skills: ["notes", "debug"] }, { op: "addBundle", name: "core", skills: ["x"] }] });
    assert.equal(p.dropped.length, 1);
    assert.equal(p.dropped[0].why, "stale");
    assert.match(p.dropped[0].reason, /'core' is already in the catalog/);
    const after = p.files.find((f: any) => f.path === "catalog/skills.yaml").after as string;
    assert.match(after, /sources:\n {2}local:[\s\S]*\n {2}mine:\n {4}repo: https:\/\/github.com\/you\/skills.git\n {4}path: skills\n {4}commit: a{40}\n {4}track: main\n {4}review: true\n/);
    assert.match(after, /bundles:\n {2}core: \[review\]\n {2}extra: \[notes, debug\]\n$/);
    assert.deepEqual(p.matrix.sources.map((x: any) => [x.name, x.review]), [["local", false], ["mine", true]]);
    assert.deepEqual(p.matrix.bundles.map((b: any) => b.name), ["core", "extra"]);
    assert.equal(read(w, "catalog/skills.yaml").includes("mine"), false);
  });
});

test("write: catalog additions are written, committed and pushed as one commit", async () => {
  await withServer(async (s, w) => {
    const entry = { repo: w.src.remote, commit: w.src.first, track: "main", path: "skills", review: true };
    const res = await post(s, "/api/write", { ops: [addServer("fresh", fakeEntry()), { op: "addSource", name: "pinned", entry }, { op: "addBundle", name: "extra", skills: ["notes"] }], message: "Add fresh, pinned and extra" });
    const doc = (await res.json()) as any;
    assert.equal(res.status, 200, JSON.stringify(doc));
    assert.equal(doc.push.code, "ok", JSON.stringify(doc.push));
    assert.deepEqual(doc.written.files, ["catalog/mcp.yaml", "catalog/skills.yaml"]);
    assert.match(read(w, "catalog/mcp.yaml"), /\n {2}fresh:\n {4}command: \[/);
    assert.match(read(w, "catalog/skills.yaml"), /pinned:\n {4}repo: .*\n {4}path: skills\n {4}commit: [0-9a-f]{40}\n {4}track: main\n {4}review: true\n/);
    assert.equal(git(w.clone, "log", "-1", "--format=%s"), "Add fresh, pinned and extra");
    assert.equal(git(w.clone, "status", "--porcelain"), "");
    assert.equal(git(w.clone, "rev-parse", "HEAD"), git(w.clone, "rev-parse", "origin/main"));
    assert.ok((await get(s, "/api/matrix")).servers.some((r: any) => r.name === "fresh"));
  });
});

test("a bundle that holds a skill another bundle holds is shown as a config that does not load, with the loader's words", async () => {
  await withServer(async (s) => {
    const p = await postJson(s, "/api/preview", { ops: [{ op: "addBundle", name: "again", skills: ["review"] }] });
    assert.equal(p.dropped.length, 0, "it is a valid shape: the loader's catalog rules decide");
    for (const c of p.checks) {
      assert.equal(c.loads, false, c.host);
      assert.match(c.problems.join("|"), /skill 'review' is in both bundle 'core' and bundle 'again'/);
    }
    assert.equal((await post(s, "/api/write", { ops: [{ op: "addBundle", name: "again", skills: ["review"] }], message: "x" })).status, 422);
  });
});

test("skills: the skills of the source clones fleet already has, and the bundle that holds each", async () => {
  await withServer(async (s, w) => {
    assert.deepEqual((await get(s, "/api/skills")).skills, [], "nothing is cloned here, so nothing is listed, and nothing is fetched");
    git(tempDir(), "clone", "--quiet", w.src.remote, sourceDir(w.home, "local"));
    const doc = await get(s, "/api/skills");
    assert.deepEqual(doc.skills, [{ name: "debug", source: "local", bundle: null }, { name: "notes", source: "local", bundle: null }, { name: "review", source: "local", bundle: "core" }]);
  });
});

test("clone: a repo is cloned shallowly to a temp directory, its skills listed and its head commit read, and discard deletes it", async () => {
  await withServer(async (s, w) => {
    const before = clones();
    const res = await post(s, "/api/catalog/clone", { repo: w.src.remote, path: "skills" });
    const doc = (await res.json()) as any;
    assert.equal(res.status, 200, JSON.stringify(doc));
    assert.equal(doc.commit, w.src.first);
    assert.equal(doc.branch, "main");
    assert.deepEqual(doc.skills, ["debug", "notes", "review"]);
    assert.equal(doc.problem, null);
    assert.equal(clones().length, before.length + 1);
    const dir = join(tmpdir(), clones().find((n) => !before.includes(n))!);
    assert.equal(git(join(dir, "repo"), "rev-list", "--count", "HEAD"), "1", "a shallow clone");
    assert.equal((await post(s, "/api/catalog/discard", { id: doc.id })).status, 200);
    assert.equal(existsSync(dir), false);
    assert.equal((await post(s, "/api/catalog/discard", { id: doc.id })).status, 200, "an id that is gone is nothing to do");
    // A new commit upstream moves what the next clone pins.
    const next = w.src.commit(skill("triage"), "more");
    const again = (await postJson(s, "/api/catalog/clone", { repo: w.src.remote, path: "skills", branch: "main" })) as any;
    assert.equal(again.commit, next);
    assert.deepEqual(again.skills, ["debug", "notes", "review", "triage"]);
    await post(s, "/api/catalog/discard", { id: again.id });
    assert.deepEqual(clones(), before);
  });
});

test("clone: a path that is no directory, a repo that cannot be cloned and a branch that is missing leave nothing behind", async () => {
  await withServer(async (s, w) => {
    const none = (await postJson(s, "/api/catalog/clone", { repo: w.src.remote, path: "nope" })) as any;
    assert.equal(none.ok, true);
    assert.match(none.problem, /path 'nope' is not a directory/);
    assert.deepEqual(none.skills, []);
    await post(s, "/api/catalog/discard", { id: none.id });
    for (const body of [{ repo: join(tempDir(), "missing.git") }, { repo: w.src.remote, branch: "nope" }]) {
      const res = await post(s, "/api/catalog/clone", body);
      assert.equal(res.status, 422, JSON.stringify(body));
      assert.equal(((await res.json()) as any).code, "clone-failed");
    }
    assert.deepEqual(clones(), []);
  });
});

test("clone: git is never handed an argument it would read as an option, a helper or a prompt", async () => {
  await withServer(async (s) => {
    const marker = join(tempDir(), "ran");
    for (const body of [{ repo: `--upload-pack=touch ${marker}` }, { repo: "-c" }, { repo: `ext::sh -c "touch ${marker}"` }, { repo: "x", branch: "--x" }, { repo: "" }, { repo: "/a b" }, { repo: "rel/ative" }, { repo: 3 }, { repo: "/tmp", path: "../x" }, { repo: "/tmp", path: "/etc" }, { repo: "/tmp", branch: "a..b" }, {}]) {
      assert.equal((await post(s, "/api/catalog/clone", body)).status, 400, JSON.stringify(body));
    }
    assert.equal(existsSync(marker), false);
    assert.deepEqual(clones(), []);
  });
});

test("the clone and probe routes are POST only, behind the token, the Host and the Origin", async () => {
  await withServer(async (s) => {
    for (const path of ["/api/catalog/clone", "/api/catalog/probe", "/api/catalog/discard"]) {
      assert.equal((await fetch(base(s) + path, { headers: { "x-fleet-token": s.token } })).status, 405, `GET ${path}`);
      const body = JSON.stringify({ repo: "/tmp", id: "x", name: "x", entry: {}, confirm: true });
      const headers = { "content-type": "application/json" };
      assert.equal((await fetch(base(s) + path, { method: "POST", headers: { ...headers, origin: base(s) }, body })).status, 401, "no token");
      assert.equal((await fetch(base(s) + path, { method: "POST", headers: { ...headers, "x-fleet-token": "wrong", origin: base(s) }, body })).status, 403, "wrong token");
      assert.equal((await fetch(base(s) + path, { method: "POST", headers: { ...headers, "x-fleet-token": s.token, origin: "http://evil.example" }, body })).status, 403, "wrong Origin");
      assert.equal((await fetch(base(s) + path, { method: "POST", headers: { ...headers, "x-fleet-token": s.token }, body })).status, 403, "no Origin");
    }
    assert.equal((await fetch(base(s) + "/api/skills", { method: "POST", headers: { "x-fleet-token": s.token, origin: base(s), "content-type": "application/json" }, body: "{}" })).status, 405);
  });
});

test("clone: the temp clones are deleted when the server stops", async () => {
  const w = world();
  const s = await startUi({ toolDir: w.clone, configDir: w.clone, home: w.home });
  const before = clones();
  await post(s, "/api/catalog/clone", { repo: w.src.remote, path: "skills" });
  await post(s, "/api/catalog/clone", { repo: w.src.remote, path: "skills", branch: "main" });
  assert.equal(clones().length, before.length + 2);
  await s.close();
  assert.deepEqual(clones(), before);
});

test("clone: a page that never discards cannot pile clones up", async () => {
  await withServer(async (s, w) => {
    for (let i = 0; i < 5; i++) await post(s, "/api/catalog/clone", { repo: w.src.remote, path: "skills" });
    assert.equal(clones().length, 3);
  });
});

test("check: it is refused unless the person confirmed", async () => {
  await withServer(async (s) => {
    for (const body of [{ name: "x", entry: fakeEntry() }, { name: "x", entry: fakeEntry(), confirm: "yes" }, { name: "x", entry: fakeEntry(), confirm: false }]) {
      const res = await post(s, "/api/catalog/probe", body);
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as any).messages[0], /must be confirmed/);
    }
  });
});

test("check: the server is started here, answers, and its tools and their size in tokens come back", async () => {
  await withServer(async (s, w) => {
    const doc = await postJson(s, "/api/catalog/probe", { name: "fake", entry: fakeEntry(), confirm: true });
    assert.equal(doc.ok, true);
    assert.equal(doc.result, "ok", JSON.stringify(doc));
    assert.equal(doc.tools, 3);
    assert.ok(doc.size > 0);
    assert.equal(doc.tokens, Math.ceil(doc.size / 4));
    assert.equal(doc.agent, "claude");
    assert.deepEqual(doc.unset, []);
    assert.equal(git(w.clone, "status", "--porcelain"), "", "nothing is written");
    // An entry that does not start is a result, not an error, and says why.
    const gone = await postJson(s, "/api/catalog/probe", { name: "gone", entry: { command: [join(tempDir(), "no-such-program")] }, confirm: true });
    assert.equal(gone.result, "missing-binary");
    const refused = await postJson(s, "/api/catalog/probe", { name: "none", entry: { transport: "http", url: "http://127.0.0.1:1/mcp" }, confirm: true });
    assert.equal(refused.result, "unreachable");
  });
});

test("check: a secret with no value on this host is left out, the server starts without it, and the answer says so", async () => {
  await withServer(async (s) => {
    const doc = await postJson(s, "/api/catalog/probe", { name: "fake", entry: fakeEntry({ env: { API_KEY: "secret:API_KEY", PLAIN: "x" } }), confirm: true });
    assert.equal(doc.result, "ok", JSON.stringify(doc));
    assert.equal(doc.tools, 3, "started without API_KEY");
    assert.deepEqual(doc.unset, ["API_KEY"]);
    // A URL that holds the missing secret has nothing to call.
    const url = await postJson(s, "/api/catalog/probe", { name: "net", entry: { transport: "http", url: "https://x.example/mcp?key=secret:API_KEY" }, confirm: true });
    assert.equal(url.result, "not-run");
    assert.deepEqual(url.unset, ["API_KEY"]);
  });
});

const SOPS = findTool("sops");
const KEYGEN = findTool("age-keygen");
test("check: a secret that has a value is given to the server, and its value is in no answer", { skip: SOPS === null || KEYGEN === null ? "sops and age-keygen are not installed" : false }, async () => {
  const w = world();
  const key = spawnSync(KEYGEN!, [], { encoding: "utf8" }).stdout;
  const recipient = spawnSync(KEYGEN!, ["-y"], { encoding: "utf8", input: key }).stdout.trim();
  mkdirSync(join(w.home, ".local/bin"), { recursive: true });
  for (const [tool, path] of [["sops", SOPS!], ["age-keygen", KEYGEN!]] as const) symlinkSync(path, join(w.home, ".local/bin", tool));
  mkdirSync(join(w.home, ".config/fleet"), { recursive: true });
  writeFileSync(join(w.home, ".config/fleet/age.key"), key, { mode: 0o600 });
  writeFileSync(join(w.clone, "hosts/laptop.yaml"), `admin: true\nage: ${recipient}\n${LAPTOP}`);
  publish(w.clone, "age");
  const VALUE = "value-that-must-not-leak-7731";
  assert.equal(runFleet(w.clone, ["secrets", "set", "shared", "API_KEY"], { home: w.home, input: VALUE }).code, EXIT.ok);
  const s = await startUi({ toolDir: w.clone, configDir: w.clone, home: w.home });
  try {
    const res = await post(s, "/api/catalog/probe", { name: "fake", entry: fakeEntry({ env: { API_KEY: "secret:API_KEY" } }), confirm: true });
    const text = await res.text();
    const doc = JSON.parse(text);
    assert.equal(doc.result, "ok", text);
    assert.equal(doc.tools, 4, "started with API_KEY");
    assert.deepEqual(doc.unset, []);
    assert.equal(text.includes(VALUE), false);
    assert.equal(JSON.stringify(await get(s, "/api/secrets")).includes(VALUE), false);
  } finally {
    await s.close();
  }
});

test("the page's client reaches the new routes: skills, clone, discard and check", async () => {
  const { createClient } = await import("../src/ui/static/api.js");
  await withServer(async (s, w) => {
    const real = globalThis.fetch;
    const client = createClient(s.token, (path, init) => real(base(s) + String(path), { ...init, headers: { ...init?.headers, Origin: base(s) } }));
    assert.deepEqual((await client.skills()).skills, []);
    const doc = await client.clone(w.src.remote, "skills", "main");
    assert.deepEqual(doc.skills, ["debug", "notes", "review"]);
    assert.equal((await client.discardClone(doc.id)).ok, true);
    assert.deepEqual(clones(), []);
    assert.equal((await client.probe("fake", fakeEntry())).tools, 3);
    await assert.rejects(client.clone("-x", ".", ""), (e: any) => e.code === "invalid" && e.status === 400);
  });
});
