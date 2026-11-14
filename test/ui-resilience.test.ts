import { test } from "node:test";
import assert from "node:assert/strict";
import { Jobs, REPLAY_MAX } from "../src/ui/jobs.ts";
import type { Job } from "../src/ui/jobs.ts";
import { openStream } from "../src/ui/static/api.js";
import { ApiError, createClient } from "../src/ui/static/api.js";
import { linkBanner, linkUsable, linkWord } from "../src/ui/static/link.js";
import { jobLabel, jobsOf, otherJobs, withJobs } from "../src/ui/static/jobs.js";
import { dropToken, loadOps, pageToken, saveOps } from "../src/ui/static/session.js";
import { elapsed, idleInit, initEnd } from "../src/ui/static/hosts.js";
import { idlePush, plain, pushEnd, writtenNotice } from "../src/ui/static/state.js";
import { blockers, DROPPED_BLOCKER } from "../src/ui/static/matrix.js";

// ---- the server's jobs

test("jobs: each kind is listed while it runs and gone when it ends, and every change is announced", () => {
  const seen: Job[][] = [];
  const jobs = new Jobs((list) => seen.push(list));
  const endPush = jobs.start({ kind: "push" });
  const endInit = jobs.start({ kind: "init", name: "mini" });
  jobs.start({ kind: "clone" })();
  assert.deepEqual(jobs.list(), [{ kind: "push" }, { kind: "init", name: "mini" }]);
  assert.equal(jobs.count, 2);
  endPush();
  endPush();
  assert.deepEqual(jobs.list(), [{ kind: "init", name: "mini" }], "ending twice ends once");
  endInit();
  assert.deepEqual(jobs.list(), []);
  assert.deepEqual(seen.at(-1), []);
  assert.equal(seen.length, 6);
  for (const kind of ["check", "secret"] as const) jobs.start({ kind, name: "X" })();
});

test("jobs: the events of a running push or init are kept for a stream that joins, and dropped when it ends", () => {
  const jobs = new Jobs(() => {});
  jobs.record("push", { event: "hosts" });
  assert.deepEqual(jobs.replay(), [], "nothing runs, nothing is kept");
  const end = jobs.start({ kind: "push" });
  jobs.record("jobs", { jobs: [] });
  jobs.record("push", { event: "hosts", hosts: [] });
  jobs.record("push", { event: "message", text: "a" });
  assert.deepEqual(jobs.replay().map((e) => e.event), ["push", "push"], "only push and init events");
  end();
  assert.deepEqual(jobs.replay(), []);
  jobs.start({ kind: "clone" });
  jobs.record("push", { event: "message" });
  assert.deepEqual(jobs.replay(), [], "a clone is not a stream of events");
});

test("jobs: the replay is bounded and never drops the hosts event that draws the lanes", () => {
  const jobs = new Jobs(() => {});
  jobs.start({ kind: "push" });
  jobs.record("push", { event: "hosts", hosts: [{ host: "a" }] });
  for (let i = 0; i < REPLAY_MAX + 50; i++) jobs.record("push", { event: "message", text: `line ${i}` });
  const kept = jobs.replay();
  assert.equal(kept.length, REPLAY_MAX);
  assert.equal((kept[0]!.data as { event: string }).event, "hosts");
  assert.equal((kept.at(-1)!.data as { text: string }).text, `line ${REPLAY_MAX + 49}`);
  assert.equal(jobs.replay().filter((e) => (e.data as { text?: string }).text === "line 0").length, 0, "the oldest lines went first");
});

test("jobs: a new push or init after one ended starts with nothing kept", () => {
  const jobs = new Jobs(() => {});
  const first = jobs.start({ kind: "init", name: "a" });
  jobs.record("init", { text: "old" });
  first();
  jobs.start({ kind: "init", name: "b" });
  assert.deepEqual(jobs.replay(), []);
});

// ---- the stream client

test("the stream client stops after a refused token and says so, and keeps trying when nothing answers", async () => {
  const tick = () => new Promise((r) => setImmediate(r));
  const made: { readyState: number; onerror: (() => void) | null; listeners: Record<string, unknown> }[] = [];
  const open = () => {
    const s = { readyState: 0, onerror: null as (() => void) | null, listeners: {}, addEventListener() {}, close() { this.readyState = 2; } };
    made.push(s);
    return s as unknown as EventSource;
  };
  for (const [seen, expected, retries] of [["denied", ["invalid"], 0], ["down", ["down"], 1]] as const) {
    made.length = 0;
    const links: string[] = [];
    const timers: (() => void)[] = [];
    openStream("t", { onHello() {}, onEvent() {}, onLink: (l) => links.push(l) }, { open, later: (fn) => void timers.push(fn), probe: async () => seen });
    made[0]!.readyState = 2;
    made[0]!.onerror!();
    await tick();
    assert.deepEqual(links, expected);
    assert.equal(timers.length, retries);
  }
});

