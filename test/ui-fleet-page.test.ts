import { test } from "node:test";
import assert from "node:assert/strict";
import { answeredWords, cardOf, contextOf, hasFix, legendOf, partTexts, seenWords, summaryOf, withFleetDoc } from "../src/ui/static/fleet.js";
import { jobLabel, jobsOf } from "../src/ui/static/jobs.js";
import { ROUTES, routeOf } from "../src/ui/static/state.js";

const status = (over: Record<string, unknown> = {}) => ({
  repos: { fleet: { branch: "main", sha: "3f9a1c2d4e5f", clean: true, ahead: 0, behind: 0 } },
  applied: { at: "2026-10-30T10:00:00Z", ageSeconds: 720, config: null },
  timer: "active",
  pending: 0,
  conflicts: 0,
  conflictList: null,
  agents: [{ id: "claude", version: "2.1.4", active: true, pinned: false }, { id: "opencode", version: null, active: false, pinned: false }],
  notInstalled: [],
  tools: {},
  ...over,
});
const host = (over: Record<string, unknown> = {}) => ({ name: "server", self: false, ssh: "me@server", asked: "done", result: "ok", detail: null, live: true, seenSeconds: null, answeredSeconds: 3, status: status(), context: null, contextResult: null, contextDetail: null, conflicts: null, ...over });

const part = (tokens: number, count = 1, unmeasured = 0) => ({ tokens, count, unmeasured });
const agent = (name: string, instructions: number, skills: number, mcp: number, complete = true) => ({ agent: name, tokens: instructions + skills + mcp, complete, instructions: part(instructions), skills: part(skills), mcp: part(mcp, 1, complete ? 0 : 1), items: [] });
const withContext = (name: string, agents: any[], live = true) => host({ name, context: { report: { agents, notes: [] }, live, seenSeconds: live ? null : 7200 } });

test("the Fleet screen is the first screen, so the page opens on it", () => {
  assert.equal(ROUTES[0], "fleet");
  assert.equal(routeOf(""), "fleet");
  assert.equal(routeOf("#/fleet"), "fleet");
  assert.equal(routeOf("#/matrix"), "matrix");
});

test("a card: a host that is fine says ok, how it is reached, when it last applied, its timer and its agents", () => {
  const c = cardOf(host());
  assert.deepEqual([c.health, c.headline, c.via, c.notLive], ["ok", "ok", "me@server", null]);
  assert.deepEqual(c.rows.map((r) => [r.label, r.value]), [["last applied", "12 min ago"], ["timer", "active"], ["pending", "0"], ["clone", "main@3f9a1c2"]]);
  assert.deepEqual(c.agents, [{ id: "claude", version: "2.1.4" }], "only the agents this host gets");
  assert.equal(cardOf(host({ self: true, ssh: null })).via, "this host");
});

test("a card: a host with conflicts names the first, and its fix can be opened once the server read them", () => {
  const list = [{ kind: "link", path: "~/.claude/rules/host.md" }, { kind: "key", path: "~/.claude.json" }];
  const items = [{ kind: "link", path: "~/.claude/rules/host.md", detail: "a hand-made file is in the way", fix: "rm ~/.claude/rules/host.md" }];
  const c = cardOf(host({ status: status({ conflicts: 2, conflictList: list }), conflicts: { ok: true, items } }));
  assert.deepEqual([c.health, c.headline, c.conflicts.first, c.conflicts.count], ["conflicts", "2 conflicts", "link ~/.claude/rules/host.md", 2]);
  assert.equal(hasFix(c), true);
  assert.equal(c.conflicts.items![0]!.fix, "rm ~/.claude/rules/host.md");
  assert.equal(cardOf(host({ status: status({ conflicts: 1 }) })).headline, "1 conflict");
  const old = cardOf(host({ status: status({ conflicts: 1 }), conflicts: { ok: false, reason: "old", detail: "detail needs a newer pin" } }));
  assert.deepEqual([hasFix(old), old.conflicts.note], [false, "its detail needs a newer pin"]);
  const fail = cardOf(host({ status: status({ conflicts: 1 }), conflicts: { ok: false, reason: "error", detail: "fleet: no ssh" } }));
  assert.equal(fail.conflicts.note, "the detail could not be read: no ssh");
});

