import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { gitEnv, installAgent, makeHome, runBin, tempDir, repoRoot } from "./helpers.ts";
import { card } from "../src/card/command.ts";
import { readCard, gridOf, levelOf, GRID_MINIMUM } from "../src/card/data.ts";
import { previewText, sparkline } from "../src/card/preview.ts";
import { renderBadge, renderCard } from "../src/card/svg.ts";
import { journalDir } from "../src/journal.ts";
import { loadModel } from "../src/tui/model.ts";
import { remember } from "../src/tui/cache.ts";
import { status as fixtureStatus } from "./tui/fixture.ts";
import { parseCatalog } from "../src/catalog.ts";
import { status, statusFromDocument } from "../src/status.ts";

const DAY = 86_400_000;

type World = { config: string; home: string; now: Date };

/**
 * A config repo made of `examples/` with `extra` more hosts, `commits` commits spread over the last year (the newest a day
 * old), and a home that is host `laptop`. The bridge has seen `server` (claude, linux) and `box` (claude and agy, macos).
 */
function world(o: { commits: number; extraHosts?: string[]; seen?: boolean }): World {
  const config = tempDir("fleet-card-config-");
  cpSync(join(repoRoot, "examples"), config, { recursive: true });
  for (const name of ["box", ...(o.extraHosts ?? [])]) writeFileSync(join(config, "hosts", `${name}.yaml`), `ssh: me@${name}\n`);
  const now = new Date();
  const run = (args: string[], when?: Date) => {
    const date = when?.toISOString();
    const r = spawnSync("git", args, { cwd: config, encoding: "utf8", env: { ...process.env, ...gitEnv, ...(date === undefined ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }) } });
    assert.equal(r.status, 0, r.stderr);
  };
  run(["init", "-q", "-b", "main"]);
  for (let i = 0; i < o.commits; i++) {
    writeFileSync(join(config, "n.txt"), String(i));
    run(["add", "-A"]);
    run(["commit", "-q", "-m", `change ${i}`], new Date(now.getTime() - (o.commits - i) * 10 * DAY));
  }
  const home = makeHome("laptop");
  installAgent(home, "agy");
  if (o.seen !== false) {
    const agent = (id: "claude" | "antigravity") => ({ id, version: "1.0.0", active: true, pinned: false });
    remember(home, "server", fixtureStatus({ os: "linux", agents: [agent("claude")], applied: { at: now.toISOString(), ageSeconds: 240, config: null } }), now.getTime());
    remember(home, "box", fixtureStatus({ os: "macos", agents: [agent("claude"), agent("antigravity")], applied: { at: now.toISOString(), ageSeconds: 3600, config: null } }), now.getTime());
  }
  return { config, home, now };
}

/** What a viewer can read of an SVG: its text, title and label. A name in the markup's own words (`servers`) is not a leak. */
const readable = (svg: string): string => [...svg.matchAll(/>([^<>]+)</g)].map((m) => m[1]).join("\n") + [...svg.matchAll(/(?:aria-label|title)="([^"]*)"/g)].map((m) => m[1]).join("\n");
const mentions = (svg: string, name: string): boolean => new RegExp(`(^|[^A-Za-z0-9_-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_-])`).test(readable(svg));

/** Every name the card must never hold, whatever the options: servers, skills, bundles and skill sources of the catalog. */
function secretsOf(config: string): string[] {
  const model = loadModel(config, "laptop");
  const catalog = parseCatalog(config, []);
  return [...model.servers.map((s) => s.name), ...model.bundles.flatMap((b) => [b.name, ...b.skills]), ...catalog.sources.map((s) => s.name)];
}

test("the default card holds no hostname and no server, skill or source name, in either style", () => {
  const w = world({ commits: 30 });
  const data = readCard(w.config, w.home, w.now);
  const hostnames = data.hosts.map((h) => h.name);
  assert.deepEqual(hostnames.sort(), ["box", "laptop", "server"]);
  const names = secretsOf(w.config);
  assert.ok(names.length >= 4, "the example config has things to leak");
  for (const style of ["machines", "map"] as const) {
    const svg = renderCard(data, style, false);
    for (const name of [...hostnames, ...names]) assert.equal(mentions(svg, name), false, `${style} holds "${name}"`);
    assert.match(svg, /host 1/);
    assert.match(svg, /host 3/);
    // The text of the picture, the title and the badge are as clean.
    assert.equal(renderBadge(data).includes("laptop"), false);
  }
});

