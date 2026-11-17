import { test } from "node:test";
import assert from "node:assert/strict";
import { applyChanges, bundleDraft, cloneKey, entryChanges, needsLook, opWarnings, serverDraft, skillChoices, sourceEditDraft, splitCommand } from "../src/ui/static/catalog.js";
import { EDIT, bundleFormOf, editPaneView, freshEdit, hostEditDraft, hostFormOf, joinCommand, ownOp, readOnlyLines, serverAsAdded, serverFormOf, sourceFormOf, startOf, withEdit } from "../src/ui/static/editing.js";
import { closable } from "../src/ui/static/adding.js";
import { opLabel, suggestMessage } from "../src/ui/static/matrix.js";
import { itemLines } from "../src/ui/static/yamlview.js";

const AGENTS = [{ id: "claude", name: "Claude Code" }, { id: "opencode", name: "opencode" }];

const SHA = "a".repeat(40);
const NEW = "b".repeat(40);
const pinned = { repo: "https://example.com/s.git", commit: SHA, track: "main", path: "skills", review: true };
const followed = { repo: "https://example.com/s.git", branch: "main", path: "." };
const clone = (f: any, over: Record<string, unknown> = {}) => ({ key: cloneKey(f), id: "i", repo: f.repo, path: f.path, branch: null, headBranch: "dev", commit: NEW, skills: ["a", "b"], problem: null, ...over }) as any;

test("a command is written in the form so that it splits back to the same list", () => {
  for (const list of [["npx", "-y", "@scope/pkg@1.2.3"], ["node", "my server.js", "it's", 'say "hi"', "back\\slash", ""], ["/usr/bin/x", "--flag=value", "a,b"]]) {
    assert.deepEqual(splitCommand(joinCommand(list)), list, joinCommand(list));
  }
  assert.equal(joinCommand(["npx", "-y", "pkg@1.0.0"]), "npx -y pkg@1.0.0");
});

test("a server form starts from the entry: command or URL, rows with secrets by name, and the agents", () => {
  const cmd = serverFormOf("docs", { command: ["npx", "-y", "pkg@1.0.0"], env: { TOKEN: "secret:DOCS_TOKEN", REGION: "eu", MIXED: "a secret:X b" }, only: ["claude"] }, AGENTS);
  assert.deepEqual(cmd, {
    name: "docs", kind: "command", command: "npx -y pkg@1.0.0", url: "",
    rows: [{ key: "TOKEN", mode: "secret", value: "DOCS_TOKEN" }, { key: "REGION", mode: "plain", value: "eu" }, { key: "MIXED", mode: "plain", value: "a secret:X b" }],
    agents: { claude: true, opencode: false },
  });
  const net = serverFormOf("t", { transport: "sse", url: "https://t.example/mcp", headers: { Authorization: "secret:T" } }, AGENTS);
  assert.deepEqual([net.kind, net.url, net.rows, net.agents.claude, net.agents.opencode], ["sse", "https://t.example/mcp", [{ key: "Authorization", mode: "secret", value: "T" }], true, true]);
  assert.equal(serverFormOf("t", { transport: "http", url: "https://t" }, AGENTS).kind, "http");
});

test("an unchanged server form is no edit; a changed one holds only the fields that changed, with what they were", () => {
  const base = { command: ["npx", "-y", "pkg@1.0.0"], env: { TOKEN: "secret:DOCS_TOKEN", REGION: "eu" }, only: ["claude"] };
  const form = serverFormOf("docs", base, AGENTS);
  const same = serverDraft(form, [], [], base);
  assert.deepEqual([same.op, same.problems, same.unchanged], [null, [], true]);
  const moved = serverDraft({ ...form, command: "npx -y pkg@1.1.0", rows: [form.rows[0]!, { key: "REGION", mode: "plain", value: "us" }, { key: "EXTRA", mode: "secret", value: "" }] }, [], [], base);
  assert.deepEqual(moved.problems, []);
  assert.deepEqual(moved.op, {
    op: "editServer", name: "docs",
    changes: [
      { key: "command", from: ["npx", "-y", "pkg@1.0.0"], to: ["npx", "-y", "pkg@1.1.0"] },
      { key: "env", from: base.env, to: { TOKEN: "secret:DOCS_TOKEN", REGION: "us", EXTRA: "secret:EXTRA" } },
    ],
  });
  const kind = serverDraft({ ...form, kind: "sse", url: "https://d.example/sse", rows: [] }, [], [], base);
  assert.deepEqual(kind.op, {
    op: "editServer", name: "docs",
    changes: [
      { key: "command", from: base.command, to: null },
      { key: "transport", from: null, to: "sse" },
      { key: "url", from: null, to: "https://d.example/sse" },
      { key: "env", from: base.env, to: null },
    ].sort((a, b) => ["command", "transport", "url", "env"].indexOf(a.key) - ["command", "transport", "url", "env"].indexOf(b.key)),
  });
  const agents = serverDraft({ ...form, agents: { claude: true, opencode: true } }, [], [], base);
  assert.deepEqual(agents.op, { op: "editServer", name: "docs", changes: [{ key: "only", from: ["claude"], to: null }] });
});

