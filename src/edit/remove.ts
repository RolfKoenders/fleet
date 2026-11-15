import { load } from "../../vendor/js-yaml.mjs";
import { removePair, same } from "./fields.ts";
import type { Section } from "./entries.ts";
import { CannotEdit, Stale, afterColon, isMap, lineStart, pairOf, parse } from "./yamltext.ts";

/**
 * Takes one entry out of a catalog section, with the lines of the entry, the comments inside it and the comment lines right above it (the
 * ones the YAML view shows as part of the item), and nothing else: any other comment, the other entries and their blank lines stay byte for byte. A section left with no entry is `{}`, which
 * the loader reads as an empty section (a bare `servers:` is not a map). The result is read again and must be the old document
 * without the entry.
 */
export function removeEntry(text: string, section: Section, name: string): string {
  const parsed = parse(text);
  const owner = parsed.map && pairOf(parsed.map, section);
  if (!owner || !isMap(owner.value)) throw new Stale(`'${name}' is not in the ${section} of the file any more`);
  if (owner.value.flow) throw new CannotEdit(`'${section}' is not a block map`);
  const map = owner.value;
  const pair = pairOf(map, name);
  if (!pair) throw new Stale(`'${name}' is not in the ${section} of the file any more`);

  const first = map.items[0] === pair;
  const keyAt = (pair.key as { range: [number, number] }).range[0];
  let from = lineStart(text, keyAt);
  // The comment lines directly above, at the entry's own indent, describe it and go with it: the same lines the YAML view shows for the item.
  const column = keyAt - from;
  for (let at = from; at > 0; ) {
    const above = lineStart(text, at - 1);
    const line = text.slice(above, at - 1);
    if (!line.trimStart().startsWith("#") || line.length - line.trimStart().length !== column) break;
    from = above;
    at = above;
  }
  // `removePair` refuses an entry that does not have lines of its own; its cut is the entry's last content line, and comments deeper than the key
  // that follow it (still inside the entry, as the YAML view has it) go as well.
  const rest = removePair(text, pair).slice(lineStart(text, keyAt));
  let kept = text.length - rest.length;
  for (let next = text.indexOf("\n", kept); next !== -1 && next + 1 < text.length; next = text.indexOf("\n", kept)) {
    const line = text.slice(kept, next);
    if (!line.trimStart().startsWith("#") || line.length - line.trimStart().length <= column) break;
    kept = next + 1;
  }
  let out = `${text.slice(0, from)}${text.slice(kept)}`;
  if (map.items.length === 1) {
    const colon = afterColon(text, owner);
    out = `${out.slice(0, colon)} {}${out.slice(colon)}`;
  } else {
    // The blank line that set the entry apart from its neighbour goes with it, so two blank lines are never left behind.
    const [before, after] = [out.slice(0, from), out.slice(from)];
    const blankBefore = /(^|\n)[ \t]*\n$/.test(before);
    const blankAfter = /^[ \t]*\n/.exec(after);
    if (blankAfter !== null && (first || blankBefore)) out = `${before}${after.slice(blankAfter[0].length)}`;
    else if (after === "" && blankBefore) out = before.replace(/\n[ \t]*\n$/, "\n");
  }

  const doc = load(text) as Record<string, Record<string, unknown>>;
  const want = structuredClone(doc);
  delete want[section]![name];
  let now: unknown = null;
  try {
    now = load(out);
  } catch {
    // reported below
  }
  if (!same(now, want)) throw new CannotEdit(`'${name}' could not be taken out without guessing`);
  return out;
}
