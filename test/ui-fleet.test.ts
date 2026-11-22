import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cachePath, readCache, readContextCache, remember, rememberContext } from "../src/tui/cache.ts";
import { shown } from "../src/tui/contextshown.ts";
import type { Probe } from "../src/tui/probe.ts";
import { FleetWatch, LIVE_SECONDS } from "../src/ui/fleet.ts";
import { startUi } from "../src/ui/server.ts";
import type { UiServer } from "../src/ui/server.ts";
import { cannedProbe, CONTEXTS, contextOf, item, makeConfig, ok, status } from "./tui/fixture.ts";
import type { Canned } from "./tui/fixture.ts";
import { makeHome } from "./helpers.ts";

/** The hosts of `makeConfig`: laptop (this host), server and box over ssh, edge on its own timer. Nothing here reaches a real host. */
async function withFleet(canned: Canned, body: (s: UiServer, home: string, config: string) => Promise<void>, over: Partial<Probe> = {}) {
  const config = makeConfig();
  const home = makeHome("laptop");
  const probe = { ...cannedProbe({ contexts: CONTEXTS, ...canned }), ...over };
  const server = await startUi({ toolDir: config, configDir: config, home, probe });
  try {
    await body(server, home, config);
  } finally {
    await server.close();
  }
}

const base = (s: UiServer) => `http://127.0.0.1:${s.port}`;
const get = async (s: UiServer, path = "/api/fleet") => ((await fetch(`${base(s)}${path}`, { headers: { "x-fleet-token": s.token } })).json() as Promise<any>);
const refresh = (s: UiServer, headers: Record<string, string> = {}) => fetch(`${base(s)}/api/fleet/refresh`, { method: "POST", headers: { "x-fleet-token": s.token, origin: base(s), ...headers } });
const hostOf = (doc: any, name: string) => doc.hosts.find((h: any) => h.name === name);

test("fleet: the routes need the token, and a refresh needs the page's own Origin", async () => {
  await withFleet({}, async (s) => {
    assert.equal((await fetch(`${base(s)}/api/fleet`)).status, 401);
    assert.equal((await fetch(`${base(s)}/api/fleet`, { headers: { "x-fleet-token": "nope" } })).status, 403);
    assert.equal((await fetch(`${base(s)}/api/fleet/refresh`, { method: "POST", headers: { origin: base(s) } })).status, 401);
    assert.equal((await refresh(s, { origin: "http://evil.example" })).status, 403);
    assert.equal((await refresh(s, { "x-fleet-token": "wrong" })).status, 403);
    assert.equal((await fetch(`${base(s)}/api/fleet/refresh`, { headers: { "x-fleet-token": s.token } })).status, 405, "a refresh is a POST");
    assert.equal((await fetch(`${base(s)}/api/fleet`, { method: "POST", headers: { "x-fleet-token": s.token, origin: base(s) } })).status, 405);
  });
});

test("fleet: before anything is asked it lists every host, this one first, with nothing live", async () => {
  await withFleet({}, async (s) => {
    const doc = await get(s);
    assert.equal(doc.ok, true);
    assert.equal(doc.running, false);
    assert.deepEqual(doc.hosts.map((h: any) => h.name), ["laptop", "box", "edge", "server"]);
    assert.ok(doc.hosts[0].self);
    for (const h of doc.hosts) assert.deepEqual([h.asked, h.live, h.status, h.context, h.result], ["never", false, null, null, null], h.name);
    assert.equal(hostOf(doc, "server").ssh, "me@server");
    assert.equal(hostOf(doc, "edge").ssh, null);
  });
});

test("fleet: what the bridge remembered is shown at once, marked not live, with its age", async () => {
  await withFleet({}, async (s, home) => {
    const now = Date.now();
    remember(home, "server", status({ conflicts: 2 }), now - 2 * 3_600_000);
    rememberContext(home, "server", shown(CONTEXTS.server as any), now - 3_600_000);
    const server = hostOf(await get(s), "server");
    assert.equal(server.live, false);
    assert.equal(server.asked, "never");
    assert.ok(Math.abs(server.seenSeconds - 7200) < 30, `seen ${server.seenSeconds}`);
    assert.equal(server.status.conflicts, 2);
    assert.deepEqual([server.context.live, Math.round(server.context.seenSeconds / 3600)], [false, 1]);
    assert.equal(server.context.report.agents[0].agent, "claude");
  });
});