test("a field the file already has is not held to a rule it may have been written without, but a changed one is", () => {
  // The loader takes a {{ vars.X }} in a URL (it has spaces), a variable name the form would not offer, and an unpinned command.
  const base = { transport: "http", url: "https://{{ vars.HOST }}/mcp", headers: { "x-lower": "v" } };
  const form = serverFormOf("t", base, AGENTS);
  assert.deepEqual(serverDraft(form, [], [], base).problems, []);
  assert.equal(serverDraft({ ...form, rows: [...form.rows, { key: "X-Two", mode: "plain", value: "2" }] }, [], [], base).problems.length, 0);
  assert.match(serverDraft({ ...form, url: "https://a b" }, [], [], base).problems[0]!, /space/);
  const cmd = { command: ["npx", "some-package"] };
  const f = serverFormOf("c", cmd, AGENTS);
  assert.deepEqual(serverDraft(f, [], [], cmd).warnings, [], "an unpinned command that is not touched is not warned about again");
  assert.equal(serverDraft({ ...f, command: "npx other-package" }, [], [], cmd).warnings.length, 1);
  assert.deepEqual(opWarnings({ op: "editServer", name: "c", changes: [{ key: "command", from: ["x"], to: ["npx", "pkg"] }] }).length, 1);
  assert.deepEqual(opWarnings({ op: "editServer", name: "c", changes: [{ key: "only", from: null, to: ["claude"] }] }), []);
});

test("the name is not checked in an edit, and a secret in the command is still refused", () => {
  const base = { command: ["x"] };
  assert.equal(serverDraft({ ...serverFormOf("docs", base, AGENTS), command: "x secret:A" }, ["docs"], [], base).problems[0], "'command' cannot refer to a secret, a command line is visible to every user; use 'env'");
  assert.deepEqual(serverDraft(serverFormOf("docs", base, AGENTS), ["docs"], [], base).problems, []);
});

test("a source form starts from the entry; a followed one offers review on for when it is pinned", () => {
  assert.deepEqual(sourceFormOf("s", pinned), { name: "s", repo: pinned.repo, path: "skills", branch: "main", mode: "pin", review: true });
  assert.deepEqual(sourceFormOf("s", { ...pinned, review: undefined }), { name: "s", repo: pinned.repo, path: "skills", branch: "main", mode: "pin", review: false });
  assert.deepEqual(sourceFormOf("s", followed), { name: "s", repo: followed.repo, path: ".", branch: "main", mode: "follow", review: true });
});

test("changing only the path or review of a source leaves the pin alone and needs no clone", () => {
  const f = sourceFormOf("s", pinned);
  assert.equal(needsLook(f, pinned), false);
  const d = sourceEditDraft({ ...f, path: "tools", review: false }, pinned, null);
  assert.deepEqual(d.problems, []);
  assert.deepEqual(d.op, { op: "editSource", name: "s", changes: [{ key: "path", from: "skills", to: "tools" }, { key: "review", from: true, to: null }] });
  assert.equal(sourceEditDraft(f, pinned, null).unchanged, true);
  // review: false that the file has is kept as it is.
  const kept = { ...pinned, review: false };
  assert.equal(sourceEditDraft(sourceFormOf("s", kept), kept, null).unchanged, true);
  assert.deepEqual((sourceEditDraft({ ...sourceFormOf("s", kept), review: true }, kept, null).op as any).changes, [{ key: "review", from: false, to: true }]);
});

