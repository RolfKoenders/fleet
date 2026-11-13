import { isMap, isScalar, isSeq, parseDocument, visit } from "../../vendor/yaml/index.js";
import type { Pair, Scalar, YAMLMap, YAMLSeq } from "../../vendor/yaml/index.js";

/**
 * Everything that reads where things sit in a YAML text, and nothing that prints one: an edit is
 * always a splice of the original text, so what it does not touch stays byte for byte.
 */

/** The text has a shape that cannot be spliced safely. The message says which. */
export class CannotEdit extends Error {}

export type Parsed = { text: string; map: YAMLMap | null };

/** Parses `text` for splicing. Anything exotic (anchors, aliases, tags, CRLF, several documents) is refused. */
export function parse(text: string): Parsed {
  if (text.includes("\r")) throw new CannotEdit("the file has Windows line endings");
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new CannotEdit(`the file is not valid YAML: ${doc.errors[0]!.message.split("\n")[0]}`);
  let exotic: string | null = null;
  visit(doc, {
    Alias: () => (exotic = "an alias"),
    Node: (_key, node) => {
      if (node.anchor) exotic = "an anchor";
      else if (node.tag) exotic = "a tag";
    },
  });
  if (exotic) throw new CannotEdit(`the file uses ${exotic}`);
  const contents = doc.contents;
  if (contents === null || contents === undefined) return { text, map: null };
  if (!isMap(contents) || contents.flow) throw new CannotEdit("the file is not a block map at the top");
  return { text, map: contents };
}

export function pairOf(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((p) => isScalar(p.key) && p.key.value === key);
}

/** The block map under `key`, `null` when it is missing or empty. Refuses a flow map or a non-map. */
export function mapUnder(map: YAMLMap | null, key: string): YAMLMap | null {
  const pair = map && pairOf(map, key);
  if (!pair || isEmpty(pair.value)) return null;
  if (!isMap(pair.value) || pair.value.flow) throw new CannotEdit(`'${key}' is not a block map`);
  return pair.value;
}

/** A key with nothing after the colon. */
export const isEmpty = (node: unknown): boolean =>
  node === null || node === undefined || (isScalar(node) && node.value === null && node.range != null && node.range[0] === node.range[1]);

export const lineStart = (text: string, pos: number): number => text.lastIndexOf("\n", pos - 1) + 1;
export const column = (text: string, pos: number): number => pos - lineStart(text, pos);
const keyStart = (pair: Pair): number => (pair.key as Scalar).range![0];

/** Where the key's colon is, plus one. */
export function afterColon(text: string, pair: Pair): number {
  return text.indexOf(":", (pair.key as Scalar).range![1]) + 1;
}

/** The end of the last line of content in `node`, which a block collection's own range does not give (it runs on over blank lines and comments). */
export function contentEnd(text: string, node: unknown): number {
  if (isMap(node) && !node.flow && node.items.length > 0) return pairEnd(text, node.items.at(-1)!);
  if (isSeq(node) && !node.flow && node.items.length > 0) return contentEnd(text, node.items.at(-1));
  return (node as { range: [number, number, number] }).range[1];
}

export function pairEnd(text: string, pair: Pair): number {
  return isEmpty(pair.value) ? afterColon(text, pair) : contentEnd(text, pair.value);
}

/**
 * Puts `lines` on new lines after the line that holds `end` (the end of some content), after any
 * comment on that line. A file with no final newline stays without one.
 */
export function insertLines(text: string, end: number, lines: string[]): string {
  let e = end;
  while (e > 0 && /\s/.test(text[e - 1]!)) e--;
  const nl = text.indexOf("\n", e);
  if (nl === -1) return `${text}\n${lines.join("\n")}`;
  return `${text.slice(0, nl + 1)}${lines.join("\n")}\n${text.slice(nl + 1)}`;
}

/** Does the text between two offsets hold a blank line? */
export const hasBlankLine = (text: string, from: number, to: number): boolean => /\n[ \t]*\n/.test(text.slice(from, to));

/** Do the entries of `map` have a blank line between them? A map of one entry has no style to copy: no. */
export function blankBetweenEntries(text: string, map: YAMLMap): boolean {
  return map.items.some((pair, i) => i > 0 && hasBlankLine(text, pairEnd(text, map.items[i - 1]!), keyStart(pair)));
}

/** Where a new last entry of the top-level map goes, as the lines to add (a blank one first when the file separates its entries). */
export function appendTopLevel(parsed: Parsed, lines: string[]): string {
  const { text, map } = parsed;
  if (!map) {
    const body = text === "" || text.endsWith("\n") ? text : `${text}\n`;
    return `${body}${text.trim() === "" ? "" : "\n"}${lines.join("\n")}\n`;
  }
  return insertLines(text, pairEnd(text, map.items.at(-1)!), blankBetweenEntries(text, map) ? ["", ...lines] : lines);
}

/** How many columns a nested block is indented in this file: the first nested block map's, else 2. */
export function indentStep(parsed: Parsed): number {
  for (const pair of parsed.map?.items ?? []) {
    if (isMap(pair.value) && !pair.value.flow && pair.value.items.length > 0) {
      return column(parsed.text, keyStart(pair.value.items[0]!)) - column(parsed.text, keyStart(pair));
    }
  }
  return 2;
}

/** How a block list sits under its key in this file, as the columns from the key to the dash. Indentless is 0. */
export function dashOffset(parsed: Parsed): number {
  for (const pair of parsed.map?.items ?? []) {
    const seq = pair.value;
    if (isSeq(seq) && !seq.flow && seq.items.length > 0) {
      return column(parsed.text, (seq.items[0] as Scalar).range![0]) - 2 - column(parsed.text, keyStart(pair));
    }
  }
  return indentStep(parsed);
}

export const keyColumn = (text: string, map: YAMLMap): number => column(text, keyStart(map.items[0]!));

/** The Scalar nodes of a list of strings, or a refusal. */
export function stringItems(seq: YAMLSeq): Scalar[] {
  const items: Scalar[] = [];
  for (const item of seq.items) {
    if (!isScalar(item) || typeof item.value !== "string") throw new CannotEdit("a list holds something other than names");
    items.push(item);
  }
  return items;
}

export { isMap, isScalar, isSeq };
export type { Pair, Scalar, YAMLMap, YAMLSeq };