test("the client says when the server refused its token", async () => {
  let denied = 0;
  const answer = (status: number) => async () => new Response(JSON.stringify({ ok: false, code: "forbidden", messages: ["fleet: the token is wrong"] }), { status });
  const client = createClient("t", answer(403) as typeof fetch, { onDenied: () => denied++ });
  await assert.rejects(client.status(), (e: unknown) => e instanceof ApiError && e.messages[0] === "the token is wrong" && e.code === "forbidden");
  await assert.rejects(createClient("t", answer(500) as typeof fetch, { onDenied: () => denied++ }).status());
  assert.equal(denied, 1);
});

// ---- link

test("link: only a server that cannot be reached disables changes, and the banner says what to do", () => {
  assert.deepEqual((["connecting", "live", "reconnecting", "invalid"] as const).map(linkUsable), [true, true, false, false]);
  assert.equal(linkBanner("live", { held: 3, working: true }), null);
  const down = linkBanner("reconnecting", { held: 0, working: false })!;
  assert.match(down.title, /not answering/);
  assert.match(down.lines.join(" "), /Run fleet ui again/);
  const bad = linkBanner("invalid", { held: 2, working: true })!;
  assert.match(bad.title, /token is no longer valid/);
  const text = bad.lines.join(" ");
  assert.match(text, /started again/);
  assert.match(text, /2 edits to push are kept in this tab/);
  assert.match(text, /finishes on its own/);
  assert.match(text, /fleet status/);
  assert.match(linkBanner("invalid", { held: 1, working: false })!.lines.join(" "), /1 edit to push is kept/);
  assert.equal(linkWord("reconnecting"), "not answering");
  assert.equal(linkWord("live"), "live");
});

// ---- the tab's storage

function fakeStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
}

test("session: the token from the address is kept for a reload, and a reload with none in the address uses it", () => {
  const store = fakeStore();
  assert.equal(pageToken(store, null), null);
  assert.equal(pageToken(store, "abc"), "abc");
  assert.equal(pageToken(store, null), "abc", "after a reload the address has no token");
  assert.equal(pageToken(store, "new"), "new", "a new URL replaces it");
  assert.equal(pageToken(store, null), "new");
  dropToken(store);
  assert.equal(pageToken(store, null), null);
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
  assert.equal(pageToken(blocked, "abc"), "abc", "a browser without storage still works for this load");
  assert.equal(pageToken(null, null), null);
  assert.deepEqual(loadOps(blocked), []);
  saveOps(blocked, [{ op: "add" }]);
});

test("session: the To push list is restored after a reload, and a damaged one restores nothing", () => {
  const store = fakeStore();
  const ops = [{ op: "add", host: "box", kind: "bundles", name: "extra" }, { op: "setSecret", file: "secrets/box.enc.yaml", names: ["K"], base: "b", content: "ENC[AES256_GCM,data:x]" }];
  assert.deepEqual(loadOps(store), []);
  saveOps(store, ops);
  assert.deepEqual(loadOps(store), ops);
  saveOps(store, []);
  assert.equal(store.data.size, 0, "an empty list is not kept");
  for (const bad of ["not json", "{}", "null", '[1, "x", null, ["op"], {"nope": 1}, {"op": "add"}]']) {
    store.setItem("fleet-ui-to-push", bad);
    assert.deepEqual(loadOps(store), bad.startsWith("[1") ? [{ op: "add" }] : [], bad);
  }
});

test("session: a plain secret value is never in what is kept", () => {
  // The edit a value becomes holds ciphertext only: the request body carries the value, and its answer has `ops` with the encrypted file.
  const store = fakeStore();
  saveOps(store, [{ op: "setSecret", file: "secrets/box.enc.yaml", names: ["TOKEN"], base: "ENC", content: "TOKEN: ENC[AES256_GCM,data:abc]" }]);
  assert.equal([...store.data.values()].join("").includes("hunter2"), false);
});

// ---- jobs in the page