test("a card: an unreachable host says when it was last seen, and keeps what it said then", () => {
  const c = cardOf(host({ result: "unreachable", detail: "ssh: connect to host box port 22: Connection timed out", live: false, seenSeconds: 7200 + 100, answeredSeconds: null, status: status({ pending: 4 }) }));
  assert.deepEqual([c.health, c.headline, c.notLive], ["unreachable", "unreachable over ssh", "last seen 2 h ago, not live"]);
  assert.match(c.detail!, /Connection timed out/);
  assert.equal(c.rows.find((r) => r.label === "pending")!.value, "4", "the last seen state is still shown");
  const never = cardOf(host({ result: "unreachable", live: false, seenSeconds: null, status: null }));
  assert.deepEqual([never.notLive, never.rows], ["never seen", []]);
});

test("a card: what was remembered and not asked yet is marked not live; a host being asked says so", () => {
  const seen = cardOf(host({ asked: "never", result: null, live: false, seenSeconds: 180, answeredSeconds: null }));
  assert.deepEqual([seen.health, seen.headline, seen.notLive], ["ok", "ok", "seen 3 min ago, not live"]);
  assert.equal(seenWords(30), "seen just now, not live");
  assert.equal(cardOf(host({ asked: "never", result: null, live: false, status: null })).headline, "not asked yet");
  const asking = cardOf(host({ asked: "asking", result: null, live: false, seenSeconds: 7200 }));
  assert.deepEqual([asking.health, asking.headline, asking.notLive], ["asking", "asking over ssh", "seen 2 h ago, not live, asking again"]);
  assert.equal(cardOf(host({ self: true, asked: "asking", result: null, live: false, status: null })).headline, "reading local state");
});

test("a card: a timer host has no status to show, and says why; a host with no usable answer says what it said", () => {
  const t = cardOf(host({ name: "edge", ssh: null, result: "timer", live: false, status: null }));
  assert.deepEqual([t.health, t.via, t.rows], ["timer", "timer", []]);
  assert.match(t.detail!, /applies on its own schedule/);
  const e = cardOf(host({ result: "error", detail: "its output was not a fleet status document (exit 1)", live: false, status: null }));
  assert.deepEqual([e.health, e.headline], ["error", "no usable answer"]);
});

test("a card: an older host that sends no agent list shows the agents its tools name, as the bridge does; one not installed is named", () => {
  const c = cardOf(host({ status: status({ agents: null, tools: { claude: "2.1.4", opencode: null, sops: "3.13.3", node: "22.0.0", t3: null } }) }));
  assert.deepEqual(c.agents, [{ id: "claude", version: "2.1.4" }, { id: "opencode", version: null }]);
  assert.deepEqual(cardOf(host({ status: status({ notInstalled: ["opencode"] }) })).missing, ["opencode"]);
});

test("the summary counts only what a live answer said, and says how many are old, unreachable or on a timer", () => {
  const doc = {
    hosts: [
      host({ name: "a", status: status({ pending: 2, conflicts: 1 }) }),
      host({ name: "b", live: false, result: null, asked: "never", status: status({ pending: 9, conflicts: 9 }), seenSeconds: 60 }),
      host({ name: "c", result: "unreachable", live: false, status: null }),
      host({ name: "d", result: "timer", live: false, status: null }),
      host({ name: "e", asked: "asking", result: null, live: false, status: null }),
    ],
  };
  assert.deepEqual(summaryOf(doc).map((p) => p.text), ["5 hosts", "asking 1", "1 seen earlier, not live", "1 unreachable", "1 on a timer, status unknown", "pending 2", "conflicts 1"]);
});

