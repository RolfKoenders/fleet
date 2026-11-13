import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, createClient, openStream } from "../src/ui/static/api.js";
import { changed, counts, lineDiff, splitLines, tokenize } from "../src/ui/static/diff.js";
import { backoff, discard, hold, idlePush, pushEnd, pushEvent, routeOf, statusView, tokenOf } from "../src/ui/static/state.js";
import { makeClone, makeHome, repoRoot } from "./helpers.ts";
import { startUi } from "../src/ui/server.ts";

const staticDir = join(repoRoot, "src/ui/static");

test("the token comes from the fragment, and a screen from the fragment after it is removed", () => {
  assert.equal(tokenOf("#t=abc-_9"), "abc-_9");
  assert.equal(tokenOf("#t="), null);
  assert.equal(tokenOf(""), null);
  assert.equal(tokenOf("#/matrix"), null);
  assert.equal(routeOf("#/hosts"), "hosts");
  assert.equal(routeOf("#hosts"), "hosts");
  assert.equal(routeOf("#t=abc"), "matrix", "the token fragment is no screen");
  assert.equal(routeOf("#/nope"), "matrix");
});

test("the reconnect delay doubles from half a second and stops at ten", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(backoff), [500, 1000, 2000, 4000, 8000, 10000, 10000]);
});

test("lineDiff: equal, added, removed and changed lines", () => {
  assert.deepEqual(lineDiff(["a", "b"], ["a", "b"]), [[" ", "a"], [" ", "b"]]);
  assert.deepEqual(lineDiff(["a"], ["a", "b"]), [[" ", "a"], ["+", "b"]]);
  assert.deepEqual(lineDiff(["a", "b"], ["b"]), [["-", "a"], [" ", "b"]]);
  assert.deepEqual(lineDiff(["a", "x", "c"], ["a", "y", "c"]), [[" ", "a"], ["-", "x"], ["+", "y"], [" ", "c"]]);
  assert.deepEqual(lineDiff([], []), []);
  const d = lineDiff(["a", "x", "c"], ["a", "y", "z", "c"]);
  assert.deepEqual(counts(d), { added: 2, removed: 1 });
  assert.equal(changed(d), true);
  assert.equal(changed(lineDiff(["a"], ["a"])), false);
  assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(splitLines(""), []);
});

test("lineDiff reproduces both sides", () => {
  const a = ["bundles: [x]", "# note", "mcp:", "  include: [a, b]"];
  const b = ["bundles: [x, y]", "mcp:", "  include: [a]", "  exclude: [c]"];
  const d = lineDiff(a, b);
  assert.deepEqual(d.filter(([o]) => o !== "+").map(([, l]) => l), a);
  assert.deepEqual(d.filter(([o]) => o !== "-").map(([, l]) => l), b);
});

test("tokenize splits a YAML line into key, string and comment, and joins back to the line", () => {
  const line = '  linear:  # the tracker "x"';
  assert.deepEqual(tokenize('  key: "v" # c'), [
    { cls: "", text: "  " },
    { cls: "k", text: "key" },
    { cls: "", text: ": " },
    { cls: "s", text: '"v"' },
    { cls: "", text: " " },
    { cls: "c", text: "# c" },
  ]);
  for (const l of [line, "", "plain", "- secret:TOKEN_A", "  # only a comment", 'a: "b#c"']) assert.equal(tokenize(l).map((t) => t.text).join(""), l, l);
  assert.deepEqual(tokenize("k: secret:TOKEN_A").map((t) => t.cls), ["k", "", "s"]);
});

