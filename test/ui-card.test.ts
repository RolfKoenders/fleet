import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { repoRoot } from "./helpers.ts";
import { startUi } from "../src/ui/server.ts";
import { canCopyImage, clipboardProblem, discussionUrl, embedFonts, fileName, STYLES, unseenNote } from "../src/ui/static/card.js";
import { routeOf } from "../src/ui/static/state.js";
import { makeConfig } from "./tui/fixture.ts";
import { makeHome } from "./helpers.ts";

async function withServer(body: (base: string, token: string, get: (path: string) => Promise<Response>, post: (body: unknown) => Promise<Response>) => Promise<void>) {
  const home = makeHome("laptop");
  const config = makeConfig();
  const server = await startUi({ toolDir: repoRoot, configDir: config, home });
  const base = `http://127.0.0.1:${server.port}`;
  const get = (path: string) => fetch(`${base}${path}`);
  const post = (b: unknown) => fetch(`${base}/api/card`, { method: "POST", headers: { "x-fleet-token": server.token, origin: base, "content-type": "application/json" }, body: JSON.stringify(b) });
  try {
    await body(base, server.token, get, post);
  } finally {
    await server.close();
  }
}

test("POST /api/card answers the SVG the CLI would write, the badge, the preview and the discussion address", async () => {
  await withServer(async (_base, _token, _get, post) => {
    const res = await post({});
    assert.equal(res.status, 200);
    const doc = await res.json();
    assert.equal(doc.ok, true);
    assert.equal(doc.style, "machines");
    assert.equal(doc.names, false);
    assert.match(doc.svg, /^<svg xmlns=.* width="1200" height="630"/);
    assert.match(doc.badge, /^<svg .*>fleet<\/text>/);
    assert.match(doc.text, /hostnames hidden$/);
    assert.equal(doc.hosts, 4);
    assert.equal(typeof doc.unseen, "number");
    for (const host of ["laptop", "server", "box", "edge"]) assert.equal(doc.svg.includes(`>${host}<`), false, host);
    assert.doesNotMatch(doc.text, /\b(server|box|edge|laptop)\b/);
    const url = new URL(doc.share.url);
    assert.equal(url.origin + url.pathname, "https://github.com/RolfKoenders/fleet/discussions/new");
    assert.equal(url.searchParams.get("category"), "show-and-tell");
    assert.match(url.searchParams.get("title")!, /^My fleet: 4 machines, \d agents?$/);
    assert.match(url.searchParams.get("body")!, /fleet card/);
    assert.equal(discussionUrl(doc.share), doc.share.url);
  });
});

test("POST /api/card takes the style and the names toggle, and refuses the rest", async () => {
  await withServer(async (_base, _token, _get, post) => {
    const map = await (await post({ style: "map", names: true })).json();
    assert.match(map.svg, /one private repo/);
    assert.match(map.svg, />laptop</);
    assert.match(map.text, /hostnames shown$/);
    for (const bad of [{ style: "pie" }, { names: "yes" }]) {
      const res = await post(bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal((await res.json()).code, "invalid");
    }
    assert.equal((await post(undefined)).status, 200, "no body is the defaults");
  });
});

test("POST /api/card needs the token and the page's origin like every API call", async () => {
  await withServer(async (base, _token, _get, _post) => {
    assert.equal((await fetch(`${base}/api/card`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: "{}" })).status, 401);
    const wrong = await fetch(`${base}/api/card`, { method: "POST", headers: { "x-fleet-token": "x".repeat(43), origin: base, "content-type": "application/json" }, body: "{}" });
    assert.equal(wrong.status, 403);
  });
});

test("the page may show its own picture, and still loads nothing from another origin", async () => {
  await withServer(async (_base, _token, get) => {
    for (const path of ["/", "/card.js", "/app.js"]) {
      const res = await get(path);
      assert.equal(res.status, 200, path);
      const csp = res.headers.get("content-security-policy")!;
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /img-src 'self' blob:/);
      assert.doesNotMatch(csp, /https?:/);
    }
    assert.match(await (await get("/")).text(), /href="#\/card"/);
    assert.equal((await get("/fonts/JetBrainsMono-Regular.woff2")).status, 200);
    assert.equal((await get("/fonts/JetBrainsMono-Bold.woff2")).status, 200);
  });
});

test("the Card screen is a route, has a style switch, a names toggle and the four actions", () => {
  assert.equal(routeOf("#/card"), "card");
  assert.deepEqual(STYLES.map(([id]) => id), ["machines", "map"]);
  const app = readFileSync(join(repoRoot, "src/ui/static/app.js"), "utf8");
  for (const id of ["card-style-", "card-names", "card-save-png", "card-copy", "card-post", "card-save-svg"]) assert.ok(app.includes(id), id);
  assert.match(app, /new ClipboardItem\(\{ "image\/png": cardPng\(\) \}\)/);
  assert.match(app, /rel: "noopener noreferrer"/);
});

test("the PNG's font is carried inside the picture, the file name follows the style, and refusals are said plainly", () => {
  const svg = '<svg><title>t</title><defs><pattern/></defs></svg>';
  const out = embedFonts(svg, { regular: "AAAA", bold: "BBBB" });
  assert.match(out, /<defs><style>@font-face\{font-family:'JetBrains Mono';font-weight:400;src:url\(data:font\/woff2;base64,AAAA\)/);
  assert.match(out, /font-weight:500 800;src:url\(data:font\/woff2;base64,BBBB\)/);
  assert.equal(/https?:/.test(out), false);
  assert.equal(fileName("machines", "png"), "fleet-card.png");
  assert.equal(fileName("map", "png"), "fleet-card-map.png");
  assert.equal(fileName("map", "svg"), "fleet-card.svg");
  assert.match(clipboardProblem(Object.assign(new Error("x"), { name: "NotAllowedError" })), /would not copy the image \(it did not allow it here\)\. Use Save PNG/);
  assert.match(clipboardProblem(null), /cannot copy images/);
  assert.equal(canCopyImage({ clipboard: { write() {} } }, class {}), true);
  assert.equal(canCopyImage({ clipboard: {} }, class {}), false);
  assert.equal(canCopyImage(undefined, undefined), false);
});

test("the page opens only the project's Show and tell address", () => {
  const good = "https://github.com/RolfKoenders/fleet/discussions/new?category=show-and-tell&title=a&body=b";
  assert.equal(discussionUrl({ url: good }), good);
  for (const url of ["https://evil.example/discussions/new?category=show-and-tell", "javascript:alert(1)", "https://github.com/RolfKoenders/fleet/discussions/new?category=general", 7, undefined]) assert.equal(discussionUrl({ url }), null, String(url));
  assert.equal(discussionUrl(null), null);
});

test("a host the bridge never saw is counted, never named, under the picture", () => {
  assert.equal(unseenNote(0), null);
  assert.match(unseenNote(1)!, /^1 host has never been seen by the bridge, so it is shown without agents and OS/);
  assert.match(unseenNote(3)!, /^3 hosts have never been seen/);
});
