import { test } from "node:test";
import assert from "node:assert/strict";
import { bundleDraft, checkLines, cloneKey, COMMAND_SECRET, confirmText, opWarnings, secretsOf, serverDraft, skillChoices, sourceDraft, splitCommand, takeBack, typedSkills, unpinned } from "../src/ui/static/catalog.js";
import { clickCell, opLabel, suggestMessage } from "../src/ui/static/matrix.js";

const server = (over: Record<string, unknown> = {}) => ({ name: "linear", kind: "command", command: "npx -y @linear/mcp-server@0.4.1", url: "", rows: [], claude: true, opencode: true, ...over }) as any;

test("a command is split like a shell would, quotes included, and an open quote is no command", () => {
  assert.deepEqual(splitCommand("npx -y  @a/b@1.0.0"), ["npx", "-y", "@a/b@1.0.0"]);
  assert.deepEqual(splitCommand(`node "my server.js" 'a b' c\\ d ""`), ["node", "my server.js", "a b", "c d", ""]);
  assert.deepEqual(splitCommand("  "), []);
  assert.equal(splitCommand(`node "oops`), null);
});

test("npx and uvx with no version are unpinned, and a version, a path or another program is not", () => {
  const w = (s: string) => unpinned(splitCommand(s)!);
  assert.match(w("npx some-package")!, /npx some-package has no version/);
  assert.match(w("npx -y @scope/pkg")!, /Pin it: @scope\/pkg@1\.2\.3/);
  assert.match(w("npx -y pkg@latest")!, /Pin it: pkg@1\.2\.3/);
  assert.match(w("npx --package pkg other-bin")!, /npx pkg has no version/);
  assert.match(w("/usr/bin/npx pkg")!, /npx pkg/);
  assert.match(w("uvx some-tool")!, /Pin it: some-tool==1\.2\.3/);
  assert.match(w("uvx --from some-tool run-it")!, /uvx some-tool has no version/);
  for (const ok of ["npx -y pkg@1.2.3", "npx -y @scope/pkg@1.2.3", "npx pkg@^1.2", "uvx tool==1.2.3", "uvx tool@1.2.3", "uvx --from tool==2.0 run", "node server.js", "docker run image", ""]) assert.equal(w(ok), null, ok);
});

test("a server form becomes the edit it holds: a command, a URL, plain and secret environment, and the agents", () => {
  const d = serverDraft(server({ rows: [{ key: "LINEAR_API_KEY", mode: "secret", value: "" }, { key: "REGION", mode: "plain", value: "eu" }, { key: "", mode: "plain", value: "" }], claude: false }), ["docs"]);
  assert.deepEqual(d.problems, []);
  assert.deepEqual(d.op, { op: "addServer", name: "linear", entry: { command: ["npx", "-y", "@linear/mcp-server@0.4.1"], env: { LINEAR_API_KEY: "secret:LINEAR_API_KEY", REGION: "eu" }, only: ["opencode"] } });
  assert.deepEqual(d.warnings, []);
  assert.deepEqual(secretsOf(d.op), ["LINEAR_API_KEY"]);
  const net = serverDraft(server({ name: "tracker", kind: "sse", url: " https://t.example/mcp ", rows: [{ key: "Authorization", mode: "plain", value: "Bearer secret:TOKEN" }, { key: "X-Key", mode: "secret", value: "KEY" }] }), []);
  assert.deepEqual(net.op, { op: "addServer", name: "tracker", entry: { transport: "sse", url: "https://t.example/mcp", headers: { Authorization: "Bearer secret:TOKEN", "X-Key": "secret:KEY" } } });
  assert.deepEqual(secretsOf(net.op), ["TOKEN", "KEY"]);
});

test("an unpinned command is a warning and the edit is still held", () => {
  const d = serverDraft(server({ command: "npx some-package" }), []);
  assert.notEqual(d.op, null);
  assert.equal(d.warnings.length, 1);
  assert.match(d.warnings[0]!, /no version/);
  assert.deepEqual(opWarnings(d.op!), [`linear: ${d.warnings[0]}`]);
  assert.deepEqual(opWarnings({ op: "addBundle", name: "b", skills: ["a"] }), []);
});

test("a secret in the command is refused with the loader's message", () => {
  const d = serverDraft(server({ command: "npx -y pkg@1.0.0 --token secret:API_KEY" }), []);
  assert.equal(d.op, null);
  assert.deepEqual(d.problems, [COMMAND_SECRET]);
  assert.equal(COMMAND_SECRET, "'command' cannot refer to a secret, a command line is visible to every user; use 'env'");
  // Something that only looks like a reference is not one.
  assert.notEqual(serverDraft(server({ command: "node a.js notsecret:x" }), []).op, null);
});

