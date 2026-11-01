import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeClone, skipIfSystemWide, makeHome, publish, runFleet, tempDir, writeExecutable } from "./helpers.ts";
import { EXIT } from "../src/exit.ts";
import { findTool } from "../src/tools.ts";

const SOPS = findTool("sops");
const AGE_KEYGEN = findTool("age-keygen");
if (SOPS === null || AGE_KEYGEN === null) throw new Error("these tests need sops and age-keygen on the probe path");

type Identity = { key: string; recipient: string };

function newIdentity(): Identity {
  const key = spawnSync(AGE_KEYGEN!, [], { encoding: "utf8" }).stdout;
  const recipient = spawnSync(AGE_KEYGEN!, ["-y"], { encoding: "utf8", input: key }).stdout.trim();
  return { key, recipient };
}

type HostSpec = { admin?: boolean; identity: Identity | null; yaml?: string };

function setup(opts: { hosts?: Record<string, HostSpec>; defaults?: string; installSops?: boolean } = {}) {
  const hosts = opts.hosts ?? {
    laptop: { admin: true, identity: newIdentity() },
    server: { identity: newIdentity() },
  };
  const { clone } = makeClone();
  const home = makeHome("laptop");
  if (opts.installSops !== false) {
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    for (const [name, path] of [["sops", SOPS!], ["age-keygen", AGE_KEYGEN!]] as const) symlinkSync(path, join(home, ".local/bin", name));
  }
  const keyFile = join(home, ".config/fleet/age.key");
  const writeKey = (identity: Identity) => {
    mkdirSync(dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, identity.key, { mode: 0o600 });
  };
  if (hosts.laptop?.identity) writeKey(hosts.laptop.identity);

  const writeYaml = (name: string, yaml: string) => {
    mkdirSync(join(clone, "hosts"), { recursive: true });
    writeFileSync(join(clone, "hosts", name), yaml);
  };
  writeYaml("_defaults.yaml", opts.defaults ?? "{}\n");
  for (const [name, spec] of Object.entries(hosts)) {
    const lines = [spec.admin ? "admin: true" : "", spec.identity ? `age: ${spec.identity.recipient}` : 'age: ""', spec.yaml ?? ""];
    writeYaml(`${name}.yaml`, `${lines.filter((l) => l !== "").join("\n")}\n`);
  }

  const setHost = (name: string, yaml: string) => {
    const spec = hosts[name]!;
    writeYaml(`${name}.yaml`, `${[spec.admin ? "admin: true" : "", spec.identity ? `age: ${spec.identity.recipient}` : 'age: ""'].filter((l) => l !== "").join("\n")}\n${yaml}`);
  };
  const run = (args: string[], o: { input?: string; env?: Record<string, string> } = {}) => (publish(clone), runFleet(clone, args, { home, ...o }));
  const json = (args: string[]) => {
    const r = run([...args, "--json"]);
    return { r, doc: JSON.parse(r.stdout) };
  };
  const decrypt = (file: string, name: string, identity: Identity = hosts.laptop!.identity!): string => {
    const keyPath = join(tempDir("fleet-key-"), "key");
    writeFileSync(keyPath, identity.key, { mode: 0o600 });
    const r = spawnSync(SOPS!, ["decrypt", "--extract", `["${name}"]`, join(clone, "secrets", `${file}.enc.yaml`)], {
      encoding: "utf8",
      env: { ...process.env, SOPS_AGE_KEY_FILE: keyPath },
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  return { clone, home, hosts, keyFile, writeYaml, setHost, writeKey, run, json, decrypt, read: (rel: string) => readFileSync(join(clone, rel), "utf8") };
}

test("secrets set reads the value from stdin and encrypts it into the file, creating it", () => {
  const s = setup();
  const r = s.run(["secrets", "set", "shared", "DEPLOYER_ACCESS_TOKEN"], { input: "tok-123\n" });
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(s.decrypt("shared", "DEPLOYER_ACCESS_TOKEN"), "tok-123");
  assert.doesNotMatch(s.read("secrets/shared.enc.yaml"), /tok-123/);
  assert.equal(r.stdout.includes("tok-123") || r.stderr.includes("tok-123"), false);
});

test("secrets set never accepts the value as an argument, and does not echo it", () => {
  const s = setup();
  const r = s.run(["secrets", "set", "shared", "DEPLOYER_ACCESS_TOKEN", "hunter2-argv"]);
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /stdin/);
  assert.equal((r.stdout + r.stderr).includes("hunter2-argv"), false);
});

test("secrets set keeps a value with spaces and newlines intact, minus one trailing newline", () => {
  const s = setup();
  assert.equal(s.run(["secrets", "set", "laptop", "TRACKER_API_KEY"], { input: "a b\nc \"quoted\"\n" }).code, EXIT.ok);
  assert.equal(s.decrypt("laptop", "TRACKER_API_KEY"), 'a b\nc "quoted"');
});

test("secrets set rejects an empty value, a bad name and an unknown file with exit 2", () => {
  const s = setup();
  assert.equal(s.run(["secrets", "set", "shared", "TOKEN"], { input: "\n" }).code, EXIT.invalid);
  assert.equal(s.run(["secrets", "set", "shared", "lower"], { input: "x" }).code, EXIT.invalid);
  assert.equal(s.run(["secrets", "set", "nowhere", "TOKEN"], { input: "x" }).code, EXIT.invalid);
});

test("secrets set for a host with no age recipient exits 2", () => {
  const s = setup({ hosts: { laptop: { admin: true, identity: newIdentity() }, server: { identity: null } } });
  const r = s.run(["secrets", "set", "server", "TOKEN"], { input: "x" });
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /server.*age recipient/);
});

test(".sops.yaml sends shared to every host with a recipient and a host file to that host plus the admin", () => {
  const laptop = newIdentity();
  const lab = newIdentity();
  const extra = newIdentity();
  const s = setup({
    hosts: {
      laptop: { admin: true, identity: laptop },
      server: { identity: lab },
      newbox: { identity: null },
      third: { identity: extra },
    },
  });
  assert.equal(s.run(["secrets", "set", "shared", "A"], { input: "x" }).code, EXIT.ok);
  const config = s.read(".sops.yaml");
  const rules = [...config.matchAll(/path_regex: '(.+)\$'\n    age: (.+)\n/g)].map((m) => [m[1], m[2]]);
  const sorted = (...r: Identity[]) => r.map((i) => i.recipient).sort().join(",");
  assert.deepEqual(rules, [
    ["secrets/shared\\.enc\\.yaml", sorted(laptop, lab, extra)],
    ["secrets/laptop\\.enc\\.yaml", laptop.recipient],
    ["secrets/server\\.enc\\.yaml", sorted(lab, laptop)],
    ["secrets/third\\.enc\\.yaml", sorted(extra, laptop)],
  ]);
  assert.equal(config.includes("newbox"), false);
});

test("a host file is readable by that host and by the admin", () => {
  const s = setup();
  assert.equal(s.run(["secrets", "set", "server", "METRICS_SERVICE_ACCOUNT_TOKEN"], { input: "g-1" }).code, EXIT.ok);
  assert.equal(s.decrypt("server", "METRICS_SERVICE_ACCOUNT_TOKEN", s.hosts.server!.identity!), "g-1");
  assert.equal(s.decrypt("server", "METRICS_SERVICE_ACCOUNT_TOKEN"), "g-1");
});

test("secrets set without exactly one admin host exits 2", () => {
  const s = setup({ hosts: { laptop: { identity: newIdentity() }, server: { identity: newIdentity() } } });
  const r = s.run(["secrets", "set", "shared", "A"], { input: "x" });
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /admin/);
});

