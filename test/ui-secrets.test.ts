import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, gitEnv, installFakeSsh, linkFleetSkill, makeClone, makeHome, publish, runFleet, tempDir, writeExecutable } from "./helpers.ts";
import { newIdentity } from "./initworld.ts";
import type { Identity } from "./initworld.ts";
import { startUi } from "../src/ui/server.ts";
import type { UiServer } from "../src/ui/server.ts";

// The server commits in this process, so git needs an author here too.
Object.assign(process.env, gitEnv);
import { findTool } from "../src/tools.ts";
import { EXIT } from "../src/exit.ts";

const SOPS = findTool("sops")!;
const applyOk = JSON.stringify({ ok: true, code: "ok", host: "remote", messages: [], created: [], updated: [], removed: [], conflicts: [] });

/** A value no other text in the test may contain: every body, stream and log is searched for it. */
const CANARY = "CANARY-7f3a91-do-not-leak";

/**
 * A config with three hosts that can hold secrets: laptop (this machine, the admin), remote (over the fake ssh) and edge
 * (timer only). Servers: tracker (laptop, TRACKER_API_KEY, already set there), docs (remote and edge, DOCS_TOKEN and
 * DOCS_REGION, set nowhere) and plain (no secret). Every key is a temp one.
 */
function world() {
  const ids = { laptop: newIdentity(), remote: newIdentity(), edge: newIdentity() } satisfies Record<string, Identity>;
  const { clone, remote } = makeClone();
  const home = makeHome("laptop");
  // fleet looks in the host's ~/.local/bin first: put the real sops and age-keygen there behind a script, which a test may overwrite.
  for (const tool of ["sops", "age-keygen"]) writeExecutable(join(home, ".local/bin", tool), `#!/bin/sh\nexec '${findTool(tool)}' "$@"\n`);
  mkdirSync(join(home, ".config/fleet"), { recursive: true });
  writeFileSync(join(home, ".config/fleet/age.key"), ids.laptop.key, { mode: 0o600 });
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(clone, rel)), { recursive: true });
    writeFileSync(join(clone, rel), content);
  };
  write("hosts/_defaults.yaml", "mcp:\n  include: [plain]\n");
  write("hosts/laptop.yaml", `admin: true\nage: ${ids.laptop.recipient}\nmcp:\n  include: [tracker]\n`);
  write("hosts/remote.yaml", `ssh: alice@remote\nage: ${ids.remote.recipient}\nmcp:\n  include: [docs]\n`);
  write("hosts/edge.yaml", `age: ${ids.edge.recipient}\nmcp:\n  include: [docs]\n`);
  write("hosts/bare.yaml", "age: \"\"\n");
  write(
    "catalog/mcp.yaml",
    "servers:\n  plain:\n    transport: http\n    url: https://plain.example.com/mcp\n  tracker:\n    transport: http\n    url: https://tracker.example.com/mcp\n    headers:\n      Authorization: secret:TRACKER_API_KEY\n  docs:\n    transport: http\n    url: https://docs.example.com/mcp\n    headers:\n      Authorization: secret:DOCS_TOKEN\n      X-Region: secret:DOCS_REGION\n",
  );
  write("catalog/skills.yaml", "sources: {}\nbundles: {}\n");
  publish(clone, "config");
  linkFleetSkill(home, clone);
  installFakeSsh(home, { "alice@remote": { stdout: applyOk } });
  // The one value that exists already: tracker's key on laptop, set the way `fleet secrets set` does.
  const r = runFleet(clone, ["secrets", "set", "laptop", "TRACKER_API_KEY"], { home, input: "tracker-old-value\n" });
  assert.equal(r.code, EXIT.ok, r.stderr);
  publish(clone, "tracker key");
  const decrypt = (file: string, name: string, who: Identity): string | null => {
    const keyPath = join(tempDir("fleet-key-"), "key");
    writeFileSync(keyPath, who.key, { mode: 0o600 });
    const out = spawnSync(SOPS, ["decrypt", "--extract", `["${name}"]`, join(clone, "secrets", `${file}.enc.yaml`)], { encoding: "utf8", env: { ...process.env, SOPS_AGE_KEY_FILE: keyPath } });
    return out.status === 0 ? out.stdout : null;
  };
  return { clone, remote, home, ids, write, decrypt };
}
type W = ReturnType<typeof world>;

