import { test } from "node:test";
import assert from "node:assert/strict";
import { REMOVE_ADMIN, REMOVE_SELF, bundleLosses, goLabel, heldForHost, hostRefusal, hostRuns, lossLine, mentions, removal, sourceSkills, touched } from "../src/ui/static/removing.js";
import { REMOVE_ADMIN as SERVER_ADMIN, REMOVE_SELF as SERVER_SELF } from "../src/hostremove.ts";
import { removalOp } from "../src/ui/static/editing.js";
import { opLabel, suggestMessage } from "../src/ui/static/matrix.js";
import { jobLabel, jobsOf, otherJobs, withJobs } from "../src/ui/static/jobs.js";
import { idleInit } from "../src/ui/static/hosts.js";
import { idlePush } from "../src/ui/static/state.js";
import { takeBack } from "../src/ui/static/catalog.js";

const pick = (host: string, name: string, op: "add" | "remove" = "add", kind: "bundles" | "mcp" = "mcp") => ({ op, host, kind, name }) as any;

test("the words of a refusal are the server's", () => {
  assert.equal(REMOVE_SELF("laptop"), SERVER_SELF("laptop"));
  assert.equal(REMOVE_ADMIN("laptop"), SERVER_ADMIN("laptop"));
});

test("a host is refused for the machine the page runs on and for the only admin, and not otherwise", () => {
  const hosts = [{ name: "laptop", self: true, admin: true }, { name: "box", self: false, admin: false }, { name: "mini", self: false }];
  assert.equal(hostRefusal(hosts[0]!, hosts), REMOVE_SELF("laptop"));
  assert.equal(hostRefusal(hosts[1]!, hosts), null);
  assert.equal(hostRefusal(hosts[2]!, hosts), null);
  const away = [{ name: "laptop", self: false, admin: true }, { name: "box", self: true, admin: false }];
  assert.equal(hostRefusal(away[0]!, away), REMOVE_ADMIN("laptop"));
  // Another admin would make it not the last one (the config allows exactly one, but the page does not decide that).
  const two = [{ name: "a", self: false, admin: true }, { name: "b", self: false, admin: true }];
  assert.equal(hostRefusal(two[0]!, two), null);
});

test("which held edits name an item", () => {
  assert.equal(mentions(pick("box", "docs"), "server", "docs"), true);
  assert.equal(mentions(pick("box", "docs", "remove"), "server", "docs"), true);
  assert.equal(mentions(pick("box", "docs", "add", "bundles"), "server", "docs"), false, "a bundle of that name is another item");
  assert.equal(mentions(pick("box", "docs", "add", "bundles"), "bundle", "docs"), true);
  assert.equal(mentions({ op: "editServer", name: "docs", changes: [] } as any, "server", "docs"), true);
  assert.equal(mentions({ op: "addSource", name: "docs", entry: {} } as any, "server", "docs"), false);
  assert.equal(mentions({ op: "editHost", host: "docs", from: null, to: "a@b" } as any, "server", "docs"), false);
  assert.equal(mentions(pick("box", "docs"), "host", "box"), false);
});

test("removing a pushed item holds the removal at the end and drops the edits and picks of it that were held", () => {
  const edit = { op: "editServer", name: "docs", changes: [{ key: "only", from: null, to: ["claude"] }] } as any;
  const other = pick("box", "tracker");
  const r = removal([pick("box", "docs"), edit, other], "server", "docs", []);
  assert.equal(r.mode, "stage");
  assert.deepEqual(r.op, { op: "removeServer", name: "docs" });
  assert.deepEqual(r.ops, [other, { op: "removeServer", name: "docs" }]);
  assert.deepEqual(r.moot, [pick("box", "docs"), edit]);
  assert.deepEqual(removal([], "bundle", "core", []).op, { op: "removeBundle", name: "core" });
  assert.deepEqual(removal([], "source", "mine", ["a", "b"]).op, { op: "removeSource", name: "mine", skills: ["a", "b"] });
});

