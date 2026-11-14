import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOps } from "../src/edit/index.ts";
import { redactUrl, urlHoldsCredentials } from "../src/redact.ts";
import { hostFields, nameClash as serverNameClash, previewHost, sshProblem as serverSsh } from "../src/ui/hostinit.ts";
import { branchProblem as serverBranch, opsOf, repoProblem as serverRepo } from "../src/ui/opsof.ts";
import { CloneStore } from "../src/ui/clones.ts";
import { setRequest, VALUE_BLANK as S_BLANK, VALUE_EMPTY as S_EMPTY, VALUE_LONG as S_LONG } from "../src/ui/secretset.ts";
import { addable, paneView } from "../src/ui/static/adding.js";
import * as client from "../src/ui/static/catalog.js";
import * as hosts from "../src/ui/static/hosts.js";
import * as secrets from "../src/ui/static/secrets.js";

// Every rule is held twice, by the server (the source of truth) and by the page's pure modules (so the dialog says it before
// the click). These tests run the same inputs through both: they must accept and refuse the same, in the same words.

const refusal = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as Error).message;
  }
};
const serverForm = (over: Record<string, unknown> = {}) => ({ name: "web", kind: "http" as const, command: "", url: "https://example.com/mcp", rows: [], claude: true, opencode: true, ...over });
const serverOps = (name: string, entry: Record<string, unknown>) => () => opsOf({ ops: [{ op: "addServer", name, entry }] });
const sourceForm = (over: Record<string, unknown> = {}) => ({ name: "docs", repo: "https://example.com/x.git", path: "", branch: "", mode: "pin" as const, review: false, ...over });
const cloned = (f: ReturnType<typeof sourceForm>) => ({ key: client.cloneKey(f), repo: f.repo, path: f.path || ".", branch: null, commit: "a".repeat(40), skills: ["s"], problem: null, id: "1", headBranch: "main" });

test("S8: a credential in an MCP server url is refused by the server and the page, with a pointer to secret:NAME", () => {
  for (const url of ["https://user:pw@example.com/mcp", "https://token@example.com/mcp", "http://u:p@127.0.0.1:9/x"]) {
    const page = client.serverDraft(serverForm({ url }), [], []).problems;
    assert.deepEqual(page, [client.MCP_URL_CREDENTIALS], url);
    assert.match(refusal(serverOps("web", { transport: "http", url }))!, /must not hold credentials .*secret:NAME/, url);
    assert.ok(refusal(serverOps("web", { transport: "http", url }))!.endsWith(client.MCP_URL_CREDENTIALS), url);
  }
  // `@` further on is not userinfo.
  for (const url of ["https://example.com/a@b", "https://example.com/mcp?u=a@b"]) {
    assert.equal(client.serverDraft(serverForm({ url }), [], []).problems.length, 0, url);
    assert.equal(refusal(serverOps("web", { transport: "http", url })), null, url);
  }
});

test("S8: a credential in a skill source repo is refused, and the words point at a credential helper", () => {
  for (const repo of ["https://user:tok3n@example.com/x.git", "https://tok3n@example.com/x.git", "ssh://user:pw@example.com/x.git"]) {
    assert.equal(client.repoProblem(repo), client.REPO_CREDENTIALS, repo);
    assert.equal(serverRepo(repo), client.REPO_CREDENTIALS, repo);
    assert.match(client.REPO_CREDENTIALS, /git credential helper/);
    assert.match(refusal(() => opsOf({ ops: [{ op: "addSource", name: "docs", entry: { repo, commit: "a".repeat(40), track: "main", path: "." } }] }))!, /credentials/);
  }
  // A user alone in an ssh or scp-style address is how those are written.
  for (const repo of ["ssh://git@example.com/x.git", "git@github.com:me/x.git", "https://example.com/x.git"]) assert.equal(serverRepo(repo), null, repo);
});

