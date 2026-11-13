// Writes what the landing page shows of CHANGELOG.md: the release pill and the What's new section in
// site/index.html (between their markers), and the whole page site/changelog/index.html.
// Usage: node scripts/site-changelog.ts [<repo root>]
// The container copies site/ without a build step, so the output is committed; a test fails when it is stale.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sections } from "../src/changelog.ts";

type Release = { version: string; date: string; kinds: { kind: string; items: string[] }[] };

const REPO = "https://github.com/RolfKoenders/fleet";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const KINDS = ["Added", "Changed", "Fixed", "Security", "You need to do"];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const slug = (kind: string) => kind.toLowerCase().replace(/[^a-z]+/g, "-").replace(/-$/, "");
/** "12 Nov 2026", or "12 Nov" without the year. Formatted by hand so the output does not depend on the locale or time zone. */
const day = (date: string, year: boolean) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]}${year ? ` ${y}` : ""}`;
};

/** The released versions, newest first, with their items by kind. `Unreleased` is not a release. */
export function releases(changelog: string): Release[] {
  const found: Release[] = [];
  for (const s of sections(changelog)) {
    const head = s.heading.match(/^(\d+\.\d+\.\d+\S*) - (\d{4}-\d{2}-\d{2})$/);
    if (head === null) continue;
    const release: Release = { version: head[1]!, date: head[2]!, kinds: [] };
    let kind: Release["kinds"][number] | undefined;
    for (const line of s.body.split("\n")) {
      const h = line.match(/^### (.+)/);
      if (h !== null) release.kinds.push((kind = { kind: h[1]!.trim(), items: [] }));
      else if (kind !== undefined && line.startsWith("- ")) kind.items.push(line.slice(2));
      else if (kind !== undefined && kind.items.length > 0 && /^\s+\S/.test(line)) kind.items[kind.items.length - 1] += ` ${line.trim()}`;
    }
    found.push(release);
  }
  return found;
}

const count = (r: Release) => r.kinds.reduce((n, k) => n + k.items.length, 0);
const changes = (r: Release) => `${count(r)} ${count(r) === 1 ? "change" : "changes"}`;

/** Inline markdown as HTML: code, links (a relative one points into the repo) and bold. */
const inline = (s: string) =>
  esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text: string, url: string) => `<a href="${url.startsWith("http") ? url : `${REPO}/blob/main/${url}`}">${text}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");

/** The first sentence is the headline, the rest is detail. */
const item = (text: string) => {
  const i = text.search(/\.\s/);
  const [head, detail] = i < 0 ? [text, ""] : [text.slice(0, i + 1), text.slice(i + 2)];
  return `<li><span class="cl-h">${inline(head)}</span>${detail === "" ? "" : ` <span class="cl-d">${inline(detail)}</span>`}</li>`;
};

/** "You need to do" is open on every release, and so is Security. `all` opens every section. */
const release = (r: Release, all: boolean) => {
  const tags = r.kinds.map((k) => `<span class="cl-tag ${slug(k.kind)}">${k.items.length} ${esc(k.kind.toLowerCase())}</span>`).join("");
  const kinds = r.kinds.map((k) => `<details class="cl-sec ${slug(k.kind)}"${all || k.kind === "You need to do" || k.kind === "Security" ? " open" : ""}><summary>${esc(k.kind)}</summary><ul>${k.items.map(item).join("")}</ul></details>`);
  return `<article class="cl-rel" id="v${r.version}">
  <header><h3>v${r.version}</h3><time datetime="${r.date}">${day(r.date, true)}</time><div class="cl-tags">${tags}</div></header>
  ${kinds.join("\n  ")}
</article>`;
};

const pill = (r: Release) => `<a class="release-pill" href="#whats-new"><b>v${r.version}</b> ${changes(r)}, ${day(r.date, false)} <span aria-hidden="true">→</span></a>`;

const rail = (all: Release[], link: string, on: boolean) =>
  all.map((r, i) => `<li${on && i === 0 ? ' class="on"' : ""}><a href="${link}#v${r.version}"><b>v${r.version}</b><span>${r.date} · ${changes(r)}</span></a></li>`).join("\n          ");

const news = (all: Release[]) => `<div class="news">
        <ol class="rail">
          ${rail(all, "changelog/", true)}
          <li class="pace">Subscribe with the <a href="${REPO}/releases.atom">RSS feed</a>, or watch the GitHub repo for releases.</li>
        </ol>
        <div>
          <div class="clamp">${release(all[0]!, false)}</div>
          <div class="news-foot"><a class="btn primary" href="changelog/">Full changelog <span aria-hidden="true">→</span></a><a class="btn" href="${REPO}/releases.atom">RSS feed</a></div>
        </div>
      </div>`;