test("held edits: hold keeps the first original, undoing drops it, discard drops one or all", () => {
  let held = hold({}, "hosts/a.yaml", "x: 1\n", "x: 2\n");
  assert.deepEqual(held, { "hosts/a.yaml": { before: "x: 1\n", after: "x: 2\n" } });
  held = hold(held, "hosts/a.yaml", "x: 2\n", "x: 3\n");
  assert.deepEqual(held["hosts/a.yaml"], { before: "x: 1\n", after: "x: 3\n" }, "the disk's text stays the original");
  assert.deepEqual(hold(held, "hosts/a.yaml", "x: 3\n", "x: 1\n"), {}, "back to the original holds nothing");
  held = hold(held, "hosts/b.yaml", "", "y: 1\n");
  assert.deepEqual(Object.keys(discard(held, "hosts/a.yaml")), ["hosts/b.yaml"]);
  assert.deepEqual(discard(held), {});
  assert.equal(Object.keys(held).length, 2, "discard does not change its input");
});

test("push events fold into lanes, stages and a log, and the end closes the run", () => {
  let p = idlePush();
  p = pushEvent(p, { event: "stage", stage: "validate" });
  assert.equal(p.running, true);
  assert.equal(p.stage, "validate");
  p = pushEvent(p, { event: "hosts", hosts: [{ host: "laptop", via: "local" }, { host: "box", via: "ssh" }] });
  p = pushEvent(p, { event: "host", host: "laptop", state: "start" });
  p = pushEvent(p, { event: "step", host: "laptop", step: "link", target: "~/.claude/skills/x", n: 1, of: 4 });
  assert.equal(p.lanes[0].state, "running");
  assert.match(p.lanes[0].step ?? "", /^1\/4 link/);
  p = pushEvent(p, { event: "message", host: "box", text: "hello" });
  p = pushEvent(p, { event: "host", host: "laptop", state: "done", result: "ok", changes: 3 });
  p = pushEvent(p, { event: "host", host: "box", state: "skip" });
  p = pushEvent(p, { event: "surprise", x: 1 });
  assert.deepEqual(p.lanes.map((l) => [l.state, l.result, l.changes]), [["done", "ok", 3], ["skip", null, 0]]);
  assert.ok(p.log.includes("box: hello"));
  assert.ok(p.log.some((l) => l.includes("surprise")), "an unknown event is logged, not dropped");
  p = pushEnd(p, { ok: true, code: "ok", hosts: [{ host: "box", result: "ok", changes: 1 }] });
  assert.equal(p.running, false);
  assert.deepEqual(p.end, { ok: true, code: "ok", messages: [] });
  assert.equal(p.lanes[1].state, "done");
  assert.equal(pushEvent(p, { event: "stage", stage: "validate" }).end, null, "an event after the end starts a new run");
  assert.equal(pushEvent(idlePush(), null).running, true);
  const long = Array.from({ length: 500 }, (_, i) => i).reduce((s, i) => pushEvent(s, { event: "message", text: String(i) }), idlePush());
  assert.equal(long.log.length, 200);
});

test("statusView names the rows the status screen shows", () => {
  const v = statusView({
    host: "laptop",
    repos: { fleet: { branch: "main", sha: "0123456789abcdef", clean: false, ahead: 0, behind: 2 } },
    applied: { at: "2026-01-01T00:00:00Z", ageSeconds: 7200, config: "abc" },
    timer: "inactive",
    pending: 2,
    conflicts: 1,
    conflictList: [{ kind: "file", path: "/x" }],
    tools: { claude: "2.1.4", opencode: null },
    messages: ["fleet: careful"],
  });
  assert.equal(v.host, "laptop");
  const row = (label: string) => v.rows.find((r) => r.label === label);
  assert.equal(row("fleet")?.value, "main@0123456");
  assert.equal(row("checkout")?.tone, "warn");
  assert.equal(row("behind")?.value, "2 commits");
  assert.match(row("applied")?.value ?? "", /^2 h ago/);
  assert.equal(row("timer")?.tone, "warn");
  assert.equal(row("conflicts")?.value, "1");
  assert.deepEqual(v.conflicts, ["file /x"]);
  assert.deepEqual(v.tools, [{ name: "claude", version: "2.1.4" }, { name: "opencode", version: null }]);
  assert.deepEqual(v.messages, ["fleet: careful"]);
  const empty = statusView({});
  assert.equal(empty.host, "unknown host");
  assert.equal(empty.rows.find((r) => r.label === "applied")?.value, "never");
});