test("removing an item whose addition is still held drops the addition and what names it, and stages nothing", () => {
  const add = { op: "addServer", name: "fresh", entry: { command: ["x"] } } as any;
  const keep = pick("box", "docs");
  const r = removal([add, pick("box", "fresh"), pick("mini", "fresh", "add"), keep], "server", "fresh", []);
  assert.equal(r.mode, "forget");
  assert.equal(r.op, null);
  assert.deepEqual(r.ops, [keep]);
  assert.equal(r.moot.length, 3);
  const bundle = removal([{ op: "addBundle", name: "b", skills: ["s"] } as any, pick("box", "b", "add", "bundles")], "bundle", "b", []);
  assert.deepEqual([bundle.mode, bundle.ops], ["forget", []]);
  const source = removal([{ op: "addSource", name: "s", entry: {} } as any], "source", "s", []);
  assert.deepEqual([source.mode, source.ops], ["forget", []]);
});

test("the skills that go with a source are those only it provides, from its clone here and from what was seen when it was added", () => {
  const known = [{ name: "a", source: "mine" }, { name: "b", source: "mine" }, { name: "c", source: "other" }, { name: "b", source: "other" }];
  assert.deepEqual(sourceSkills("mine", known, {}), ["a"]);
  assert.deepEqual(sourceSkills("mine", known, { mine: ["z", "a"] }), ["a", "z"]);
  assert.deepEqual(sourceSkills("mine", known, { fresh: ["a"] }), []);
  assert.deepEqual(sourceSkills("nope", known, {}), []);
});

test("what each bundle loses is counted, one that keeps none is flagged by left, and the words say it", () => {
  const bundles = [{ name: "core", skills: ["a", "b", "c"] }, { name: "extra", skills: ["a", "x"] }, { name: "solo", skills: ["b"] }, { name: "untouched", skills: ["y"] }];
  const losses = bundleLosses(bundles, ["a", "b", "c"]);
  assert.deepEqual(losses.map((l) => [l.bundle, l.lost.length, l.left]), [["core", 3, 0], ["extra", 1, 1], ["solo", 1, 0]]);
  assert.equal(lossLine(losses[0]!), "core loses 3 skills (a, b, c)");
  assert.equal(lossLine(losses[1]!), "extra loses 1 skill (a)");
  assert.equal(lossLine(losses[2]!), "solo loses its only skill (b)");
  assert.deepEqual(bundleLosses(bundles, []), []);
});

test("the files a removal touches are named by host, with the defaults as such, and secrets and the catalog apart", () => {
  const t = touched([{ path: "catalog/mcp.yaml" }, { path: "hosts/_defaults.yaml" }, { path: "hosts/box.yaml" }, { path: "hosts/a.b.yaml" }, { path: "secrets/box.enc.yaml" }, { path: ".sops.yaml" }]);
  assert.deepEqual(t, { catalog: ["catalog/mcp.yaml"], hosts: ["the defaults", "box", "a.b"] });
});

test("a host's removal drops its picks, its ssh edit and the secrets it or the rekey makes stale, and no other host's", () => {
  const ops = [pick("box", "docs"), pick("mini", "docs"), { op: "editHost", host: "box", from: null, to: "a@b" }, { op: "editHost", host: "mini", from: null, to: "a@b" }, { op: "setSecret", file: "secrets/box.enc.yaml" }, { op: "setSecret", file: "secrets/shared.enc.yaml" }, { op: "setSecret", file: "secrets/mini.enc.yaml" }, { op: "editServer", name: "box", changes: [] }] as any[];
  assert.deepEqual(heldForHost(ops, "box"), [ops[0], ops[2], ops[4], ops[5]]);
});

test("the button says what it does", () => {
  assert.equal(goLabel("forget"), "Drop the addition");
  assert.match(goLabel("stage"), /to push/);
  assert.match(goLabel("run"), /push/);
});

