const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const indentOf = (line: string) => line.length - line.trimStart().length;
const significant = (line: string) => line.trim() !== "" && !line.trimStart().startsWith("#");

/**
 * Swaps the sha on a `commit:` line and touches nothing else, so comments, quoting and spacing survive. The
 * line is found under the top-level key `top`, then (when `key` is not null) the child map named `key`.
 * Returns null unless the line is found exactly once with the sha `from`, so a layout it does not know is
 * never guessed at.
 */
export function replaceCommit(text: string, top: string, key: string | null, from: string, to: string): string | null {
  const lines = text.split("\n");
  const topLine = new RegExp(`^${escapeRegExp(top)}:[ \\t]*(#.*)?\\r?$`);
  const first = lines.findIndex((l) => topLine.test(l));
  if (first === -1) return null;
  let end = first + 1;
  while (end < lines.length && (!significant(lines[end]!) || indentOf(lines[end]!) > 0)) end++;

  const section = lines.slice(first + 1, end);
  let start = -1;
  let stop = section.length;
  if (key !== null) {
    const level = Math.min(...section.filter(significant).map(indentOf));
    const name = new RegExp(`^ {${level}}(?:${escapeRegExp(key)}|"${escapeRegExp(key)}"|'${escapeRegExp(key)}'):[ \\t]*(?:#.*)?\\r?$`);
    start = section.findIndex((l) => name.test(l));
    if (start === -1) return null;
    stop = start + 1;
    while (stop < section.length && (!significant(section[stop]!) || indentOf(section[stop]!) > level)) stop++;
  }

  const commit = /^([ \t]+commit:[ \t]*(["']?))([0-9a-f]{40})(\2(?:[ \t]+#.*)?[ \t]*\r?)$/;
  const hits = section.slice(start + 1, stop).flatMap((l, i) => (commit.test(l) ? [start + 1 + i] : []));
  if (hits.length !== 1 || commit.exec(section[hits[0]!]!)![3] !== from) return null;
  section[hits[0]!] = section[hits[0]!]!.replace(commit, `$1${to}$4`);
  return [...lines.slice(0, first + 1), ...section, ...lines.slice(end)].join("\n");
}
