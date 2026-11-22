import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startUi } from "../src/ui/server.ts";
import type { UiServer } from "../src/ui/server.ts";
import { git, publish } from "./helpers.ts";
import { HEADER_TOKEN, TOKEN, repoText, world } from "./captureworld.ts";
import type { W } from "./captureworld.ts";

async function withServer(body: (s: UiServer, w: W, bodies: string[]) => Promise<void>, opts: Parameters<typeof world>[0] = {}) {
  const w = world(opts);
  const server = await startUi({ toolDir: w.clone, configDir: w.clone, home: w.home });
  try {
    await body(server, w, []);
  } finally {
    await server.close();
  }
}

const base = (s: UiServer) => `http://127.0.0.1:${s.port}`;
async function get(s: UiServer, path: string, bodies: string[]) {
  const res = await fetch(base(s) + path, { headers: { "x-fleet-token": s.token } });
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, doc: JSON.parse(text) as any };
}
async function call(s: UiServer, path: string, body: unknown, bodies: string[]) {
  const res = await fetch(base(s) + path, { method: "POST", headers: { "x-fleet-token": s.token, origin: base(s), "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, text, doc: JSON.parse(text) as any };
}
const noValue = (bodies: string[]) => bodies.forEach((b) => assert.ok(!b.includes(TOKEN), "no answer holds a value"));

const TRACKER = { type: "http", url: "https://tracker.example.com/mcp", headers: { Authorization: HEADER_TOKEN } };

test("GET /api/capture lists what this machine has with names and shapes, never a value", async () => {
  await withServer(async (s, w, bodies) => {
    w.claude({ tracker: TRACKER, scraper: { type: "stdio", command: "npx", args: ["-y", "scraper-mcp"], env: { SCRAPER_API_KEY: TOKEN, REGION: "eu" } } });
    const { status, doc } = await get(s, "/api/capture", bodies);
    assert.equal(status, 200);
    assert.equal(doc.host, "laptop");
    assert.deepEqual(doc.items.map((i: any) => [i.kind, i.name, i.state]), [["mcp", "tracker", "new"], ["mcp", "scraper", "new"]]);
    assert.deepEqual(doc.items[1].variants[0].keys.map((k: any) => [k.key, k.secret]), [["SCRAPER_API_KEY", true], ["REGION", false]]);
    assert.match(doc.items[1].variants[0].warning, /no version/, "the unpinned command is warned about, as on Add");
    noValue(bodies);
    assert.equal(git(w.clone, "status", "--porcelain"), "", "reading writes nothing");
  });
});

test("an answer is built into held edits with the value encrypted, and writing it takes this machine over, so the push applies cleanly", async () => {
  await withServer(async (s, w, bodies) => {
    w.claude({ tracker: TRACKER });
    const stream = await fetch(`${base(s)}/api/events?token=${s.token}`);
    const reader = stream.body!.getReader();
    let events = "";
    const reading = (async () => {
      const decoder = new TextDecoder();
      while (!events.includes("event: pushend")) {
        const { value, done } = await reader.read();
        if (done) break;
        events += decoder.decode(value);
      }
      await reader.cancel();
    })();

    const built = await call(s, "/api/capture/build", { ops: [], decision: { kind: "mcp", name: "tracker", action: "add", scope: "host", variant: 0, onlyHad: false, secrets: [{ where: "headers", key: "Authorization", name: "TRACKER_AUTHORIZATION" }] } }, bodies);
    assert.equal(built.status, 200, built.text);
    assert.equal(built.doc.takeover, true);
    assert.deepEqual(built.doc.ops.map((o: any) => o.op), ["addServer", "setSecret", "add"]);
    assert.deepEqual(built.doc.ops[0].entry.headers, { Authorization: "secret:TRACKER_AUTHORIZATION" });
    assert.match(built.doc.ops[1].content, /^TRACKER_AUTHORIZATION: ENC\[AES256_GCM,/);
    assert.equal(git(w.clone, "status", "--porcelain"), "", "nothing is written by building");

    // Each choice shows its YAML on To push, secrets as names only.
    const shown = await call(s, "/api/preview", { ops: built.doc.ops }, bodies);
    assert.deepEqual(shown.doc.dropped, []);
    assert.deepEqual(shown.doc.files.map((f: any) => f.path), ["catalog/mcp.yaml", "hosts/laptop.yaml", "secrets/laptop.enc.yaml"]);
    assert.ok(!JSON.stringify(shown.doc.files).includes("AES256_GCM"));

    const written = await call(s, "/api/write", { ops: built.doc.ops, message: "Capture mcp tracker", captured: [{ kind: "mcp", name: "tracker" }] }, bodies);
    assert.equal(written.status, 200, written.text);
    assert.deepEqual(written.doc.captured.adopted, ["mcp:tracker"]);
    // The apply of the push found the entry recorded as fleet's: it did not report it as a conflict.
    assert.equal(written.doc.push.conflicts?.length ?? 0, 0, written.text);
    assert.equal(written.doc.ok, true, written.text);
    await reading;
    assert.equal(w.decrypt("laptop", "TRACKER_AUTHORIZATION")?.trim(), HEADER_TOKEN);
    noValue([...bodies, events]);
    assert.ok(!repoText(w.clone).includes(TOKEN));
    assert.ok(readFileSync(join(w.home, ".claude.json"), "utf8").includes(TOKEN), "nothing was taken off the machine");
  });
});

test("an answer about an item that is gone, a bad answer and a taken secret name are refused without echoing anything", async () => {
  await withServer(async (s, w, bodies) => {
    w.claude({ tracker: TRACKER });
    const gone = await call(s, "/api/capture/build", { ops: [], decision: { kind: "mcp", name: "nothing", action: "add" } }, bodies);
    assert.equal(gone.status, 404);
    const bad = await call(s, "/api/capture/build", { ops: [], decision: { kind: "mcp", name: "tracker", action: "delete" } }, bodies);
    assert.equal(bad.status, 400);
    const badName = await call(s, "/api/capture/build", { ops: [], decision: { kind: "mcp", name: "tracker", action: "add", secrets: [{ where: "headers", key: "Authorization", name: "lower case" }] } }, bodies);
    assert.equal(badName.status, 400);
    const missing = await call(s, "/api/capture/build", { ops: [], decision: { kind: "mcp", name: "tracker", action: "add", secrets: [{ where: "headers", key: "Nope", name: "OTHER_NAME" }] } }, bodies);
    assert.equal(missing.status, 422);
    noValue(bodies);
    assert.equal(git(w.clone, "status", "--porcelain"), "");
  });
});

test("ignore is a held edit of the host file, and taking over what matches changes nothing in the config", async () => {
  await withServer(async (s, w, bodies) => {
    w.claude({ mine: { type: "http", url: "https://mine.example.com/mcp" }, stats: { type: "http", url: "https://stats.example.com/mcp" } });
    w.opencode({ stats: { type: "remote", url: "https://stats.example.com/mcp" } });
    const ignored = await call(s, "/api/capture/build", { ops: [], decision: { kind: "mcp", name: "mine", action: "ignore" } }, bodies);
    assert.equal(ignored.status, 200, ignored.text);
    assert.deepEqual(ignored.doc.ops, [{ op: "ignore", host: "laptop", item: "mcp:mine" }]);
    const shown = await call(s, "/api/preview", { ops: ignored.doc.ops }, bodies);
    assert.match(shown.doc.files[0].after, /unmanaged: \[mcp:mine\]/);

    // `stats` is in the catalog and this host does not pick it yet: picking it is the answer, which also takes it over once written.
    const picked = await call(s, "/api/capture/build", { ops: ignored.doc.ops, decision: { kind: "mcp", name: "stats", action: "add", scope: "all" } }, bodies);
    assert.equal(picked.status, 200, picked.text);
    assert.deepEqual(picked.doc.ops.map((o: any) => o.op), ["ignore", "addEverywhere"]);
    assert.equal(picked.doc.takeover, true);
    const done = await call(s, "/api/write", { ops: picked.doc.ops, message: "Pick stats", captured: [{ kind: "mcp", name: "stats" }] }, bodies);
    assert.equal(done.doc.ok, true, done.text);
    assert.deepEqual(done.doc.captured.adopted, ["mcp:stats"]);
    const after = await get(s, "/api/capture", bodies);
    assert.deepEqual(after.doc.items, [], "ignored and from config: nothing is left to list");
  });
});

test("take over works for an item the host already picks, and refuses a body that is not a list of items", async () => {
  await withServer(async (s, w, bodies) => {
    w.claude({ stats: { type: "http", url: "https://stats.example.com/mcp" } });
    w.opencode({ stats: { type: "remote", url: "https://stats.example.com/mcp" } });
    w.write("hosts/laptop.yaml", `admin: true\nage: ${w.id.recipient}\nmcp:\n  include: [stats]\n`);
    publish(w.clone, "pick");
    const listed = await get(s, "/api/capture", bodies);
    assert.equal(listed.doc.items[0].state, "takeover");
    const taken = await call(s, "/api/capture/takeover", { items: [{ kind: "mcp", name: "stats" }] }, bodies);
    assert.equal(taken.status, 200, taken.text);
    assert.deepEqual(taken.doc.adopted, ["mcp:stats"]);
    assert.equal((await call(s, "/api/capture/takeover", { items: "stats" }, bodies)).status, 400);
    assert.equal((await call(s, "/api/capture/takeover", { items: [{ kind: "mcp", name: "../x" }] }, bodies)).status, 400);
  });
});
