import { mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeSsh, linkFleetSkill, makeClone, makeHome, publish, repoRoot, runFleet, tempDir } from "./helpers.ts";
import { acquirePushLock } from "../src/lock.ts";
import { EXIT } from "../src/exit.ts";
import { ui } from "../src/ui/command.ts";
import { startUi } from "../src/ui/server.ts";
import type { UiServer } from "../src/ui/server.ts";

const applyOk = JSON.stringify({ ok: true, code: "ok", host: "remote", messages: [], created: [], updated: [], removed: [], conflicts: [] });

/** A config clone (also the tool) for host laptop, one ssh host answered by the fake ssh, and a temp HOME. */
function world() {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(clone, rel)), { recursive: true });
    writeFileSync(join(clone, rel), content);
  };
  write("hosts/laptop.yaml", "{}\n");
  write("hosts/remote.yaml", "ssh: alice@remote\n");
  publish(clone, "config");
  linkFleetSkill(home, clone);
  installFakeSsh(home, { "alice@remote": { stdout: applyOk } });
  return { clone, home };
}

async function withServer(options: { idleMs?: number; staticDir?: string } = {}, body: (s: UiServer, w: ReturnType<typeof world>) => Promise<void>) {
  const w = world();
  const server = await startUi({ toolDir: w.clone, configDir: w.clone, home: w.home, ...options });
  try {
    await body(server, w);
  } finally {
    await server.close();
  }
}

const base = (s: UiServer) => `http://127.0.0.1:${s.port}`;
const authed = (s: UiServer, extra: Record<string, string> = {}) => ({ "x-fleet-token": s.token, ...extra });
const post = (s: UiServer, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base(s) + path, { method: "POST", headers: authed(s, { origin: base(s), "content-type": "application/json", ...headers }), body: JSON.stringify(body) });

/** A raw request, for what `fetch` would normalise or refuse to send: another Host, a path with dots. */
function raw(s: UiServer, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: s.port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (d) => (body += d)).on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

const events = async (res: Response, until: (seen: string) => boolean): Promise<string> => {
  const reader = res.body!.getReader();
  let seen = "";
  const decoder = new TextDecoder();
  while (!until(seen)) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value);
  }
  await reader.cancel();
  return seen;
};

test("the server binds 127.0.0.1 only and the URL carries the token in the fragment", async () => {
  await withServer({}, async (s) => {
    assert.equal(s.address, "127.0.0.1");
    assert.equal(s.url, `http://127.0.0.1:${s.port}/#t=${s.token}`);
    assert.ok(s.token.length >= 40);
  });
});

test("an API call without the token is 401 and with a wrong one 403", async () => {
  await withServer({}, async (s) => {
    assert.equal((await fetch(`${base(s)}/api/status`)).status, 401);
    assert.equal((await fetch(`${base(s)}/api/status`, { headers: { "x-fleet-token": "nope" } })).status, 403);
    assert.equal((await fetch(`${base(s)}/api/status`, { headers: { "x-fleet-token": s.token + "x" } })).status, 403);
    assert.equal((await fetch(`${base(s)}/api/events`)).status, 401);
    assert.equal((await fetch(`${base(s)}/api/events?token=nope`)).status, 403);
    assert.equal((await fetch(`${base(s)}/api/status?token=${s.token}`)).status, 401, "only the stream takes the token as a query");
  });
});

test("GET status answers with what fleet status knows", async () => {
  await withServer({}, async (s) => {
    const res = await fetch(`${base(s)}/api/status`, { headers: authed(s) });
    assert.equal(res.status, 200);
    const doc = (await res.json()) as Record<string, unknown>;
    assert.equal(doc.code, "ok");
    assert.ok("repos" in doc && "tools" in doc && "pending" in doc);
  });
});

test("a request whose Host is not 127.0.0.1:<port> is refused, with and without the token", async () => {
  await withServer({}, async (s) => {
    for (const host of ["evil.example", `evil.example:${s.port}`, `localhost:${s.port}`, "127.0.0.1", `127.0.0.1:${s.port + 1}`]) {
      assert.equal((await raw(s, "/api/status", { host, "x-fleet-token": s.token })).status, 403, host);
      assert.equal((await raw(s, "/", { host })).status, 403, host);
    }
    assert.equal((await raw(s, "/", { host: `127.0.0.1:${s.port}` })).status, 200);
  });
});

test("a write needs the page's own Origin", async () => {
  await withServer({}, async (s) => {
    for (const origin of ["http://evil.example", `http://localhost:${s.port}`, "null"]) {
      assert.equal((await post(s, "/api/push", {}, { origin })).status, 403, origin);
    }
    const missing = await fetch(`${base(s)}/api/push`, { method: "POST", headers: authed(s, { "content-type": "application/json" }), body: "{}" });
    assert.equal(missing.status, 403);
    assert.equal((await post(s, "/api/push", {}, { "x-fleet-token": "wrong" })).status, 403);
  });
});

