import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { bareToolPath, makeHome, repoRoot, writeExecutable } from "./helpers.ts";

const wrapper = join(repoRoot, "bin/fleet");

/** Reports itself when run as the CLI, and passes the type-stripping probe. */
const usableNode = (label: string) => `#!/bin/sh
if [ "$1" = "-e" ]; then exit 0; fi
echo "node=${label} path=$FLEET_NODE_PATH"
`;
const unusableNode = `#!/bin/sh
exit 1
`;

function runWrapper(home: string, pathDir: string, env: Record<string, string> = {}) {
  const r = spawnSync("/bin/sh", [wrapper, "status"], {
    encoding: "utf8",
    env: { HOME: home, PATH: pathDir, ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("wrapper prefers FLEET_NODE, then fnm default, then ~/.local/bin, then PATH", () => {
  const home = makeHome();
  const pathDir = bareToolPath();
  const fnm = join(home, ".local/share/fnm/aliases/default/bin/node");
  const local = join(home, ".local/bin/node");
  const onPath = join(pathDir, "node");
  const override = join(home, "override/node");
  writeExecutable(override, usableNode("override"));
  writeExecutable(fnm, usableNode("fnm"));
  writeExecutable(local, usableNode("local"));
  writeExecutable(onPath, usableNode("path"));

  const pick = (env?: Record<string, string>) => runWrapper(home, pathDir, env).stdout;
  assert.match(pick({ FLEET_NODE: override }), /node=override/);
  assert.match(pick(), /node=fnm/);
  writeExecutable(fnm, unusableNode);
  assert.match(pick(), /node=local/);
  writeExecutable(local, unusableNode);
  assert.match(pick(), /node=path/);
});

test("wrapper skips a FLEET_NODE that cannot strip types", () => {
  const home = makeHome();
  const pathDir = bareToolPath();
  writeExecutable(join(home, "old/node"), unusableNode);
  writeExecutable(join(home, ".local/bin/node"), usableNode("local"));
  const r = runWrapper(home, pathDir, { FLEET_NODE: join(home, "old/node") });
  assert.match(r.stdout, /node=local/);
});

test("wrapper finds Node with no fnm or profile on PATH", () => {
  const home = makeHome();
  writeExecutable(join(home, ".local/bin/node"), usableNode("local"));
  const r = runWrapper(home, bareToolPath());
  assert.equal(r.code, 0);
  assert.match(r.stdout, /node=local/);
});

test("wrapper exports the path it probed, not a resolved one", () => {
  const home = makeHome();
  const pathDir = bareToolPath();
  const versions = join(home, ".local/share/fnm/node-versions/v22.18.0/bin");
  writeExecutable(join(versions, "node"), usableNode("fnm"));
  const aliasDir = join(home, ".local/share/fnm/aliases");
  mkdirSync(aliasDir, { recursive: true });
  symlinkSync(join(home, ".local/share/fnm/node-versions/v22.18.0"), join(aliasDir, "default"));

  const r = runWrapper(home, pathDir);
  assert.match(r.stdout, new RegExp(`path=${join(aliasDir, "default/bin/node")}\n`));
});

test("wrapper exits 127 with a message when no Node is usable", () => {
  const home = makeHome();
  const r = runWrapper(home, bareToolPath());
  assert.equal(r.code, 127);
  assert.match(r.stderr, /no Node with type stripping found/);
  assert.equal(r.stdout, "");
});
