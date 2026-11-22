import { readFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { status } from "../src/status.ts";
import { git, makeSource, publish, runFleet, tempDir } from "./helpers.ts";
import { diff } from "../src/apply.ts";
import { InvalidConfigError, loadConfig } from "../src/config.ts";
import { statusFromDocument } from "../src/status.ts";
import { everything, HEADER_TOKEN, OTHER, repoText, terminal, TOKEN, world } from "./captureworld.ts";
import type { W } from "./captureworld.ts";

const changes = (w: W) => {
  const out = diff(w.clone, false, w.home);
  // An agent this machine happens to have besides the two the tests set up is none of what is being looked at.
  return (out.text ?? "").split("\n").filter((l) => !l.includes(".gemini") && !l.includes("timer")).join("\n");
};

test("a server with a token in its env and in a header becomes secret:NAME; the value is in sops and in no output", async () => {
  const w = world();
  w.claude({
    linear: { type: "http", url: "https://linear.example.com/mcp", headers: { Authorization: HEADER_TOKEN } },
    scraper: { type: "stdio", command: "npx", args: ["-y", "scraper-mcp@1.2.0"], env: { SCRAPER_API_KEY: TOKEN, REGION: "eu" } },
  });
  const seen: string[] = [];

  // Reported first, with no value anywhere in it.
  const found = await w.run([]);
  seen.push(everything(found));
  const items = (found.fields as any).items;
  assert.deepEqual(items.map((i: any) => [i.kind, i.name, i.state]), [["mcp", "linear", "new"], ["mcp", "scraper", "new"]]);
  assert.deepEqual(items[0].variants[0].keys, [{ where: "headers", key: "Authorization", secret: true, name: "LINEAR_AUTHORIZATION" }]);
  assert.deepEqual(items[1].variants[0].keys.map((k: any) => [k.key, k.secret, k.name]), [["SCRAPER_API_KEY", true, "SCRAPER_API_KEY"], ["REGION", false, "SCRAPER_REGION"]]);
  assert.equal(git(w.clone, "status", "--porcelain"), "", "reporting writes nothing");

  // The header's name looks like a secret, so it is one without asking. The env's other key is asked about.
  const t = terminal(["h", "", "n", "h", "", "p", "n"]);
  const done = await w.run([], { terminal: t.io });
  seen.push(everything(done), t.out.join(""));
  assert.equal(done.code, "ok", JSON.stringify(done));
  assert.deepEqual((done.fields as any).captured.map((c: any) => [c.kind, c.name, c.action]), [["mcp", "linear", "add"], ["mcp", "scraper", "add"]]);

  const catalog = w.read("catalog/mcp.yaml");
  assert.match(catalog, /Authorization: secret:LINEAR_AUTHORIZATION/);
  assert.match(catalog, /SCRAPER_API_KEY: secret:SCRAPER_API_KEY/);
  assert.match(catalog, /REGION: eu/);
  assert.equal(w.decrypt("laptop", "LINEAR_AUTHORIZATION")?.trim(), HEADER_TOKEN, "the value is in sops");
  assert.equal(w.decrypt("laptop", "SCRAPER_API_KEY")?.trim(), TOKEN);
  const text = repoText(w.clone);
  for (const value of [TOKEN, HEADER_TOKEN]) {
    assert.ok(!text.includes(value), "no value in the catalog, a host file or the history");
    for (const s of seen) assert.ok(!s.includes(value), "no value in any output");
  }
  assert.match(w.read("hosts/laptop.yaml"), /include:[\s\S]*linear/);
  assert.equal(git(w.clone, "status", "--porcelain"), "", "committed");
  // Both agents get it from the one entry; fleet owns what is here, so apply has nothing to do.
  assert.ok(!/created|updated|removed/.test(changes(w).replace(/^.*nothing.*$/gim, "")), changes(w));
});

test("a secret value never reaches the status, an error or --json, even when capture fails", async () => {
  const w = world({ host: () => "admin: true\n" });
  w.claude({ linear: { type: "http", url: "https://linear.example.com/mcp", headers: { Authorization: HEADER_TOKEN } } });
  // This host has no age recipient, so the value cannot be kept: capture refuses, and says so without the value.
  const r = await w.run(["mcp", "linear"], { host: true });
  assert.notEqual(r.code, "ok");
  assert.ok(!everything(r).includes(TOKEN));
  assert.equal(git(w.clone, "status", "--porcelain"), "", "nothing was written");
  assert.ok(!JSON.stringify(status(w.clone, w.clone, false, w.home)).includes(TOKEN));
});

test("an env value that does not look like a secret becomes one when the person says so", async () => {
  const w = world();
  w.claude({ scraper: { type: "stdio", command: "npx", args: ["-y", "scraper-mcp@1.2.0"], env: { REGION: OTHER } } });
  const t = terminal(["h", "s", "", "n", "n"]);
  const r = await w.run([], { terminal: t.io });
  assert.equal(r.code, "ok", JSON.stringify(r));
  assert.match(w.read("catalog/mcp.yaml"), /REGION: secret:SCRAPER_REGION/);
  assert.equal(w.decrypt("laptop", "SCRAPER_REGION")?.trim(), OTHER);
  assert.ok(!repoText(w.clone).includes(OTHER));
  assert.ok(!t.out.join("").includes(OTHER), "the prompt names the key and never shows the value");
});

test("every host: the secret goes to the shared secrets file and the pick to the defaults", async () => {
  const w = world();
  w.claude({ linear: { type: "http", url: "https://linear.example.com/mcp", headers: { Authorization: HEADER_TOKEN } } });
  const r = await w.run(["mcp", "linear"], { all: true });
  assert.equal(r.code, "ok", JSON.stringify(r));
  assert.equal(w.decrypt("shared", "LINEAR_AUTHORIZATION")?.trim(), HEADER_TOKEN);
  assert.match(w.read("hosts/_defaults.yaml"), /linear/);
  assert.ok(!/include/.test(w.read("hosts/laptop.yaml")));
});

test("a server the agents have in two forms is one item, shown side by side, and the person picks one", async () => {
  const w = world();
  w.claude({ docs: { type: "http", url: "https://a.example.com/mcp" } });
  w.opencode({ docs: { type: "remote", url: "https://b.example.com/mcp" } });
  const found = await w.run([]);
  const items = (found.fields as any).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].variants.length, 2);
  assert.deepEqual(items[0].variants.map((v: any) => v.agents), [["claude"], ["opencode"]]);

  const t = terminal(["h", "2", "n"]);
  const r = await w.run([], { terminal: t.io });
  assert.equal(r.code, "ok", JSON.stringify(r));
  const shown = t.out.join("");
  assert.match(shown, /\[1\] claude\s+\[2\] opencode/);
  assert.match(shown, /https:\/\/a\.example\.com\/mcp/);
  assert.match(shown, /https:\/\/b\.example\.com\/mcp/);
  assert.match(w.read("catalog/mcp.yaml"), /url: https:\/\/b\.example\.com\/mcp/);
  // The other agent has the catalog's version at the next apply, and capture says so.
  assert.deepEqual((r.fields as any).rewrites, ["~/.claude.json mcpServers.docs"]);
  assert.match((r.messages ?? []).join("\n"), /next apply will rewrite it/);
  assert.deepEqual((r.fields as any).takenOver, ["mcp:docs"]);
  assert.match(changes(w), /docs/);
});