/** Everything the server prints while a test runs, to search for a value in. */
function captureOutput() {
  const seen: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const take = (chunk: unknown) => void seen.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
  // The test runner's own reports travel on stdout too: only text that mentions the canary matters, and none may.
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (take(chunk), (out as (...a: unknown[]) => boolean)(chunk, ...rest))) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => (take(chunk), (err as (...a: unknown[]) => boolean)(chunk, ...rest))) as typeof process.stderr.write;
  return {
    seen,
    stop() {
      process.stdout.write = out;
      process.stderr.write = err;
    },
  };
}

async function withServer(body: (s: UiServer, w: W, bodies: string[]) => Promise<void>) {
  const w = world();
  const server = await startUi({ toolDir: w.clone, configDir: w.clone, home: w.home });
  const bodies: string[] = [];
  try {
    await body(server, w, bodies);
  } finally {
    await server.close();
  }
}

const base = (s: UiServer) => `http://127.0.0.1:${s.port}`;
const get = async (s: UiServer, path: string) => (await fetch(base(s) + path, { headers: { "x-fleet-token": s.token } })).json() as Promise<any>;
/** POSTs and returns the response text too, so a test can search every byte that came back. */
async function call(s: UiServer, path: string, body: unknown, bodies: string[] = [], raw?: string) {
  const res = await fetch(base(s) + path, { method: "POST", headers: { "x-fleet-token": s.token, origin: base(s), "content-type": "application/json" }, body: raw ?? JSON.stringify(body) });
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, text, doc: JSON.parse(text) as any };
}
const set = (s: UiServer, body: Record<string, unknown>, bodies: string[] = []) => call(s, "/api/secrets/set", { name: "DOCS_TOKEN", value: CANARY, files: ["remote"], ops: [], ...body }, bodies);
const read = (w: W, rel: string) => readFileSync(join(w.clone, rel), "utf8");
const leftovers = () => readdirSync(tmpdir()).filter((f) => f.startsWith("fleet-secret-"));