test("fleet: a refresh asks every host and the answer is live; a host that is not reached keeps what was last seen, and says so", async () => {
  await withFleet(
    { hosts: { box: { result: "unreachable", status: null, detail: "ssh: connect to host box port 22: Connection timed out" }, edge: { result: "timer", status: null } } },
    async (s, home) => {
      remember(home, "box", status({ applied: { at: "2026-10-30T10:00:00Z", ageSeconds: 100, config: null }, timer: "active" }), Date.now() - 5 * 3_600_000);
      const res = await refresh(s);
      assert.equal(res.status, 200);
      const doc: any = await res.json();
      assert.equal(doc.running, false);
      const [laptop, server, box, edge] = ["laptop", "server", "box", "edge"].map((n) => hostOf(doc, n));
      assert.deepEqual([laptop.live, laptop.result, laptop.asked], [true, "ok", "done"]);
      assert.deepEqual([server.live, server.result, server.seenSeconds], [true, "ok", null]);
      assert.ok(server.answeredSeconds < 30);
      assert.deepEqual([box.live, box.result], [false, "unreachable"]);
      assert.match(box.detail, /Connection timed out/);
      assert.ok(Math.abs(box.seenSeconds - 5 * 3600) < 30, "the last seen state is kept, with its age");
      assert.equal(box.status.timer, "active");
      assert.equal(box.contextResult, null, "a host that did not answer is not asked a second question");
      assert.deepEqual([edge.result, edge.status, edge.live], ["timer", null, false]);
      // The next read, from another page, sees the same.
      assert.deepEqual(hostOf(await get(s), "box").result, "unreachable");
    },
  );
});

test("fleet: the startup context of each host: measured, on an older pin (kept as last seen), and the lower bound", async () => {
  await withFleet({}, async (s, home) => {
    rememberContext(home, "box", shown(contextOf({ claude: [item("instructions", "~/.claude/CLAUDE.md", 500)] })), Date.now() - 60_000);
    const doc: any = await (await refresh(s)).json();
    const laptop = hostOf(doc, "laptop");
    assert.equal(laptop.context.live, true);
    const claude = laptop.context.report.agents.find((a: any) => a.agent === "claude");
    assert.equal(claude.complete, false, "a server nobody measured makes the total a lower bound");
    assert.equal(claude.mcp.unmeasured, 1);
    const box = hostOf(doc, "box");
    assert.equal(box.contextResult, "old");
    assert.deepEqual([box.context.live, box.context.seenSeconds >= 60], [false, true], "an older pin leaves the remembered context, marked");
    const edge = hostOf(doc, "edge");
    assert.deepEqual([edge.context, edge.contextResult], [null, "timer"]);
  });
});

test("fleet: a host with conflicts is asked for them in full, with the fix; one on an older pin says so", async () => {
  await withFleet(
    {
      hosts: { server: ok({ conflicts: 1, conflictList: [{ kind: "link", path: "~/.claude/rules/host.md" }] }), box: ok({ conflicts: 2 }), laptop: ok({ conflicts: 1 }) },
      remote: { server: { ok: true, items: [{ kind: "link", path: "~/.claude/rules/host.md", detail: "a hand-made file is in the way", fix: "rm ~/.claude/rules/host.md" }] }, box: { ok: false, reason: "old", detail: "detail needs a newer pin" } },
      conflicts: { ok: true, items: [{ kind: "key", path: "~/.claude.json", detail: "changed by hand", fix: "fleet adopt" }] },
    },
    async (s) => {
      const doc: any = await (await refresh(s)).json();
      assert.deepEqual(hostOf(doc, "server").conflicts, { ok: true, items: [{ kind: "link", path: "~/.claude/rules/host.md", detail: "a hand-made file is in the way", fix: "rm ~/.claude/rules/host.md" }] });
      assert.equal(hostOf(doc, "server").status.conflictList[0].path, "~/.claude/rules/host.md", "the card can name the first");
      assert.deepEqual(hostOf(doc, "box").conflicts, { ok: false, reason: "old", detail: "detail needs a newer pin" });
      assert.equal(hostOf(doc, "laptop").conflicts.items[0].fix, "fleet adopt", "this host is planned in place");
    },
  );
});

test("fleet: the memory file is the bridge's own: a refresh writes it and the bridge's reader reads it", async () => {
  await withFleet({ hosts: { server: ok({ pending: 3 }) } }, async (s, home) => {
    assert.equal(cachePath(home).endsWith(".local/state/fleet/bridge-hosts.json"), true);
    // An entry of a host that is not in the config, and one for a host that is, written as the bridge writes them.
    remember(home, "retired", status({ pending: 9 }));
    await refresh(s);
    const seen = readCache(home);
    assert.equal(seen.server!.result.status!.pending, 3, "the bridge reads what the page wrote");
    assert.equal(seen.retired!.result.status!.pending, 9, "an entry the page did not ask for is kept");
    assert.equal(seen.laptop, undefined, "this host is read in place and not remembered, as in the bridge");
    assert.equal(readContextCache(home).server!.report.agents[0]!.agent, "claude");
    const file = JSON.parse(readFileSync(cachePath(home), "utf8"));
    assert.deepEqual([file.app, file.version], ["fleet-bridge-hosts", 1]);
    assert.ok(!JSON.stringify(file).includes("conflictList\":["), "no more is written than the bridge writes");
  });
});