test("a changed branch of a pinned source is looked at first, and the pin moves to the head of the new branch", () => {
  const f = { ...sourceFormOf("s", pinned), branch: "dev" };
  assert.equal(needsLook(f, pinned), true);
  assert.match(sourceEditDraft(f, pinned, null).problems[0]!, /look at the repo first/);
  assert.match(sourceEditDraft(f, pinned, clone({ ...f, branch: "x" })).problems[0]!, /look at the repo first/, "a clone of another branch is no look");
  const d = sourceEditDraft(f, pinned, clone(f));
  assert.deepEqual(d.op, { op: "editSource", name: "s", changes: [{ key: "commit", from: SHA, to: NEW }, { key: "track", from: "main", to: "dev" }] });
  assert.match(sourceEditDraft(f, pinned, clone(f, { skills: [] })).problems[0]!, /no skill/);
  assert.equal(sourceEditDraft(f, pinned, clone(f, { problem: "the path is not a directory" })).problems[0], "the path is not a directory");
  // An emptied branch is the repo's default: when that is the branch it already has, the pin stays.
  const blank = { ...sourceFormOf("s", pinned), branch: "" };
  assert.equal(sourceEditDraft(blank, pinned, clone(blank, { headBranch: "main" })).unchanged, true);
  assert.match(sourceEditDraft(blank, pinned, clone(blank, { headBranch: null })).problems[0]!, /detached head/);
});

test("a source goes from pinned to followed and back, with the clone", () => {
  const f = { ...sourceFormOf("s", pinned), mode: "follow" as const };
  assert.equal(needsLook(f, pinned), true);
  assert.deepEqual((sourceEditDraft(f, pinned, clone(f, { headBranch: "main" })).op as any).changes, [
    { key: "commit", from: SHA, to: null }, { key: "track", from: "main", to: null }, { key: "branch", from: null, to: "main" }, { key: "review", from: true, to: null },
  ].sort((a, b) => ["commit", "track", "branch", "path", "review"].indexOf(a.key) - ["commit", "track", "branch", "path", "review"].indexOf(b.key)));
  const g = { ...sourceFormOf("s", followed), mode: "pin" as const };
  assert.deepEqual((sourceEditDraft(g, followed, clone(g, { headBranch: "main" })).op as any).changes, [
    { key: "commit", from: null, to: NEW }, { key: "track", from: null, to: "main" }, { key: "branch", from: "main", to: null }, { key: "review", from: null, to: true },
  ].sort((a, b) => ["commit", "track", "branch", "path", "review"].indexOf(a.key) - ["commit", "track", "branch", "path", "review"].indexOf(b.key)));
  // The repo is never part of an edit.
  assert.ok(!(sourceEditDraft({ ...g, repo: "https://other.example/r.git" }, followed, clone(g)).op as any)?.changes?.some((c: any) => c.key === "repo"));
});

test("a bundle form ticks the skills the page knows and types the rest; an edit is the list from what the file had to what the form says", () => {
  const choices = [{ name: "review", source: "s", bundle: "core" }, { name: "debug", source: "s", bundle: "core" }, { name: "notes", source: "s", bundle: null }];
  const f = bundleFormOf("core", ["review", "debug", "mine"], choices);
  assert.deepEqual(f, { name: "core", picked: ["review", "debug"], extra: "mine" });
  assert.deepEqual(bundleDraft(f, [], choices, [], ["review", "debug", "mine"]).unchanged, true);
  const d = bundleDraft({ ...f, picked: ["review", "notes"], extra: "" }, [], choices, [], ["review", "debug", "mine"]);
  assert.deepEqual(d.problems, [], "a skill of its own bundle is not refused");
  assert.deepEqual(d.op, { op: "editBundle", name: "core", from: ["review", "debug", "mine"], to: ["review", "notes"] });
  assert.match(bundleDraft({ ...f, extra: "" , picked: []}, [], choices, [], ["a"]).problems[0]!, /at least one skill/);
  const other = [...choices, { name: "plan", source: "s", bundle: "extra" }];
  assert.match(bundleDraft({ ...f, extra: "plan" }, [], other, [], ["review"]).problems[0]!, /already in bundle 'extra'/);
});