test("the table says set, missing or unused for each name and host, and picks the default targets", async () => {
  await withServer(async (s) => {
    const { table } = await get(s, "/api/secrets");
    assert.deepEqual(table.hosts, [{ name: "laptop", age: true }, { name: "bare", age: false }, { name: "edge", age: true }, { name: "remote", age: true }].sort((a, b) => (a.name === "laptop" ? -1 : b.name === "laptop" ? 1 : a.name.localeCompare(b.name))));
    const row = (name: string) => table.names.find((n: any) => n.name === name);
    assert.deepEqual(table.names.map((n: any) => n.name), ["DOCS_REGION", "DOCS_TOKEN", "TRACKER_API_KEY"]);
    assert.deepEqual(row("TRACKER_API_KEY").usedBy, ["tracker"]);
    const states = (name: string) => Object.fromEntries(Object.entries(row(name).cells).map(([h, c]: any) => [h, c.state]));
    assert.deepEqual(states("TRACKER_API_KEY"), { laptop: "set", remote: "unused", edge: "unused", bare: "unused" });
    assert.deepEqual(states("DOCS_TOKEN"), { laptop: "unused", remote: "missing", edge: "missing", bare: "unused" });
    assert.equal(row("TRACKER_API_KEY").cells.laptop.from, "host");
    // By default: the hosts that pick a server using it and lack it. When nobody lacks it, the hosts that hold it (a replacement).
    assert.deepEqual(row("DOCS_TOKEN").targets, ["edge", "remote"]);
    assert.deepEqual(row("TRACKER_API_KEY").targets, ["laptop"]);
    assert.doesNotMatch(JSON.stringify(table), /tracker-old-value|ENC\[/);
  });
});

test("a value set for one host is encrypted for that host and the admin, held, and written and pushed with the rest", async () => {
  const log = captureOutput();
  try {
    await withServer(async (s, w, bodies) => {
      const stream = await fetch(`${base(s)}/api/events?token=${s.token}`);
      const reader = stream.body!.getReader();
      let events = "";
      const reading = (async () => {
        const decoder = new TextDecoder();
        while (!events.includes("event: pushend")) {
          const { value, done } = await reader.read();
          if (done) break;
          events += decoder.decode(value);
        }
        await reader.cancel();
      })();

      const before = git(w.clone, "rev-parse", "HEAD");
      const made = await set(s, {}, bodies);
      assert.equal(made.status, 200, made.text);
      assert.equal(made.doc.ops.length, 1);
      const op = made.doc.ops[0];
      assert.deepEqual([op.op, op.file, op.names], ["setSecret", "secrets/remote.enc.yaml", ["DOCS_TOKEN"]]);
      assert.equal(op.base, "absent", "the file did not exist");
      assert.match(op.content, /^DOCS_TOKEN: ENC\[AES256_GCM,/);
      assert.deepEqual(made.doc.replaces, ["secrets/remote.enc.yaml"]);
      // Nothing was written: the repo is as it was, and no temp dir is left.
      assert.equal(git(w.clone, "status", "--porcelain"), "");
      assert.deepEqual(leftovers(), []);

      const held = made.doc.ops;
      const p = await call(s, "/api/preview", { ops: held }, bodies);
      assert.equal(p.status, 200, p.text);
      assert.deepEqual(p.doc.dropped, []);
      assert.deepEqual(p.doc.files.map((f: any) => f.path), ["secrets/remote.enc.yaml"]);
      // The review shows the name and a mark of the ciphertext, not the ciphertext.
      assert.match(p.doc.files[0].after, /^DOCS_TOKEN: ENC\[\.\.\.[0-9a-f]{6}\]\n$/);
      assert.equal(JSON.stringify(p.doc.files).includes("AES256_GCM"), false, "the review of the file holds no ciphertext");
      assert.equal(p.doc.secrets.names.find((n: any) => n.name === "DOCS_TOKEN").cells.remote.state, "set", "the table after the edits");
      assert.equal(git(w.clone, "status", "--porcelain"), "");

      const written = await call(s, "/api/write", { ops: held, message: "Set DOCS_TOKEN for remote" }, bodies);
      assert.equal(written.status, 200, written.text);
      assert.equal(written.doc.ok, true, written.text);
      assert.deepEqual(written.doc.written.files, ["secrets/remote.enc.yaml"]);
      assert.equal(git(w.clone, "log", "-1", "--format=%s"), "Set DOCS_TOKEN for remote");
      assert.equal(git(w.clone, "status", "--porcelain"), "");
      assert.equal(git(w.clone, "rev-parse", "HEAD"), git(w.clone, "rev-parse", "origin/main"), "pushed");
      assert.notEqual(git(w.clone, "rev-parse", "HEAD"), before);
      await reading;

      // The ciphertext opens with remote's key and with the admin's, and with no one else's.
      assert.equal(w.decrypt("remote", "DOCS_TOKEN", w.ids.remote), CANARY);
      assert.equal(w.decrypt("remote", "DOCS_TOKEN", w.ids.laptop), CANARY);
      assert.equal(w.decrypt("remote", "DOCS_TOKEN", w.ids.edge), null);
      assert.doesNotMatch(read(w, "secrets/remote.enc.yaml"), new RegExp(CANARY));
      assert.equal(git(w.clone, "log", "-p", "--all").includes(CANARY), false, "no commit holds the value");
      const after = (await get(s, "/api/secrets")).table.names.find((n: any) => n.name === "DOCS_TOKEN");
      assert.deepEqual(Object.fromEntries(Object.entries(after.cells).map(([h, c]: any) => [h, c.state])), { laptop: "unused", remote: "set", edge: "missing", bare: "unused" });
      assert.deepEqual(after.targets, ["edge"]);

      for (const text of [...bodies, events]) assert.equal(text.includes(CANARY), false, "no answer or event holds the value");
    });
  } finally {
    log.stop();
  }
  assert.equal(log.seen.some((t) => t.includes(CANARY)), false, "the server printed nothing with the value");
});

test("two hosts at once, the shared file and a second name for the same file give one held edit per file", async () => {
  await withServer(async (s, w, bodies) => {
    const two = await set(s, { files: ["remote", "edge", "shared"] }, bodies);
    assert.equal(two.status, 200, two.text);
    assert.deepEqual(two.doc.ops.map((o: any) => o.file), ["secrets/remote.enc.yaml", "secrets/edge.enc.yaml", "secrets/shared.enc.yaml"]);
    // A second name for the remote file replaces its held edit, built on the first: both names are in the one edit, from the disk file.
    const more = await set(s, { name: "DOCS_REGION", value: "eu-fake-1", files: ["remote"], ops: two.doc.ops }, bodies);
    assert.equal(more.status, 200, more.text);
    assert.equal(more.doc.ops.length, 1);
    assert.deepEqual(more.doc.ops[0].names, ["DOCS_TOKEN", "DOCS_REGION"]);
    assert.equal(more.doc.ops[0].base, "absent");
    const held = [...two.doc.ops.filter((o: any) => !more.doc.replaces.includes(o.file)), ...more.doc.ops];
    const written = await call(s, "/api/write", { ops: held, message: "Set secrets" }, bodies);
    assert.equal(written.status, 200, written.text);
    assert.deepEqual([...written.doc.written.files].sort(), ["secrets/edge.enc.yaml", "secrets/remote.enc.yaml", "secrets/shared.enc.yaml"]);
    assert.equal(w.decrypt("remote", "DOCS_TOKEN", w.ids.remote), CANARY);
    assert.equal(w.decrypt("remote", "DOCS_REGION", w.ids.remote), "eu-fake-1");
    assert.equal(w.decrypt("edge", "DOCS_TOKEN", w.ids.edge), CANARY);
    assert.equal(w.decrypt("shared", "DOCS_TOKEN", w.ids.edge), CANARY, "shared is encrypted for every host with a key");
    assert.equal(w.decrypt("shared", "DOCS_TOKEN", w.ids.remote), CANARY);
    assert.equal(w.decrypt("shared", "DOCS_TOKEN", w.ids.laptop), CANARY);
    // Replacing a value in an existing file leaves the other names' ciphertext byte for byte, and changes this one.
    const before = read(w, "secrets/laptop.enc.yaml").split("\n").find((l) => l.startsWith("TRACKER_API_KEY:"));
    const replace = await set(s, { name: "TRACKER_API_KEY", value: "tracker-new-value", files: ["laptop"] }, bodies);
    assert.equal(replace.status, 200, replace.text);
    assert.equal(replace.doc.ops[0].base.length, 64);
    assert.notEqual(replace.doc.ops[0].content.split("\n").find((l: string) => l.startsWith("TRACKER_API_KEY:")), before);
    // Only the name that was set differs, so the engine accepts it as a replacement.
    const replayed = await call(s, "/api/preview", { ops: replace.doc.ops }, bodies);
    assert.deepEqual(replayed.doc.dropped, []);
    assert.deepEqual(replayed.doc.files.map((f: any) => f.path), ["secrets/laptop.enc.yaml"]);
    const [was, now] = [replayed.doc.files[0].before, replayed.doc.files[0].after];
    assert.notEqual(was, now);
    for (const text of bodies) assert.equal(text.includes(CANARY), false);
  });
});

test("a bad name, a bad value, an unknown host, a bad file and a host with no key are refused, and the answer never repeats the value", async () => {
  await withServer(async (s, w, bodies) => {
    const head = git(w.clone, "rev-parse", "HEAD");
    for (const bad of [
      { name: "lower" }, { name: "A B" }, { name: "../X" }, { name: 3 }, { name: "" },
      { value: "" }, { value: 12 }, { value: CANARY.repeat(400) },
      { files: [] }, { files: ["nowhere"] }, { files: ["../remote"] }, { files: "remote" }, { files: [3] }, { files: ["shared", "ghost"] },
    ]) {
      const r = await set(s, bad, bodies);
      assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 100));
      assert.equal(r.doc.code, "invalid");
    }
    const none = await set(s, { files: ["bare"] }, bodies);
    assert.equal(none.status, 422);
    assert.equal(none.doc.code, "no-recipient");
    assert.deepEqual(leftovers(), []);
    assert.equal(git(w.clone, "status", "--porcelain"), "");
    assert.equal(git(w.clone, "rev-parse", "HEAD"), head);
    // A body that is not JSON is refused without repeating any of it.
    const cut = await call(s, "/api/secrets/set", null, bodies, `{"name":"DOCS_TOKEN","value":"${CANARY}`);
    assert.equal(cut.status, 400);
    for (const text of bodies) assert.equal(text.includes(CANARY), false);
  });
});