test("a server form says what is missing, and nothing is held until it is right", () => {
  const problems = (over: Record<string, unknown>, taken: string[] = []) => serverDraft(server(over), taken).problems.join("|");
  assert.match(problems({ name: "" }), /give it a name/);
  assert.match(problems({ name: "has.dot" }), /letters, digits, '_' or '-'/);
  assert.match(problems({}, ["linear"]), /'linear' is already in the catalog/);
  assert.match(problems({ command: "" }), /enter the command/);
  assert.match(problems({ command: `node "x` }), /quote that is not closed/);
  assert.match(problems({ kind: "http", url: "ftp://x" }), /http or https address/);
  assert.match(problems({ rows: [{ key: "A B", mode: "plain", value: "x" }] }), /'A B' is not a valid environment variable name/);
  assert.match(problems({ rows: [{ key: "A", mode: "plain", value: "" }] }), /A needs a value/);
  assert.match(problems({ rows: [{ key: "A", mode: "plain", value: "1" }, { key: "A", mode: "plain", value: "2" }] }), /A is set twice/);
  assert.match(problems({ kind: "http", url: "https://x.example", rows: [{ key: "Authorization", mode: "secret", value: "" }] }), /secret name/);
  assert.match(problems({ claude: false, opencode: false }), /at least one agent/);
});

test("a skill source is added from a clone: it pins the head commit, tracks the branch, and reviews by default", () => {
  const form = { name: "mine", repo: " https://example.com/s.git ", path: "", branch: "", mode: "pin", review: true } as any;
  const clone = (over: Record<string, unknown> = {}) => ({ key: cloneKey(form), id: "i", repo: "https://example.com/s.git", path: ".", branch: null, headBranch: "main", commit: "a".repeat(40), skills: ["a", "b"], problem: null, ...over }) as any;
  assert.match(sourceDraft(form, [], null).problems[0]!, /look at the repo first/);
  assert.deepEqual(sourceDraft(form, [], clone()).op, { op: "addSource", name: "mine", entry: { repo: "https://example.com/s.git", commit: "a".repeat(40), track: "main", path: ".", review: true } });
  assert.deepEqual((sourceDraft({ ...form, review: false }, [], clone()).op as any)?.entry.review, undefined);
  assert.deepEqual(sourceDraft({ ...form, mode: "follow" }, [], clone()).op, { op: "addSource", name: "mine", entry: { repo: "https://example.com/s.git", branch: "main", path: "." } });
  assert.equal((sourceDraft({ ...form, branch: "dev" }, [], clone()).problems[0]), "look at the repo first: it is cloned shallowly to list its skills and read its head commit", "a changed branch needs a new clone");
  assert.equal((sourceDraft({ ...form, branch: "dev" }, [], clone({ key: cloneKey({ ...form, branch: "dev" }) })).op as any)?.entry.track, "dev");
  assert.match(sourceDraft(form, [], clone({ headBranch: null })).problems[0]!, /detached head/);
  assert.match(sourceDraft(form, [], clone({ skills: [] })).problems[0]!, /no skill/);
  assert.match(sourceDraft(form, [], clone({ problem: "path 'x' is not a directory" })).problems[0]!, /not a directory/);
  assert.match(sourceDraft(form, ["mine"], clone()).problems[0]!, /already in the catalog/);
  assert.notEqual(cloneKey(form), cloneKey({ ...form, repo: "other" }));
});

test("a bundle is made of the skills the sources have, those of a held source, and names typed in", () => {
  const known = [{ name: "review", source: "local", bundle: "core" }, { name: "notes", source: "local", bundle: null }];
  const ops: any[] = [{ op: "addSource", name: "new", entry: {} }, { op: "addBundle", name: "other", skills: ["extra-one"] }];
  const choices = skillChoices(known, ops, { new: ["notes", "fresh", "extra-one"] });
  assert.deepEqual(choices.map((c) => [c.name, c.source, c.bundle]), [["extra-one", "new", "other"], ["fresh", "new", null], ["notes", "local", null], ["review", "local", "core"]]);
  const draft = (over: Record<string, unknown>) => bundleDraft({ name: "mine", picked: ["notes"], extra: "", ...over } as any, ["core"], choices);
  assert.deepEqual(draft({}).op, { op: "addBundle", name: "mine", skills: ["notes"] });
  assert.deepEqual((draft({ picked: ["notes", "fresh"], extra: "fresh, typed other" }).op as any)?.skills, ["notes", "fresh", "typed", "other"]);
  assert.deepEqual(typedSkills(" a,b  c ,"), ["a", "b", "c"]);
  assert.match(draft({ picked: [] }).problems[0]!, /at least one skill/);
  assert.match(draft({ picked: ["review"] }).problems[0]!, /skill 'review' is already in bundle 'core'/);
  assert.match(draft({ extra: "fleet" }).problems[0]!, /reserved/);
  assert.match(draft({ extra: "a/b" }).problems[0]!, /not a skill name/);
  assert.match(draft({ name: "core" }).problems[0]!, /already in the catalog/);
  assert.match(draft({ extra: "elsewhere" }).warnings[0]!, /elsewhere is in none of the sources/);
});