test("--names shows the hostnames and still no server, skill or source name", () => {
  const w = world({ commits: 30 });
  const data = readCard(w.config, w.home, w.now);
  const names = secretsOf(w.config);
  for (const style of ["machines", "map"] as const) {
    const svg = renderCard(data, style, true);
    for (const host of ["box", "laptop", "server"]) assert.match(svg, new RegExp(`>${host}<`), `${style} names ${host}`);
    assert.doesNotMatch(svg, /host 1/);
    for (const name of names) assert.equal(mentions(svg, name), false, `${style} holds "${name}"`);
  }
  // A hostile name cannot break out of the markup.
  const svg = renderCard({ ...data, hosts: [{ ...data.hosts[0]!, name: `a"><script>x</script>` }] }, "machines", true);
  assert.equal(svg.includes("<script>"), false);
});

test("the card is 1200 x 630 and holds no address it would fetch", () => {
  const w = world({ commits: 30 });
  const data = readCard(w.config, w.home, w.now);
  for (const svg of [renderCard(data, "machines", false), renderCard(data, "map", false), renderBadge(data)]) {
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.equal(/https?:\/\/(?!www\.w3\.org)/.test(svg), false, "no other address");
    assert.equal(/<image|<foreignObject|@import|url\(http/.test(svg), false);
  }
  assert.match(renderCard(data, "machines", false), /width="1200" height="630" viewBox="0 0 1200 630"/);
  assert.ok(renderCard(data, "machines", false).includes("rolflab.nl/fleet"));
  // The logo mark of the site header is drawn, not a placeholder dot.
  assert.match(renderCard(data, "map", false), /M8 20h22l10 10v32H8Z/);
});

test("the activity grid is on the card at 20 commits in the year and not at 19", () => {
  assert.equal(GRID_MINIMUM, 20);
  const at20 = world({ commits: 20 });
  const d20 = readCard(at20.config, at20.home, at20.now);
  assert.equal(d20.changes, 20);
  assert.notEqual(d20.activity, null);
  assert.match(renderCard(d20, "machines", false), /activity, 12 months/);
  assert.match(previewText(d20, false, false), /activity, 12 months/);

  const at19 = world({ commits: 19 });
  const d19 = readCard(at19.config, at19.home, at19.now);
  assert.equal(d19.changes, 19);
  assert.equal(d19.activity, null);
  const svg = renderCard(d19, "machines", false);
  assert.doesNotMatch(svg, /activity, 12 months/);
  assert.match(svg, /19 changes<\/tspan> in the last year/, "the bottom line stays");
  assert.doesNotMatch(previewText(d19, false, false), /activity/);
  // The map has no grid at any count.
  assert.doesNotMatch(renderCard(d20, "map", false), /activity/);
});

test("commits older than a year are not changes", () => {
  const w = world({ commits: 25 });
  const later = new Date(w.now.getTime() + 400 * DAY);
  assert.equal(readCard(w.config, w.home, later).changes, 0);
});

test("the grid is a week to a column, Sunday first, with only the 12 months in it", () => {
  const now = new Date(2026, 10, 22, 12); // a Sunday
  const grid = gridOf(["2026-11-22", "2026-11-22", "2026-11-21"], now);
  assert.equal(grid.at(-1)![0], 2, "today is the first day of the last week");
  assert.equal(grid.at(-1)![1], null, "tomorrow is not drawn");
  assert.equal(grid.at(-2)![6], 1, "yesterday is the last day of the week before");
  assert.ok(grid.length === 53 || grid.length === 52);
  assert.equal(grid.flat().filter((d) => d !== null).length, 365);
  assert.deepEqual([0, 1, 5, 9, 10].map((c) => levelOf(c, 10)), [0, 1, 2, 4, 4]);
  assert.equal(sparkline([[1, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0], [5, 5, 0, 0, 0, 0, 0]]), "▂▁█");
});

test("the map shows six machines and a +N more card above six, and the bottom line", () => {
  const six = world({ commits: 30, extraHosts: ["b1", "b2", "b3"] }); // 3 + 3 = 6 hosts
  const d6 = readCard(six.config, six.home, six.now);
  assert.equal(d6.hosts.length, 6);
  const svg6 = renderCard(d6, "map", false);
  assert.doesNotMatch(svg6, /more/);
  assert.match(svg6, /host 6/);

  const nine = world({ commits: 30, extraHosts: ["b1", "b2", "b3", "b4", "b5", "b6"] }); // 9 hosts
  const d9 = readCard(nine.config, nine.home, nine.now);
  assert.equal(d9.hosts.length, 9);
  const svg9 = renderCard(d9, "map", false);
  assert.match(svg9, />\+3 more</);
  assert.match(svg9, /host 6/);
  assert.doesNotMatch(svg9, /host 7/);
  // The count on the card is all nine, not the six shown.
  const machines = renderCard(d9, "machines", false);
  assert.match(machines, />9<\/text>/);
  assert.match(machines, />\+3 more</);
  assert.match(previewText(d9, false, false), /\+3 more/);
  assert.match(svg9, /<\/tspan> changes this year/);
});

test("the badge counts machines and agents, in the singular too", () => {
  const w = world({ commits: 5 });
  const data = readCard(w.config, w.home, w.now);
  assert.equal(data.hosts.length, 3);
  const badge = renderBadge(data);
  assert.match(badge, new RegExp(`>3 machines · ${data.agents} agents<`));
  assert.match(badge, /aria-label="fleet: 3 machines, \d+ agents?"/);
  assert.match(badge, /height="20"/);
  const one = renderBadge({ ...data, hosts: [data.hosts[0]!], agents: 1 });
  assert.match(one, />1 machine · 1 agent</);
});

test("agents and OS are the bridge's last answer; a host it never saw is blank and the preview says so", () => {
  const w = world({ commits: 30 });
  const data = readCard(w.config, w.home, w.now);
  const byName = Object.fromEntries(data.hosts.map((h) => [h.name, h]));
  assert.deepEqual(byName.box!.agents, ["claude", "agy"]);
  assert.equal(byName.box!.os, "macos");
  assert.equal(byName.box!.appliedAgo, 3600);
  assert.deepEqual(byName.server!.agents, ["claude"]);
  assert.equal(byName.laptop!.seen, true, "this host is read live");
  assert.equal(byName.laptop!.os === "linux" || byName.laptop!.os === "macos", true);
  assert.equal(data.agents >= 2, true);

  const blind = world({ commits: 30, seen: false });
  const d = readCard(blind.config, blind.home, blind.now);
  assert.deepEqual(d.hosts.filter((h) => !h.seen).map((h) => h.name), ["box", "server"]);
  const text = previewText(d, false, false);
  assert.match(text, /host 1, host 3 were never seen by the bridge/);
  assert.match(text, /\(not seen yet\)/);
  assert.equal(text.includes("box"), false);
  assert.match(renderCard(d, "map", false), /not seen yet/);
});

test("the pushes are the push journal's, and a full journal says at least", () => {
  const w = world({ commits: 30 });
  const write = (n: number, commit: string | null) => {
    mkdirSync(journalDir(w.home), { recursive: true });
    const name = `20261101T10${String(n).padStart(2, "0")}00.000Z-${n}.jsonl`;
    writeFileSync(join(journalDir(w.home), name), `${JSON.stringify({ journal: 1, v: 1, time: "2026-11-01T10:00:00.000Z", commit, only: null, hosts: ["laptop"], ms: 100, interrupted: false, result: "ok", end: null })}\n`);
  };
  for (let i = 0; i < 3; i++) write(i + 1, "a".repeat(40));
  let data = readCard(w.config, w.home, w.now);
  assert.deepEqual(data.pushes, { count: 3, atLeast: false });
  assert.match(renderCard(data, "machines", false), /3 pushes<\/tspan>/);
  for (let i = 3; i < 20; i++) write(i + 1, "a".repeat(40));
  data = readCard(w.config, w.home, w.now);
  assert.deepEqual(data.pushes, { count: 20, atLeast: true });
  assert.match(previewText(data, false, false), /20\+ pushes since/);
  assert.match(renderCard(data, "machines", false), /20\+ pushes<\/tspan>/);
});

test("the first month comes from the config repo's first commit", () => {
  const w = world({ commits: 30 });
  const data = readCard(w.config, w.home, w.now);
  const oldest = new Date(w.now.getTime() - 300 * DAY);
  const month = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][oldest.getMonth()];
  assert.equal(data.since, `${month} ${oldest.getFullYear()}`);
});