test("only the agents that had it: capture sets only: itself for an agent that cannot work, and the person can narrow it", async () => {
  const w = world();
  w.claude({ live: { type: "sse", url: "https://live.example.com/sse" }, mine: { type: "http", url: "https://mine.example.com/mcp" } });
  const t = terminal(["h", "y", "h", "y"]);
  const r = await w.run([], { terminal: t.io });
  assert.equal(r.code, "ok", JSON.stringify(r));
  const catalog = w.read("catalog/mcp.yaml");
  // opencode takes an sse server; Antigravity CLI does not. Only the agents that had it was answered yes for both.
  assert.match(catalog, /live:[\s\S]*only: \[claude\]/);
  assert.match(catalog, /mine:[\s\S]*only: \[claude\]/);

  const w2 = world();
  w2.claude({ live: { type: "sse", url: "https://live.example.com/sse" } });
  const t2 = terminal(["h", "n"]);
  const r2 = await w2.run([], { terminal: t2.io });
  assert.equal(r2.code, "ok", JSON.stringify(r2));
  const only = /live:[\s\S]*?only: \[([^\]]*)\]/.exec(w2.read("catalog/mcp.yaml"));
  assert.ok(only === null || !only[1]!.includes("antigravity"), "an agent that cannot work with an sse server is never in only");
});

test("a hand-added copy of a catalog entry is offered to take over, and taking it over leaves nothing for apply", async () => {
  const w = world();
  w.claude({ metrics: { type: "stdio", command: "mcp-metrics", args: [], env: {} } });
  w.opencode({ metrics: { type: "local", command: ["mcp-metrics"] } });
  const found = await w.run([]);
  assert.deepEqual((found.fields as any).items.map((i: any) => [i.name, i.state]), [["metrics", "catalog"]]);

  const t = terminal(["h"]);
  const r = await w.run([], { terminal: t.io });
  assert.equal(r.code, "ok", JSON.stringify(r));
  assert.deepEqual((r.fields as any).takenOver, ["mcp:metrics"]);
  assert.match(w.read("hosts/laptop.yaml"), /metrics/);
  assert.equal(changes(w).includes("metrics"), false, changes(w));
  const after = await w.run([]);
  assert.deepEqual((after.fields as any).items, [], "from config now");
});