test("no response carries a CORS header", async () => {
  await withServer({}, async (s) => {
    const responses = [
      await fetch(`${base(s)}/`),
      await fetch(`${base(s)}/api/status`),
      await fetch(`${base(s)}/api/status`, { headers: authed(s, { origin: "http://evil.example" }) }),
      await fetch(`${base(s)}/api/status`, { method: "OPTIONS", headers: { origin: "http://evil.example", "access-control-request-method": "POST" } }),
      await post(s, "/api/push", {}, { origin: "http://evil.example" }),
      await fetch(`${base(s)}/nothing`),
    ];
    for (const r of responses) {
      for (const [name] of r.headers) assert.equal(name.startsWith("access-control-"), false, `${r.status} ${name}`);
      await r.body?.cancel();
    }
  });
});

test("static files are served with their type, and nothing outside the folder", async () => {
  const dir = tempDir("fleet-static-");
  writeFileSync(join(dir, "index.html"), "<p>hi</p>");
  writeFileSync(join(dir, "app.js"), "export {}");
  writeFileSync(join(dir, "app.css"), "a{}");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "..", "outside.txt"), "outside");
  await withServer({ staticDir: dir }, async (s) => {
    const index = await fetch(`${base(s)}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type")!, /^text\/html/);
    assert.equal(await index.text(), "<p>hi</p>");
    assert.match((await fetch(`${base(s)}/app.js`)).headers.get("content-type")!, /^text\/javascript/);
    assert.match((await fetch(`${base(s)}/app.css`)).headers.get("content-type")!, /^text\/css/);
    assert.equal((await fetch(`${base(s)}/missing.js`)).status, 404);
    assert.equal((await fetch(`${base(s)}/sub`)).status, 404, "a directory is not a file");
    for (const path of ["/../outside.txt", "/%2e%2e/outside.txt", "/..%2foutside.txt", "/sub/../../outside.txt", "/%2e%2e%2f%2e%2e%2fetc/passwd", "/..\\outside.txt", "/%00", "//etc/passwd", "/app.js%00.css"]) {
      const r = await raw(s, path, { host: `127.0.0.1:${s.port}` });
      assert.notEqual(r.status, 200, path);
      assert.equal(r.body.includes("outside"), false, path);
    }
  });
});

test("the committed page is served from src/ui/static", async () => {
  await withServer({}, async (s) => {
    const page = await (await fetch(`${base(s)}/`)).text();
    assert.match(page, /<script type="module" src="\/app\.js">/);
    assert.match(await (await fetch(`${base(s)}/api.js`)).text(), /X-Fleet-Token/);
    assert.equal((await fetch(`${base(s)}/index.html`)).status, 200);
    assert.equal((await raw(s, "/../../package.json", { host: `127.0.0.1:${s.port}` })).status, 404);
    assert.ok(repoRoot);
  });
});

test("the server stops by itself after the idle time with no stream, and not while a stream is open", async () => {
  await withServer({ idleMs: 400 }, async (s) => {
    const stream = await fetch(`${base(s)}/api/events?token=${s.token}`);
    const seen = await events(stream, (t) => t.includes("event: hello"));
    assert.match(seen, /event: hello/);
    // `events` cancelled the stream above; open another and keep it for longer than the idle time.
    const open = await fetch(`${base(s)}/api/events?token=${s.token}`);
    const outcome = await Promise.race([s.stopped, new Promise((r) => setTimeout(() => r("still up"), 1200))]);
    assert.equal(outcome, "still up");
    assert.equal((await fetch(`${base(s)}/api/status`, { headers: authed(s) })).status, 200);
    await open.body!.cancel();
    assert.equal(await Promise.race([s.stopped, new Promise((r) => setTimeout(() => r("never"), 5000))]), "idle");
  });
});

test("a server nobody connects to stops after the idle time", async () => {
  await withServer({ idleMs: 200 }, async (s) => {
    assert.equal(await s.stopped, "idle");
  });
});

test("a push while the push lock is held answers locked, with the holder's pid", async () => {
  await withServer({}, async (s, w) => {
    const release = acquirePushLock(w.home);
    try {
      const res = await post(s, "/api/push", {});
      assert.equal(res.status, 409);
      const doc = (await res.json()) as { code: string; ok: boolean; messages: string[] };
      assert.equal(doc.code, "locked");
      assert.equal(doc.ok, false);
      assert.ok(doc.messages.some((m) => m.includes(`a push is already running (pid ${process.pid})`)), doc.messages.join("|"));
    } finally {
      release();
    }
  });
});

test("a push runs the real fleet push and relays its events over the stream", async () => {
  await withServer({}, async (s) => {
    const stream = await fetch(`${base(s)}/api/events?token=${s.token}`);
    const reading = events(stream, (t) => t.includes("event: pushend"));
    const res = await post(s, "/api/push", { message: "from the page" });
    assert.equal(res.status, 200);
    const doc = (await res.json()) as { ok: boolean; code: string; hosts: { host: string; result: string }[] };
    assert.equal(doc.code, "ok");
    assert.deepEqual(doc.hosts.map((h) => h.host).sort(), ["laptop", "remote"]);
    const seen = await reading;
    assert.match(seen, /event: push\ndata: \{"event":"stage","host":null,"stage":"validate"\}/);
    assert.match(seen, /"event":"host","host":"remote","state":"done"/);
    assert.match(seen, /event: pushend/);
  });
});

test("a bad push body is 400, and a body is never written to stdout or stderr", async () => {
  await withServer({}, async (s) => {
    const marker = "typed-in-the-browser-3f9c";
    const written: string[] = [];
    const [out, err] = [process.stdout.write, process.stderr.write];
    process.stdout.write = ((c: unknown) => (written.push(String(c)), true)) as typeof process.stdout.write;
    process.stderr.write = ((c: unknown) => (written.push(String(c)), true)) as typeof process.stderr.write;
    let statuses: number[];
    try {
      statuses = [(await post(s, "/api/push", { message: 5, marker })).status, (await post(s, "/api/push", [marker])).status];
      const bad = await fetch(`${base(s)}/api/push`, { method: "POST", headers: authed(s, { origin: base(s), "content-type": "application/json" }), body: `{"marker":"${marker}"` });
      statuses.push(bad.status);
      const wrongType = await fetch(`${base(s)}/api/push`, { method: "POST", headers: authed(s, { origin: base(s), "content-type": "text/plain" }), body: marker });
      statuses.push(wrongType.status);
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
    assert.deepEqual(statuses, [400, 400, 400, 400]);
    assert.equal(written.join("").includes(marker), false);
  });
});

test("ui: --no-open and SSH_CONNECTION do not open a browser, and the URL is always printed", async () => {
  const w = world();
  const run = async (open: boolean, env: NodeJS.ProcessEnv) => {
    const opened: string[] = [];
    const printed: string[] = [];
    const stop = new AbortController();
    const done = ui({ toolDir: w.clone, configDir: () => w.clone, home: w.home, json: false, open, env, opener: (u) => opened.push(u), out: (t) => printed.push(t), signal: stop.signal });
    await new Promise((r) => setTimeout(r, 300));
    stop.abort();
    const result = await done;
    return { opened, printed: printed.join(""), result };
  };
  const plain = await run(true, {});
  assert.equal(plain.opened.length, 1);
  assert.match(plain.printed, /http:\/\/127\.0\.0\.1:\d+\/#t=[\w-]+/);
  assert.equal(plain.opened[0], /http:\/\/\S+/.exec(plain.printed)![0]);
  const noOpen = await run(false, {});
  assert.deepEqual(noOpen.opened, []);
  assert.match(noOpen.printed, /#t=/);
  const ssh = await run(true, { SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" });
  assert.deepEqual(ssh.opened, []);
  assert.match(ssh.printed, /#t=/);
  assert.match(ssh.printed, /ssh -L \d+:127\.0\.0\.1:\d+/);
  assert.equal(ssh.result.code, "ok");
});

test("ui refuses --json, and `fleet ui --json` exits 2", async () => {
  const w = world();
  const r = await ui({ toolDir: w.clone, configDir: () => w.clone, home: w.home, json: true, open: false });
  assert.equal(r.code, "invalid");
  const run = runFleet(w.clone, ["ui", "--json"], { home: w.home });
  assert.equal(run.code, EXIT.invalid);
  assert.match(run.stdout, /no --json form/);
});

test("fleet help lists ui and fleet agent does not", () => {
  const w = world();
  const help = runFleet(w.clone, ["help"], { home: w.home });
  assert.match(help.stdout, /^ {2}ui {2}/m);
  assert.match(help.stdout, /--no-open/);
  const agent = runFleet(w.clone, ["agent"], { home: w.home });
  assert.equal(/fleet ui\b/.test(agent.stdout), false);
});

test("--port and --no-open are only for ui, and a bad port is refused", () => {
  const w = world();
  assert.equal(runFleet(w.clone, ["status", "--port", "80"], { home: w.home }).code, EXIT.invalid);
  assert.equal(runFleet(w.clone, ["status", "--no-open"], { home: w.home }).code, EXIT.invalid);
  assert.equal(runFleet(w.clone, ["ui", "--port", "99999"], { home: w.home }).code, EXIT.invalid);
  assert.equal(runFleet(w.clone, ["ui", "--port", "x"], { home: w.home }).code, EXIT.invalid);
});