test("fleet: a file the bridge wrote is read by the page, and one the page cannot read is left to the bridge to replace", async () => {
  await withFleet({}, async (s, home) => {
    remember(home, "server", status({ pending: 4 }));
    assert.equal(hostOf(await get(s), "server").status.pending, 4);
    writeFileSync(cachePath(home), "{not json");
    assert.equal(hostOf(await get(s), "server").status, null, "a corrupt file is no memory, not an error");
    mkdirSync(dirname(cachePath(home)), { recursive: true });
    await refresh(s);
    assert.equal(readCache(home).server!.result.status!.pending, 0, "the refresh replaced it with a file the bridge reads");
  });
});

test("fleet: asking does not block the server, and the hosts are asked once however many pages ask", async () => {
  let asked = 0;
  const release: (() => void)[] = [];
  await withFleet(
    {},
    async (s) => {
      const first = refresh(s);
      const second = refresh(s);
      // While the hosts are being asked, the server answers other calls, and says what it is doing.
      await new Promise((r) => setTimeout(r, 50));
      const during = await get(s);
      assert.equal(during.running, true);
      assert.equal(hostOf(during, "server").asked, "asking");
      assert.equal((await fetch(`${base(s)}/api/skills`, { headers: { "x-fleet-token": s.token } })).status, 200);
      for (const r of release) r();
      const [a, b] = await Promise.all([first.then((r) => r.json()), second.then((r) => r.json())]);
      assert.equal((a as any).running, false);
      assert.deepEqual(a, b);
      assert.equal(asked, 4, "one question per host, not one per page");
    },
    {
      host: (host) => {
        asked++;
        return new Promise((resolve) => release.push(() => resolve(ok())));
      },
    },
  );
});

test("fleet: the answers arrive on the stream one host at a time, and the job is named", async () => {
  await withFleet({}, async (s) => {
    const stream = await fetch(`${base(s)}/api/events?token=${s.token}`);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    const reading = (async () => {
      while (!/event: fleet\ndata: .*\n\n[^]*event: jobs\ndata: {"jobs":\[\]}/.test(seen)) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += decoder.decode(value);
      }
      await reader.cancel();
    })();
    await refresh(s);
    await reading;
    assert.match(seen, /event: jobs\ndata: {"jobs":\[{"kind":"fleet"}\]}/);
    const docs = [...seen.matchAll(/event: fleet\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!));
    assert.ok(docs.length >= 5, "once to say it started, then each host");
    assert.ok(docs[0].running);
    assert.equal(docs.at(-1).running, false);
    assert.ok(docs.some((d) => d.hosts.some((h: any) => h.asked === "asking")));
  });
});

test("fleet: a probe that throws is an error on that host, not a failure of the screen", async () => {
  await withFleet(
    {},
    async (s) => {
      const doc: any = await (await refresh(s)).json();
      assert.deepEqual([hostOf(doc, "server").result, hostOf(doc, "server").live], ["error", false]);
      assert.match(hostOf(doc, "server").detail, /boom/);
      assert.equal(hostOf(doc, "box").result, "ok");
    },
    { host: async (host) => { if (host.name === "server") throw new Error("boom"); return ok(); } },
  );
});

test("fleet: an answer older than two minutes is a memory like any other, not live", async () => {
  const config = makeConfig();
  const home = makeHome("laptop");
  let clock = Date.now();
  const watch = new FleetWatch({ configDir: config, home, probe: cannedProbe({ contexts: CONTEXTS, hosts: { box: { result: "unreachable", status: null, detail: "no route" } } }), now: () => clock });
  await watch.refresh();
  const fresh = watch.doc().hosts;
  assert.deepEqual([fresh.find((h) => h.name === "server")!.live, fresh.find((h) => h.name === "box")!.result], [true, "unreachable"]);
  clock += (LIVE_SECONDS + 5) * 1000;
  const later = watch.doc().hosts;
  const server = later.find((h) => h.name === "server")!;
  assert.deepEqual([server.live, server.asked, server.result, server.conflicts], [false, "never", null, null]);
  assert.ok(Math.abs(server.seenSeconds! - (LIVE_SECONDS + 5)) < 5, "what the answer left in the memory file, with its age");
  assert.equal(later.find((h) => h.name === "box")!.result, null, "an old failure is not shown as if it were news");
});