test("secrets edit without a TTY exits 2", () => {
  const s = setup();
  const r = s.run(["secrets", "edit", "shared"], { env: { EDITOR: "true" } });
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /terminal|TTY/);
});

test("rekey regenerates .sops.yaml, re-encrypts every file for the new recipients, and says tokens still need rotating", () => {
  const s = setup();
  s.run(["secrets", "set", "shared", "DEPLOYER_ACCESS_TOKEN"], { input: "c-1" });
  s.run(["secrets", "set", "server", "ERRORS_ACCESS_TOKEN"], { input: "s-1" });
  const newcomer = newIdentity();
  s.writeYaml("newbox.yaml", `age: ${newcomer.recipient}\n`);
  const r = s.run(["secrets", "rekey"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stdout + r.stderr, /rotat/);
  assert.match(s.read(".sops.yaml"), /secrets\/newbox\\\.enc\\\.yaml/);
  assert.equal(s.decrypt("shared", "DEPLOYER_ACCESS_TOKEN", newcomer), "c-1");
  assert.equal(s.decrypt("server", "ERRORS_ACCESS_TOKEN"), "s-1");
});

test("rekey cuts off a host whose recipient was removed", () => {
  const lab = newIdentity();
  const s = setup({ hosts: { laptop: { admin: true, identity: newIdentity() }, server: { identity: lab } } });
  s.run(["secrets", "set", "shared", "DEPLOYER_ACCESS_TOKEN"], { input: "c-1" });
  s.writeYaml("server.yaml", 'age: ""\n');
  assert.equal(s.run(["secrets", "rekey"]).code, EXIT.ok);
  const keyPath = join(tempDir("fleet-key-"), "key");
  writeFileSync(keyPath, lab.key);
  const r = spawnSync(SOPS!, ["decrypt", join(s.clone, "secrets/shared.enc.yaml")], { encoding: "utf8", env: { ...process.env, SOPS_AGE_KEY_FILE: keyPath } });
  assert.notEqual(r.status, 0);
  assert.equal(s.decrypt("shared", "DEPLOYER_ACCESS_TOKEN"), "c-1");
});

test("rekey --json lists the files it updated and keeps the rotation warning in messages", () => {
  const s = setup();
  s.run(["secrets", "set", "shared", "A"], { input: "x" });
  const { r, doc } = s.json(["secrets", "rekey"]);
  assert.equal(r.code, EXIT.ok);
  assert.deepEqual(doc.rekeyed, ["secrets/shared.enc.yaml"]);
  assert.match(doc.messages.join("\n"), /rotate/);
});

test("rekey with no key file exits 5 and with no secrets files does nothing but write .sops.yaml", () => {
  const empty = setup();
  const r1 = empty.run(["secrets", "rekey"]);
  assert.equal(r1.code, EXIT.ok, r1.stderr);
  const s = setup();
  s.run(["secrets", "set", "shared", "A"], { input: "x" });
  rmSync(s.keyFile);
  assert.equal(s.run(["secrets", "rekey"]).code, EXIT["needs-secret"]);
});

const CLAUDE_SETTINGS = (home: string) => join(home, ".claude/settings.json");
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

const tokenSetting = (value: string) => `settings:\n  claude:\n    env:\n      TOKEN: ${JSON.stringify(value)}\n`;

test("apply renders secret:NAME into a settings value, alone and inside a longer string", () => {
  const s = setup();
  s.run(["secrets", "set", "shared", "DEPLOYER_ACCESS_TOKEN"], { input: "tok-abc" });
  s.setHost("laptop", `settings:\n  claude:\n    env:\n      ALONE: secret:DEPLOYER_ACCESS_TOKEN\n      LONGER: "Bearer secret:DEPLOYER_ACCESS_TOKEN!"\n      TWICE: "secret:DEPLOYER_ACCESS_TOKEN/secret:DEPLOYER_ACCESS_TOKEN"\n`);
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(readJson(CLAUDE_SETTINGS(s.home)).env, {
    ALONE: "tok-abc",
    LONGER: "Bearer tok-abc!",
    TWICE: "tok-abc/tok-abc",
  });
});

test("a secret value that looks like a reference is not expanded again", () => {
  const s = setup();
  s.run(["secrets", "set", "shared", "OUTER"], { input: "secret:INNER" });
  s.run(["secrets", "set", "shared", "INNER"], { input: "deep" });
  s.setHost("laptop", tokenSetting("secret:OUTER"));
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.equal(readJson(CLAUDE_SETTINGS(s.home)).env.TOKEN, "secret:INNER");
});

test("the host file wins over shared for the same name", () => {
  const s = setup();
  s.run(["secrets", "set", "shared", "TOKEN"], { input: "from-shared" });
  s.run(["secrets", "set", "laptop", "TOKEN"], { input: "from-host" });
  s.setHost("laptop", tokenSetting("secret:TOKEN"));
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.equal(readJson(CLAUDE_SETTINGS(s.home)).env.TOKEN, "from-host");
});

test("only the names the host uses are decrypted, one at a time", () => {
  const s = setup();
  s.run(["secrets", "set", "shared", "USED"], { input: "u" });
  s.run(["secrets", "set", "shared", "UNUSED"], { input: "n" });
  s.run(["secrets", "set", "laptop", "OTHER_UNUSED"], { input: "o" });
  const log = join(s.home, "sops-calls.log");
  rmSync(join(s.home, ".local/bin/sops"));
  writeExecutable(join(s.home, ".local/bin/sops"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${SOPS}' "$@"\n`);
  s.setHost("laptop", tokenSetting("secret:USED"));
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  const decrypts = readFileSync(log, "utf8").split("\n").filter((l) => /\bdecrypt\b/.test(l));
  assert.equal(decrypts.length, 1, decrypts.join("\n"));
  assert.match(decrypts[0]!, /--extract \["USED"\] secrets\/shared\.enc\.yaml$/);
});

test("a name is decrypted once even when several settings use it", () => {
  const s = setup();
  s.run(["secrets", "set", "shared", "A"], { input: "a" });
  const log = join(s.home, "sops-calls.log");
  rmSync(join(s.home, ".local/bin/sops"));
  writeExecutable(join(s.home, ".local/bin/sops"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${SOPS}' "$@"\n`);
  s.setHost("laptop", "settings:\n  claude:\n    env: { ONE: secret:A, TWO: secret:A }\n  opencode:\n    x: secret:A\n");
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.equal(readFileSync(log, "utf8").split("\n").filter((l) => /\bdecrypt\b/.test(l)).length, 1);
});

const assertNothingWritten = (s: ReturnType<typeof setup>) => {
  assert.equal(existsSync(CLAUDE_SETTINGS(s.home)), false);
  assert.equal(existsSync(join(s.home, ".local/state/fleet/applied.json")), false);
};

test("a name in neither file exits 5 before any write, naming the name and both files", () => {
  const s = setup();
  s.run(["secrets", "set", "shared", "OTHER"], { input: "x" });
  s.setHost("laptop", tokenSetting("secret:MISSING_ONE") + "    other: secret:OTHER\n");
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT["needs-secret"]);
  assert.match(r.stderr, /MISSING_ONE/);
  assert.match(r.stderr, /secrets\/laptop\.enc\.yaml/);
  assert.match(r.stderr, /secrets\/shared\.enc\.yaml/);
  assertNothingWritten(s);
});

test("a missing secrets file counts as no names, so the lookup falls through to shared", () => {
  const s = setup();
  s.run(["secrets", "set", "shared", "TOKEN"], { input: "only-shared" });
  s.setHost("laptop", tokenSetting("secret:TOKEN"));
  assert.equal(existsSync(join(s.clone, "secrets/laptop.enc.yaml")), false);
  assert.equal(s.run(["apply"]).code, EXIT.ok);
});

test("a missing age key exits 5 before any write", () => {
  const s = setup();
  s.run(["secrets", "set", "shared", "TOKEN"], { input: "x" });
  s.setHost("laptop", tokenSetting("secret:TOKEN"));
  rmSync(s.keyFile);
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT["needs-secret"]);
  assert.match(r.stderr, /age key/);
  assertNothingWritten(s);
});

test("a key that is not a recipient exits 5 before any write", () => {
  const s = setup();
  s.run(["secrets", "set", "shared", "TOKEN"], { input: "x" });
  s.setHost("laptop", tokenSetting("secret:TOKEN"));
  s.writeKey(newIdentity());
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT["needs-secret"]);
  assert.match(r.stderr, /TOKEN/);
  assertNothingWritten(s);
});

test("a missing sops exits 5 before any write, but only when a secret is used", { skip: skipIfSystemWide("sops") }, () => {
  const s = setup({ installSops: false });
  s.setHost("laptop", tokenSetting("secret:TOKEN"));
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT["needs-secret"]);
  assert.match(r.stderr, /sops is not installed/);
  assertNothingWritten(s);
  s.setHost("laptop", tokenSetting("plain"));
  assert.equal(s.run(["apply"]).code, EXIT.ok);
});

for (const [version, ok] of [["3.10.4", false], ["3.11.0", true], ["3.9.0", false], ["4.0.0", true]] as const) {
  test(`sops ${version} is ${ok ? "accepted" : "too old: exit 5 before any write"}`, () => {
    const s = setup({ installSops: false });
    // Fake sops: reports a version, and decrypts to a fixed value when asked to.
    writeExecutable(join(s.home, ".local/bin/sops"), `#!/bin/sh\ncase "$1" in --version) echo 'sops ${version} (latest)';; *) printf fake;; esac\n`);
    mkdirSync(join(s.clone, "secrets"), { recursive: true });
    writeFileSync(join(s.clone, "secrets/shared.enc.yaml"), "TOKEN: ENC[x]\nsops: {}\n");
    writeFileSync(s.keyFile, "key");
    s.setHost("laptop", tokenSetting("secret:TOKEN"));
    const r = s.run(["apply"]);
    if (ok) {
      assert.equal(r.code, EXIT.ok, r.stderr);
    } else {
      assert.equal(r.code, EXIT["needs-secret"]);
      assert.match(r.stderr, new RegExp(`sops ${version.replaceAll(".", "\\.")} is too old.*3\\.11\\.0`));
      assertNothingWritten(s);
    }
  });
}

test("secret: is rejected in vars and in files, with exit 2 and nothing written", () => {
  for (const yaml of [
    'vars:\n  URL: "https://x/secret:TOKEN"\n',
    "files:\n  - { source: config/secret:TOKEN, target: ~/.x }\n",
    "files:\n  - { source: config/a.md, target: ~/secret:TOKEN }\n",
  ]) {
    const s = setup();
    s.setHost("laptop", yaml);
    const r = s.run(["apply"]);
    assert.equal(r.code, EXIT.invalid, yaml);
    assert.match(r.stderr, /secret/);
    assertNothingWritten(s);
  }
});

test("secret: is rejected in vars of the defaults file too", () => {
  const s = setup({ defaults: 'vars:\n  A: "secret:TOKEN"\n' });
  const r = s.run(["diff"]);
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /_defaults\.yaml.*vars\.A/);
});

