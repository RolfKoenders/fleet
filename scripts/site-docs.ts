// Writes the docs pages: every doc in NAV to site/docs/<page>/index.html, the docs home site/docs/index.html
// and site/docs/search.json, searched by site/docs/docs.js. Usage: node scripts/site-docs.ts [<repo root>]
// The container copies site/ without a build step, so the output is committed; a test fails when it is stale.
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { esc, renderDoc, slug } from "./site-markdown.ts";

const REPO = "https://github.com/RolfKoenders/fleet";
const SITE = "https://rolflab.nl/fleet/docs";

export type Page = { file: string; slug: string; title: string; blurb: string };
export type Section = { name: string; pages: Page[] };

const page = (file: string, title: string, blurb: string): Page => ({ file, slug: slug(file.replace(/\.md$/, "")), title, blurb });

/**
 * The docs pages, in the order the side navigation shows them. An empty section is not rendered.
 * docs/commands.md is generated from src/cli.ts by scripts/docs-commands.ts. docs/releasing.md is for
 * maintainers and stays off the site, so a link to it goes to GitHub.
 */
export const NAV: Section[] = [
  {
    name: "Start",
    pages: [
      page("getting-started.md", "Getting started", "Install fleet, create your config and set up your first machines."),
      page("setting-up-machines.md", "Setting up machines", "What each machine needs: ssh, which agents it gets, servers and macOS."),
    ],
  },
  {
    name: "Guides",
    pages: [
      page("bridge.md", "The bridge", "The full-screen view of every host, and pushing from it."),
      page("ui.md", "The page", "fleet ui: see and change your whole fleet in a browser."),
      page("mcp-logins.md", "MCP logins", "How each tool logs in to an MCP server, on this machine and over ssh."),
      page("adding-an-agent.md", "Adding an agent", "What it takes for fleet to support another coding agent."),
    ],
  },
  {
    name: "Reference",
    pages: [
      page("commands.md", "Commands", "Every fleet command and option, what it changes and its --json form."),
      page("reference-fleet-yaml.md", "fleet.yaml", "The pinned tool version every machine runs, and what follows it."),
      page("reference-hosts.md", "Host files and defaults", "Every key of hosts/_defaults.yaml and hosts/<name>.yaml, and how a host file layers on the defaults."),
      page("reference-catalog-mcp.md", "catalog/mcp.yaml", "Every key of an MCP server: command or url, env, headers, secrets and only."),
      page("reference-catalog-skills.md", "catalog/skills.yaml", "Every key of a skill source and a bundle: commit, track, branch and review."),
    ],
  },
  { name: "FAQ", pages: [page("faq.md", "FAQ", "Where secrets end up, what the install script does, updating and more.")] },
];

export const PAGES: Page[] = NAV.flatMap((s) => s.pages);

/** Every docs/*.md file by name: a link to one of these is a link into the docs, on the site or on GitHub. */
export type Docs = Record<string, string>;

/**
 * Where a link in a doc goes. A doc that is a page (`bridge.md`, `docs/bridge.md`,
 * `setting-up-machines.md#macos`) links to its page; a doc that is not (releasing.md) and any other file
 * in the repo (CONTRIBUTING.md, ../install.sh) goes to GitHub, as a link into docs/ does there.
 */