test("the API client sends the token as a header and turns a refusal into an ApiError", async () => {
  const seen: { path: string; init: RequestInit }[] = [];
  const answer = (status: number, body: unknown): typeof fetch => async (path, init) => {
    seen.push({ path: String(path), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  };
  const ok = createClient("tok", answer(200, { ok: true }));
  assert.deepEqual(await ok.status(), { ok: true });
  assert.equal(seen[0].path, "/api/status");
  assert.equal((seen[0].init.headers as Record<string, string>)["X-Fleet-Token"], "tok");
  await ok.push("msg");
  assert.equal(seen[1].init.method, "POST");
  assert.equal(seen[1].init.body, JSON.stringify({ message: "msg" }));
  await ok.push();
  assert.equal(seen[2].init.body, "{}");
  const locked = createClient("tok", answer(409, { ok: false, code: "locked", messages: ["a push is already running (pid 7)"] }));
  await assert.rejects(locked.push(), (e: unknown) => e instanceof ApiError && e.code === "locked" && e.messages[0] === "a push is already running (pid 7)" && e.status === 409);
  const down = createClient("tok", async () => { throw new TypeError("fetch failed"); });
  await assert.rejects(down.status(), (e: unknown) => e instanceof ApiError && e.code === "network");
});

test("the stream client reconnects with a growing delay after the browser gives up, and resets on hello", () => {
  type Listener = (e: { data: string }) => void;
  const made: FakeSource[] = [];
  class FakeSource {
    readyState = 0;
    onerror: (() => void) | null = null;
    listeners: Record<string, Listener> = {};
    url: string;
    constructor(url: string) {
      this.url = url;
      made.push(this);
    }
    addEventListener(name: string, fn: Listener) {
      this.listeners[name] = fn;
    }
    close() {
      this.readyState = 2;
    }
  }
  const waits: number[] = [];
  const timers: (() => void)[] = [];
  const log: string[] = [];
  const stream = openStream(
    "t k",
    { onHello: (d) => log.push("hello " + JSON.stringify(d)), onEvent: (n, d) => log.push(n + " " + JSON.stringify(d)), onLink: (l) => log.push(l ? "live" : "down") },
    { open: (url) => new FakeSource(url) as unknown as EventSource, later: (fn, ms) => (waits.push(ms), timers.push(fn)) },
  );
  assert.equal(made[0].url, "/api/events?token=t%20k");
  made[0].listeners.hello({ data: '{"pushing":false}' });
  made[0].listeners.push({ data: '{"event":"stage"}' });
  made[0].listeners.pushend({ data: "not json" });
  made[0].onerror!();
  assert.equal(timers.length, 0, "while the browser is retrying by itself we do nothing");
  made[0].readyState = 2;
  made[0].onerror!();
  timers.shift()!();
  made[1].readyState = 2;
  made[1].onerror!();
  timers.shift()!();
  assert.deepEqual(waits, [500, 1000]);
  made[2].listeners.hello({ data: "{}" });
  made[2].readyState = 2;
  made[2].onerror!();
  assert.deepEqual(waits, [500, 1000, 500], "a hello resets the delay");
  assert.deepEqual(log.slice(0, 4), ['live', 'hello {"pushing":false}', 'push {"event":"stage"}', "pushend null"]);
  stream.close();
  timers.shift()!();
  assert.equal(made.length, 3, "a closed stream does not reconnect");
});

// ---- the real server ----

async function withServer(body: (base: string, token: string) => Promise<void>) {
  const { clone } = makeClone();
  const home = makeHome("laptop");
  const server = await startUi({ toolDir: clone, configDir: clone, home });
  try {
    await body(`http://127.0.0.1:${server.port}`, server.token);
  } finally {
    await server.close();
  }
}

const modules = ["app.js", "api.js", "state.js", "diff.js", "dom.js", "matrix.js", "catalog.js"];

test("the page, its modules, its style and its bundled fonts are served with the right types", async () => {
  await withServer(async (base) => {
    const types: Record<string, RegExp> = { "/": /^text\/html/, "/style.css": /^text\/css/, "/fonts/JetBrainsMono-Regular.woff2": /^font\/woff2/, "/fonts/JetBrainsMono-Bold.woff2": /^font\/woff2/, "/fonts/OFL.txt": /^text\/plain/ };
    for (const m of modules) types[`/${m}`] = /^text\/javascript/;
    for (const [path, type] of Object.entries(types)) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type")!, type, path);
      assert.match(res.headers.get("content-security-policy")!, /default-src 'self'/, path);
    }
    // The served JavaScript is the source as written: no type stripping, so no experimental warning to print.
    assert.equal(await (await fetch(`${base}/state.js`)).text(), readFileSync(join(staticDir, "state.js"), "utf8"));
  });
});

test("the bundled fonts are the landing page's, and ship with their licence", () => {
  const fonts = readdirSync(join(repoRoot, "site/fonts")).sort();
  assert.deepEqual(readdirSync(join(staticDir, "fonts")).sort(), fonts);
  for (const f of fonts) assert.ok(readFileSync(join(staticDir, "fonts", f)).equals(readFileSync(join(repoRoot, "site/fonts", f))), `${f} differs from site/fonts`);
});

test("the page loads nothing from another origin, and uses the landing page's palette", () => {
  const sources = ["index.html", "style.css", ...modules].map((f) => [f, readFileSync(join(staticDir, f), "utf8")] as const);
  for (const [name, text] of sources) {
    assert.doesNotMatch(text.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, ""), /https?:\/\/|\/\/cdn|googleapis|@import/, name);
  }
  const palette = (text: string) => Object.fromEntries([...text.matchAll(/--(ink|surface|raised|border|text|brand|info|warn|bad|muted|faint|sub): (#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]));
  const brightOf = (text: string) => /--(?:brand-)?bright: (#[0-9a-f]{6})/.exec(text)?.[1];
  const ours = palette(readFileSync(join(staticDir, "style.css"), "utf8"));
  const site = palette(readFileSync(join(repoRoot, "site/style.css"), "utf8"));
  assert.ok(Object.keys(ours).length >= 11);
  assert.equal(brightOf(readFileSync(join(staticDir, "style.css"), "utf8")), /--brand-bright: (#[0-9a-f]{6})/.exec(readFileSync(join(repoRoot, "site/style.css"), "utf8"))?.[1]);
  for (const [name, value] of Object.entries(ours)) assert.equal(value, site[name], name);
});

test("the status answer names the host, for the page's header", async () => {
  await withServer(async (base, token) => {
    const doc = (await (await fetch(`${base}/api/status`, { headers: { "x-fleet-token": token } })).json()) as { host: string };
    assert.equal(doc.host, "laptop");
    assert.equal(statusView(doc).host, "laptop");
  });
});

test("the real API client and stream client work against the real server", async () => {
  await withServer(async (base, token) => {
    // The client uses relative URLs and a browser sends Origin on its own; here we add both.
    const real = globalThis.fetch;
    const client = createClient(token, (path, init) => real(base + String(path), { ...init, headers: { ...init?.headers, Origin: base } }));
    const doc = await client.status();
    assert.equal(doc.host, "laptop");
    await assert.rejects(createClient("wrong", (path, init) => real(base + String(path), { ...init, headers: { ...init?.headers, Origin: base } })).status(), (e: unknown) => e instanceof ApiError && e.code === "forbidden" && e.status === 403);
    const res = await real(`${base}/api/events?token=${token}`);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value), /event: hello/);
    await reader.cancel();
  });
});
