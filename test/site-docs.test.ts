import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { build, docLink, PAGES, type Docs } from "../scripts/site-docs.ts";
import { renderDoc } from "../scripts/site-markdown.ts";
import { repoRoot } from "./helpers.ts";

const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");
const docs = (): Docs =>
  Object.fromEntries(
    readdirSync(join(repoRoot, "docs"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => [f, read(join("docs", f))]),
  );
const built = () => build(read("site/index.html"), docs());

test("site docs: the committed pages are what docs/*.md generates now", () => {
  const out = built();
  assert.ok(out.index === read("site/docs/index.html"), "site/docs/index.html is out of date with docs/*.md: run 'npm run site:docs' and commit the result");
  for (const p of PAGES) {
    assert.ok(out.pages[p.slug] === read(`site/docs/${p.slug}/index.html`), `site/docs/${p.slug}/index.html is out of date with docs/${p.file}: run 'npm run site:docs' and commit the result`);
  }
  assert.ok(out.search === read("site/docs/search.json"), "site/docs/search.json is out of date with docs/*.md: run 'npm run site:docs' and commit the result");
});

test("site docs: every doc is a page except the releasing guide, and the Reference section is on every page", () => {
  assert.deepEqual(
    [...PAGES.map((p) => p.file)].sort(),
    readdirSync(join(repoRoot, "docs")).filter((f) => f.endsWith(".md") && f !== "releasing.md").sort(),
  );
  const out = built();
  for (const html of [out.index, ...Object.values(out.pages)]) {
    assert.match(html, /<h[23]>Reference<\/h[23]>/, "the Reference section is not rendered");
    assert.doesNotMatch(html, /\u2014/);
  }
});

test("site docs: a link to a doc goes to its page, with or without an anchor, and any other file goes to GitHub", () => {
  const link = docLink(Object.keys(docs()), new Map(PAGES.map((p) => [p.file, p.slug])));
  const sample =
    "# Sample\n\nSee [the bridge](docs/bridge.md), [machines](setting-up-machines.md#macos), [this page](#sample), [contributing](CONTRIBUTING.md), [the script](../install.sh) and [releasing](releasing.md).\n";
  const { html } = renderDoc(sample, link);
  assert.match(html, /href="\.\.\/bridge\/"/);
  assert.match(html, /href="\.\.\/setting-up-machines\/#macos"/);
  assert.match(html, /href="#sample"/);
  assert.match(html, /href="https:\/\/github\.com\/RolfKoenders\/fleet\/blob\/main\/CONTRIBUTING\.md"/);
  assert.match(html, /href="https:\/\/github\.com\/RolfKoenders\/fleet\/blob\/main\/install\.sh"/);
  assert.match(html, /href="https:\/\/github\.com\/RolfKoenders\/fleet\/blob\/main\/docs\/releasing\.md"/);
});

test("site docs: search.json has an entry for every h2 of every page, and a word found on every page", () => {
  const out = built();
  const entries = JSON.parse(out.search) as { page: string; heading: string; anchor: string; text: string }[];
  for (const p of PAGES) {
    const h2s = [...out.pages[p.slug]!.matchAll(/<h2 id="([^"]+)">/g)].map((m) => m[1]!);
    assert.ok(h2s.length > 0, `docs/${p.file} has no ## heading`);
    for (const id of h2s) {
      assert.ok(entries.some((e) => e.page === p.slug && e.anchor === id), `no search entry for docs/${p.file} heading #${id}`);
    }
    assert.ok(
      entries.some((e) => e.page === p.slug && /fleet/i.test(`${e.heading} ${e.text}`)),
      `no entry of docs/${p.file} finds the word fleet`,
    );
  }
  assert.doesNotMatch(out.search, /\u2014/);
});

test("site docs: each page shows its own h2s as On this page, and the side navigation lists every page", () => {
  const out = built();
  for (const p of PAGES) {
    const html = out.pages[p.slug]!;
    const ids = [...html.matchAll(/<h2 id="([^"]+)">/g)].map((m) => m[1]!);
    const toc = html.slice(html.indexOf('class="doc-toc"'));
    for (const id of ids) assert.match(toc, new RegExp(`href="#${id}"`), `docs/${p.file} h2 #${id} is not on this page`);
    assert.match(html, new RegExp(`class="on" aria-current="page" href="\\.\\./${p.slug}/"`));
  }
  for (const p of PAGES) assert.match(out.index, new RegExp(`href="${p.slug}/"`));
});

test("site docs: the landing page and the changelog page link to the docs, and the pages load the site's own files", () => {
  const index = read("site/index.html");
  assert.match(index, /<a href="docs\/" data-umami-event="fleet-docs-click">Docs<\/a>/);
  assert.match(index, /<a href="docs\/faq\/">FAQ<\/a>/);
  assert.match(index, /<a href="docs\/bridge\/">The bridge<\/a>/);
  assert.match(index, /<a href="docs\/adding-an-agent\/">Adding an agent<\/a>/);
  assert.match(read("site/changelog/index.html"), /<a href="\.\.\/docs\/" data-umami-event="fleet-docs-click">Docs<\/a>/);

  const out = built();
  assert.ok(out.index.includes('<link rel="canonical" href="https://rolflab.nl/fleet/docs/">'));
  assert.match(out.index, /<script src="docs\.js" defer><\/script>/);
  for (const [slug, html] of Object.entries(out.pages)) {
    assert.ok(html.includes(`<link rel="canonical" href="https://rolflab.nl/fleet/docs/${slug}/">`), `${slug} has no canonical address`);
    assert.match(html, /href="\.\.\/\.\.\/style\.css"/);
    assert.match(html, /href="\.\.\/\.\.\/fonts\/JetBrainsMono-Regular\.woff2"/);
    assert.match(html, /<script src="\.\.\/docs\.js" defer><\/script>/);
    assert.match(html, /data-base="\.\.\/"/);
    assert.doesNotMatch(html, /(?:href|src)="(?:style\.css|fonts\/|docs\.js)/, `${slug} points outside its own directory`);
  }
});

test("site docs: markdown renders headings with ids, lists, tables and code, escaped", () => {
  const md = [
    "# T",
    "",
    "Text with <b>tags</b> & `code`.",
    "",
    "## A heading",
    "",
    "- one",
    "  - nested",
    "- two",
    "",
    "1. first",
    "2. second",
    "",
    "| A | B |",
    "| --- | --- |",
    "| `<x>` | **b** |",
    "",
    "```sh",
    "fleet <push> & apply",
    "```",
  ].join("\n");
  const out = renderDoc(md, (url) => url);
  assert.equal(out.title, "T");
  assert.match(out.html, /<p>Text with &lt;b&gt;tags&lt;\/b&gt; &amp; <code>code<\/code>\.<\/p>/);
  assert.match(out.html, /<h2 id="a-heading">A heading<\/h2>/);
  assert.match(out.html, /<ul><li>one<ul><li>nested<\/li><\/ul><\/li><li>two<\/li><\/ul>/);
  assert.match(out.html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(out.html, /<div class="doc-table"><table><thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead><tbody><tr><td><code>&lt;x&gt;<\/code><\/td><td><b>b<\/b><\/td><\/tr><\/tbody><\/table><\/div>/);
  assert.match(out.html, /<pre class="doc-code"><code>fleet &lt;push&gt; &amp; apply<\/code><\/pre>/);
  assert.deepEqual(out.sections, [
    { heading: "T", anchor: "", text: "Text with <b>tags</b> & code." },
    { heading: "A heading", anchor: "a-heading", text: "A heading one nested two first second A B <x> b fleet <push> & apply" },
  ]);
});