test("a held removal is found for its item, undone as one unit, and described", () => {
  const op = { op: "removeSource", name: "mine", skills: ["a"] } as any;
  const ops = [pick("box", "x"), op];
  assert.equal(removalOp(ops, "source", "mine"), op);
  assert.equal(removalOp(ops, "server", "mine"), undefined);
  assert.deepEqual(takeBack(ops, op), [ops[0]]);
  assert.equal(opLabel(op), "remove skill source mine from the catalog");
  assert.equal(opLabel({ op: "removeServer", name: "docs" } as any), "remove server docs from the catalog");
  assert.equal(opLabel({ op: "removeBundle", name: "core" } as any), "remove bundle core from the catalog");
  assert.equal(suggestMessage([{ op: "removeServer", name: "docs" } as any]), "Remove server docs");
  assert.equal(suggestMessage([{ op: "removeServer", name: "docs" } as any, { op: "removeBundle", name: "core" } as any]), "Remove server docs; remove bundle core");
  const long = Array.from({ length: 9 }, (_, i) => ({ op: "removeServer", name: `server-number-${i}` }) as any);
  assert.equal(suggestMessage(long), "Remove 9 catalog entries");
});

test("a removal of a host is a job of its own: labelled, followed by the page, and not mistaken for a push or an init", () => {
  assert.equal(jobLabel({ kind: "remove", name: "box" }), "removing box is running");
  assert.deepEqual(jobsOf({ jobs: [{ kind: "remove", name: "box" }] }), [{ kind: "remove", name: "box" }]);
  assert.deepEqual(otherJobs([{ kind: "remove" }, { kind: "clone" }]), [{ kind: "clone" }]);
  const page = () => ({ push: idlePush(), init: idleInit(), removal: idleInit() });
  const hello = withJobs(page(), [{ kind: "remove", name: "box" }], null);
  assert.deepEqual([hello.removal.running, hello.removal.name, hello.push.running, hello.init.running], [true, "box", false, false]);
  const running = { ...page(), removal: { ...idleInit(), running: true, name: "box", lines: ["a"] } };
  assert.equal(withJobs(running, [], [{ kind: "remove", name: "box" }]).removal.running, false);
  assert.deepEqual(withJobs(running, [], [{ kind: "remove", name: "box" }]).removal.lines, ["a"], "the output stays");
  assert.equal(withJobs(running, [], []).removal.running, true, "a run this page just began is not counted yet");
  // A page that keeps no removal state is as before.
  assert.equal("removal" in withJobs({ push: idlePush(), init: idleInit() }, [{ kind: "remove", name: "box" }], null), false);
});

test("the server keeps the events of a running removal for a page that joins late, and starts afresh for the next run", async () => {
  const { Jobs } = await import("../src/ui/jobs.ts");
  const jobs = new Jobs(() => {});
  const end = jobs.start({ kind: "remove", name: "box" });
  jobs.record("remove", { text: "$ fleet secrets rekey" });
  assert.deepEqual(jobs.replay(), [{ event: "remove", data: { text: "$ fleet secrets rekey" } }]);
  end();
  assert.deepEqual(jobs.replay(), []);
  jobs.record("remove", { text: "late" });
  assert.deepEqual(jobs.replay(), [], "nothing is kept without a running job");
});

test("the host dialog names the rekey only when the fleet keeps secrets, as the server runs it", () => {
  const files = [{ path: "hosts/box.yaml" }, { path: "secrets/box.enc.yaml" }, { path: ".sops.yaml" }];
  const kept = hostRuns("box", { files, rekey: true });
  assert.equal(kept.head, "runs now: rekeys, commits and pushes");
  assert.equal(kept.lead, "Removes the host box now, not through To push: it deletes hosts/box.yaml and secrets/box.enc.yaml, runs fleet secrets rekey so no secrets file names its key, then commits and pushes this repo.");
  const none = hostRuns("box", { files: [{ path: "hosts/box.yaml" }], rekey: false });
  assert.equal(none.head, "runs now: commits and pushes");
  assert.equal(none.lead, "Removes the host box now, not through To push: it deletes hosts/box.yaml, then commits and pushes this repo.");
});
