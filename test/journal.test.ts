import { test } from "node:test";
import assert from "node:assert/strict";
import { comparable } from "../src/journal.ts";
import type { JournalEntry } from "../src/journal.ts";

const entry = (file: string, over: Partial<JournalEntry["header"]> = {}): JournalEntry => ({
  file,
  header: { journal: 1, v: 1, time: "2026-11-13T09:00:00.000Z", commit: null, only: null, hosts: ["laptop"], ms: 1000, interrupted: false, result: "ok", end: null, ...over },
});

test("a push is compared with the most recent earlier push of the same scope", () => {
  const all = [entry("d"), entry("c", { only: "box" }), entry("b", { result: "conflict" }), entry("a"), entry("z", { only: "box" })];
  assert.equal(comparable(all, all[0]!)?.file, "a", "all hosts with all hosts, skipping a single host's push and one that did not end ok");
  const single = [entry("d", { only: "box" }), entry("c"), entry("b", { only: "server" }), entry("a", { only: "box" })];
  assert.equal(comparable(single, single[0]!)?.file, "a", "the same single host");
});

test("there is nothing to compare with when there is no earlier push of that scope, or the push itself did not end ok", () => {
  const first = [entry("b", { only: "box" }), entry("a")];
  assert.equal(comparable(first, first[0]!), null);
  const interrupted = [entry("b", { interrupted: true, result: null }), entry("a")];
  assert.equal(comparable(interrupted, interrupted[0]!), null);
  const later = [entry("c"), entry("b")];
  assert.equal(comparable(later, later[1]!), null, "only earlier ones count");
});