test("an entry a host already picks that equals the config is taken over without a commit", async () => {
  const w = world({ host: (id) => `admin: true\nage: ${id.recipient}\nmcp:\n  include: [stats]\n` });
  w.claude({ stats: { type: "http", url: "https://stats.example.com/mcp" } });
  w.opencode({ stats: { type: "remote", url: "https://stats.example.com/mcp" } });
  const found = await w.run([]);
  assert.deepEqual((found.fields as any).items.map((i: any) => [i.name, i.state]), [["stats", "takeover"]]);
  const before = git(w.clone, "rev-parse", "HEAD");
  const r = await w.run(["mcp", "stats"], { host: true });
  assert.equal(r.code, "ok", JSON.stringify(r));
  assert.equal(git(w.clone, "rev-parse", "HEAD"), before, "nothing to commit");
  assert.deepEqual((r.fields as any).takenOver, ["mcp:stats"]);
  assert.equal(changes(w).includes("stats"), false, changes(w));
});

test("a same-name entry with another definition is a conflict: not offered, and counted in one line", async () => {
  const w = world();
  w.claude({ metrics: { type: "stdio", command: "something-else" }, other: { type: "http", url: "https://o.example.com/mcp" } });
  const found = await w.run([]);
  assert.deepEqual((found.fields as any).items.map((i: any) => i.name), ["other"]);
  assert.deepEqual((found.fields as any).differs, [{ kind: "mcp", name: "metrics" }]);
  assert.match(found.text ?? "", /1 differs from the catalog: see fleet status --conflicts/);
  const r = await w.run(["mcp", "metrics"], { host: true });
  assert.equal(r.code, "invalid");
  assert.match((r.messages ?? []).join(""), /conflict/);
});

function skillRepo(w: W, name = "review") {
  const src = makeSource({ [`skills/${name}/SKILL.md`]: `---\nname: ${name}\ndescription: Looks at a diff.\n---\nBody.\n` });
  const mine = join(tempDir("fleet-mine-"), "box");
  git(dirname(mine), "clone", "--quiet", src.remote, mine);
  mkdirSync(join(w.home, ".claude/skills"), { recursive: true });
  symlinkSync(join(mine, "skills", name), join(w.home, ".claude/skills", name));
  return { src, mine };
}