test("the skills a held edit frees or takes are what the other forms see", () => {
  const known = [{ name: "review", source: "s", bundle: "core" }, { name: "debug", source: "s", bundle: "core" }];
  const ops = [{ op: "editBundle", name: "core", from: ["review", "debug"], to: ["review"] }] as any;
  assert.deepEqual(skillChoices(known, ops, {}).map((k) => [k.name, k.bundle]), [["debug", null], ["review", "core"]]);
  const staged = skillChoices(known, [{ op: "editSource", name: "s2", changes: [] }] as any, { s2: ["fresh"] });
  assert.ok(staged.some((k) => k.name === "fresh"));
});

test("a host form is the ssh destination only, checked as Add checks it", () => {
  const f = hostFormOf("box", { ssh: "me@box" });
  assert.deepEqual(f, { name: "box", ssh: "me@box", from: "" });
  const none = hostEditDraft(f, { ssh: "me@box" });
  assert.deepEqual([none.op, none.unchanged], [null, true]);
  assert.deepEqual(hostEditDraft({ ...f, ssh: " me@box.lan " }, { ssh: "me@box" }).op, { op: "editHost", host: "box", from: "me@box", to: "me@box.lan" });
  assert.deepEqual(hostEditDraft({ ...f, ssh: "me@x" }, {}).op, { op: "editHost", host: "box", from: null, to: "me@x" });
  assert.match(hostEditDraft({ ...f, ssh: "" }, { ssh: "me@box" }).problems[0]!, /over ssh/);
  assert.equal(hostEditDraft({ ...f, ssh: "-oProxyCommand=x" }, { ssh: "me@box" }).problems[0], "A destination cannot start with '-': ssh would read it as an option.");
  assert.match(hostEditDraft({ ...f, ssh: "me@box:22" }, { ssh: "me@box" }).problems[0]!, /port/);
});

test("an Edit dialog starts from the file, from an unpushed addition, or says why it cannot", () => {
  const doc = (over: Record<string, unknown> = {}) => ({ found: true, editable: true, reason: null, path: "catalog/mcp.yaml", value: { command: ["a"] }, text: "", ...over });
  assert.deepEqual(startOf("server", "x", doc(), undefined), { state: "ready", error: null, reason: null, base: { command: ["a"] }, value: { command: ["a"] } });
  // An edit already to push is on top of the file; the dialog's edit is made against the file.
  const own = { op: "editServer", name: "x", changes: [{ key: "command", from: ["a"], to: ["b"] }] } as any;
  const s = startOf("server", "x", doc(), own);
  assert.deepEqual([s.base, s.value], [{ command: ["a"] }, { command: ["b"] }]);
  assert.deepEqual(startOf("bundle", "x", doc({ value: ["a"] }), { op: "editBundle", name: "x", from: ["a"], to: ["a", "b"] }).value, ["a", "b"]);
  assert.deepEqual(startOf("host", "x", doc({ value: { ssh: "a@b" } }), { op: "editHost", host: "x", from: "a@b", to: "c@d" }).value, { ssh: "c@d" });
  // An unpushed addition is changed in place: it starts from what was added, the file need not have it.
  const add = { op: "addServer", name: "x", entry: { command: ["z"] } } as any;
  assert.deepEqual(startOf("server", "x", doc({ found: false, value: null }), add), { state: "ready", error: null, reason: null, base: { command: ["z"] }, value: { command: ["z"] } });
  assert.equal(startOf("bundle", "x", doc({ found: false }), { op: "addBundle", name: "x", skills: ["q"] } as any).base[0], "q");
  const ro = startOf("server", "x", doc({ editable: false, reason: "'a' is a map written over several lines" }), undefined);
  assert.deepEqual([ro.state, ro.reason], ["readonly", "'a' is a map written over several lines"]);
  assert.equal(startOf("server", "x", doc({ found: false }), undefined).state, "error");
});

