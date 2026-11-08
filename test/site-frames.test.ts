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
  assert.deepEqual(tabs, ["home", "matrix", "conflicts", "push", "context", "palette", "help"], "the tabs follow the bridge's order");
  const window: { FLEET_FRAMES?: { screens: Record<string, unknown>; push: unknown[]; homeFill: unknown[]; context: unknown[] } } = {};
  new Function("window", committed())(window);
  const data = window.FLEET_FRAMES!;
  const clips: Record<string, unknown> = { home: data.homeFill, push: data.push, context: data.context };
  const main = readFileSync(join(repoRoot, "site/main.js"), "utf8");
  const captions = main.slice(main.indexOf("const CAPTIONS"), main.indexOf("};", main.indexOf("const CAPTIONS")));
  for (const tab of tabs) {
    assert.ok(clips[tab] ?? data.screens[tab], `no recording for the ${tab} tab`);
    assert.match(captions, new RegExp(`\\b${tab}: "`), `no caption for the ${tab} tab`);
  }
  assert.doesNotMatch(captions, /\u2014/, "a caption has an em dash");
});

test("site: the bridge's keys and the chips under the window lead to tabs", () => {
  const html = readFileSync(join(repoRoot, "site/index.html"), "utf8");
  const tabs = new Set([...html.matchAll(/role="tab" data-screen="(\w+)"/g)].map((m) => m[1]));
  const chips = [...html.matchAll(/<button type="button" data-screen="(\w+)"><kbd>/g)].map((m) => m[1]!);
  assert.ok(chips.length >= 6 && chips.every((c) => tabs.has(c)), "a chip names a screen with no tab");
  const main = readFileSync(join(repoRoot, "site/main.js"), "utf8");
  const keys = main.match(/const KEYS = \{([^}]*)\}/)![1]!;
  const targets = [...keys.matchAll(/: "(\w+)"/g)].map((m) => m[1]!);
  assert.ok(targets.length >= 8 && targets.every((t) => tabs.has(t)), `a key plays a screen with no tab: ${targets}`);
  for (const [key, screen] of [["1", "home"], ["2", "matrix"], ["3", "conflicts"], ["c", "conflicts"], ["7", "push"], ["P", "push"], [":", "palette"], ["\\?", "help"]]) {
    assert.match(keys, new RegExp(`"?${key}"?: "${screen}"`), `${key} should play ${screen}`);
  }
});

type Packed = { cols: number; rows: number; lines: number[] };
type Data = { rows: [string, number, number, number][][]; context: Packed[]; contextBars: Packed; review: Packed };
const data = (): Data => {
  const window: { FLEET_FRAMES?: Data } = {};
  new Function("window", committed())(window);
  return window.FLEET_FRAMES!;
};
/** A packed frame as text lines, with the colours of each line's runs. */
const lines = (d: Data, f: Packed) => f.lines.map((i) => d.rows[i]!.map((s) => s[0]).join(""));

test("site: the context tab is a clip of the bridge's own screen, and the card's bars are cut from it", () => {
  const d = data();
  assert.ok(d.context.length > 60, "the clip plays the selection down the hosts");
  const first = lines(d, d.context[0]!);
  assert.match(first[0]!, /8 Context/);
  assert.match(first.join("\n"), /a full bar is ~20\.3k \(claude, laptop\)/);
  assert.match(lines(d, d.context[d.context.length - 1]!).join("\n"), /╭─ server /, "the selection ends on the last host");
  const bars = lines(d, d.contextBars);
  assert.deepEqual(bars.map((l) => l.trimEnd()), first.slice(3, 11).map((l) => l.slice(0, 73).trimEnd()));
  assert.ok(bars.some((l) => /laptop +claude +█+ +~20\.3k\+/.test(l)), "the bars of laptop, on the one scale");
  assert.ok(d.contextBars.lines.flatMap((i) => d.rows[i]!).some((s) => s[1] === 0x58a6ff), "the skills part has its own colour");
});

test("site: the skill review block is the real output of fleet on a fixture source, flags and colour included", () => {
  const d = data();
  const text = lines(d, d.review);
  assert.equal(text[0], "$ fleet skills update --review");
  assert.match(text[2]!, /^acme-skills {2}[0-9a-f]{7} → [0-9a-f]{7}, 5 commits, 4 of your 8 skills changed \(3 others\)$/);
  const flags = text.filter((l) => /^ {2}[!i] /.test(l));
  assert.deepEqual(flags.map((l) => l.replace(/\s+/g, " ").trim()), [
    "! diagnose scripts/trace.sh new script; new URL https://traces.acme.example/upload",
    "! tdd SKILL.md allowed-tools: + Bash(curl:*)",
    "i triage SKILL.md description changed",
  ]);
  const runs = d.review.lines.flatMap((i) => d.rows[i]!);
  const colourOf = (needle: string) => runs.find((s) => s[0].includes(needle))![1];
  assert.equal(colourOf("! diagnose"), 0xd29922, "a warning is the bridge's warn colour, as fleet colours it");
  assert.ok(runs.some((s) => s[3] & 2 && s[0].includes("i triage")), "an info line is dim");
  assert.match(text[text.length - 1]!, /^d full diff {3}y move the pin {3}n keep [0-9a-f]{7}$/);
});

test("site: the cards show those blocks, and the widget's screenshot is one file in two places", () => {
  const html = readFileSync(join(repoRoot, "site/index.html"), "utf8");
  const main = readFileSync(join(repoRoot, "site/main.js"), "utf8");
  for (const id of ["review", "context-bars"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(main, /block\("review", F\.review\)/);
  assert.match(main, /block\("context-bars", F\.contextBars\)/);
  assert.match(html, /<h3>Startup context<\/h3>/);
  assert.match(html, /<h3>Skill review<\/h3>/);
  assert.doesNotMatch(html, /context budget/i);
  const plugin = "https://github.com/RolfKoenders/fleet-omarchy";
  assert.ok(html.includes(`href="${plugin}"`), "the section links to the plugin's repo");
  assert.match(html, /src="omarchy-widget\.png"[^>]*alt="[^"]{40,}"/, "the screenshot has alt text that says what is in it");
  const copy = (path: string) => readFileSync(join(repoRoot, path));
  assert.ok(copy("site/omarchy-widget.png").equals(copy("assets/omarchy-widget.png")), "the site's and the README's screenshots differ");
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  assert.match(readme, /<img alt="[^"]+" src="assets\/omarchy-widget\.png"/);
  assert.ok(readme.includes(`](${plugin})`), "the README links to the plugin's repo");
});