test("the terminal preview reads like the mockup, and colours only when asked", () => {
  const w = world({ commits: 30 });
  const data = readCard(w.config, w.home, w.now);
  const plain = previewText(data, false, false);
  assert.match(plain, /^ {2}● fleet {3}3 machines · \d agents · \d+ skills · \d+ MCP servers\n\n {2}host 1 {2}claude agy {2,}macos\n/);
  assert.match(plain, /\n {2}host 3 /);
  assert.match(plain, /\n {2}activity, 12 months {2}[▁-█]+\n/);
  assert.match(plain, /30 changes this year · 0 pushes since \w+ \d{4} · hostnames hidden$/);
  assert.doesNotMatch(plain, /\u001b/);
  assert.match(previewText(data, false, true), /\u001b\[32m●\u001b\[0m/);
  const named = previewText(data, true, false);
  assert.match(named, /\n {2}box\s+claude agy/);
  assert.match(named, /hostnames shown$/);
});

test("fleet card writes fleet-card.svg and prints the preview, then the file", () => {
  const w = world({ commits: 30 });
  const out = tempDir("fleet-card-out-");
  const r = card(w.config, { dir: out, style: undefined, names: false, badge: false, color: false, home: w.home, now: w.now });
  assert.equal(r.code, "ok");
  assert.match(r.text!, /\n\nwrote fleet-card\.svg \(1200 x 630\)$/);
  const svg = readFileSync(join(out, "fleet-card.svg"), "utf8");
  assert.match(svg, /^<svg /);
  assert.equal(svg, renderCard(readCard(w.config, w.home, w.now), "machines", false));
  assert.equal(r.fields!.file, "fleet-card.svg");
  assert.equal(r.fields!.grid, true);

  const map = card(w.config, { dir: out, style: "map", names: true, badge: false, color: false, home: w.home, now: w.now });
  assert.equal(map.code, "ok");
  assert.match(readFileSync(join(out, "fleet-card.svg"), "utf8"), /one private repo/);
  assert.match(map.text!, /hostnames shown/);

  const badge = card(w.config, { dir: out, style: undefined, names: false, badge: true, color: false, home: w.home, now: w.now });
  assert.match(badge.text!, /wrote fleet-badge\.svg \(\d+ x 20\)$/);
  assert.match(readFileSync(join(out, "fleet-badge.svg"), "utf8"), /3 machines/);
});

test("fleet card refuses what it does not know, and writes nothing", () => {
  const w = world({ commits: 30 });
  const out = tempDir("fleet-card-out-");
  const base = { dir: out, names: false, badge: false, color: false, home: w.home, now: w.now };
  const bad = card(w.config, { ...base, style: "pie" });
  assert.equal(bad.code, "invalid");
  assert.match(bad.messages![0]!, /--style is machines or map/);
  assert.equal(card(w.config, { ...base, style: "map", badge: true }).code, "invalid");
  assert.equal(card(w.config, { ...base, style: undefined, names: true, badge: true }).code, "invalid");
  assert.equal(card(w.config, { ...base, dir: join(out, "missing"), style: undefined }).code, "error");
  assert.throws(() => readFileSync(join(out, "fleet-card.svg")));
});

test("the command line: fleet card, its options, and --json", () => {
  const w = world({ commits: 30 });
  const out = tempDir("fleet-card-run-");
  const env = { FLEET_CONFIG: w.config };
  const run = (...args: string[]) => {
    const r = spawnSync(join(repoRoot, "bin/fleet"), args, { cwd: out, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: w.home, FLEET_NODE: process.env.FLEET_NODE_PATH ?? process.execPath, ...gitEnv, ...env } });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const plain = run("card");
  assert.equal(plain.code, 0, plain.stderr);
  assert.match(plain.stdout, /wrote fleet-card\.svg \(1200 x 630\)/);
  assert.match(readFileSync(join(out, "fleet-card.svg"), "utf8"), /host 1/);

  const json = JSON.parse(run("card", "--style", "map", "--json").stdout);
  assert.equal(json.ok, true);
  assert.equal(json.style, "map");
  assert.equal(json.machines, 3);
  assert.equal(json.changes, 30);
  assert.equal(JSON.stringify(json).includes("box"), false, "no hostname in the document either");

  assert.equal(run("card", "--style", "pie").code, 2);
  assert.equal(run("status", "--names").code, 2);
  assert.match(run("status", "--badge").stderr, /only for 'card'/);
  assert.match(run("help").stdout, /card\s+Write fleet-card\.svg/);
  const agent = run("agent").stdout;
  assert.equal(agent.includes("fleet card"), false, "agents are not taught a command made to be shared by a person");
  void runBin;
});

test("status says which OS a host runs, and a document with a wrong one is read as unknown", () => {
  const w = world({ commits: 1 });
  const here = status(repoRoot, w.config, false, w.home);
  assert.ok(["linux", "macos"].includes(here.fields!.os as string));
  const doc = JSON.parse(JSON.stringify(fixtureStatus({ os: "macos" })));
  assert.equal(statusFromDocument(doc)!.os, "macos");
  assert.equal(statusFromDocument({ ...doc, os: "plan9\u001b[31m" })!.os, null);
  const { os: _os, ...older } = doc;
  assert.equal(statusFromDocument(older)!.os, null, "a host on an older fleet sends none");
});