test("an edit joins To push in place of the item's own, an unpushed addition is changed instead of stacked on, and no change takes the edit back", () => {
  const edit = (to: string) => ({ op: "editServer", name: "x", changes: [{ key: "command", from: ["a"], to: [to] }] }) as any;
  const other = { op: "add", host: "h", kind: "mcp", name: "x" } as any;
  const first = withEdit([other], undefined, edit("b"), { command: ["a"] });
  assert.deepEqual(first.ops, [other, edit("b")]);
  const own = first.ops[1];
  assert.equal(ownOp(first.ops, "server", "x"), own);
  const again = withEdit(first.ops, own, edit("c"), { command: ["a"] });
  assert.deepEqual(again.ops, [other, edit("c")], "replaced where it was");
  assert.deepEqual(withEdit(first.ops, own, null, { command: ["a"] }).ops, [other], "back to the file: nothing to push");
  const add = { op: "addServer", name: "x", entry: { command: ["z"], only: ["claude"] } } as any;
  const changed = withEdit([add, other], add, { op: "editServer", name: "x", changes: [{ key: "command", from: ["z"], to: ["y"] }, { key: "only", from: ["claude"], to: null }] }, add.entry);
  assert.deepEqual(changed.ops, [{ op: "addServer", name: "x", entry: { command: ["y"] } }, other]);
  assert.deepEqual(changed.sent, { op: "addServer", name: "x", entry: { command: ["y"] } });
  assert.deepEqual(withEdit([add], add, null, add.entry).ops, [add], "an unpushed addition is never taken off by an edit that changes nothing");
  const bundle = { op: "addBundle", name: "b", skills: ["a"] } as any;
  assert.deepEqual(withEdit([bundle], bundle, { op: "editBundle", name: "b", from: ["a"], to: ["a", "c"] }, bundle.skills).ops, [{ op: "addBundle", name: "b", skills: ["a", "c"] }]);
  const src = { op: "addSource", name: "s", entry: pinned } as any;
  assert.deepEqual((withEdit([src], src, { op: "editSource", name: "s", changes: [{ key: "path", from: "skills", to: "x" }] }, pinned).ops[0] as any).entry.path, "x");
  assert.equal(ownOp([{ op: "editHost", host: "box", from: null, to: "a@b" }], "host", "box")?.op, "editHost");
  assert.equal(ownOp([add], "bundle", "x"), undefined);
});

test("the server check of an edit runs the whole entry as it would be", () => {
  const base = { command: ["a"], env: { K: "v" } };
  const d = serverDraft({ ...serverFormOf("x", base, AGENTS), command: "b" }, [], [], base);
  assert.deepEqual(serverAsAdded(d, base, "x"), { op: "addServer", name: "x", entry: { command: ["b"], env: { K: "v" } } });
  assert.deepEqual(serverAsAdded(serverDraft(serverFormOf("x", base, AGENTS), [], [], base), base, "x"), { op: "addServer", name: "x", entry: base });
  assert.equal(serverAsAdded({ op: null, problems: ["x"], warnings: [] }, base, "x"), null);
  const added = serverDraft(serverFormOf("n", { command: ["a"] }, AGENTS), [], []);
  assert.equal(serverAsAdded(added, null, "n")?.op, "addServer");
});

test("the pane of an Edit shows the file as a diff against the file without this edit, and says what it cannot", () => {
  const base = "servers:\n  x:\n    command: [a]\n  y:\n    command: [c]\n";
  const op = { op: "editServer", name: "x", changes: [{ key: "command", from: ["a"], to: ["b"] }] } as any;
  const d = { op, problems: [] };
  const live = (doc: unknown, error: string | null = null) => ({ key: JSON.stringify(op), doc, error });
  const answer = (over: Record<string, unknown> = {}) => ({ dropped: [], checks: [{ host: "h", loads: true, problems: [] }], files: [{ path: "catalog/mcp.yaml", before: base, after: base.replace("[a]", "[b]") }], ...over });
  assert.equal(editPaneView(d, null, "catalog/mcp.yaml", base, op).state, "reading");
  const p = editPaneView(d, live(answer()), "catalog/mcp.yaml", base, op);
  assert.deepEqual([p.state, p.tag, p.tone], ["diff", "changed in place", "ok"]);
  assert.deepEqual(p.lines.filter(([o]) => o !== " "), [["-", "    command: [a]"], ["+", "    command: [b]"]]);
  assert.equal(editPaneView(d, live(answer({ checks: [{ host: "h", loads: false, problems: ["bad"] }] })), "catalog/mcp.yaml", base, op).broken, "With this, the config does not load for h: bad");
  const dropped = editPaneView(d, live(answer({ dropped: [{ op, reason: "'servers.x.command' is not what this edit was made from: it has changed in the file" }] })), "catalog/mcp.yaml", base, op);
  assert.deepEqual([dropped.state, dropped.tag], ["refused", "does not apply"]);
  assert.equal(editPaneView(d, live(null, "no"), "catalog/mcp.yaml", base, op).state, "refused");
  const none = editPaneView({ op: null, problems: [], unchanged: true }, null, "catalog/mcp.yaml", base, null);
  assert.deepEqual([none.state, none.tag], ["missing", "no change"]);
  assert.match(none.problems[0]!, /change something/);
  assert.match(editPaneView({ op: null, problems: [], unchanged: true }, null, "catalog/mcp.yaml", base, null, true).problems[0]!, /takes the edit off To push/);
  assert.deepEqual(editPaneView({ op: null, problems: ["give it a command"] }, null, "p", base, null).problems, ["give it a command"]);
  // The op the server was asked about may differ from the form's (an unpushed addition is changed in place).
  const add = { op: "addServer", name: "x", entry: { command: ["b"] } } as any;
  const dropped2 = editPaneView(d, live(answer({ dropped: [{ op: add, reason: "r" }] })), "catalog/mcp.yaml", base, add);
  assert.equal(dropped2.state, "refused");
});