test("S8: the loader refuses a url and a repo with credentials in a config file, not only the page's edits", async () => {
  const { parseMcpCatalog } = await import("../src/mcp.ts");
  const { parseCatalog } = await import("../src/catalog.ts");
  const mcp: string[] = [];
  parseMcpCatalog(".", mcp, { root: ".", files: { "catalog/mcp.yaml": "servers:\n  a:\n    transport: http\n    url: https://u:p@example.com/\n" } });
  assert.match(mcp.join(), /must not hold credentials/);
  const skills: string[] = [];
  parseCatalog(".", skills, { root: ".", files: { "catalog/skills.yaml": `sources:\n  a:\n    repo: https://u:p@example.com/x.git\n    branch: main\n` } });
  assert.match(skills.join(), /must not hold credentials/);
  // A `{{ vars.X }}` has spaces of its own and is no problem.
  const ok: string[] = [];
  parseMcpCatalog(".", ok, { root: ".", files: { "catalog/mcp.yaml": "servers:\n  a:\n    transport: http\n    url: '{{ vars.HUB }}'\n" } });
  assert.deepEqual(ok, []);
});

test("S8: userinfo is stripped from a message that echoes a URL", async () => {
  assert.equal(redactUrl("cannot clone https://user:tok3n@host/x.git: boom"), "cannot clone https://host/x.git: boom");
  assert.equal(redactUrl("see https://tok3n@host/x and ssh://u:p@h/x"), "see https://host/x and ssh://h/x");
  assert.equal(redactUrl("ssh://git@host/x.git and git@host:x.git"), "ssh://git@host/x.git and git@host:x.git");
  assert.equal(urlHoldsCredentials("ssh://git@host/x"), false);
  assert.equal(urlHoldsCredentials("https://host/x@y"), false);
  // The clone store refuses it before git sees it, so nothing is cloned or echoed.
  await assert.rejects(new CloneStore().create("https://user:tok3n@127.0.0.1:1/x.git", ".", null), (e: Error) => !e.message.includes("tok3n") && /credentials/.test(e.message));
  // A clone that fails shows the address without its user.
  await assert.rejects(new CloneStore().create("ssh://git@127.0.0.1:1/x.git", ".", null), (e: Error) => /cannot clone ssh:\/\/git@127\.0\.0\.1:1\/x\.git/.test(e.message));
});

test("N3: a url with whitespace is refused, in the same words", () => {
  for (const url of ["https://exa mple.com/mcp", "https://example.com/m cp"]) {
    assert.deepEqual(client.serverDraft(serverForm({ url }), [], []).problems, [client.URL_SPACE], url);
    assert.ok(refusal(serverOps("web", { transport: "http", url }))!.endsWith(client.URL_SPACE), url);
  }
  // A control character is refused by the page in the same words; the server refuses it earlier, as not usable.
  assert.deepEqual(client.serverDraft(serverForm({ url: "https://example.com/m\tcp" }), [], []).problems, [client.URL_SPACE]);
  assert.notEqual(refusal(serverOps("web", { transport: "http", url: "https://example.com/m\tcp" })), null);
  assert.equal(client.urlProblem("ftp://x/"), "the URL must be an http or https address");
  assert.equal(client.repoProblem("https://exa mple.com/x"), serverRepo("https://exa mple.com/x"));
});

