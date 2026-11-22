import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, publish } from "./helpers.ts";
import { acquirePushLock } from "../src/lock.ts";
import { startUi } from "../src/ui/server.ts";
import type { UiServer } from "../src/ui/server.ts";
import { REMOVE_ADMIN, REMOVE_SELF } from "../src/hostremove.ts";
import { identityOf, setup } from "./initworld.ts";
import type { S } from "./initworld.ts";

// The child runs with the temp HOME, which has no git identity: its commits need one.
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" });

/**
 * laptop is the admin and this machine; `server` was set up by the real init (so it has an age key, and can read `shared` and its own
 * secrets); `box` has no key. The fake ssh never reaches a real machine.
 */
function world() {
  const s = setup();
  const done = s.json(["server"]);
  assert.equal(done.doc.ok, true, JSON.stringify(done.doc));
  s.setSecret("shared", "SHARED_TOKEN", "mock-shared-value");
  s.setSecret("server", "SERVER_ONLY", "mock-server-value");
  s.write("hosts/box.yaml", "# A build box.\nssh: bob@box\nage: \"\"\n");
  s.write("hosts/_defaults.yaml", "bundles: []\n");
  publish(s.clone, "box");
  return s;
}

async function withServer(body: (server: UiServer, w: S) => Promise<void>, make: () => S = world) {
  const w = make();
  const server = await startUi({ toolDir: w.clone, configDir: w.clone, home: w.home });
  try {
    await body(server, w);
  } finally {
    await server.close();
  }
}

const base = (s: UiServer) => `http://127.0.0.1:${s.port}`;
const post = (s: UiServer, path: string, body: unknown) =>
  fetch(`${base(s)}${path}`, { method: "POST", headers: { "x-fleet-token": s.token, origin: base(s), "content-type": "application/json" }, body: JSON.stringify(body) });
const remove = (s: UiServer, name: string, over: Record<string, unknown> = {}) => post(s, "/api/hosts/remove", { name, confirm: true, ...over });
const preview = (s: UiServer, name: string) => post(s, "/api/hosts/remove/preview", { name });