test("the dialog says Edit, always closes, and an item fleet cannot change is shown read-only", () => {
  assert.deepEqual(Object.values(EDIT), ["Edit MCP server", "Edit skill source", "Edit skill bundle", "Edit host"]);
  assert.equal(closable("host", { running: true }), false);
  assert.equal(closable("host", { running: true }, true), true, "an edit runs nothing, so a running init is no reason to keep it open");
  const f = freshEdit("server", "docs", AGENTS);
  assert.deepEqual([f.kind, f.edit?.name, f.edit?.state], ["server", "docs", "loading"]);
  const text = "# top\nservers:\n  a:\n    command: [x]\n  docs: &d\n    command: [y]\n    env:\n      K: v\n  z:\n    command: [q]\n";
  assert.deepEqual(readOnlyLines(text, "server", "docs"), ["  docs: &d", "    command: [y]", "    env:", "      K: v"]);
  assert.deepEqual(readOnlyLines("ssh: a@b\n", "host", "box"), ["ssh: a@b"]);
  assert.deepEqual(itemLines(text, "server", "nope"), null);
  assert.deepEqual(readOnlyLines("x: 1\n", "bundle", "nope"), ["x: 1"]);
});

test("edits have words and a commit message", () => {
  const ops = [
    { op: "editServer", name: "docs", changes: [] },
    { op: "editSource", name: "mine", changes: [] },
    { op: "editBundle", name: "core", from: ["a"], to: ["b"] },
    { op: "editHost", host: "box", from: null, to: "a@b" },
  ] as any[];
  assert.deepEqual(ops.map(opLabel), ["edit server docs", "edit skill source mine", "edit bundle core", "edit host box"]);
  assert.equal(suggestMessage(ops.slice(0, 1)), "Edit server docs");
  assert.equal(suggestMessage(ops.slice(2)), "Edit bundle core and host box");
  assert.equal(suggestMessage(ops), "Edit server docs, skill source mine, bundle core and host box");
  const long = ops.map((o) => ({ ...o, ...(o.op === "editHost" ? { host: "a-rather-long-host-name" } : { name: `${o.name}-with-a-long-name` }) }));
  assert.equal(suggestMessage(long), "Edit 4 items");
  assert.equal(suggestMessage([...long, { op: "addBundle", name: "n", skills: ["a"] }] as any), "Add 1 catalog entry; edit 4 items");
  assert.equal(suggestMessage([ops[0], { op: "add", host: "box", kind: "mcp", name: "x" }] as any), "Edit server docs; give box x");
});

test("entry changes name only what differs, and applying them gives the entry back", () => {
  const base = { a: 1, b: [1], c: { x: 1 } };
  assert.deepEqual(entryChanges(base, { a: 1, b: [2], d: "n" }, ["a", "b", "c", "d"]), [{ key: "b", from: [1], to: [2] }, { key: "c", from: { x: 1 }, to: null }, { key: "d", from: null, to: "n" }]);
  assert.deepEqual(applyChanges(base, entryChanges(base, { a: 1, b: [2], d: "n" }, ["a", "b", "c", "d"])), { a: 1, b: [2], d: "n" });
});
