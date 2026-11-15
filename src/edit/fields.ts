import { load } from "../../vendor/js-yaml.mjs";
import { stringText } from "./scalars.ts";
import type { Quote } from "./scalars.ts";
import { flowText, pairLines, styleOf } from "./entries.ts";
import type { Style, Value } from "./entries.ts";
import { CannotEdit, Stale, afterColon, appendTopLevel, indentStep, insertLines, isEmpty, isMap, isScalar, isSeq, keyColumn, lineStart, pairEnd, pairOf, parse } from "./yamltext.ts";
import type { Pair, Parsed, Scalar, YAMLMap, YAMLSeq } from "./yamltext.ts";

/**
 * Changing the value of keys that are already in a file, one key at a time. This is the one place that splices inside an entry;
 * `addEntry` and the list edits only ever add lines. A change says what the key held (`from`) and what it should hold (`to`),
 * where `null` is "not there": `from: null` adds the key, `to: null` takes it out with its line. Only the text of a changed value
 * moves: every other key, comment and blank line stays byte for byte, and a comment at the end of a changed line stays on it.
 *
 * The same discipline as the rest of the engine: a value that is not what `from` says is `Stale`, a shape that cannot be spliced
 * safely is `CannotEdit`, and the result is read again and must be exactly the old document with the changes made.
 */

export type Change = { key: string; from: Value | null; to: Value | null };

const isScalarValue = (v: Value): v is string | number | boolean => typeof v !== "object";

/** Two values are the same: maps without regard to the order of their keys, lists in order. */
export function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const [ka, kb] = [Object.keys(a), Object.keys(b)];
    return ka.length === kb.length && ka.every((k) => k in b && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
}

function loadDoc(text: string): unknown {
  try {
    return load(text) ?? null;
  } catch {
    throw new CannotEdit("the file is not valid YAML");
  }
}

/** What `path` holds in a loaded document, `null` when it is not there. */
function valueAt(doc: unknown, path: readonly string[]): Value | null {
  let at: unknown = doc;
  for (const key of path) {
    if (typeof at !== "object" || at === null || Array.isArray(at) || !(key in at)) return null;
    at = (at as Record<string, unknown>)[key];
  }
  return (at ?? null) as Value | null;
}

/** The document with `changes` made at `path`: what the file must read as afterwards. */
function expected(doc: unknown, path: readonly string[], changes: readonly Change[]): unknown {
  const root = structuredClone(doc ?? {}) as Record<string, unknown>;
  let at = root;
  for (const key of path) at = at[key] as Record<string, unknown>;
  for (const c of changes) {
    if (c.to === null) delete at[c.key];
    else at[c.key] = c.to;
  }
  return root;
}

/** The block map at `path` and the pair that holds it (`null` for the top of the file). */
function mapAt(parsed: Parsed, path: readonly string[]): { map: YAMLMap; owner: Pair | null } {
  let map = parsed.map;
  let owner: Pair | null = null;
  for (const key of path) {
    const pair: Pair | undefined = map ? pairOf(map, key) : undefined;
    if (!pair) throw new Stale(`'${key}' is not in the file any more`);
    if (!isMap(pair.value) || pair.value.flow) throw new CannotEdit(`'${key}' is not a block map`);
    map = pair.value;
    owner = pair;
  }
  if (!map) throw new CannotEdit("the file holds no keys");
  return { map, owner };
}