test("N3: names are at most 64 characters, for servers, sources and bundles", () => {
  const ok = "a".repeat(64);
  const long = "a".repeat(65);
  assert.equal(client.serverDraft(serverForm({ name: ok }), [], []).problems.length, 0);
  assert.deepEqual(client.serverDraft(serverForm({ name: long }), [], []).problems, ["the name can be at most 64 characters"]);
  assert.equal(refusal(serverOps(ok, { transport: "http", url: "https://example.com/" })), null);
  assert.match(refusal(serverOps(long, { transport: "http", url: "https://example.com/" }))!, /the name can be at most 64 characters$/);
  assert.deepEqual(client.bundleDraft({ name: long, picked: [], extra: "a" }, [], []).problems.filter((p) => /at most/.test(p)), ["the name can be at most 64 characters"]);
  assert.match(refusal(() => opsOf({ ops: [{ op: "addBundle", name: long, skills: ["a"] }] }))!, /the name can be at most 64 characters$/);
  assert.equal(refusal(() => opsOf({ ops: [{ op: "addBundle", name: ok, skills: ["a"] }] })), null);
  const f = sourceForm({ name: long });
  assert.ok(client.sourceDraft(f, [], cloned(f)).problems.includes("the name can be at most 64 characters"));
  assert.match(refusal(() => opsOf({ ops: [{ op: "addSource", name: long, entry: { repo: "https://example.com/x.git", commit: "a".repeat(40), track: "main", path: "." } }] }))!, /at most 64/);
  // Hosts, in the same words.
  assert.equal(hosts.hostDraft({ name: long, ssh: "me@mini", from: "" }, []).name, hosts.NAME_LONG);
  assert.equal(refusal(() => hostFields({ name: long, ssh: "me@mini" })), hosts.NAME_LONG);
  assert.equal(refusal(() => hostFields({ name: ok, ssh: "me@mini" })), null);
});

test("N4: the source dialog refuses a bad repo, branch and path before the repo is looked at, as the server does", () => {
  const repos = ["ftp://example.com/x", "-x", "ext::sh -c id", "https://exa mple.com/x", "relative/path", "https://example.com/x.git", "/abs/path", "git@github.com:me/x.git", "x".repeat(501)];
  for (const repo of repos) assert.equal(client.repoProblem(repo), serverRepo(repo), repo);
  for (const branch of ["-x", "a..b", "ok/branch", "main", "a b"]) assert.equal(client.branchProblem(branch), serverBranch(branch), branch);
  for (const repo of repos) {
    const f = sourceForm({ repo });
    const draft = client.sourceDraft(f, [], null);
    if (serverRepo(repo) === null) assert.ok(draft.problems.every((p) => /look at the repo/.test(p)), repo);
    else assert.deepEqual(draft.problems, [serverRepo(repo)], repo);
  }
  assert.deepEqual(client.sourceInputs(sourceForm({ branch: "-x" })), { repo: null, branch: serverBranch("-x"), path: null });
  assert.equal(client.sourceInputs(sourceForm({ path: "../x" })).path, "the path must be a directory inside the repo, without '..'");
  assert.equal(client.sourceInputs(sourceForm({ path: "/abs" })).path, client.pathProblem("/abs"));
  assert.match(refusal(() => opsOf({ ops: [{ op: "addSource", name: "d", entry: { repo: "https://example.com/x.git", commit: "a".repeat(40), track: "main", path: "../x" } }] }))!, /the path must be a directory inside the repo, without '\.\.'/);
  // Nothing is said of what is not typed yet.
  assert.deepEqual(client.sourceInputs(sourceForm({ repo: "" })), { repo: null, branch: null, path: null });
});

test("N5: a row with a value and no name says to give it a name", () => {
  for (const [kind, label] of [["command", "environment variable"], ["http", "header"]] as const) {
    const f = serverForm({ kind, command: "node server.js", rows: [{ key: "", mode: "plain", value: "x" }] });
    const problems = client.serverDraft(f, [], []).problems;
    assert.deepEqual(problems, [`give it a name (this row has a value but no ${label} name)`]);
    assert.ok(!problems.join().includes("''"));
  }
});

