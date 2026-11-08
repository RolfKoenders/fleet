import { mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cachePath, readCache, readContextCache, remember, rememberContext } from "../../src/tui/cache.ts";
import { shown } from "../../src/tui/contextshown.ts";
import { bridgeFor, CACHE_FILE, contextOf, item, makeConfig, ok, status } from "./fixture.ts";
import { makeHome, repoRoot, runFleet, makeClone, installStatusTools } from "../helpers.ts";

const HOUR = 3_600_000;

test("cache: a status is remembered with only what the card shows, in a file of mode 600", () => {
  const home = makeHome();
  const now = 1_800_000_000_000;
  remember(home, "server", status({ applied: { at: "2026-10-30T10:00:00Z", ageSeconds: 720, config: "c0ffee1" } }), now - 2 * HOUR);
  const path = cachePath(home);
  assert.equal(path, join(home, CACHE_FILE));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(dirname(path)), ["bridge-hosts.json"], "no temp file is left");
  const text = readFileSync(path, "utf8");
  assert.doesNotMatch(text, /c0ffee1/, "the config commit is not a card field");
  const got = readCache(home, now);
  assert.equal(got.server!.agoSeconds, 7200);
  assert.equal(got.server!.result.status!.applied.ageSeconds, 720 + 7200, "the age moves on with the time since");
  assert.equal(got.server!.result.status!.applied.config, null);
});

test("cache: a host is added without losing the others, and a corrupt file is replaced", () => {
  const home = makeHome();
  remember(home, "a", status());
  remember(home, "b", status());
  assert.deepEqual(Object.keys(readCache(home)).sort(), ["a", "b"]);
  writeFileSync(cachePath(home), "{not json");
  assert.deepEqual(readCache(home), {});
  remember(home, "c", status());
  assert.deepEqual(Object.keys(readCache(home)), ["c"]);
});

test("cache: a foreign, mistyped, linked or huge file is ignored, and what is read is cut down like remote text", () => {
  const home = makeHome();
  const path = cachePath(home);
  mkdirSync(dirname(path), { recursive: true });
  const entry = (over: Record<string, unknown> = {}) => ({ savedAt: Date.now() - 1000, status: { ...status(), ...over } });
  const write = (doc: unknown) => writeFileSync(path, JSON.stringify(doc));
  write({ version: 1, hosts: { a: entry() } });
  assert.deepEqual(readCache(home), {}, "no app marker");
  write({ app: "fleet-bridge-hosts", version: 2, hosts: { a: entry() } });
  assert.deepEqual(readCache(home), {}, "another version");
  write([1, 2]);
  assert.deepEqual(readCache(home), {});
  write({ app: "fleet-bridge-hosts", version: 1, hosts: { a: { savedAt: "now", status: status() }, b: { savedAt: 5, status: "x" }, c: entry({ pending: -3, conflicts: "many" }), d: entry({ timer: "active\u001b]0;pwned\u0007", repos: { fleet: { branch: "main", sha: "x".repeat(900), clean: true, ahead: 0, behind: 0 } }, extra: "ignored" }) } });
  const got = readCache(home);
  assert.deepEqual(Object.keys(got).sort(), ["c", "d"]);
  assert.equal(got.c!.result.status!.pending, null, "a bad number is unknown, not a number");
  assert.equal(got.c!.result.status!.conflicts, null, "a bad number is unknown, not a number");
  assert.doesNotMatch(JSON.stringify(got.d), /\u001b|\u0007/);
  assert.ok(got.d!.result.status!.repos.fleet.sha.length <= 200);
  assert.equal("extra" in got.d!.result.status!, false);

  writeFileSync(path, " ".repeat(300_000));
  assert.deepEqual(readCache(home), {}, "too big");
  const other = join(makeHome(), "real.json");
  write({ app: "fleet-bridge-hosts", version: 1, hosts: { a: entry() } });
  writeFileSync(other, readFileSync(path));
  const linked = makeHome();
  mkdirSync(dirname(cachePath(linked)), { recursive: true });
  symlinkSync(other, cachePath(linked));
  assert.deepEqual(readCache(linked), {}, "a link is not trusted");
});

