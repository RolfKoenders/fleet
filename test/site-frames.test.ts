import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { hostname, homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { record } from "../scripts/site-frames/record.ts";
import { makeHome, repoRoot, tempDir } from "./helpers.ts";

const committed = () => readFileSync(join(repoRoot, "site/frames.js"), "utf8");

test("site: frames.js is what the bridge records now", async () => {
  const { text } = await record();
  assert.ok(text === committed(), "site/frames.js is out of date with the bridge: run 'npm run site:frames' and commit the result");
});

test("site: the recording is the same wherever it runs", () => {
  // A different home, time zone, language, working directory and temp directory than this process has.
  const out = join(tempDir("fleet-frames-out-"), "frames.js");
  const r = spawnSync(process.execPath, [join(repoRoot, "scripts/site-frames.ts"), out], {
    cwd: tempDir("fleet-frames-cwd-"),
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: makeHome("elsewhere"), TZ: "Pacific/Auckland", LANG: "C", TMPDIR: tempDir("fleet-frames-tmp-") },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(readFileSync(out, "utf8") === committed(), "recorded elsewhere, the frames differ from site/frames.js");
});

test("site: the recording holds nothing from the machine it ran on", () => {
  const text = committed();
  for (const own of [hostname(), homedir(), tmpdir(), repoRoot]) assert.ok(own.length < 3 || !text.includes(own), `frames.js names ${own}`);
});

test("site: the page loads its frames as data and imports nothing from the tool", () => {
  const files = readdirSync(join(repoRoot, "site"), { recursive: true, encoding: "utf8" }).filter((f) => /\.(js|ts|html|css)$/.test(f));
  assert.ok(files.includes("main.js") && files.includes("frames.js"));
  for (const f of files) {
    const text = readFileSync(join(repoRoot, "site", f), "utf8");
    assert.doesNotMatch(text, /\bimport\b[^;\n]*["'`]|import\(|require\(/, `${f} imports a module`);
    assert.doesNotMatch(text, /src\/|\.\.\/(test|scripts)/, `${f} refers to the tool's code`);
  }
});

test("site: every tab of the bridge window has a recording and a caption", () => {
  const html = readFileSync(join(repoRoot, "site/index.html"), "utf8");
  const tabs = [...html.matchAll(/role="tab" data-screen="(\w+)"/g)].map((m) => m[1]!);
  assert.deepEqual(tabs, ["home", "matrix", "conflicts", "push", "palette", "help"], "the tabs follow the bridge's order");
  const window: { FLEET_FRAMES?: { screens: Record<string, unknown>; push: unknown[]; homeFill: unknown[] } } = {};
  new Function("window", committed())(window);
  const data = window.FLEET_FRAMES!;
  const clips: Record<string, unknown> = { home: data.homeFill, push: data.push };
  const main = readFileSync(join(repoRoot, "site/main.js"), "utf8");
  const captions = main.slice(main.indexOf("const CAPTIONS"), main.indexOf("};", main.indexOf("const CAPTIONS")));
  for (const tab of tabs) {
    assert.ok(clips[tab] ?? data.screens[tab], `no recording for the ${tab} tab`);
    assert.match(captions, new RegExp(`\\b${tab}: "`), `no caption for the ${tab} tab`);
  }
  assert.doesNotMatch(captions, /\u2014/, "a caption has an em dash");
});