test("N7: a duplicate of an addition already on To push says so; names are compared without case", () => {
  const taken = ["web1"];
  assert.deepEqual(client.serverDraft(serverForm({ name: "web1" }), taken, []).problems, ["'web1' is already in the catalog"]);
  assert.deepEqual(client.serverDraft(serverForm({ name: "web1" }), taken, ["web1"]).problems, ["'web1' is already added to To push"]);
  assert.deepEqual(client.serverDraft(serverForm({ name: "WEB1" }), taken, ["web1"]).problems, ["'WEB1' is already added to To push"]);
  assert.match(client.serverDraft(serverForm({ name: "WEB1" }), taken, []).problems[0]!, /^'WEB1' clashes with 'web1', which is already in the catalog: names are compared without regard to case$/);
  // The server: against the catalog (the engine), and against an addition earlier in the same list.
  const entry = { transport: "http", url: "https://example.com/" };
  const files = { "catalog/mcp.yaml": "servers:\n  web1:\n    transport: http\n    url: https://example.com/\n" };
  assert.equal(applyOps(files, [{ op: "addServer", name: "web1", entry }]).dropped[0]!.reason, "'web1' is already in the catalog");
  assert.equal(applyOps(files, [{ op: "addServer", name: "WEB1", entry }]).dropped[0]!.reason, "'WEB1' clashes with 'web1', which is already in the catalog: names are compared without regard to case");
  const twice = (a: string, b: string) => () => opsOf({ ops: [{ op: "addServer", name: a, entry }, { op: "addServer", name: b, entry }] });
  assert.equal(refusal(twice("web1", "web1")), "ops[1]: 'web1' is already added to To push");
  assert.equal(refusal(twice("web1", "WEB1")), "ops[1]: 'WEB1' is already added to To push");
  assert.equal(refusal(twice("web1", "web2")), null);
  // A source and a bundle of the same name are not the same kind of thing.
  assert.equal(refusal(() => opsOf({ ops: [{ op: "addBundle", name: "x", skills: ["a"] }, { op: "addSource", name: "x", entry: { repo: "https://example.com/x.git", branch: "main", path: "." } }] })), null);
  const f = sourceForm({ name: "Docs" });
  assert.equal(client.sourceDraft(f, [], cloned(f), ["docs"]).problems[0], "'Docs' is already added to To push");
  assert.equal(client.bundleDraft({ name: "Core", picked: ["a"], extra: "" }, [], [], ["core"]).problems[0], "'Core' is already added to To push");
});

test("S9: host names are compared without case and `shared` is reserved, in the same words", () => {
  assert.equal(hosts.nameClash("BOX", ["box"]), serverNameClash("BOX", ["box"]));
  assert.match(hosts.nameClash("BOX", ["box"])!, /too close to the host box/);
  assert.equal(hosts.nameClash("box", ["box"]), "box is already a host.");
  assert.equal(hosts.nameClash("mini", ["box"]), null);
  for (const name of ["shared", "SHARED", "Shared"]) {
    assert.equal(hosts.hostDraft({ name, ssh: "me@mini", from: "" }, []).name, hosts.SHARED_HOST, name);
    assert.equal(refusal(() => hostFields({ name, ssh: "me@mini" })), hosts.SHARED_HOST, name);
  }
  assert.equal(hosts.hostDraft({ name: "BOX", ssh: "me@mini", from: "" }, ["box"]).body, null);
  // The engine refuses it too, so a preview (and the write) cannot make hosts/BOX.yaml next to hosts/box.yaml.
  const dir = mkdtempSync(join(tmpdir(), "fleet-val-"));
  mkdirSync(join(dir, "hosts"));
  writeFileSync(join(dir, "hosts", "box.yaml"), "ssh: me@box\n");
  const preview = previewHost(dir, { name: "BOX", ssh: "me@mini", from: null });
  assert.ok("refused" in preview && preview.refused.message === hosts.nameClash("BOX", ["box"]));
  // The engine itself refuses it too, whatever calls it.
  const engine = applyOps({ "hosts/box.yaml": "ssh: me@box\n" }, [{ op: "addHost", host: "BOX", ssh: "me@mini", from: null }]);
  assert.match(engine.dropped[0]!.reason, /clashes with hosts\/box\.yaml/);
  assert.equal(applyOps({}, [{ op: "addHost", host: "Shared", ssh: "me@mini", from: null }]).dropped[0]!.reason, hosts.SHARED_HOST);
  const shared = previewHost(dir, { name: "shared", ssh: "me@mini", from: null });
  assert.ok("refused" in shared && shared.refused.message === hosts.SHARED_HOST);
  assert.ok("doc" in previewHost(dir, { name: "mini", ssh: "me@mini", from: null }));
});

