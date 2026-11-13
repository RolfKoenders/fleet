import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { build, releases } from "../scripts/site-changelog.ts";
import { repoRoot } from "./helpers.ts";

const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");
const changelog = () => read("CHANGELOG.md");

const SAMPLE = `# Changelog

## Unreleased

### Added

- Not out yet.

## 1.1.0 - 2026-02-03

### Added

- One thing. It has detail, with \`code\` in it.
- Another thing.

### You need to do

- Run \`fleet apply\` twice.

## 1.0.0 - 2026-01-09

### Fixed

- A bug.
`;

test("site changelog: the committed pages are what CHANGELOG.md generates now", () => {
  const out = build(changelog(), read("site/index.html"));
  assert.ok(out.index === read("site/index.html"), "site/index.html is out of date with CHANGELOG.md: run 'npm run site:changelog' and commit the result");
  assert.ok(out.changelog === read("site/changelog/index.html"), "site/changelog/index.html is out of date with CHANGELOG.md: run 'npm run site:changelog' and commit the result");
});

test("site changelog: Unreleased is not a release, and the pill and the rail show released versions only", () => {
  assert.deepEqual(releases(SAMPLE).map((r) => r.version), ["1.1.0", "1.0.0"]);
  const out = build(SAMPLE, read("site/index.html"));
  assert.match(out.index, /<a class="release-pill" href="#whats-new"><b>v1\.1\.0<\/b> 3 changes, 3 Feb /);
  assert.doesNotMatch(out.index, /Not out yet/);
  assert.doesNotMatch(out.changelog, /Not out yet|Unreleased/);
  const railed = [...out.index.matchAll(/<li( class="on")?><a href="changelog\/#v([\d.]+)"/g)].map((m) => [m[1] !== undefined, m[2]]);
  assert.deepEqual(railed, [[true, "1.1.0"], [false, "1.0.0"]]);
});

test("site changelog: every release is on the changelog page, with You need to do open and a filter for each heading", () => {
  const all = releases(changelog());
  const html = read("site/changelog/index.html");
  for (const r of all) assert.match(html, new RegExp(`<article class="cl-rel" id="v${r.version.replace(/\./g, "\\.")}">`));
  assert.ok(all.length >= 3);
  for (const open of html.matchAll(/<details class="cl-sec you-need-to-do"([^>]*)>/g)) assert.equal(open[1], " open");
  const sample = build(SAMPLE, read("site/index.html")).changelog;
  assert.match(sample, /<details class="cl-sec you-need-to-do" open>/);
  assert.match(sample, /<details class="cl-sec fixed"><summary>Fixed/, "the other kinds of an older release start closed");
  const filters = [...html.matchAll(/data-f="([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(filters, ["all", "added", "changed", "fixed", "security", "you-need-to-do"]);
});

test("site changelog: the RSS link is GitHub's releases feed, and the page links its own pieces relatively", () => {
  const index = read("site/index.html");
  assert.match(index, /<a class="btn" href="https:\/\/github\.com\/RolfKoenders\/fleet\/releases\.atom">RSS feed<\/a>/);
  assert.match(index, /<a class="btn primary" href="changelog\/">Full changelog/);
  const html = read("site/changelog/index.html");
  assert.match(html, /href="\.\.\/style\.css"/);
  assert.match(html, /href="\.\.\/fonts\/JetBrainsMono-Regular\.woff2"/);
  assert.doesNotMatch(html, /(?:href|src)="(?:style\.css|fonts\/|main\.js|frames\.js)/);
});

test("site changelog: the landing page links Compare and What's new, and has no em dash", () => {
  const index = read("site/index.html");
  assert.match(index, /<a href="#compare">Compare<\/a>\s*<a href="#whats-new">What's new<\/a>/);
  for (const id of ["compare", "whats-new"]) assert.match(index, new RegExp(`<section class="${id}" id="${id}">`));
  assert.doesNotMatch(index, /id="push-live"/);
  assert.doesNotMatch(index, /never does/i);
  for (const text of [index, read("site/changelog/index.html"), read("site/style.css")]) assert.doesNotMatch(text, /—/);
});