test("a skill in a git repo with a remote becomes a pinned source with review, and a bundle", async () => {
  const w = world();
  const { src } = skillRepo(w);
  const found = await w.run([]);
  const item = (found.fields as any).items.find((i: any) => i.kind === "skill");
  assert.equal(item.state, "new");
  assert.equal(item.repo.repo, src.remote);
  assert.equal(item.repo.path, "skills");
  assert.equal(item.repo.commit, src.first);

  const t = terminal(["h", ""]);
  const r = await w.run([], { terminal: t.io });
  assert.equal(r.code, "ok", JSON.stringify(r));
  const catalog = w.read("catalog/skills.yaml");
  assert.match(catalog, new RegExp(`repo: ${src.remote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(catalog, /path: skills/);
  assert.match(catalog, new RegExp(`commit: ${src.first}`));
  assert.match(catalog, /review: true/);
  assert.match(catalog, /bundles:\n\s+remote: \[review\]/);
  assert.match(w.read("hosts/laptop.yaml"), /bundles:/);
  // The link is the person's own, not fleet's clone: capture does not remove it, and says what to do.
  assert.match((r.messages ?? []).join("\n"), /is a symlink to .*, not to .*Delete the link/);
});

test("a skill in a repo that is already a source only gets a bundle", async () => {
  const w = world();
  const { src } = skillRepo(w);
  w.write("catalog/skills.yaml", `sources:\n  box:\n    repo: ${src.remote}\n    path: skills\n    commit: ${src.first}\n    track: main\nbundles: {}\n`);
  publish(w.clone, "source");
  const r = await w.run(["skill", "review"], { host: true });
  assert.equal(r.code, "ok", JSON.stringify(r));
  const catalog = w.read("catalog/skills.yaml");
  assert.equal((catalog.match(/repo:/g) ?? []).length, 1, "the source is not added twice");
  assert.match(catalog, /box:/);
  assert.match(catalog, /bundles:[\s\S]*box: \[review\]/);
});

test("a loose skill folder with no repo is listed and cannot be captured, only ignored", async () => {
  const w = world();
  mkdirSync(join(w.home, ".claude/skills/loose"), { recursive: true });
  writeFileSync(join(w.home, ".claude/skills/loose/SKILL.md"), "---\nname: loose\ndescription: x\n---\n");
  const found = await w.run([]);
  const item = (found.fields as any).items.find((i: any) => i.name === "loose");
  assert.equal(item.state, "blocked");
  assert.match(item.message, /put it in a repo/);
  const r = await w.run(["skill", "loose"], { host: true });
  assert.equal(r.code, "invalid");
  assert.equal(git(w.clone, "status", "--porcelain"), "");
  // --yes leaves it alone and says so.
  const all = await w.run([], { yes: true });
  assert.match((all.messages ?? []).join("\n"), /left skill:loose/);
});

test("unmanaged hides an item, and the host file keeps the list", async () => {
  const w = world();
  w.claude({ mine: { type: "http", url: "https://mine.example.com/mcp" }, other: { type: "http", url: "https://o.example.com/mcp" } });
  assert.equal(((await w.run([])).fields as any).items.length, 2);
  const r = await w.run(["mcp", "mine"], { ignore: true });
  assert.equal(r.code, "ok", JSON.stringify(r));
  assert.match(w.read("hosts/laptop.yaml"), /unmanaged: \[mcp:mine\]/);
  const after = await w.run([]);
  assert.deepEqual((after.fields as any).items.map((i: any) => i.name), ["other"]);
  // Nothing was removed from the machine.
  assert.ok(readFileSync(join(w.home, ".claude.json"), "utf8").includes("mine.example.com"));
  // Not counted either.
  const s = status(w.clone, w.clone, false, w.home);
  assert.equal((s.fields as any).unmanaged, 1);
});

test("without a terminal capture only reports, and --yes applies the defaults", async () => {
  const w = world();
  w.claude({ linear: { type: "http", url: "https://linear.example.com/mcp", headers: { Authorization: HEADER_TOKEN } }, plain: { type: "http", url: "https://plain.example.com/mcp" } });
  const head = git(w.clone, "rev-parse", "HEAD");
  const only = await w.run([]);
  assert.equal(only.code, "ok");
  assert.match(only.text ?? "", /mcp\s+linear/);
  assert.equal(git(w.clone, "rev-parse", "HEAD"), head);
  assert.ok(!everything(only).includes(TOKEN));

  const done = await w.run([], { yes: true });
  assert.equal(done.code, "ok", JSON.stringify(done));
  assert.deepEqual((done.fields as any).captured.map((c: any) => c.name), ["linear", "plain"]);
  assert.equal(w.decrypt("laptop", "LINEAR_AUTHORIZATION")?.trim(), HEADER_TOKEN);
  assert.ok(!repoText(w.clone).includes(TOKEN));
  assert.ok(!everything(done).includes(TOKEN));
  assert.equal((done.fields as any).pushed, false);
});

test("a credential in a command line or in a URL is not copied: the item is blocked", async () => {
  const w = world();
  w.claude({
    cli: { type: "stdio", command: "tool", args: ["--token", TOKEN] },
    url: { type: "http", url: `https://user:${TOKEN}@example.com/mcp` },
    query: { type: "http", url: `https://example.com/mcp?api_key=${TOKEN}` },
  });
  const found = await w.run([]);
  const items = (found.fields as any).items;
  assert.deepEqual(items.map((i: any) => i.state), ["blocked", "blocked", "blocked"]);
  assert.ok(!everything(found).includes(TOKEN), "a blocked item shows none of its definition");
  const r = await w.run([], { yes: true });
  assert.equal(git(w.clone, "status", "--porcelain"), "");
  assert.ok(!everything(r).includes(TOKEN));
});

test("capture refuses when the config repo has changes of its own", async () => {
  const w = world();
  w.claude({ mine: { type: "http", url: "https://mine.example.com/mcp" } });
  writeFileSync(join(w.clone, "catalog/notes.txt"), "mine\n");
  const r = await w.run(["mcp", "mine"], { host: true });
  assert.equal(r.code, "invalid");
  assert.match((r.messages ?? []).join(""), /changes of its own/);
});

