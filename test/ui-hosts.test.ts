import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, publish } from "./helpers.ts";
import { acquirePushLock } from "../src/lock.ts";
import { startUi } from "../src/ui/server.ts";
import type { UiServer } from "../src/ui/server.ts";
import { cleanLine } from "../src/ui/hostinit.ts";
import { setup } from "./initworld.ts";
import type { S } from "./initworld.ts";

// The child runs with the temp HOME, which has no git identity: init's own commit needs one.
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" });

/**
 * The two-machine world of the init tests: laptop is the admin and this machine, `server` is a host that already
 * exists, and the fake ssh answers `bob@mini` with a second, fresh machine. Nothing here reaches a real host.
 */
function world() {
  const s = setup();
  s.write("catalog/mcp.yaml", "servers:\n  tracker:\n    transport: http\n    url: https://tracker.example.com/mcp\n");
  s.write("catalog/skills.yaml", "sources: {}\nbundles:\n  extra: []\n  more: []\n");
  s.write("hosts/box.yaml", "# A build box.\nssh: alice@server\nage: \"\"\nbundles: [extra, more]\nmcp:\n  include: [tracker]  # for builds\nvars:\n  DOCS_URL: https://box.example.com\nfiles:\n  - { source: config/note.md, target: ~/.claude/note.md }\n");
  s.write("config/note.md", "a note\n");
  publish(s.clone, "box");
  const plans = JSON.parse(readFileSync(join(s.home, "fake-ssh.json"), "utf8"));
  writeFileSync(join(s.home, "fake-ssh.json"), JSON.stringify({ ...plans, "bob@mini": { home: s.lab } }));
  return s;
}

async function withServer(body: (server: UiServer, w: S) => Promise<void>) {
  const w = world();
  const server = await startUi({ toolDir: w.clone, configDir: w.clone, home: w.home });
  try {
    await body(server, w);
  } finally {
    await server.close();
  }
}

const base = (s: UiServer) => `http://127.0.0.1:${s.port}`;
const post = (s: UiServer, body: unknown) =>
  fetch(`${base(s)}/api/hosts/init`, { method: "POST", headers: { "x-fleet-token": s.token, origin: base(s), "content-type": "application/json" }, body: JSON.stringify(body) });
const mini = (over: Record<string, unknown> = {}) => ({ name: "mini", ssh: "bob@mini", from: null, confirm: true, ...over });