const region = (name: string) => new RegExp(`(<!-- site:${name} begin -->)[\\s\\S]*?(<!-- site:${name} end -->)`);
const fill = (html: string, name: string, body: string) => {
  if (!region(name).test(html)) throw new Error(`site/index.html has no '${name}' markers`);
  return html.replace(region(name), (_, begin: string, end: string) => `${begin}\n      ${body}\n      ${end}`);
};

const filter = (kind: string, i: number) => `<button type="button" class="${i === 0 ? "on" : ""}" data-f="${slug(kind)}">${esc(kind)}</button>`;

/** The head of the page is the landing page's own, so the two cannot drift. */
const page = (indexHtml: string, all: Release[]) => {
  const head = indexHtml.slice(0, indexHtml.indexOf("</head>"));
  const meta = head
    .replace(/<title>[\s\S]*?<\/title>/, "<title>fleet · Changelog</title>")
    .replace(/<meta name="description"[^>]*>/, '<meta name="description" content="Every release of fleet: what you can do now, what changed, and what you need to do before you push.">')
    .replace(/<meta property="og:title"[^>]*>/, '<meta property="og:title" content="fleet · Changelog">')
    .replace(/<meta property="og:description"[^>]*>/, '<meta property="og:description" content="Every release of fleet, with what you need to do before you push.">')
    .replace(/<link rel="canonical"[^>]*>/, '<link rel="canonical" href="https://rolflab.nl/fleet/changelog/">')
    .replace(/(href|src)="(fonts\/|style\.css)/g, '$1="../$2');
  const nav = indexHtml.match(/<header class="nav">[\s\S]*?<\/header>/)![0]
    .replace(/href="#top"/, 'href="../"')
    .replace(/href="#(how|bridge|compare|start)"/g, 'href="../#$1"')
    .replace('<a href="#whats-new">What\'s new</a>', '<a href="../#whats-new">What\'s new</a>')
    .replace(/(<a href="\.\.\/#start">)/, '<a href="./" aria-current="page" style="color:var(--text)">Changelog</a>\n      $1');
  return `${meta}
</head>
<body>
  <div class="backdrop" aria-hidden="true"></div>

  ${nav}

  <main class="clpage">
    <h1>Changelog</h1>
    <p class="lede">Every release of fleet, built from <code>CHANGELOG.md</code>. Pick a kind to see only those changes. "You need to do" is open on every release: read it before you push.</p>
    <div class="filters" role="group" aria-label="Show only">${["All", ...KINDS].map(filter).join("")}</div>
    <ol class="rail">
      ${rail(all, "", true)}
    </ol>
    <div>
${all.map((r, i) => release(r, i === 0)).join("\n")}
    </div>
  </main>

  <script>
    document.querySelectorAll(".filters button").forEach((b) => b.addEventListener("click", () => {
      document.querySelectorAll(".filters button").forEach((x) => x.classList.toggle("on", x === b));
      const f = b.dataset.f;
      document.querySelectorAll(".cl-sec").forEach((s) => {
        const hit = f === "all" || s.classList.contains(f);
        s.hidden = !hit;
        if (f !== "all" && hit) s.open = true;
      });
    }));
    const nav = document.querySelector(".nav");
    addEventListener("scroll", () => nav.classList.toggle("scrolled", scrollY > 8), { passive: true });
  </script>
</body>
</html>
`;
};

/** The two files, from the changelog and the landing page as they are now. */
export function build(changelog: string, indexHtml: string): { index: string; changelog: string } {
  const all = releases(changelog);
  if (all.length === 0) throw new Error("CHANGELOG.md has no released version");
  const index = fill(fill(indexHtml, "release-pill", pill(all[0]!)), "whats-new", news(all));
  return { index, changelog: page(index, all) };
}

if (import.meta.main) {
  const root = process.argv[2] ?? join(import.meta.dirname, "..");
  const out = build(readFileSync(join(root, "CHANGELOG.md"), "utf8"), readFileSync(join(root, "site/index.html"), "utf8"));
  writeFileSync(join(root, "site/index.html"), out.index);
  mkdirSync(join(root, "site/changelog"), { recursive: true });
  writeFileSync(join(root, "site/changelog/index.html"), out.changelog);
}