const quoteOf = (node: Scalar): Quote => (node.type === "QUOTE_DOUBLE" ? "double" : node.type === "QUOTE_SINGLE" ? "single" : "plain");
const oneLine = (text: string, node: { range?: [number, number, number] | null }): boolean => !text.slice(node.range![0], node.range![1]).includes("\n");
const restOfLine = (text: string, from: number): string => text.slice(from, text.indexOf("\n", from) === -1 ? text.length : text.indexOf("\n", from));
/** Nothing but space and a comment follows `from` on its line. */
const onlyComment = (text: string, from: number): boolean => /^\s*(#.*)?$/.test(restOfLine(text, from));

/**
 * Why the value of `pair` cannot be changed by splicing, as a `CannotEdit`. A value is one line of plain or quoted text, a list or map written
 * in flow style on one line, or a block list or block map of such values with every item on a line of its own.
 */
function checkShape(text: string, pair: Pair, label: string): void {
  const node = pair.value;
  if (isEmpty(node)) throw new CannotEdit(`'${label}' has no value`);
  checkNode(text, node, label);
}

function checkNode(text: string, node: unknown, label: string): void {
  if (isScalar(node)) {
    if (node.type === "BLOCK_FOLDED" || node.type === "BLOCK_LITERAL") throw new CannotEdit(`'${label}' is a block of text (| or >)`);
    if (!oneLine(text, node)) throw new CannotEdit(`'${label}' is a value written over several lines`);
  } else if (isSeq(node) && node.flow) {
    if (!oneLine(text, node)) throw new CannotEdit(`'${label}' is a list written over several lines`);
    if (!node.items.every(isScalar)) throw new CannotEdit(`'${label}' is a list of lists or maps`);
  } else if (isMap(node) && node.flow) {
    if (!oneLine(text, node)) throw new CannotEdit(`'${label}' is a map written over several lines`);
    if (!node.items.every((p) => isScalar(p.value))) throw new CannotEdit(`'${label}' is a map of lists or maps`);
  } else if (isSeq(node)) {
    for (const item of node.items) {
      if (!isScalar(item)) throw new CannotEdit(`'${label}' is a list of lists or maps`);
      const from = lineStart(text, item.range![0]);
      if (!/^\s*-\s+$/.test(text.slice(from, item.range![0])) || !onlyComment(text, item.range![1])) throw new CannotEdit(`'${label}' has items that are not on lines of their own`);
      checkNode(text, item, label);
    }
  } else if (isMap(node)) {
    for (const p of node.items) {
      if (!isScalar(p.key)) throw new CannotEdit(`'${label}' has a key that is not plain text`);
      const key = String(p.key.value);
      if (!/^\s*$/.test(text.slice(lineStart(text, p.key.range![0]), p.key.range![0]))) throw new CannotEdit(`'${label}.${key}' does not start its line`);
      checkShape(text, p, `${label}.${key}`);
    }
  } else {
    throw new CannotEdit(`'${label}' is not a value fleet can change`);
  }
}

/**
 * Why the entry at `path` cannot be edited, or `null` when it can. The entry is a block map (a server, a source, or the top of a host file),
 * of which `only` names the keys that matter (all of them when it is not given), or a block or flow list (a bundle).
 */
export function editProblem(text: string, path: readonly string[], only?: readonly string[]): string | null {
  try {
    const parsed = parse(text);
    if (path.length === 0) {
      if (!parsed.map) return null;
      for (const p of parsed.map.items) if (isScalar(p.key) && (only === undefined || only.includes(String(p.key.value)))) checkShape(text, p, String(p.key.value));
      return null;
    }
    const { map } = mapAt(parsed, path.slice(0, -1));
    const pair = pairOf(map, path.at(-1)!);
    if (!pair) throw new Stale(`'${path.at(-1)}' is not in the file`);
    const label = path.at(-1)!;
    if (isMap(pair.value) && !pair.value.flow) {
      for (const p of pair.value.items) {
        if (!isScalar(p.key)) throw new CannotEdit(`'${label}' has a key that is not plain text`);
        if (only === undefined || only.includes(String(p.key.value))) checkShape(text, p, `${label}.${p.key.value}`);
      }
    } else if (isSeq(pair.value)) checkNode(text, pair.value, label);
    else throw new CannotEdit(`'${label}' is not a map or a list written in block style`);
    return null;
  } catch (error) {
    if (error instanceof CannotEdit) return error.message;
    throw error;
  }
}

/** The value of `path` as the file says, or `undefined` when it is not there. */
export function readValue(text: string, path: readonly string[]): Value | undefined {
  const v = valueAt(loadDoc(text), path);
  return v === null ? undefined : v;
}

/**
 * Makes `changes` to the keys of the block map at `path` (`[]` is the top of the file). `order` is the order in which a key that is not
 * there yet is placed among the others. Every `from` must be what the file holds now (else `Stale`).
 */
export function editFields(text: string, path: readonly string[], changes: readonly Change[], order: readonly string[] = []): string {
  const before = loadDoc(text);
  for (const c of changes) {
    const now = valueAt(before, [...path, c.key]);
    if (!same(now, c.from)) throw new Stale(`'${[...path, c.key].join(".")}' is not what this edit was made from: it has changed in the file`);
  }
  const todo = changes.filter((c) => !same(c.from, c.to));
  // Keys that are there first, then new keys in the order the file's kind of entry writes them.
  const rank = (c: Change) => (order.indexOf(c.key) < 0 ? order.length : order.indexOf(c.key));
  const added = todo.filter((c) => c.from === null).sort((a, b) => rank(a) - rank(b));
  // Every step works on a text that ends in a newline, so a last line is like any other.
  const newline = text.endsWith("\n");
  let out = newline ? text : `${text}\n`;
  for (const c of [...todo.filter((c) => c.from !== null), ...added]) out = change(out, path, c, order);
  if (!newline) out = out.slice(0, -1);
  if (!same(loadDoc(out), expected(before, path, changes))) throw new CannotEdit(`'${path.join(".") || "the file"}' could not be changed without guessing`);
  return out;
}

function change(text: string, path: readonly string[], c: Change, order: readonly string[]): string {
  const parsed = parse(text);
  if (path.length === 0 && !parsed.map) {
    if (c.to === null) return text;
    return appendTopLevel(parsed, pairLines(c.key, c.to, 0, freshStyle(parsed)));
  }
  const { map, owner } = mapAt(parsed, path);
  const pair = pairOf(map, c.key);
  if (c.to === null) return pair ? removePair(text, pair) : text;
  if (!pair) return insertPair(text, parsed, map, owner, c.key, c.to, order);
  checkShape(text, pair, [...path, c.key].join("."));
  return replaceValue(text, parsed, pair, owner, [...path, c.key], c.from!, c.to);
}

const freshStyle = (parsed: Parsed): Style => ({ quote: "plain", flowKeys: new Map(), flowLists: true, flowMaps: false, paddedFlowMaps: true, entryFlow: false, step: indentStep(parsed), keys: [] });

function styleFor(text: string, parsed: Parsed, owner: Pair | null): Style {
  return owner ? styleOf(text, owner, indentStep(parsed)) : freshStyle(parsed);
}

/** A key that is not there yet goes after the last key that comes before it in `order` (or at the end when `order` says nothing), else first. */
function insertPair(text: string, parsed: Parsed, map: YAMLMap, owner: Pair | null, key: string, value: Value, order: readonly string[]): string {
  const rank = (k: string) => (order.indexOf(k) < 0 ? order.length : order.indexOf(k));
  const lines = pairLines(key, value, keyColumn(text, map), styleFor(text, parsed, owner));
  let after: Pair | undefined;
  for (const p of map.items) if (isScalar(p.key) && rank(String(p.key.value)) <= rank(key)) after = p;
  if (after) return insertLines(text, pairEnd(text, after), lines);
  const at = lineStart(text, (map.items[0]!.key as Scalar).range![0]);
  return `${text.slice(0, at)}${lines.join("\n")}\n${text.slice(at)}`;
}

/** The key and everything under it, with its lines. A comment above it stays. */
export function removePair(text: string, pair: Pair): string {
  const keyAt = (pair.key as Scalar).range![0];
  const from = lineStart(text, keyAt);
  const end = pairEnd(text, pair);
  if (!/^\s*$/.test(text.slice(from, keyAt)) || !onlyComment(text, end)) throw new CannotEdit(`'${(pair.key as Scalar).value}' does not have lines of its own`);
  const nl = text.indexOf("\n", end);
  return `${text.slice(0, from)}${text.slice(nl === -1 ? text.length : nl + 1)}`;
}

/** The value's own lines are gone and the key holds `[]` or `{}`. A comment at the end of the key's line stays. */
function emptied(text: string, pair: Pair, empty: "[]" | "{}"): string {
  const colon = afterColon(text, pair);
  const nl = text.indexOf("\n", colon);
  const end = pairEnd(text, pair);
  const stop = text.indexOf("\n", end);
  return `${text.slice(0, colon)} ${empty}${text.slice(colon, nl + 1)}${text.slice(stop === -1 ? text.length : stop + 1)}`;
}

const splice = (text: string, from: number, to: number, insert: string): string => `${text.slice(0, from)}${insert}${text.slice(to)}`;

function replaceValue(text: string, parsed: Parsed, pair: Pair, owner: Pair | null, path: readonly string[], from: Value, to: Value): string {
  const node = pair.value;
  const label = path.join(".");
  const style = styleFor(text, parsed, owner);
  if (isScalar(node)) {
    if (!isScalarValue(to)) throw new CannotEdit(`'${label}' would change from a single value to a list or map`);
    return splice(text, node.range![0], node.range![1], typeof to === "string" ? stringText(to, quoteOf(node)) : String(to));
  }
  if (isSeq(node) && node.flow) {
    if (!Array.isArray(to) || !to.every(isScalarValue)) throw new CannotEdit(`'${label}' would change to something other than a list of values`);
    return splice(text, node.range![0], node.range![1], flowText(to, style));
  }
  if (isMap(node) && node.flow) {
    if (typeof to !== "object" || Array.isArray(to) || !Object.values(to).every(isScalarValue)) throw new CannotEdit(`'${label}' would change to something other than a map of values`);
    return splice(text, node.range![0], node.range![1], flowText(to, style));
  }
  if (isSeq(node)) return blockList(text, pair, node, to);
  if (isMap(node)) {
    if (typeof to !== "object" || Array.isArray(to)) throw new CannotEdit(`'${label}' would change from a map to something else`);
    if (Object.keys(to).length === 0) return emptied(text, pair, "{}");
    const [f, t] = [from as Record<string, Value>, to];
    const keys = [...new Set([...Object.keys(f), ...Object.keys(t)])];
    const inner = keys.map((key): Change => ({ key, from: f[key] ?? null, to: t[key] ?? null })).filter((c) => !same(c.from, c.to));
    // The keys of the map are written in the order the new value has them.
    const newKeys = Object.keys(t);
    const order = [...newKeys];
    let out = text;
    for (const c of [...inner.filter((c) => c.from !== null), ...inner.filter((c) => c.from === null).sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))]) out = change(out, path, c, order);
    return out;
  }
  throw new CannotEdit(`'${label}' is not a value fleet can change`);
}

