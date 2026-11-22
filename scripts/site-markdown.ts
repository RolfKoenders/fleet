// The markdown the site pages are written in, rendered by hand: the docs use a known subset (headings,
// paragraphs, lists, tables, fenced code, inline code, links and bold; a one-line HTML comment is skipped), and the site has no build step
// and no dependency. scripts/site-changelog.ts shares the inline part for the changelog's items.

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The anchor a heading gets: lowercase words joined by dashes, as GitHub names them. */
export const slug = (heading: string) => heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Inline markdown as HTML, escaped: `code`, [links](url) and **bold**. `link` decides where a link goes. */
export function inline(s: string, link: (url: string) => string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text: string, url: string) => `<a href="${link(url)}">${text}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
}

/** The same line with its inline marks taken out, for the search index. */
export const plain = (s: string) =>
  s.replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1");

export type DocSection = { heading: string; anchor: string; text: string };
export type Doc = { title: string; html: string; sections: DocSection[] };

const LIST = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
/** A table's second line: pipes, spaces, colons and at least one dash. */
const isTableSep = (s: string) => /^[\s|:-]+$/.test(s) && s.includes("-");
const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/**
 * One markdown document as the body of a docs page. The first `# ` line is the page's title and is not
 * part of the body. `sections` is the text of the page cut at each `## `, for the search index: the
 * entry before the first `## ` has the title as its heading and no anchor.
 */
export function renderDoc(md: string, link: (url: string) => string): Doc {
  const lines = md.split("\n");
  const out: string[] = [];
  const sections: DocSection[] = [];
  const text: string[] = [];
  let title = "";
  let heading = "";
  let anchor = "";
  let i = 0;

  const cut = () => {
    if (text.join("").trim() !== "") sections.push({ heading: heading || title, anchor, text: text.join(" ").trim() });
    text.length = 0;
  };

  /** The list at line `i`, as HTML. Items indented deeper than the list's own become a list inside that item. */
  const list = (indent: number): string => {
    const ordered = /^\d/.test(lines[i]!.match(LIST)![2]!);
    const items: string[] = [];
    while (i < lines.length) {
      const m = lines[i]!.match(LIST);
      if (m === null || m[1]!.length < indent || (m[1]!.length === indent && ordered !== /^\d/.test(m[2]!))) break;
      if (m[1]!.length > indent) {
        items[items.length - 1] += list(m[1]!.length);
        continue;
      }
      items.push(`<li>${inline(m[3]!, link)}`);
      text.push(plain(m[3]!));
      i++;
    }
    const tag = ordered ? "ol" : "ul";
    return `<${tag}>${items.map((x) => `${x}</li>`).join("")}</${tag}>`;
  };

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "" || /^<!--.*-->$/.test(line.trim())) i++;
    else if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
      i++;
      out.push(`<pre class="doc-code"><code>${esc(code.join("\n"))}</code></pre>`);
      text.push(code.join(" "));
    } else if (/^#{1,4} /.test(line)) {
      const [, marks, raw] = line.match(/^(#{1,4}) (.+)$/) as unknown as [string, string, string];
      const words = raw.trim();
      if (marks.length === 1 && title === "") {
        title = plain(words);
        cut();
      } else {
        if (marks.length === 2) {
          cut();
          heading = plain(words);
          anchor = slug(words);
        }
        out.push(`<h${marks.length} id="${slug(words)}">${inline(words, link)}</h${marks.length}>`);
        text.push(plain(words));
      }
      i++;
    } else if (line.includes("|") && isTableSep(lines[i + 1] ?? "")) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") rows.push(cells(lines[i++]!));
      out.push(
        `<div class="doc-table"><table><thead><tr>${head.map((c) => `<th>${inline(c, link)}</th>`).join("")}</tr></thead>` +
          `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, link)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`,
      );
      text.push(plain(head.join(" ")), ...rows.map((r) => plain(r.join(" "))));
    } else if (LIST.test(line)) {
      out.push(list(line.match(LIST)![1]!.length));
    } else {
      const para: string[] = [];
      while (
        i < lines.length && lines[i]!.trim() !== "" && !/^(#{1,4} |```)/.test(lines[i]!) &&
        !LIST.test(lines[i]!) && !(lines[i]!.includes("|") && isTableSep(lines[i + 1] ?? ""))
      ) para.push(lines[i++]!.trim());
      out.push(`<p>${inline(para.join(" "), link)}</p>`);
      text.push(plain(para.join(" ")));
    }
  }
  cut();
  return { title, html: out.join("\n"), sections };
}