test("{{ vars.NAME }} renders into settings from defaults, the host file and the built-in HOME", () => {
  const s = setup({ defaults: "vars:\n  A: from-defaults\n  B: from-defaults\n" });
  s.setHost("laptop", 'vars:\n  B: from-host\nsettings:\n  claude:\n    env:\n      ONE: "{{ vars.A }}-{{vars.B}}"\n      TWO: "{{ vars.HOME }}/x"\n');
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  assert.deepEqual(readJson(CLAUDE_SETTINGS(s.home)).env, { ONE: "from-defaults-from-host", TWO: `${s.home}/x` });
});

test("an unknown variable exits 2 naming it, before any write", () => {
  const s = setup();
  s.setHost("laptop", 'settings:\n  claude:\n    env:\n      ONE: "{{ vars.NOPE }}"\n');
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.invalid);
  assert.match(r.stderr, /vars\.NOPE/);
  assertNothingWritten(s);
});

const PLAINTEXT = "plaintext-hunter2-do-not-leak";

function leakSetup() {
  const s = setup();
  s.run(["secrets", "set", "shared", "DEPLOYER_ACCESS_TOKEN"], { input: PLAINTEXT });
  s.setHost("laptop", tokenSetting("Bearer secret:DEPLOYER_ACCESS_TOKEN"));
  return s;
}