export function docLink(docs: string[], onSite: Map<string, string>): (url: string) => string {
  return (url) => {
    if (/^(https?:|#|mailto:)/.test(url)) return url;
    const [path, anchor = ""] = url.split("#");
    const name = path.replace(/^(\.\.\/)+/, "").replace(/^\.\//, "").replace(/^docs\//, "");
    const here = onSite.get(name);
    if (here !== undefined) return `../${here}/${anchor === "" ? "" : `#${anchor}`}`;
    return `${REPO}/blob/main/${docs.includes(name) ? `docs/${name}` : name}`;
  };
}

/** The docs home and every page, from the landing page's head and nav and the docs as they are now. */
export function build(indexHtml: string, docs: Docs): { index: string; pages: Record<string, string>; search: string } {
  const link = docLink(Object.keys(docs), new Map(PAGES.map((p) => [p.file, p.slug])));
  const rendered = PAGES.map((p) => ({ p, doc: renderDoc(docs[p.file]!, link) }));
  if (rendered.some(({ p, doc }) => docs[p.file] === undefined || doc.title === "")) {
    throw new Error(`docs/${PAGES.map((p) => p.file).join(", ")}: a page's doc is missing or has no '# ' title`);
  }
  const search = JSON.stringify(
    rendered.flatMap(({ p, doc }) =>
      doc.sections.map((s) => ({ page: p.slug, title: p.title, heading: s.heading, anchor: s.anchor, text: s.text })),
    ),
  );
  const index = home(indexHtml);
  const pages = Object.fromEntries(rendered.map(({ p, doc }) => [p.slug, article(indexHtml, p, doc)]));
  return { index, pages, search };
}

/** The landing page's head, retitled and pointed at the files a docs page sits two levels below. */
const head = (indexHtml: string, title: string, blurb: string, url: string, up: string) =>
  indexHtml
    .slice(0, indexHtml.indexOf("</head>"))
    .replace(/<title>[\s\S]*?<\/title>/, `<title>fleet · Docs · ${esc(title)}</title>`)
    .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${esc(blurb)}">`)
    .replace(/<meta property="og:title"[^>]*>/, `<meta property="og:title" content="fleet · Docs · ${esc(title)}">`)
    .replace(/<meta property="og:description"[^>]*>/, `<meta property="og:description" content="${esc(blurb)}">`)
    .replace(/<link rel="canonical"[^>]*>/, `<link rel="canonical" href="${url}">`)
    .replace(/(href|src)="(fonts\/|style\.css)/g, `$1="${up}$2`);

/** The landing page's nav, pointed back at it, with the Docs link as the page you are on. */
const nav = (indexHtml: string, up: string) =>
  indexHtml
    .match(/<header class="nav">[\s\S]*?<\/header>/)![0]
    .replace(/href="#top"/, `href="${up}"`)
    .replace(/href="#(how|watch|bridge|ui|compare|whats-new|start)"/g, `href="${up}#$1"`)
    .replace(/<a href="docs\/"([^>]*)>Docs<\/a>/, `<a href="${up}docs/"$1 aria-current="page" style="color:var(--text)">Docs</a>`);

/** The side navigation, and under it the page's own headings. `up` is the way back to the docs home. */
const side = (up: string, current: string, toc: DocSectionOfPage[]) => {
  const sections = NAV.filter((s) => s.pages.length > 0)
    .map(
      (s) =>
        `<section><h3>${esc(s.name)}</h3>${s.pages.map((p) => `<a${p.slug === current ? ' class="on" aria-current="page"' : ""} href="${up === "" ? "" : up}${p.slug}/">${esc(p.title)}</a>`).join("")}</section>`,
    )
    .join("\n        ");
  const onThisPage =
    toc.length === 0
      ? ""
      : `\n        <nav class="doc-toc" aria-label="On this page"><h3>On this page</h3>${toc.map((s) => `<a href="#${s.anchor}">${esc(s.heading)}</a>`).join("")}</nav>`;
  return `<div class="doc-search" role="search">
          <input type="search" id="doc-search" placeholder="Search the docs ( / )" autocomplete="off" aria-label="Search the docs">
          <div class="doc-results" id="doc-results" hidden></div>
        </div>
        <nav class="doc-nav" aria-label="Docs">
        ${sections}
        </nav>${onThisPage}`;
};

type DocSectionOfPage = { heading: string; anchor: string };

/** One doc's page. */
const article = (indexHtml: string, p: Page, doc: { title: string; html: string; sections: DocSectionOfPage[] }) => {
  const toc = doc.sections.filter((s) => s.anchor !== "");
  return `${head(indexHtml, p.title, p.blurb, `${SITE}/${p.slug}/`, "../../")}
</head>
<body data-base="../">
  <div class="backdrop" aria-hidden="true"></div>

  ${nav(indexHtml, "../../")}

  <main class="docpage">
    <div class="doc-head">
      <h1>${esc(doc.title)}</h1>
      <button type="button" class="doc-menu-btn" aria-expanded="false" aria-controls="doc-side">Menu</button>
    </div>
    <aside class="doc-side" id="doc-side">
      ${side("../", p.slug, toc)}
    </aside>
    <article class="doc-body">
${doc.html}
    </article>
  </main>

  <script src="../docs.js" defer></script>
</body>
</html>
`;
};

/** The docs home: the same side navigation and every page with its one-line description. */
const home = (indexHtml: string) =>
  `${head(indexHtml, "Docs", "Every fleet doc: getting started, setting up machines, the bridge, the page, MCP logins, adding an agent and the FAQ.", `${SITE}/`, "../")}
</head>
<body data-base="">
  <div class="backdrop" aria-hidden="true"></div>

  ${nav(indexHtml, "../")}

  <main class="docpage">
    <div class="doc-head">
      <h1>Docs</h1>
      <button type="button" class="doc-menu-btn" aria-expanded="false" aria-controls="doc-side">Menu</button>
    </div>
    <aside class="doc-side" id="doc-side">
      ${side("", "", [])}
    </aside>
    <div class="doc-home">
${NAV.filter((s) => s.pages.length > 0)
  .map((s) => {
    const items = s.pages
      .map((p) => `<li><a href="${p.slug}/"><b>${esc(p.title)}</b><span>${esc(p.blurb)}</span></a></li>`)
      .join("\n        ");
    return `<section><h2>${esc(s.name)}</h2><ul>
        ${items}
      </ul></section>`;
  })
  .join("\n      ")}
    </div>
  </main>

  <script src="docs.js" defer></script>
</body>
</html>
`;

if (import.meta.main) {
  const root = process.argv[2] ?? join(import.meta.dirname, "..");
  const docs: Docs = {};
  for (const name of readdirSync(join(root, "docs")).sort()) {
    if (name.endsWith(".md")) docs[name] = readFileSync(join(root, "docs", name), "utf8");
  }
  const out = build(readFileSync(join(root, "site/index.html"), "utf8"), docs);
  for (const [slugOfPage, html] of Object.entries(out.pages)) {
    mkdirSync(join(root, "site/docs", slugOfPage), { recursive: true });
    writeFileSync(join(root, "site/docs", slugOfPage, "index.html"), html);
  }
  mkdirSync(join(root, "site/docs"), { recursive: true });
  writeFileSync(join(root, "site/docs/index.html"), out.index);
  writeFileSync(join(root, "site/docs/search.json"), out.search);
}