test("the command line: flags need an item, one choice at a time, and --host here takes no name", () => {
  const w = world();
  const run = (...args: string[]) => runFleet(w.clone, args, { home: w.home });
  assert.match(run("capture", "mcp", "x").stderr, /say what to do with x/);
  assert.match(run("capture", "mcp", "x", "--host", "--all").stderr, /choose one of/);
  assert.match(run("capture", "--host").stderr, /name it/);
  assert.match(run("apply", "--ignore").stderr, /only for 'capture'/);
  assert.match(run("push", "--host").stderr, /argument missing|requires|value/i);
  const json = run("capture", "--json");
  assert.equal(JSON.parse(json.stdout).items.length, 0);
});

test("fleet capture --json reports on stdout, and a captured value is in no stream", () => {
  const w = world();
  w.claude({ linear: { type: "http", url: "https://linear.example.com/mcp", headers: { Authorization: HEADER_TOKEN } } });
  const report = runFleet(w.clone, ["capture", "--json"], { home: w.home });
  assert.equal(report.code, 0, report.stderr);
  assert.ok(!(report.stdout + report.stderr).includes(TOKEN));
  const doc = JSON.parse(report.stdout);
  assert.equal(doc.items[0].name, "linear");
  assert.equal(git(w.clone, "status", "--porcelain"), "", "--json writes nothing");
  const done = runFleet(w.clone, ["capture", "mcp", "linear", "--host", "--no-push", "--json"], { home: w.home });
  assert.equal(done.code, 0, done.stderr);
  assert.ok(!(done.stdout + done.stderr).includes(TOKEN));
  assert.equal(JSON.parse(done.stdout).pushed, false);
  assert.ok(!repoText(w.clone).includes(TOKEN));
  const text = runFleet(w.clone, ["status"], { home: w.home });
  assert.ok(!(text.stdout + text.stderr).includes(TOKEN));
});

test("push now: yes pushes the commit to the remote, no leaves it committed", async () => {
  const w = world();
  w.claude({ mine: { type: "http", url: "https://mine.example.com/mcp" } });
  const t = terminal(["h", "n", "n"]);
  const r = await w.run([], { terminal: t.io, noPush: false });
  assert.equal((r.fields as any).pushed, false);
  assert.match(t.out.join(""), /Push now\? \[y\/N\]/);
  assert.match((r.messages ?? []).join("\n"), /not pushed/);
  assert.notEqual(git(w.clone, "rev-parse", "HEAD"), git(w.clone, "rev-parse", "origin/main"));
});

test("the loader takes unmanaged in a host file only, as a list of mcp:<name> and skill:<name>", () => {
  const w = world();
  const load = () => loadConfig(w.clone, "laptop", { home: w.home, sources: "none" });
  w.write("hosts/laptop.yaml", "unmanaged: [mcp:one, skill:two]\n");
  assert.deepEqual(load().unmanaged, ["mcp:one", "skill:two"]);
  for (const bad of ["unmanaged: one\n", "unmanaged: [one]\n", "unmanaged: [tool:one]\n", "unmanaged: [mcp:]\n", "unmanaged: [1]\n"]) {
    w.write("hosts/laptop.yaml", bad);
    assert.throws(load, (e: unknown) => e instanceof InvalidConfigError && /'unmanaged' must be a list of 'mcp:<name>' and 'skill:<name>'/.test(e.problems.join("\n")), bad);
  }
  w.write("hosts/laptop.yaml", "{}\n");
  w.write("hosts/_defaults.yaml", "unmanaged: [mcp:one]\n");
  assert.throws(load, (e: unknown) => e instanceof InvalidConfigError && /unknown key 'unmanaged'/.test(e.problems.join("\n")), "the defaults cannot ignore for every host");
});

test("status reports how many items are not from config, in the document and in one line, and reads the field of another host", () => {
  const w = world();
  w.claude({ a: { type: "http", url: "https://a.example.com/mcp" }, b: { type: "http", url: "https://b.example.com/mcp" } });
  const s = status(w.clone, w.clone, false, w.home);
  assert.equal((s.fields as any).unmanaged, 2);
  assert.match(s.text ?? "", /not from config: 2 \(fleet capture lists them\)/);
  const none = world();
  assert.equal((status(none.clone, none.clone, false, none.home).fields as any).unmanaged, 0);
  assert.doesNotMatch(status(none.clone, none.clone, false, none.home).text ?? "", /not from config/);
  const doc = { repos: { fleet: { branch: "main", sha: "abc", clean: true, ahead: 0, behind: 0 } }, unmanaged: 4 };
  assert.equal(statusFromDocument(doc as any)!.unmanaged, 4);
  assert.equal(statusFromDocument({ ...doc, unmanaged: "4" } as any)!.unmanaged, null, "an older fleet, or a wrong value, is unknown");
  assert.equal(statusFromDocument({ repos: doc.repos } as any)!.unmanaged, null);
});