test("N8: an ssh target with no host, or with a port, is refused early with the same words on both sides", () => {
  const cases: Record<string, string | null> = {
    "bob@": hosts.SSH_EMPTY_HOST,
    "bob@mini:22": hosts.SSH_PORT,
    "mini:22": hosts.SSH_PORT,
    "bob@[fe80::1]:22": hosts.SSH_PORT,
    "-oProxyCommand=x": hosts.SSH_OPTION,
    "bob@mini mini": hosts.SSH_SHAPE,
    "bob@mini": null,
    "mini": null,
    "bob@10.0.0.4": null,
    "bob@[fe80::1%eth0]": null,
    "bob@fe80::1": null,
  };
  for (const [ssh, want] of Object.entries(cases)) {
    assert.equal(hosts.sshProblem(ssh), want, ssh);
    assert.equal(serverSsh(ssh), want, ssh);
    assert.equal(refusal(() => hostFields({ name: "mini", ssh })), want, ssh);
    const d = hosts.hostDraft({ name: "mini", ssh, from: "" }, []);
    assert.equal(d.ssh, want, ssh);
    assert.equal(d.body === null, want !== null, ssh);
  }
  assert.match(hosts.SSH_PORT, /~\/\.ssh\/config/);
});

test("S10: a value too long, or only spaces, is refused with the limit named, in the same words on both sides", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-val-"));
  mkdirSync(join(dir, "hosts"));
  const req = (value: unknown) => () => setRequest({ name: "API_KEY", value, files: ["shared"], ops: [] }, dir);
  assert.equal(secrets.valueProblem(""), S_EMPTY);
  assert.equal(secrets.valueProblem("x".repeat(secrets.MAX_VALUE + 1)), S_LONG);
  assert.equal(secrets.valueProblem("   \t "), S_BLANK);
  assert.equal(secrets.valueProblem("x".repeat(secrets.MAX_VALUE)), null);
  assert.equal(secrets.valueProblem(" a "), null);
  assert.match(S_LONG, /at most 8192 characters/);
  assert.equal(refusal(req("")), S_EMPTY);
  assert.equal(refusal(req("x".repeat(9000))), S_LONG);
  assert.equal(refusal(req("   ")), S_BLANK);
  assert.equal(refusal(req("x".repeat(8192))), null);
});

test("N6: Add to push waits while the pane says refused, does not apply, or the config would not load", () => {
  const d = { op: { op: "addBundle", name: "writing", skills: ["a"] }, problems: [] };
  const key = JSON.stringify(d.op);
  const file = { path: "catalog/skills.yaml", before: "", after: "bundles:\n  writing: [a]\n" };
  const doc = (over: Record<string, unknown> = {}) => ({ dropped: [], checks: [{ host: "laptop", loads: true, problems: [] }], files: [file], ...over });
  assert.equal(addable(paneView("bundle", d, { key, doc: doc(), error: null }, null)), true);
  assert.equal(addable(paneView("bundle", d, { key, doc: null, error: "ops[0]: no" }, null)), false, "refused");
  assert.equal(addable(paneView("bundle", d, { key, doc: doc({ dropped: [{ op: d.op, reason: "'writing' is already in the catalog" }] }), error: null }, null)), false, "does not apply");
  assert.equal(addable(paneView("bundle", d, { key, doc: doc({ checks: [{ host: "laptop", loads: false, problems: ["bad"] }] }), error: null }, null)), false, "would not load");
});

test("N2: the secrets dialog never runs the refusal into the ask to type again", () => {
  const msg = "no age key at /h/.config/fleet/age.key; `fleet init` creates it";
  assert.equal(secrets.retryText(msg), `${msg}. Type the value again.`);
  assert.equal(secrets.retryText("it failed."), "it failed. Type the value again.");
});