test("cache: nothing but the bridge reads it, and status gives the same answer whatever is in it", () => {
  const sources = readdirSync(join(repoRoot, "src"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
  const naming = sources.filter((f) => readFileSync(join(repoRoot, "src", f), "utf8").includes("bridge-hosts"));
  assert.deepEqual(naming, ["tui/cache.ts"]);

  const { clone } = makeClone();
  const home = makeHome("laptop");
  installStatusTools(home);
  const read = () => JSON.parse(runFleet(clone, ["status", "--json"], { home }).stdout);
  const before = read();
  mkdirSync(dirname(cachePath(home)), { recursive: true });
  writeFileSync(cachePath(home), JSON.stringify({ app: "fleet-bridge-hosts", version: 1, hosts: { laptop: { savedAt: 1, status: status({ pending: 99 }) } } }));
  assert.deepEqual(read(), before);
  assert.equal(JSON.parse(readFileSync(cachePath(home), "utf8")).hosts.laptop.status.pending, 99, "status did not touch it either");
});

test("bridge: remembered hosts show as seen earlier and not live until the host answers", async () => {
  const cached = { server: { result: ok({ pending: 5 }), agoSeconds: 2 * 3600 } };
  const b = await bridgeFor(makeConfig(), { hosts: { server: "never" } }, { settle: false, app: { cached } });
  const f = b.frame();
  assert.match(f, /seen 2h ago, not live/);
  assert.match(f, /1 seen earlier, not live/);
  assert.match(f, /pending 5/, "the card is filled from the file");
  assert.match(f, /asking 1 .*pending 0/, "but the totals count only what hosts said this run");
  b.advance(60_000);
  assert.match(b.frame(), /seen 2h ago/, "the age keeps counting");
});

test("bridge: a live answer replaces the old one, and only good answers from other hosts are remembered", async () => {
  const saved: string[] = [];
  const b = await bridgeFor(
    makeConfig(),
    { hosts: { server: ok({ pending: 4 }), box: { result: "unreachable", status: null, detail: "no route" } } },
    { settle: false, app: { cached: { server: { result: ok({ pending: 5 }), agoSeconds: 7200 } }, remember: (host) => void saved.push(host) } },
  );
  await b.settle();
  b.advance(100);
  const f = b.frame();
  assert.doesNotMatch(f, /seen 2h ago/);
  assert.match(f, /pending 4/);
  assert.deepEqual(saved, ["server"], "not this host, not an unreachable one");
});

const sample = () => shown(contextOf({ claude: [item("instructions", "~/.claude/CLAUDE.md", 1200), item("skills", "review", 400), item("mcp", "tracker", 14000), item("mcp", "analytics", null, false), item("mcp", "issues", null, true, "auth-needed")] }));

test("cache: a startup context is kept next to the status, cut to the fields the screen shows, in a file of mode 600", () => {
  const home = makeHome();
  const now = 1_800_000_000_000;
  remember(home, "server", status(), now - HOUR);
  rememberContext(home, "server", sample(), now - 2 * HOUR);
  const path = cachePath(home);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dirname(path)), ["bridge-hosts.json"], "no temp file is left");
  const doc = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(Object.keys(doc.hosts.server).sort(), ["context", "savedAt", "status"], "one entry for the host");
  const kept = doc.hosts.server.context;
  assert.deepEqual(Object.keys(kept.report.agents[0]).sort(), ["agent", "instructions", "items", "mcp", "skills"]);
  assert.deepEqual(Object.keys(kept.report.agents[0].items[0]).sort(), ["doctor", "fromConfig", "kind", "name", "tokens"], "no path, no measurement time");
  assert.equal(kept.report.agents[0].items.find((i: { name: string }) => i.name === "issues").doctor, "auth-needed", "why a server has no size is kept");
  assert.equal(kept.report.agents[0].items.find((i: { name: string }) => i.name === "analytics").tokens, null, "unknown stays unknown, never 0");
  const got = readContextCache(home, now);
  assert.equal(got.server!.agoSeconds, 7200);
  assert.deepEqual(got.server!.report, sample());
  assert.equal(readCache(home, now).server!.agoSeconds, 3600, "the status keeps its own age");
  remember(home, "server", status({ pending: 3 }), now);
  assert.equal(readContextCache(home, now).server!.agoSeconds, 7200, "a new status does not touch the context");
});

