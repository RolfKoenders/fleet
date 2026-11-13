import { load } from "../../vendor/js-yaml.mjs";
import { CannotEdit, afterColon, appendTopLevel, column, contentEnd, dashOffset, indentStep, insertLines, isEmpty, isMap, isScalar, isSeq, keyColumn, lineStart, mapUnder, pairOf, parse, stringItems } from "./yamltext.ts";
import type { Pair, Parsed, Scalar, YAMLMap } from "./yamltext.ts";
import { plainSafe } from "./scalars.ts";

/** A list of names in a config file: `bundles` is ["bundles"], `mcp.include` is ["mcp", "include"]. */
export type ListPath = readonly [string] | readonly [string, string];

/** Where the list sits: its pair, and the map that pair is in. */
function locate(parsed: Parsed, path: ListPath): { pair: Pair | undefined; parent: YAMLMap | null } {
  const [first, second] = path;
  if (second === undefined) return { pair: parsed.map ? pairOf(parsed.map, first) : undefined, parent: parsed.map };
  const parent = mapUnder(parsed.map, first);
  return { pair: parent ? pairOf(parent, second) : undefined, parent };
}

/** The names in the list, empty when the list is missing, `[]` or a bare key. */
export function readList(text: string, path: ListPath): string[] {
  const { pair } = locate(parse(text), path);
  if (!pair || isEmpty(pair.value)) return [];
  if (!isSeq(pair.value)) throw new CannotEdit(`'${path.join(".")}' is not a list`);
  return stringItems(pair.value).map((s) => s.value as string);
}

/** How the file writes its lists: block when it has block lists and no flow ones. */
function wantsFlow(map: YAMLMap | null): boolean {
  const lists: boolean[] = [];
  for (const pair of map?.items ?? []) {
    if (isSeq(pair.value) && pair.value.items.every(isScalar)) lists.push(pair.value.flow === true);
    if (isMap(pair.value) && !pair.value.flow) {
      for (const inner of pair.value.items) if (isSeq(inner.value) && inner.value.items.every(isScalar)) lists.push(inner.value.flow === true);
    }
  }
  return lists.length === 0 || lists.some(Boolean);
}

/** `name` as the neighbours write theirs: double or single quoted when they are, plain when it can be. */
function itemText(name: string, neighbour: Scalar | undefined): string {
  if (neighbour?.type === "QUOTE_SINGLE") return `'${name.replaceAll("'", "''")}'`;
  if (neighbour?.type === "QUOTE_DOUBLE" || !plainSafe(name)) return JSON.stringify(name);
  return name;
}

function listLines(parsed: Parsed, key: string, pad: number, name: string): string[] {
  const at = " ".repeat(pad);
  if (wantsFlow(parsed.map)) return [`${at}${key}: [${itemText(name, undefined)}]`];
  return [`${at}${key}:`, `${at}${" ".repeat(dashOffset(parsed))}- ${itemText(name, undefined)}`];
}

function checked(after: string, path: ListPath, expected: string[]): string {
  let doc: unknown = null;
  try {
    doc = load(after);
  } catch {
    // reported below
  }
  let at: unknown = doc;
  for (const key of path) at = (at as Record<string, unknown> | null)?.[key];
  if (JSON.stringify(at) !== JSON.stringify(expected)) throw new CannotEdit(`'${path.join(".")}' could not be changed without guessing`);
  return after;
}