test("jobs: the page labels each kind, and a push is not claimed for anything else", () => {
  assert.equal(jobLabel({ kind: "push" }), "a push is running");
  assert.equal(jobLabel({ kind: "init", name: "mini" }), "fleet init of mini is running");
  assert.match(jobLabel({ kind: "clone" }), /cloned/);
  assert.match(jobLabel({ kind: "check", name: "tracker" }), /tracker is being checked/);
  assert.match(jobLabel({ kind: "secret", name: "API_KEY" }), /API_KEY is being encrypted/);
  for (const kind of ["clone", "check", "secret"] as const) assert.doesNotMatch(jobLabel({ kind }), /push/);
  assert.deepEqual(jobsOf({ jobs: [{ kind: "init", name: "m" }, { kind: "x" }, null, { kind: "push", name: 4 }] }), [{ kind: "init", name: "m" }, { kind: "push" }]);
  assert.deepEqual(jobsOf({ pushing: true }), []);
  assert.deepEqual(otherJobs([{ kind: "push" }, { kind: "clone" }]), [{ kind: "clone" }]);
});

const page = () => ({ push: idlePush(), init: idleInit() });

test("jobs: a hello with a push or an init starts it afresh, and one without ends what ran", () => {
  const withPush = withJobs(page(), [{ kind: "push" }], null);
  assert.equal(withPush.push.running, true);
  assert.equal(withPush.init.running, false);
  const withInit = withJobs(page(), [{ kind: "init", name: "mini" }], null);
  assert.equal(withInit.init.running, true);
  assert.equal(withInit.init.name, "mini");
  assert.equal(withInit.push.running, false, "an init is not a push");
  const busy = { push: { ...idlePush(), running: true, log: ["old"] }, init: idleInit() };
  assert.deepEqual(withJobs(busy, [{ kind: "push" }], null).push.log, [], "the events are replayed, so the old ones go");
  assert.equal(withJobs(busy, [], null).push.running, false);
  assert.equal(withJobs(busy, [{ kind: "clone" }], null).push.running, false, "a clone does not keep a push running");
});

test("jobs: a jobs event ends only what it saw end, and does not start again what is showing", () => {
  const running = { push: { ...idlePush(), running: true, log: ["keep"] }, init: idleInit() };
  assert.deepEqual(withJobs(running, [{ kind: "push" }], [{ kind: "clone" }]).push.log, ["keep"]);
  assert.equal(withJobs(running, [], [{ kind: "push" }]).push.running, false, "its end is seen");
  assert.equal(withJobs(running, [], []).push.running, true, "a run this page just began is not counted yet");
  const init = { push: idlePush(), init: { ...idleInit(), running: true, name: "mini", lines: ["a"] } };
  const ended = withJobs(init, [], [{ kind: "init", name: "mini" }]);
  assert.equal(ended.init.running, false);
  assert.deepEqual(ended.init.lines, ["a"], "the output stays");
  assert.equal(withJobs(page(), [{ kind: "init", name: "x" }], []).init.running, true);
});

// ---- words

test("messages are shown without the terminal's `fleet: ` prefix", () => {
  assert.equal(plain("fleet: a push is already running (pid 7)"), "a push is already running (pid 7)");
  assert.equal(plain("box: fleet: kept"), "box: fleet: kept");
  assert.deepEqual(pushEnd(idlePush(), { ok: false, code: "error", messages: ["fleet: box is unreachable"] }).end?.messages, ["box is unreachable"]);
  assert.deepEqual(initEnd(idleInit(), { ok: false, code: "error", messages: ["fleet: hosts/m.yaml was removed again"] }).end?.messages, ["hosts/m.yaml was removed again"]);
});

test("the Review notice of edits that no longer apply has one blocker of its own to leave out", () => {
  assert.equal(blockers({ outside: [], dropped: [{}], checks: [], running: false })[0], DROPPED_BLOCKER);
});

test("after a write whose push failed, the notice says what is committed and what to do", () => {
  assert.equal(writtenNotice({ commit: "abc1234def" }, "ok"), null);
  assert.equal(writtenNotice(undefined, "conflict"), null);
  const conflict = writtenNotice({ commit: "abc1234def" }, "conflict")!;
  assert.match(conflict, /committed as abc1234, but it was not pushed/);
  assert.match(conflict, /no longer on To push/);
  assert.match(conflict, /then press Push/);
  assert.match(writtenNotice({ commit: "abc1234" }, "unreachable")!, /network or ssh/);
  assert.match(writtenNotice({ commit: "abc1234" }, "error")!, /Fix what the log names/);
  assert.match(writtenNotice({ commit: "" }, "locked")!, /committed, but/);
});

test("the init clock reads in seconds, then minutes", () => {
  assert.deepEqual([-5, 0, 999, 42_000, 59_999, 60_000, 65_000, 3_725_000].map(elapsed), ["0 s", "0 s", "0 s", "42 s", "59 s", "1 min 00 s", "1 min 05 s", "62 min 05 s"]);
});