test("the summary adds up nothing when no host has answered, rather than a zero that reads as none", () => {
  const doc = { hosts: [host({ live: false, result: null, asked: "never", seenSeconds: 60 })] };
  assert.deepEqual(summaryOf(doc).map((p) => p.text), ["1 host", "1 seen earlier, not live"]);
});

test("startup context: every agent's bar is on one scale, the heaviest being full", () => {
  const doc = { hosts: [withContext("laptop", [agent("claude", 1000, 3000, 6000), agent("opencode", 500, 500, 0)]), withContext("server", [agent("claude", 1000, 1000, 0)])] };
  const c = contextOf(doc);
  assert.deepEqual(c.biggest, { host: "laptop", agent: "claude", tokens: 10000 });
  assert.equal(c.scale, 10000);
  const [laptop, server] = c.hosts;
  assert.deepEqual(laptop!.agents[0]!.widths, { instructions: 10, skills: 30, mcp: 60 });
  assert.equal(laptop!.agents[0]!.fill, 100);
  assert.equal(laptop!.agents[1]!.fill, 10);
  assert.equal(server!.agents[0]!.fill, 20, "a light host is a short bar beside the heavy one, not a full one of its own");
  assert.equal(laptop!.agents[0]!.total, "~10.0k");
  assert.equal(legendOf(c), "All bars share one scale: a full bar is ~10.0k, claude on laptop.");
});

test("startup context: a server nobody measured makes the total a lower bound with a +, never zero", () => {
  const doc = { hosts: [withContext("laptop", [agent("claude", 1000, 500, 0, false)])] };
  const a = contextOf(doc).hosts[0]!.agents[0]!;
  assert.deepEqual([a.total, a.lower], ["~1.5k+", true]);
  assert.equal(a.texts.mcp, "not measured (1)", "and the part says it was not measured, not that it was none");
  assert.equal(partTexts({ instructions: part(0, 0), skills: part(0, 0), mcp: part(0, 0) } as any).mcp, "none");
  assert.equal(partTexts(agent("x", 0, 0, 4000, true) as any).mcp, "up to ~4.0k (1)");
});

test("startup context: a remembered one is marked, and a host with none says why", () => {
  const doc = {
    hosts: [
      withContext("server", [agent("claude", 100, 0, 0)], false),
      host({ name: "box", result: "ok", contextResult: "old" }),
      host({ name: "edge", ssh: null, result: "timer", live: false, status: null, contextResult: "timer" }),
      host({ name: "far", result: "unreachable", live: false, status: null }),
      host({ name: "new", asked: "never", result: null, live: false, status: null }),
    ],
  };
  const [server, box, edge, far, fresh] = contextOf(doc).hosts;
  assert.equal(server!.notLive, "seen 2 h ago, not live");
  assert.match(box!.why!, /needs a newer pin/);
  assert.equal(edge!.why, "no ssh destination");
  assert.equal(far!.why, "unreachable over ssh");
  assert.equal(fresh!.why, "not asked yet");
  assert.equal(contextOf({ hosts: [host()] }).biggest, null);
  assert.equal(legendOf(contextOf({ hosts: [host()] })), null);
});

test("the stream's documents replace the page's; one that is not a document changes nothing", () => {
  const a = { hosts: [host()] };
  const b = { hosts: [host({ name: "other" })] };
  assert.equal(withFleetDoc(a, b), b);
  assert.equal(withFleetDoc(a, null), a);
  assert.equal(withFleetDoc(a, { ok: false }), a);
  assert.equal(answeredWords(host({ answeredSeconds: 2 })), "asked just now");
  assert.equal(answeredWords(host({ answeredSeconds: 125 })), "asked 2 min ago");
  assert.equal(answeredWords(host({ live: false })), null);
});

test("the header names the job of asking the hosts", () => {
  const jobs = jobsOf({ jobs: [{ kind: "fleet" }] });
  assert.deepEqual(jobs, [{ kind: "fleet" }]);
  assert.equal(jobLabel(jobs[0]!), "asking every host");
});