test("fleet diff shows *** where a secret was rendered and never the secret", () => {
  const s = leakSetup();
  const r = s.run(["diff"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stdout, /create ~\/\.claude\/settings\.json env\.TOKEN = "Bearer \*\*\*"/);
  assert.equal((r.stdout + r.stderr).includes(PLAINTEXT), false);
  assert.equal(existsSync(CLAUDE_SETTINGS(s.home)), false);
});

test("no plaintext reaches stdout, stderr or applied state, in text or JSON, on first apply, update and no-op", () => {
  const s = leakSetup();
  const seen = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;
  const outputs = [s.run(["apply"]), s.run(["apply", "--json"]), s.run(["diff"]), s.run(["diff", "--json"])];
  s.run(["secrets", "set", "shared", "DEPLOYER_ACCESS_TOKEN"], { input: `${PLAINTEXT}-v2` });
  outputs.push(s.run(["diff"]), s.run(["apply"]), s.run(["apply", "--json"]), s.run(["status"]));
  for (const r of outputs) {
    assert.equal(r.code, EXIT.ok, r.stderr);
    assert.equal(seen(r).includes("plaintext-hunter2"), false, seen(r));
  }
  const state = readFileSync(join(s.home, ".local/state/fleet/applied.json"), "utf8");
  assert.equal(state.includes("plaintext-hunter2"), false);
  // The secret does reach the file the tool reads, which is the point.
  assert.equal(readJson(CLAUDE_SETTINGS(s.home)).env.TOKEN, `Bearer ${PLAINTEXT}-v2`);
});

test("changing a secret updates the setting; leaving it alone is a no-op", () => {
  const s = leakSetup();
  assert.equal(s.run(["apply"]).code, EXIT.ok);
  const same = s.json(["apply"]);
  assert.deepEqual(same.doc.updated, []);
  s.run(["secrets", "set", "shared", "DEPLOYER_ACCESS_TOKEN"], { input: "rotated" });
  const { r, doc } = s.json(["apply"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(doc.updated, [{ file: "~/.claude/settings.json", path: "env.TOKEN" }]);
  assert.equal(readJson(CLAUDE_SETTINGS(s.home)).env.TOKEN, "Bearer rotated");
});

test("a conflict report never shows a rendered secret", () => {
  const s = leakSetup();
  mkdirSync(join(s.home, ".claude"));
  writeFileSync(CLAUDE_SETTINGS(s.home), JSON.stringify({ env: { TOKEN: "someone else's" } }));
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT.conflict);
  assert.equal((r.stdout + r.stderr).includes("plaintext-hunter2"), false);
});

test("secrets set with no age key exits 5 before any write, new file or not", () => {
  const s = setup();
  rmSync(s.keyFile);
  const r = s.run(["secrets", "set", "shared", "FOO"], { input: "x" });
  assert.equal(r.code, EXIT["needs-secret"]);
  assert.match(r.stderr, /age key/);
  assert.equal(existsSync(join(s.clone, ".sops.yaml")), false);
  assert.equal(existsSync(join(s.clone, "secrets")), false);
});

test("a value typed as an argument is never echoed, wherever it lands", () => {
  const s = setup();
  for (const args of [
    ["secrets", "set", "sk-live-abc123"],
    ["secrets", "edit", "sk-live-abc123"],
    ["secrets", "set", "--sk-live-abc123"],
    ["secrets", "set", "shared", "--sk-live-abc123"],
    ["secrets", "set", "shared", "NAME", "sk-live-abc123"],
  ]) {
    const r = s.run(args, { input: "x" });
    assert.equal(r.code, EXIT.invalid, args.join(" "));
    assert.equal((r.stdout + r.stderr).includes("sk-live-abc123"), false, args.join(" "));
  }
});

test("an ambient SOPS_AGE_KEY does not stand in for the host's key file", () => {
  const s = setup();
  s.run(["secrets", "set", "shared", "TOKEN"], { input: "x" });
  s.setHost("laptop", tokenSetting("secret:TOKEN"));
  const key = s.hosts.laptop!.identity!.key;
  s.writeKey(newIdentity());
  const r = s.run(["apply"], { env: { SOPS_AGE_KEY: key, SOPS_AGE_KEY_CMD: `echo '${key}'` } });
  assert.equal(r.code, EXIT["needs-secret"]);
  assertNothingWritten(s);
});

test("rekey updates the files that have recipients and warns about one that has none", () => {
  const lab = newIdentity();
  const s = setup({ hosts: { laptop: { admin: true, identity: newIdentity() }, server: { identity: lab } } });
  s.run(["secrets", "set", "shared", "A"], { input: "x" });
  s.run(["secrets", "set", "server", "B"], { input: "y" });
  s.writeYaml("server.yaml", 'age: ""\n');
  const { r, doc } = s.json(["secrets", "rekey"]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(doc.rekeyed, ["secrets/shared.enc.yaml"]);
  assert.match(doc.messages.join("\n"), /secrets\/server\.enc\.yaml has no recipients/);
  const keyPath = join(tempDir("fleet-key-"), "key");
  writeFileSync(keyPath, lab.key);
  const cut = spawnSync(SOPS!, ["decrypt", join(s.clone, "secrets/shared.enc.yaml")], { encoding: "utf8", env: { ...process.env, SOPS_AGE_KEY_FILE: keyPath } });
  assert.notEqual(cut.status, 0);
});

test("a name whose value is not a plain string in the secrets file is not a secret", () => {
  const s = setup();
  s.run(["secrets", "set", "shared", "FLAT"], { input: "x" });
  const keyPath = join(tempDir("fleet-key-"), "key");
  writeFileSync(keyPath, s.hosts.laptop!.identity!.key);
  const nested = spawnSync(SOPS!, ["set", "--value-stdin", join(s.clone, "secrets/shared.enc.yaml"), '["NESTED"]'], {
    input: '{"inner":1}',
    encoding: "utf8",
    env: { ...process.env, SOPS_AGE_KEY_FILE: keyPath },
  });
  assert.equal(nested.status, 0, nested.stderr);
  s.setHost("laptop", tokenSetting("secret:NESTED"));
  const r = s.run(["apply"]);
  assert.equal(r.code, EXIT["needs-secret"]);
  assert.match(r.stderr, /NESTED/);
  assertNothingWritten(s);
});