test("cache: a context can be kept for a host whose status was not, and a status for one without a context", () => {
  const home = makeHome();
  rememberContext(home, "a", sample());
  remember(home, "b", status());
  assert.deepEqual(Object.keys(readContextCache(home)), ["a"]);
  assert.deepEqual(Object.keys(readCache(home)), ["b"], "a host with no status has no card to fill in");
});

test("cache: a damaged, foreign or oversize context is dropped alone, and what is read is cut down like remote text", () => {
  const home = makeHome();
  const path = cachePath(home);
  mkdirSync(dirname(path), { recursive: true });
  const part = { tokens: 10, count: 1, unmeasured: 0 };
  const agent = (over: Record<string, unknown> = {}) => ({ agent: "claude", instructions: part, skills: part, mcp: part, items: [{ kind: "skills", name: "review", tokens: 10, fromConfig: true }], ...over });
  const entry = (report: unknown, savedAt: unknown = Date.now() - 1000) => ({ savedAt: Date.now() - 1000, status: status(), context: { savedAt, report } });
  const write = (hosts: Record<string, unknown>) => writeFileSync(path, JSON.stringify({ app: "fleet-bridge-hosts", version: 1, hosts }));
  write({
    a: entry({ agents: [agent()] }),
    b: entry("nothing"),
    c: entry({ agents: [agent({ agent: "vim" })] }),
    d: entry({ agents: [agent({ mcp: { tokens: -4, count: 1, unmeasured: 0 } })] }),
    e: entry({ agents: [agent({ mcp: { tokens: 1, count: 1, unmeasured: 5 } })] }),
    f: entry({ agents: [agent({ items: [{ kind: "mcp", name: "x\u001b]0;pwned\u0007y", tokens: "lots", fromConfig: 1, extra: "no", path: "/etc/passwd" }, { kind: "other", name: "z", tokens: 1 }, { kind: "skills", name: "" }] })] }),
    g: entry({ agents: [agent({ instructions: { tokens: 5e9, count: 1, unmeasured: 0 } })] }),
    h: entry({ agents: [agent()] }, "yesterday"),
  });
  const got = readContextCache(home);
  assert.deepEqual(Object.keys(got).sort(), ["a", "f"]);
  const items = got.f!.report.agents[0]!.items;
  assert.equal(items.length, 1, "an unknown kind and a nameless item are dropped");
  assert.doesNotMatch(items[0]!.name, /[\u001b\u0007]/);
  assert.equal(items[0]!.tokens, null, "a size that is not a number is unknown, not a number");
  assert.equal(items[0]!.fromConfig, false);
  assert.equal(items[0]!.path, null, "nothing but the shown fields is taken");
  assert.deepEqual(Object.keys(readCache(home)).sort(), ["a", "b", "c", "d", "e", "f", "g", "h"], "the statuses are good and are still read");

  writeFileSync(path, " ".repeat(300_000));
  assert.deepEqual(readContextCache(home), {}, "too big");
  writeFileSync(path, "{not json");
  assert.deepEqual(readContextCache(home), {});
  write({ a: entry({ agents: [agent()] }) });
  const linked = makeHome();
  mkdirSync(dirname(cachePath(linked)), { recursive: true });
  symlinkSync(path, cachePath(linked));
  assert.deepEqual(readContextCache(linked), {}, "a link is not trusted");
  rememberContext(home, "z", sample());
  assert.deepEqual(Object.keys(readContextCache(home)).sort(), ["a", "z"], "a good file is added to");
  writeFileSync(path, JSON.stringify({ version: 1, hosts: { a: entry({ agents: [agent()] }) } }));
  assert.deepEqual(readContextCache(home), {}, "no app marker");
});

test("cache: the fields an older bridge reads are where they were, and the file is still only the bridge's", () => {
  const home = makeHome();
  remember(home, "server", status());
  rememberContext(home, "server", sample());
  const doc = JSON.parse(readFileSync(cachePath(home), "utf8"));
  assert.equal(doc.version, 1);
  assert.ok(doc.hosts.server.status && typeof doc.hosts.server.savedAt === "number");
  const sources = readdirSync(join(repoRoot, "src"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
  assert.deepEqual(sources.filter((f) => readFileSync(join(repoRoot, "src", f), "utf8").includes("bridge-hosts")), ["tui/cache.ts"]);
});