test("a held edit is refused as stale when the file changed on disk meanwhile, and nothing is overwritten", async () => {
  await withServer(async (s, w, bodies) => {
    const made = await set(s, { name: "TRACKER_API_KEY", value: CANARY, files: ["laptop"] }, bodies);
    assert.equal(made.status, 200, made.text);
    // Someone changes the same file after the value was encrypted (here: the CLI, then a commit).
    const r = runFleet(w.clone, ["secrets", "set", "laptop", "OTHER_KEY"], { home: w.home, input: "other\n" });
    assert.equal(r.code, EXIT.ok, r.stderr);
    publish(w.clone, "someone else's secret");
    const disk = read(w, "secrets/laptop.enc.yaml");
    const p = await call(s, "/api/preview", { ops: made.doc.ops }, bodies);
    assert.equal(p.status, 200);
    assert.deepEqual(p.doc.dropped.map((d: any) => [d.why, d.op.op]), [["stale", "setSecret"]]);
    assert.match(p.doc.dropped[0].reason, /not what the value was encrypted into/);
    assert.deepEqual(p.doc.files, []);
    const head = git(w.clone, "rev-parse", "HEAD");
    const written = await call(s, "/api/write", { ops: made.doc.ops, message: "Replace the tracker key" }, bodies);
    assert.equal(written.status, 409);
    assert.equal(written.doc.code, "stale");
    assert.equal(read(w, "secrets/laptop.enc.yaml"), disk, "the file is as the other change left it");
    assert.equal(git(w.clone, "rev-parse", "HEAD"), head);
    // A second value for a file whose held edit is stale is refused too: the page must forget the stale one first.
    const again = await set(s, { name: "TRACKER_API_KEY", value: CANARY, files: ["laptop"], ops: made.doc.ops }, bodies);
    assert.equal(again.status, 409);
    assert.equal(again.doc.code, "stale");
    for (const text of bodies) assert.equal(text.includes(CANARY), false);
  });
});