/** Adds `name` at the end of the list, writing it as the file writes its lists. The list is made when it is missing. */
export function addToList(text: string, path: ListPath, name: string): string {
  const parsed = parse(text);
  const { pair, parent } = locate(parsed, path);
  const expected = [...readList(text, path), name];
  const [first, second] = path;

  let result: string;
  if (!pair) {
    if (second === undefined) {
      result = appendTopLevel(parsed, listLines(parsed, first, 0, name));
    } else if (parent) {
      result = insertLines(text, contentEnd(text, parent), listLines(parsed, second, keyColumn(text, parent), name));
    } else {
      const top = parsed.map && pairOf(parsed.map, first);
      if (top) {
        // `mcp:` with nothing under it: the first child goes on the next line.
        result = insertLines(text, afterColon(text, top), listLines(parsed, second, column(text, (top.key as Scalar).range![0]) + indentStep(parsed), name));
      } else {
        const child = listLines(parsed, second, indentStep(parsed), name);
        result = appendTopLevel(parsed, [`${first}:`, ...child]);
      }
    }
  } else if (isEmpty(pair.value)) {
    const at = afterColon(text, pair);
    result = `${text.slice(0, at)} [${itemText(name, undefined)}]${text.slice(at)}`;
  } else if (isSeq(pair.value)) {
    const seq = pair.value;
    const items = stringItems(seq);
    const last = items.at(-1);
    if (seq.flow) {
      const [start, end] = seq.range!;
      if (text.slice(start, end).includes("\n")) throw new CannotEdit(`'${path.join(".")}' is a list written over several lines`);
      result = last
        ? `${text.slice(0, last.range![1])}, ${itemText(name, items[0])}${text.slice(last.range![1])}`
        : `${text.slice(0, start)}[${itemText(name, undefined)}]${text.slice(end)}`;
    } else {
      const prefix = text.slice(lineStart(text, last!.range![0]), last!.range![0]);
      if (!/^\s*-\s+$/.test(prefix)) throw new CannotEdit(`'${path.join(".")}' has items that are not on lines of their own`);
      result = insertLines(text, last!.range![1], [`${prefix}${itemText(name, items[0])}`]);
    }
  } else {
    throw new CannotEdit(`'${path.join(".")}' is not a list`);
  }
  return checked(result, path, expected);
}

/** Takes `name` out of the list. A list left empty is `[]`. A name that is not there leaves the text as it was. */
export function removeFromList(text: string, path: ListPath, name: string): string {
  const parsed = parse(text);
  const { pair } = locate(parsed, path);
  const names = readList(text, path);
  if (!pair || !isSeq(pair.value) || !names.includes(name)) return text;
  const seq = pair.value;
  const items = stringItems(seq);
  const i = items.findIndex((s) => s.value === name);
  const expected = names.filter((_, j) => j !== i);

  let result: string;
  if (seq.flow) {
    const [start, end] = seq.range!;
    if (text.slice(start, end).includes("\n")) throw new CannotEdit(`'${path.join(".")}' is a list written over several lines`);
    let from: number;
    let to: number;
    if (items.length === 1) [from, to] = [start, end];
    else if (i === items.length - 1) [from, to] = [items[i - 1]!.range![1], items[i]!.range![1]];
    else [from, to] = [items[i]!.range![0], items[i + 1]!.range![0]];
    result = `${text.slice(0, from)}${items.length === 1 ? "[]" : ""}${text.slice(to)}`;
  } else {
    const item = items[i]!;
    const [start, end] = item.range!;
    const from = lineStart(text, start);
    if (!/^\s*-\s+$/.test(text.slice(from, start)) || text.slice(start, end).includes("\n")) {
      throw new CannotEdit(`'${path.join(".")}' has items that are not on lines of their own`);
    }
    const nl = text.indexOf("\n", end);
    const to = nl === -1 ? text.length : nl + 1;
    const rest = text.slice(end, nl === -1 ? text.length : nl);
    if (!/^\s*(#.*)?$/.test(rest)) throw new CannotEdit(`'${path.join(".")}' has items that are not on lines of their own`);
    let cut = `${text.slice(0, from)}${text.slice(to)}`;
    if (items.length === 1) {
      const at = afterColon(text, pair);
      cut = `${cut.slice(0, at)} []${cut.slice(at)}`;
    }
    result = cut;
  }
  return checked(result, path, expected);
}