test("the check's answer reads as the result, the tools and their size, and any secret left out", () => {
  const ok = { result: "ok", tools: 23, tokens: 6100, latencyMs: 480, protocol: "2025-11-25", detail: null, unset: [], agent: "claude" };
  assert.deepEqual(checkLines(ok), { tone: "ok", lines: ["It started and answered: 23 tools, ~6.1k tokens of definitions in 480 ms."] });
  const missing = checkLines({ ...ok, tools: 1, tokens: 80, unset: ["API_KEY"] });
  assert.equal(missing.lines[0], "It started and answered: 1 tool, ~80 tokens of definitions in 480 ms.");
  assert.equal(missing.lines[1], "API_KEY has no value on this host, so it was started without it.");
  assert.match(missing.lines.at(-1)!, /Calls that need the missing secrets will fail/);
  assert.equal(checkLines({ ...ok, result: "timeout", tools: null, tokens: null, detail: "no answer in time" }).tone, "bad");
  assert.equal(checkLines({ ...ok, result: "auth-needed" }).tone, "warn");
  assert.deepEqual(checkLines({ ...ok, result: "not-run", detail: "nothing to call", unset: [] }), { tone: "warn", lines: ["nothing to call"] });
});

test("the confirmation names the command and says it uses real credentials and may download packages", () => {
  const op = serverDraft(server({ command: "npx -y pkg@1.0.0", rows: [{ key: "TOKEN", mode: "secret", value: "" }] }), []).op;
  const text = confirmText(op);
  assert.match(text, /the command npx -y pkg@1\.0\.0/);
  assert.match(text, /real credentials/);
  assert.match(text, /\(TOKEN\)/);
  assert.match(text, /download packages/);
  assert.match(confirmText(serverDraft(server({ kind: "http", url: "https://x.example/mcp" }), []).op), /a request to https:\/\/x\.example\/mcp/);
  assert.equal(confirmText(null), "");
});

test("taking back an addition takes back the picks of it too, and nothing else", () => {
  const add = { op: "addServer", name: "fresh", entry: {} } as any;
  const bundle = { op: "addBundle", name: "fresh", skills: ["a"] } as any;
  const ops: any[] = [add, bundle, { op: "add", host: "box", kind: "mcp", name: "fresh" }, { op: "add", host: "box", kind: "bundles", name: "fresh" }, { op: "remove", host: "box", kind: "mcp", name: "docs" }];
  assert.deepEqual(takeBack(ops, add).map((o: any) => o.op + ":" + o.name), ["addBundle:fresh", "add:fresh", "remove:docs"]);
  assert.equal(takeBack(ops, add).some((o: any) => o.kind === "mcp" && o.name === "fresh"), false);
  assert.deepEqual(takeBack(ops, bundle).map((o: any) => o.op + ":" + o.name), ["addServer:fresh", "add:fresh", "remove:docs"]);
});

test("catalog additions have words, a commit message, and never get in the way of a click on a cell", () => {
  const server = { op: "addServer", name: "linear", entry: {} } as any;
  const source = { op: "addSource", name: "mine", entry: {} } as any;
  const bundle = { op: "addBundle", name: "extra", skills: [] } as any;
  assert.equal(opLabel(server), "add server linear to the catalog");
  assert.equal(opLabel(source), "add skill source mine to the catalog");
  assert.equal(opLabel(bundle), "add bundle extra to the catalog");
  assert.equal(suggestMessage([server]), "Add server linear");
  assert.equal(suggestMessage([server, source, bundle]), "Add server linear; add skill source mine; add bundle extra");
  const pick = { op: "add", host: "box", kind: "mcp", name: "linear" } as any;
  assert.equal(suggestMessage([server, pick]), "Add server linear; give box linear");
  assert.equal(suggestMessage([{ op: "addServer", name: "a-quite-long-server-name", entry: {} }, { op: "addServer", name: "another-long-server-name", entry: {} }, source, bundle] as any), "Add 4 catalog entries");
  const cell = { on: false, picked: null, excluded: null };
  assert.equal(clickCell([server, bundle], "box", "mcp", "linear", cell).length, 3);
  assert.deepEqual(clickCell([server, pick], "box", "mcp", "linear", cell), [server]);
});