/** Collects the stream until `pushend`-like `initend` has come. */
function watch(s: UiServer) {
  const state = { seen: "" };
  const done = (async () => {
    const res = await fetch(`${base(s)}/api/events?token=${s.token}`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    while (!state.seen.includes("event: initend")) {
      const { value, done: end } = await reader.read();
      if (end) break;
      state.seen += decoder.decode(value);
    }
    await reader.cancel();
  })();
  return { state, done };
}

test("a bad name, an ssh destination that ssh would read as an option or that has a space, and a missing confirmation are refused before anything is written or run", async () => {
  await withServer(async (s, w) => {
    const head = git(w.clone, "rev-parse", "HEAD");
    for (const bad of [
      mini({ name: "../x" }), mini({ name: "-x" }), mini({ name: "a b" }), mini({ name: "" }), mini({ name: 3 }),
      mini({ ssh: "-oProxyCommand=touch /tmp/x" }), mini({ ssh: "-F/etc/passwd" }), mini({ ssh: "bob@mini extra" }), mini({ ssh: "bob@mini\n" }), mini({ ssh: "bob@mini;id" }), mini({ ssh: "" }), mini({ ssh: "$(id)" }),
      mini({ from: "../laptop" }), mini({ confirm: false }), mini({ confirm: undefined }),
    ]) {
      const res = await post(s, bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal(((await res.json()) as any).code, "invalid");
    }
    assert.equal(existsSync(join(w.clone, "hosts/mini.yaml")), false);
    assert.equal(git(w.clone, "rev-parse", "HEAD"), head);
    assert.deepEqual(w.sshCalls(), [], "no ssh was run");
  });
});

test("a host from the defaults: the file is written, the real init sets it up over ssh and commits and pushes, and its output is streamed", async () => {
  await withServer(async (s, w) => {
    const { state, done } = watch(s);
    const res = await post(s, mini());
    const doc = (await res.json()) as any;
    assert.equal(res.status, 200, JSON.stringify(doc));
    assert.equal(doc.ok, true, JSON.stringify(doc));
    assert.equal(doc.code, "ok");
    assert.equal(doc.written, "hosts/mini.yaml");
    await done;
    // The file as the edit engine wrote it, with the age init put in.
    assert.match(w.read("hosts/mini.yaml"), /^ssh: bob@mini\nage: age1[a-z0-9]+\n$/);
    assert.equal(w.initCommits("mini"), 1, "init pushed its own commit");
    assert.equal(git(w.clone, "status", "--porcelain"), "");
    assert.equal(git(w.clone, "rev-parse", "HEAD"), git(w.clone, "rev-parse", "origin/main"));
    assert.ok(existsSync(w.labKey), "the key was made on the new host");
    assert.ok(w.timerOn());
    // The output came over the stream while it ran, and the end after it.
    assert.match(state.seen, /event: init\ndata: \{"text":"\$ fleet init mini"\}/);
    assert.match(state.seen, /1\. prerequisites/);
    assert.match(state.seen, /event: initend\ndata: \{"ok":true,"code":"ok"/);
    assert.ok(state.seen.indexOf('"text":"$ fleet init mini"') < state.seen.indexOf("event: initend"));
  });
});

test("a host copied from another gets its bundles, exclude, mcp, settings and vars, and not its ssh, age or files", async () => {
  await withServer(async (s, w) => {
    const res = await post(s, mini({ from: "box" }));
    const doc = (await res.json()) as any;
    assert.equal(doc.ok, true, JSON.stringify(doc));
    const text = w.read("hosts/mini.yaml");
    assert.match(text, /^ssh: bob@mini\nage: age1[a-z0-9]+\n\nbundles: \[extra, more\]\n\nmcp:\n  include: \[tracker\]  # for builds\n\nvars:\n  DOCS_URL: https:\/\/box\.example\.com\n$/);
    assert.doesNotMatch(text, /alice@server|files:/);
    assert.equal(w.read("hosts/box.yaml").includes("age: \"\""), true, "the source is not touched");
  });
});

test("a host that exists is refused, and nothing is run", async () => {
  await withServer(async (s, w) => {
    const res = await post(s, mini({ name: "server" }));
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as any).code, "exists");
    const none = await post(s, mini({ from: "nowhere" }));
    assert.equal(none.status, 409);
    assert.equal(((await none.json()) as any).code, "stale");
    assert.deepEqual(w.sshCalls(), []);
  });
});

test("it respects the push lock: while another push holds it the answer is 409 locked and nothing is written", async () => {
  await withServer(async (s, w) => {
    const release = acquirePushLock(w.home);
    try {
      // The lock holder here is this very process, which is alive: that is what a running push looks like.
      const res = await post(s, mini());
      assert.equal(res.status, 409);
      const doc = (await res.json()) as any;
      assert.equal(doc.code, "locked");
      assert.match(doc.messages[0], /a push is already running/);
    } finally {
      release();
    }
    assert.equal(existsSync(join(w.clone, "hosts/mini.yaml")), false);
    assert.deepEqual(w.sshCalls(), []);
    // And the lock is let go when init has run, so a push can follow.
    assert.equal((await post(s, mini())).status, 200);
    const again = acquirePushLock(w.home);
    again();
  });
});

test("it refuses when the config repo has changes the page did not make, and writes nothing", async () => {
  await withServer(async (s, w) => {
    writeFileSync(join(w.clone, "hosts/laptop.yaml"), `${w.read("hosts/laptop.yaml")}# edited by hand\n`);
    const res = await post(s, mini());
    assert.equal(res.status, 409);
    const doc = (await res.json()) as any;
    assert.equal(doc.code, "outside-changes");
    assert.deepEqual(doc.outside, [" M hosts/laptop.yaml"]);
    assert.equal(existsSync(join(w.clone, "hosts/mini.yaml")), false);
    assert.deepEqual(w.sshCalls(), []);
  });
});

test("when init fails before it committed anything, the host file is removed and the repo is as it was", async () => {
  await withServer(async (s, w) => {
    const head = git(w.clone, "rev-parse", "HEAD");
    // This destination has no answer in the fake ssh: it is unreachable.
    const { state, done } = watch(s);
    const res = await post(s, mini({ ssh: "bob@nowhere" }));
    const doc = (await res.json()) as any;
    assert.equal(doc.ok, false);
    assert.equal(doc.code, "unreachable");
    assert.equal(doc.removed, true);
    await done;
    assert.match(state.seen, /unreachable over ssh/);
    assert.equal(existsSync(join(w.clone, "hosts/mini.yaml")), false);
    assert.equal(git(w.clone, "rev-parse", "HEAD"), head);
    assert.equal(git(w.clone, "status", "--porcelain"), "");
    // The same name can be tried again, from a clean repo.
    assert.equal(((await (await post(s, mini())).json()) as any).ok, true);
  });
});

test("when init fails after it committed and pushed, the host file stays, and the page is told to run init again", async () => {
  await withServer(async (s, w) => {
    // The timer is the last step: everything before it, including the commit of the host file, has happened.
    writeFileSync(join(w.lab, "fake-systemctl-fail"), "");
    const res = await post(s, mini());
    const doc = (await res.json()) as any;
    assert.equal(doc.ok, false, JSON.stringify(doc));
    assert.equal(doc.kept, true);
    assert.equal(doc.removed, false);
    assert.match(doc.messages.join(" "), /fleet init mini' again/);
    assert.match(w.read("hosts/mini.yaml"), /^ssh: bob@mini\nage: age1/);
    assert.equal(w.initCommits("mini"), 1);
    assert.equal(git(w.clone, "status", "--porcelain"), "");
  });
});

test("a line of the child's output is shown without escape sequences or control characters", () => {
  assert.equal(cleanLine("\x1b[32mdone\x1b[0m\r\x07 ok\t."), "done ok\t.");
});