function watch(s: UiServer) {
  const state = { seen: "" };
  const done = (async () => {
    const res = await fetch(`${base(s)}/api/events?token=${s.token}`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    while (!state.seen.includes("event: removeend")) {
      const { value, done: end } = await reader.read();
      if (end) break;
      state.seen += decoder.decode(value);
    }
    await reader.cancel();
  })();
  return { state, done };
}

test("the preview says what is deleted and rewritten, and names the secrets the host could read, never their values", async () => {
  await withServer(async (s, w) => {
    const head = git(w.clone, "rev-parse", "HEAD");
    const doc = (await (await preview(s, "server")).json()) as any;
    assert.equal(doc.ok, true, JSON.stringify(doc));
    assert.deepEqual(doc.files.map((f: any) => f.path), ["hosts/server.yaml", "secrets/server.enc.yaml", ".sops.yaml"]);
    const [hostFile, secrets, sops] = doc.files;
    assert.equal(hostFile.before, w.read("hosts/server.yaml"));
    assert.equal(hostFile.after, "");
    // The secrets file is shown by its names with a short mark of the ciphertext.
    assert.match(secrets.before, /^SERVER_ONLY: ENC\[\.\.\.[0-9a-f]{6}\]\n$/);
    assert.equal(secrets.after, "");
    // `.sops.yaml` as rekey will write it: no rule for the host's file, and its key gone from the others.
    const recipient = identityOf(w.lab).recipient;
    assert.ok(sops.before.includes(recipient));
    assert.ok(!sops.after.includes(recipient));
    assert.ok(!sops.after.includes("secrets/server.enc.yaml"));
    assert.equal(doc.rekey, true);
    assert.deepEqual(doc.rekeyed, ["secrets/shared.enc.yaml"]);
    assert.deepEqual(doc.readable, { shared: ["SHARED_TOKEN"], own: ["SERVER_ONLY"] });
    assert.ok(!JSON.stringify(doc).includes("mock-"), "no value is in the answer");
    assert.ok(!JSON.stringify(doc).includes("ENC[AES"), "no ciphertext either");
    assert.equal(git(w.clone, "rev-parse", "HEAD"), head);
    assert.equal(git(w.clone, "status", "--porcelain"), "");
    // A host with no key reads nothing, and touches no secrets file.
    const box = (await (await preview(s, "box")).json()) as any;
    assert.deepEqual(box.readable, { shared: [], own: [] });
    assert.deepEqual(box.rekeyed, []);
    assert.deepEqual(box.files.map((f: any) => f.path), ["hosts/box.yaml"]);
  });
});

test("removing a host deletes its files, rekeys so its key can no longer read the shared secrets, commits and pushes, and streams the output", async () => {
  await withServer(async (s, w) => {
    const lab = identityOf(w.lab);
    assert.equal(w.decrypt("shared", "SHARED_TOKEN", lab), "mock-shared-value", "it could read it before");
    const { state, done } = watch(s);
    const res = await remove(s, "server");
    const doc = (await res.json()) as any;
    assert.equal(res.status, 200, JSON.stringify(doc));
    assert.equal(doc.ok, true, JSON.stringify(doc));
    assert.equal(doc.removed, true);
    await done;
    assert.equal(existsSync(join(w.clone, "hosts/server.yaml")), false);
    assert.equal(existsSync(join(w.clone, "secrets/server.enc.yaml")), false);
    assert.ok(!w.read(".sops.yaml").includes(lab.recipient));
    assert.ok(!w.read(".sops.yaml").includes("server.enc.yaml"));
    // The real rekey ran: the shared file no longer has the host's recipient, and the admin still reads it.
    assert.ok(!w.read("secrets/shared.enc.yaml").includes(lab.recipient));
    assert.equal(w.decrypt("shared", "SHARED_TOKEN", lab), null);
    assert.equal(w.decrypt("shared", "SHARED_TOKEN", w.admin), "mock-shared-value");
    assert.equal(git(w.clone, "log", "-1", "--format=%s"), "Remove host server");
    assert.equal(git(w.clone, "status", "--porcelain"), "");
    assert.equal(git(w.clone, "rev-parse", "HEAD"), git(w.clone, "rev-parse", "origin/main"), "pushed");
    // Its machine is not touched: it keeps its key and its files, and nothing ran over ssh for the removal.
    assert.ok(existsSync(w.labKey));
    assert.equal(w.sshCalls().filter((c) => c.join(" ").includes("rekey")).length, 0);
    assert.match(state.seen, /event: remove\ndata: \{"text":"\$ delete hosts\/server\.yaml and secrets\/server\.enc\.yaml"\}/);
    assert.match(state.seen, /"text":"\$ fleet secrets rekey"/);
    assert.match(state.seen, /"text":"\$ git push"/);
    assert.match(state.seen, /event: removeend\ndata: \{"ok":true,"code":"ok"/);
    // It is gone: a second removal is stale, and the other host is untouched.
    assert.equal((await remove(s, "server")).status, 409);
    assert.ok(existsSync(join(w.clone, "hosts/box.yaml")));
  });
});

test("a host with no key is removed without touching any secrets file", async () => {
  await withServer(async (s, w) => {
    const shared = w.read("secrets/shared.enc.yaml");
    const doc = (await (await remove(s, "box")).json()) as any;
    assert.equal(doc.ok, true, JSON.stringify(doc));
    assert.equal(existsSync(join(w.clone, "hosts/box.yaml")), false);
    assert.equal(w.read("secrets/shared.enc.yaml"), shared);
    assert.equal(git(w.clone, "show", "--stat", "--format=", "HEAD").includes("secrets/"), false);
  });
});

test("a fleet that keeps no secrets removes a host without running rekey", async () => {
  const bare = () => {
    const s = world();
    git(s.clone, "rm", "-r", "--quiet", ".sops.yaml", "secrets");
    publish(s.clone, "no secrets");
    return s;
  };
  await withServer(async (s, w) => {
    // The preview says so, and the page words the dialog from it.
    assert.equal(((await (await preview(s, "box")).json()) as any).rekey, false);
    const { state, done } = watch(s);
    const doc = (await (await remove(s, "box")).json()) as any;
    assert.equal(doc.ok, true, JSON.stringify(doc));
    await done;
    assert.equal(existsSync(join(w.clone, "hosts/box.yaml")), false);
    assert.equal(existsSync(join(w.clone, ".sops.yaml")), false);
    assert.equal(existsSync(join(w.clone, "secrets")), false);
    assert.doesNotMatch(state.seen, /fleet secrets rekey/);
    assert.equal(git(w.clone, "log", "-1", "--format=%s"), "Remove host box");
    assert.equal(git(w.clone, "rev-parse", "HEAD"), git(w.clone, "rev-parse", "origin/main"), "pushed");
  }, bare);
});

test("the host this page runs on and the only admin host are refused, by the preview and by the removal, and nothing is touched", async () => {
  await withServer(async (s, w) => {
    const head = git(w.clone, "rev-parse", "HEAD");
    // laptop is both: this machine's refusal comes first.
    for (const path of ["/api/hosts/remove/preview", "/api/hosts/remove"]) {
      const res = await post(s, path, { name: "laptop", confirm: true });
      assert.equal(res.status, 409);
      const doc = (await res.json()) as any;
      assert.equal(doc.code, "self");
      assert.equal(doc.messages[0], `fleet: ${REMOVE_SELF("laptop")}`);
    }
    // From another machine the admin is still refused: the page runs on `server` here.
    writeFileSync(join(w.home, ".config/fleet/host"), "server\n");
    for (const path of ["/api/hosts/remove/preview", "/api/hosts/remove"]) {
      const res = await post(s, path, { name: "laptop", confirm: true });
      assert.equal(res.status, 409);
      const doc = (await res.json()) as any;
      assert.equal(doc.code, "admin");
      assert.equal(doc.messages[0], `fleet: ${REMOVE_ADMIN("laptop")}`);
    }
    assert.equal(existsSync(join(w.clone, "hosts/laptop.yaml")), true);
    assert.equal(git(w.clone, "rev-parse", "HEAD"), head);
    assert.equal(git(w.clone, "status", "--porcelain"), "");
  });
});

test("a missing confirmation, a bad name and a host that is not there are refused before anything is touched", async () => {
  await withServer(async (s, w) => {
    const head = git(w.clone, "rev-parse", "HEAD");
    for (const bad of [{ name: "server" }, { name: "server", confirm: false }, { name: "server", confirm: "yes" }, { name: "../server", confirm: true }, { name: "", confirm: true }, { name: 3, confirm: true }, { name: "shared", confirm: true }, { name: "-x", confirm: true }]) {
      assert.equal((await post(s, "/api/hosts/remove", bad)).status, 400, JSON.stringify(bad));
    }
    const nobody = await remove(s, "nobody");
    assert.equal(nobody.status, 409);
    assert.equal(((await nobody.json()) as any).code, "stale");
    assert.equal(existsSync(join(w.clone, "hosts/server.yaml")), true);
    assert.equal(git(w.clone, "rev-parse", "HEAD"), head);
  });
});

test("it refuses while a push holds the lock, and when the repo has changes the page did not make", async () => {
  await withServer(async (s, w) => {
    const release = acquirePushLock(w.home);
    try {
      const res = await remove(s, "box");
      assert.equal(res.status, 409);
      assert.equal(((await res.json()) as any).code, "locked");
    } finally {
      release();
    }
    writeFileSync(join(w.clone, "hosts/laptop.yaml"), `${w.read("hosts/laptop.yaml")}# by hand\n`);
    const res = await remove(s, "box");
    assert.equal(res.status, 409);
    const doc = (await res.json()) as any;
    assert.equal(doc.code, "outside-changes");
    assert.deepEqual(doc.outside, [" M hosts/laptop.yaml"]);
    assert.equal(existsSync(join(w.clone, "hosts/box.yaml")), true);
  });
});

test("when rekey fails, every file is put back and nothing is committed", async () => {
  await withServer(async (s, w) => {
    // A shared file sops cannot read: rekey stops on it, after the host's files have been deleted.
    writeFileSync(join(w.clone, "secrets/shared.enc.yaml"), "not: a sops file\n");
    git(w.clone, "commit", "-qam", "break shared");
    const head = git(w.clone, "rev-parse", "HEAD");
    const sops = w.read(".sops.yaml");
    const hostText = w.read("hosts/server.yaml");
    const own = w.read("secrets/server.enc.yaml");
    const { state, done } = watch(s);
    const res = await remove(s, "server");
    const doc = (await res.json()) as any;
    assert.equal(doc.ok, false, JSON.stringify(doc));
    assert.equal(doc.removed, false);
    assert.match(doc.messages.join(" "), /did not finish/);
    assert.match(doc.messages.join(" "), /the repo is as it was/);
    await done;
    assert.match(state.seen, /event: removeend/);
    assert.equal(w.read("hosts/server.yaml"), hostText);
    assert.equal(w.read("secrets/server.enc.yaml"), own);
    assert.equal(w.read(".sops.yaml"), sops);
    assert.equal(git(w.clone, "rev-parse", "HEAD"), head);
    assert.equal(git(w.clone, "status", "--porcelain"), "");
    assert.equal(git(w.clone, "diff", "--cached", "--name-only"), "");
  });
});

test("when only the push fails, the removal stays committed and the page is told to push it", async () => {
  await withServer(async (s, w) => {
    git(w.clone, "remote", "set-url", "origin", join(w.clone, "nowhere.git"));
    const res = await remove(s, "box");
    const doc = (await res.json()) as any;
    assert.equal(doc.ok, false);
    assert.equal(doc.kept, true);
    assert.equal(doc.removed, true);
    assert.match(doc.messages.join(" "), /box is removed and committed, but it could not be pushed/);
    assert.equal(git(w.clone, "log", "-1", "--format=%s"), "Remove host box");
    assert.equal(existsSync(join(w.clone, "hosts/box.yaml")), false);
    assert.equal(git(w.clone, "status", "--porcelain"), "");
  });
});