/** The longest run of items that `a` and `b` share, in order: pairs of indexes. */
function common(a: readonly unknown[], b: readonly unknown[]): [number, number][] {
  const n = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) n[i]![j] = a[i] === b[j] ? n[i + 1]![j + 1]! + 1 : Math.max(n[i + 1]![j]!, n[i]![j + 1]!);
  const out: [number, number][] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) out.push([i++, j++]);
    else if (n[i + 1]![j]! >= n[i]![j + 1]!) i++;
    else j++;
  }
  return out;
}

/**
 * A block list becomes `to`: items that are gone lose their line, new ones get a line after the item before them, and the items that stay are not touched,
 * so a comment at the end of their line stays.
 */
function blockList(text: string, pair: Pair, seq: YAMLSeq, to: Value): string {
  const label = String((pair.key as Scalar).value);
  if (!Array.isArray(to) || !to.every(isScalarValue)) throw new CannotEdit(`'${label}' would change to something other than a list of values`);
  if (to.length === 0) return emptied(text, pair, "[]");
  const items = seq.items as Scalar[];
  const kept = common(items.map((i) => i.value), to);
  const keptOld = new Set(kept.map(([i]) => i));
  const anchorOf = new Map(kept.map(([i, j]) => [j, i]));
  const first = items[0]!;
  const prefix = text.slice(lineStart(text, first.range![0]), first.range![0]);
  const quote = quoteOf(first);
  const lineEnd = (item: Scalar) => (text.indexOf("\n", item.range![1]) === -1 ? text.length : text.indexOf("\n", item.range![1]) + 1);

  const cuts: { at: number; del: number; ins: string }[] = [];
  items.forEach((item, i) => {
    if (!keptOld.has(i)) cuts.push({ at: lineStart(text, item.range![0]), del: lineEnd(item) - lineStart(text, item.range![0]), ins: "" });
  });
  const inserts = new Map<number, string[]>();
  let anchor = -1;
  to.forEach((v, j) => {
    if (anchorOf.has(j)) anchor = anchorOf.get(j)!;
    else inserts.set(anchor, [...(inserts.get(anchor) ?? []), `${prefix}${typeof v === "string" ? stringText(v, quote) : String(v)}\n`]);
  });
  for (const [after, lines] of inserts) cuts.push({ at: after < 0 ? lineStart(text, first.range![0]) : lineEnd(items[after]!), del: 0, ins: lines.join("") });
  // From the end of the text backwards, so a position still means the same place; a line that goes is cut before one is put where it stood.
  cuts.sort((a, b) => b.at - a.at || (b.del > 0 ? 1 : 0) - (a.del > 0 ? 1 : 0));
  let out = text;
  for (const c of cuts) out = splice(out, c.at, c.at + c.del, c.ins);
  return out;
}