test("an edit that is not a clean sops file, is for the wrong recipients, deletes a name or sets another is refused", async () => {
  await withServer(async (s, w, bodies) => {
    const good = (await set(s, {}, bodies)).doc.ops[0];
    const attempt = (over: Record<string, unknown>) => call(s, "/api/preview", { ops: [{ ...good, ...over }] }, bodies);
    const status = async (over: Record<string, unknown>) => (await attempt(over)).status;
    // Shape and text: refused as a bad request.
    assert.equal(await status({ file: "secrets/../x.enc.yaml" }), 400);
    assert.equal(await status({ file: "hosts/laptop.yaml" }), 400);
    assert.equal(await status({ file: "secrets/remote.enc.yml" }), 400);
    assert.equal(await status({ names: ["lower"] }), 400);
    assert.equal(await status({ names: [] }), 400);
    assert.equal(await status({ names: ["OTHER"] }), 400, "the file does not hold that name");
    assert.equal(await status({ base: "nonsense" }), 400);
    assert.equal(await status({ content: "DOCS_TOKEN: plaintext-value\nsops:\n  version: 3\n" }), 400, "a plaintext value");
    assert.equal(await status({ content: good.content + "EXTRA: ENC[AES256_GCM,data:x]\n" }), 400, "a key after the sops block");
    assert.equal(await status({ content: good.content.replace("sops:", "sops: {}\nsops:") }), 400, "a repeated block");
    assert.equal(await status({ content: "DOCS_TOKEN: ENC[AES256_GCM,data:x]\n" }), 400, "no sops block");
    assert.equal(await status({ content: undefined }), 400);
    // The recipients must be the ones .sops.yaml names for that file: remote's ciphertext under edge's path is not.
    const wrongFile = await attempt({ file: "secrets/edge.enc.yaml" });
    assert.equal(wrongFile.status, 400);
    assert.match(wrongFile.doc.messages[0], /not encrypted for the recipients/);
    const noKey = await attempt({ file: "secrets/bare.enc.yaml" });
    assert.equal(noKey.status, 400);
    assert.match(noKey.doc.messages[0], /host with an age recipient/);
    // The write refuses the same, before the lock and before any file.
    const head = git(w.clone, "rev-parse", "HEAD");
    const refused = await call(s, "/api/write", { ops: [{ ...good, file: "secrets/edge.enc.yaml" }], message: "x" }, bodies);
    assert.equal(refused.status, 400);
    assert.equal(git(w.clone, "rev-parse", "HEAD"), head);

    // Deleting or rewriting another name in the file is stale, never written: build an edit for the laptop file that drops its key.
    const laptop = (await set(s, { name: "OTHER_KEY", value: "v", files: ["laptop"] }, bodies)).doc.ops[0];
    const dropped = { ...laptop, base: laptop.base, content: laptop.content.split("\n").filter((l: string) => !l.startsWith("TRACKER_API_KEY:")).join("\n") };
    const lost = await call(s, "/api/preview", { ops: [dropped] }, bodies);
    assert.equal(lost.status, 200, lost.text);
    assert.deepEqual(lost.doc.dropped.map((d: any) => d.why), ["stale"]);
    assert.match(lost.doc.dropped[0].reason, /does not match what it was made from/);
    const rewritten = { ...laptop, names: ["OTHER_KEY"], content: laptop.content.replace(/^(TRACKER_API_KEY: ENC\[AES256_GCM,data:)/m, "$1AA") };
    const moved = await call(s, "/api/preview", { ops: [rewritten] }, bodies);
    assert.deepEqual(moved.doc.dropped.map((d: any) => d.why), ["stale"], "a name that was not asked for may not change");
    for (const text of bodies) assert.equal(text.includes(CANARY), false);
  });
});

test("a failing sops, one that is missing and a key that cannot open the file give fixed messages that hold neither the value nor what sops said", async () => {
  const log = captureOutput();
  try {
    await withServer(async (s, w, bodies) => {
      // A sops that says what a real one can: the stdin it was given, in its error. It must not reach an answer.
      writeExecutable(
        join(w.home, ".local/bin/sops"),
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "sops 3.11.0"; exit 0; fi\nINPUT=$(cat)\necho "error with context: $INPUT while reading /secret/place" >&2\nexit 128\n`,
      );
      const failed = await set(s, {}, bodies);
      assert.equal(failed.status, 422);
      assert.equal(failed.doc.code, "sops-failed");
      assert.match(failed.doc.messages[0], /^fleet: sops could not (set the value in|create) secrets\/remote\.enc\.yaml$/);
      assert.doesNotMatch(failed.text, /error with context|\/secret\/place/);
      assert.deepEqual(leftovers(), []);

      // sops that cannot open the file (an existing one, this machine is no recipient): a fixed sentence, again not sops' own.
      writeExecutable(
        join(w.home, ".local/bin/sops"),
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "sops 3.11.0"; exit 0; fi\nINPUT=$(cat)\necho "Failed to get the data key required to decrypt the data: $INPUT" >&2\nexit 128\n`,
      );
      const locked = await set(s, { name: "TRACKER_API_KEY", files: ["laptop"] }, bodies);
      assert.equal(locked.status, 422);
      assert.match(locked.doc.messages[0], /^fleet: this machine's age key cannot open secrets\/laptop\.enc\.yaml: only a host that is a recipient of it can add to it$/);
      assert.deepEqual(leftovers(), []);

      // A sops that is too old or unreadable is refused by fleet's own check, with its own words.
      writeExecutable(join(w.home, ".local/bin/sops"), `#!/bin/sh\necho "garbage $(cat)"\nexit 0\n`);
      const odd = await set(s, {}, bodies);
      assert.equal(odd.status, 422);
      assert.equal(odd.doc.code, "needs-secret");

      // No age key on this machine.
      writeExecutable(join(w.home, ".local/bin/sops"), `#!/bin/sh\nexit 1\n`);
      for (const bodyText of bodies) assert.equal(bodyText.includes(CANARY), false);
      assert.equal(git(w.clone, "status", "--porcelain"), "");
    });
  } finally {
    log.stop();
  }
  assert.equal(log.seen.some((t) => t.includes(CANARY)), false);
});

test("without an age key on this machine the answer says so, and holds nothing of the value", async () => {
  await withServer(async (s, w, bodies) => {
    writeFileSync(join(w.home, ".config/fleet/.keep"), "");
    spawnSync("rm", ["-f", join(w.home, ".config/fleet/age.key")]);
    const r = await set(s, {}, bodies);
    assert.equal(r.status, 422);
    assert.equal(r.doc.code, "needs-secret");
    assert.match(r.doc.messages[0], /no age key/);
    for (const text of bodies) assert.equal(text.includes(CANARY), false);
  });
});

test("the route needs the token and the Origin like every write, and the body is not echoed to a browser that is not the page", async () => {
  await withServer(async (s, _w, bodies) => {
    const body = JSON.stringify({ name: "DOCS_TOKEN", value: CANARY, files: ["remote"], ops: [] });
    const noToken = await fetch(`${base(s)}/api/secrets/set`, { method: "POST", headers: { origin: base(s), "content-type": "application/json" }, body });
    assert.equal(noToken.status, 401);
    const wrongOrigin = await fetch(`${base(s)}/api/secrets/set`, { method: "POST", headers: { "x-fleet-token": s.token, origin: "http://evil.example", "content-type": "application/json" }, body });
    assert.equal(wrongOrigin.status, 403);
    const form = await fetch(`${base(s)}/api/secrets/set`, { method: "POST", headers: { "x-fleet-token": s.token, origin: base(s), "content-type": "text/plain" }, body });
    assert.equal(form.status, 400);
    for (const res of [noToken, wrongOrigin, form]) bodies.push(await res.text());
    for (const text of bodies) assert.equal(text.includes(CANARY), false);
    const get405 = await fetch(`${base(s)}/api/secrets/set`, { headers: { "x-fleet-token": s.token } });
    assert.equal(get405.status, 405);
  });
});
