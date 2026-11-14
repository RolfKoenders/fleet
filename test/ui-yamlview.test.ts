import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { itemLines, itemYaml, yamlPath, yamlTag } from "../src/ui/static/yamlview.js";
import { setup } from "./initworld.ts";
import { startUi } from "../src/ui/server.ts";
import type { UiServer } from "../src/ui/server.ts";

const MCP = `# MCP servers.

servers:
  # A stdio server.
  docs:
    command: [npx, -y, "@example/docs-mcp@1.0.0"]
    env:
      DOCS_BASE_URL: "{{ vars.DOCS_URL }}"
    # a note inside docs

  # A server with a secret.
  # Pin it.
  tracker-local:
    command: [npx, -y, "@example/tracker-mcp@2.0.0"]
    env:
      TRACKER_API_KEY: secret:TRACKER_API_KEY
    only: [claude]
  "quoted":
    transport: http
`;

const SKILLS = `sources:
  # pinned
  pinned:
    repo: https://example.com/a.git
    commit: 1234567890abcdef1234567890abcdef12345678
    track: main

  # followed
  mine:
    repo: https://example.com/b.git
    branch: main

bundles:
  # the core
  core: [review, debug]
  extra: [notes]
`;

test("a server is its own lines with the comments right above it, and not the comments that belong to the next one", () => {
  assert.deepEqual(itemLines(MCP, "server", "docs"), [
    "  # A stdio server.",
    "  docs:",
    '    command: [npx, -y, "@example/docs-mcp@1.0.0"]',
    "    env:",
    '      DOCS_BASE_URL: "{{ vars.DOCS_URL }}"',
    "    # a note inside docs",
  ]);
  const t = itemLines(MCP, "server", "tracker-local")!;
  assert.deepEqual(t.slice(0, 3), ["  # A server with a secret.", "  # Pin it.", "  tracker-local:"]);
  assert.equal(t.at(-1), "    only: [claude]");
  assert.ok(t.includes("      TRACKER_API_KEY: secret:TRACKER_API_KEY"), "a secret is the reference as written");
  assert.deepEqual(itemLines(MCP, "server", "quoted"), ['  "quoted":', "    transport: http"]);
});

test("sources and bundles share a file: each is found under its own section, a name in the other is not found", () => {
  assert.deepEqual(itemLines(SKILLS, "source", "mine"), ["  # followed", "  mine:", "    repo: https://example.com/b.git", "    branch: main"]);
  assert.deepEqual(itemLines(SKILLS, "bundle", "core"), ["  # the core", "  core: [review, debug]"]);
  assert.deepEqual(itemLines(SKILLS, "bundle", "extra"), ["  extra: [notes]"]);
  assert.equal(itemLines(SKILLS, "bundle", "mine"), null);
  assert.equal(itemLines(SKILLS, "source", "core"), null);
  assert.equal(itemLines(SKILLS, "server", "docs"), null);
  assert.equal(itemLines("", "server", "docs"), null);
  assert.equal(itemLines("sources: {}\nbundles: {}\n", "bundle", "x"), null);
});

test("a host is its whole file, comments included", () => {
  const text = "# A build box.\nssh: a@b\nage: \"\"\n";
  assert.deepEqual(itemLines(text, "host", "box"), ["# A build box.", "ssh: a@b", 'age: ""']);
  assert.equal(itemLines("", "host", "box"), null);
  assert.equal(yamlPath("host", "box"), "hosts/box.yaml");
  assert.equal(yamlPath("server", "x"), "catalog/mcp.yaml");
  assert.equal(yamlPath("bundle", "x"), "catalog/skills.yaml");
});

test("with no edit to push the item's lines show as they are", () => {
  const y = itemYaml("bundle", "core", SKILLS, SKILLS);
  assert.equal(y.state, "plain");
  assert.deepEqual(y.lines, [[" ", "  # the core"], [" ", "  core: [review, debug]"]]);
  assert.equal(yamlTag(y), "as in the repo");
});

test("an item that is added shows all its lines as added; one that is gone, as removed; one in neither, absent", () => {
  const after = SKILLS.replace("  extra: [notes]\n", "  extra: [notes]\n  writing: [alpha]\n");
  const added = itemYaml("bundle", "writing", SKILLS, after);
  assert.equal(added.state, "added");
  assert.deepEqual(added.lines, [["+", "  writing: [alpha]"]]);
  assert.equal(yamlTag(added), "to push: +1 -0");
  assert.equal(itemYaml("bundle", "writing", after, SKILLS).state, "removed");
  assert.equal(itemYaml("bundle", "nope", SKILLS, SKILLS).state, "absent");
});

test("a host changed by a pick shows the diff of its file with a little around the change", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `k${i}: v`);
  const before = `${lines.join("\n")}\nbundles: [a]\n`;
  const y = itemYaml("host", "box", before, before.replace("[a]", "[a, b]"));
  assert.equal(y.state, "changed");
  assert.deepEqual(y.lines.filter(([op]) => op !== " "), [["-", "bundles: [a]"], ["+", "bundles: [a, b]"]]);
  assert.ok(y.lines.length < 10, "the lines far from the change are left out");
  assert.equal(yamlTag(y), "to push: +1 -1");
});

// ---- the route

async function withServer(body: (s: UiServer, configDir: string) => Promise<void>) {
  const w = setup();
  w.write("catalog/mcp.yaml", MCP);
  w.write("catalog/skills.yaml", SKILLS);
  w.write("hosts/box.yaml", "# A build box.\nssh: alice@server\nage: \"\"\n");
  const server = await startUi({ toolDir: w.clone, configDir: w.clone, home: w.home });
  try {
    await body(server, w.clone);
  } finally {
    await server.close();
  }
}
const base = (s: UiServer) => `http://127.0.0.1:${s.port}`;
const ask = (s: UiServer, body: unknown, headers: Record<string, string> = { "x-fleet-token": s.token }) =>
  fetch(`${base(s)}/api/yaml`, { method: "POST", headers: { origin: base(s), "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("the route answers the file of an item by kind and name, as it is on disk, and nothing else", async () => {
  await withServer(async (s, dir) => {
    const mcp = (await (await ask(s, { kind: "server", name: "docs" })).json()) as any;
    assert.deepEqual(mcp, { ok: true, path: "catalog/mcp.yaml", text: MCP });
    assert.equal(((await (await ask(s, { kind: "bundle", name: "core" })).json()) as any).path, "catalog/skills.yaml");
    assert.equal(((await (await ask(s, { kind: "source", name: "mine" })).json()) as any).text, SKILLS);
    const host = (await (await ask(s, { kind: "host", name: "box" })).json()) as any;
    assert.deepEqual(host, { ok: true, path: "hosts/box.yaml", text: readFileSync(join(dir, "hosts/box.yaml"), "utf8") });
    assert.equal((await ask(s, { kind: "host", name: "gone" })).status, 404);
  });
});

test("the route refuses a path, a bad kind or name, and a call without the token", async () => {
  await withServer(async (s) => {
    for (const bad of [{ kind: "host", name: "../secrets/shared.enc" }, { kind: "host", name: "box.yaml/../x" }, { kind: "host", name: "/etc/passwd" }, { kind: "file", name: "x" }, { kind: "server", name: "" }, { kind: "server" }, { path: "catalog/mcp.yaml" }, { kind: "server", name: 3 }, []]) {
      const res = await ask(s, bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
    assert.equal((await ask(s, { kind: "server", name: "docs" }, {})).status, 401);
    assert.equal((await ask(s, { kind: "server", name: "docs" }, { "x-fleet-token": "nope" })).status, 403);
  });
});
