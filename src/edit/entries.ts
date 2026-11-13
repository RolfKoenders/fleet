import { load } from "../../vendor/js-yaml.mjs";
import { plainSafe, stringText } from "./scalars.ts";
import type { Quote } from "./scalars.ts";
import { CannotEdit, afterColon, appendTopLevel, blankBetweenEntries, column, contentEnd, indentStep, insertLines, isEmpty, isMap, isScalar, isSeq, mapUnder, pairOf, parse } from "./yamltext.ts";
import type { Pair, Scalar } from "./yamltext.ts";

/** A map in a catalog file whose entries are the things a config adds: `servers`, `sources`, `bundles`. */
export type Section = "servers" | "sources" | "bundles";

/** What a new entry may hold: strings, numbers, booleans, lists of those, and maps of those. */
export type Value = string | number | boolean | Value[] | { [key: string]: Value };

/** The keys of a new entry, in the order to write them when the entry before it does not say. */
export const KEY_ORDER: Record<Section, string[]> = {
  servers: ["command", "transport", "url", "env", "headers", "only"],
  sources: ["repo", "commit", "branch", "track", "path", "review"],
  bundles: [],
};

/** The names in `section`, empty when the section is missing. */
export function entryNames(text: string, section: Section): string[] {
  const map = mapUnder(parse(text).map, section);
  return (map?.items ?? []).map((p) => String((p.key as Scalar).value));
}

type Style = {
  quote: Quote;
  /** Per key of the entry before: was its list or map written in flow style? */
  flowKeys: Map<string, boolean>;
  flowLists: boolean;
  flowMaps: boolean;
  paddedFlowMaps: boolean;
  /** Was the entry before written as one flow map? */
  entryFlow: boolean;
  /** Columns from an entry's key to its own children. */
  step: number;
  keys: string[];
};

/** Reads how the entry before is written, to write the next one the same way. */
function styleOf(text: string, prev: Pair, sectionStep: number): Style {
  const quotes: Quote[] = [];
  const lists: boolean[] = [];
  const maps: boolean[] = [];
  const flowKeys = new Map<string, boolean>();
  let padded = true;
  const walk = (node: unknown): void => {
    if (isScalar(node)) {
      if (typeof node.value === "string" && plainSafe(node.value)) {
        quotes.push(node.type === "QUOTE_DOUBLE" ? "double" : node.type === "QUOTE_SINGLE" ? "single" : "plain");
      }
    } else if (isSeq(node)) {
      lists.push(node.flow === true);
      node.items.forEach(walk);
    } else if (isMap(node)) {
      maps.push(node.flow === true);
      if (node.flow && node.range) padded = text[node.range[0] + 1] === " ";
      node.items.forEach((p) => walk(p.value));
    }
  };
  const value = prev.value;
  walk(value);
  if (isMap(value)) {
    for (const p of value.items) {
      if (isSeq(p.value) || isMap(p.value)) flowKeys.set(String((p.key as Scalar).value), p.value.flow === true);
    }
  }
  const counts = (q: Quote) => quotes.filter((x) => x === q).length;
  const quote: Quote = counts("double") > counts("plain") && counts("double") >= counts("single") ? "double" : counts("single") > counts("plain") ? "single" : "plain";
  const step = isMap(value) && !value.flow && value.items.length > 0
    ? column(text, (value.items[0]!.key as Scalar).range![0]) - column(text, (prev.key as Scalar).range![0])
    : sectionStep;
  return {
    quote,
    flowKeys,
    flowLists: lists.length === 0 || lists.some(Boolean),
    flowMaps: maps.length > 0 && maps.every(Boolean),
    paddedFlowMaps: padded,
    entryFlow: isMap(value) && value.flow === true,
    step,
    keys: isMap(value) ? value.items.map((p) => String((p.key as Scalar).value)) : [],
  };
}

const isScalarValue = (v: Value): v is string | number | boolean => typeof v !== "object";

function scalarText(v: string | number | boolean, style: Style): string {
  return typeof v === "string" ? stringText(v, style.quote) : String(v);
}

function flowText(v: Value, style: Style): string {
  if (isScalarValue(v)) return scalarText(v, style);
  if (Array.isArray(v)) return `[${v.map((x) => flowText(x, style)).join(", ")}]`;
  const pairs = Object.entries(v).map(([k, x]) => `${keyText(k, style)}: ${flowText(x, style)}`);
  if (pairs.length === 0) return "{}";
  return style.paddedFlowMaps ? `{ ${pairs.join(", ")} }` : `{${pairs.join(", ")}}`;
}

const keyText = (key: string, style: Style): string => (plainSafe(key) ? key : stringText(key, style.quote === "single" ? "single" : "double"));

/** `key: value` as lines at column `pad`, lists and maps in flow style where the entry before had them so. */
function pairLines(key: string, value: Value, pad: number, style: Style): string[] {
  const at = " ".repeat(pad);
  const head = `${at}${keyText(key, style)}:`;
  if (isScalarValue(value)) return [`${head} ${scalarText(value, style)}`];
  const isList = Array.isArray(value);
  const empty = isList ? value.length === 0 : Object.keys(value).length === 0;
  const flow = style.flowKeys.get(key) ?? (isList ? style.flowLists : style.flowMaps);
  if (empty || flow) return [`${head} ${flowText(value, style)}`];
  if (isList) {
    const items = value.map((x) => {
      if (!isScalarValue(x)) throw new CannotEdit("a list of lists or maps cannot be written safely");
      return `${at}${" ".repeat(style.step)}- ${scalarText(x, style)}`;
    });
    return [head, ...items];
  }
  return [head, ...Object.entries(value).flatMap(([k, x]) => pairLines(k, x, pad + style.step, style))];
}

function entryLines(name: string, value: Value, pad: number, style: Style, canonical: string[]): string[] {
  if (isScalarValue(value) || Array.isArray(value)) return pairLines(name, value, pad, style);
  const rank = (k: string): number => {
    const own = style.keys.indexOf(k);
    if (own >= 0) return own;
    const known = canonical.indexOf(k);
    return 1000 + (known >= 0 ? known : 500);
  };
  const keys = Object.keys(value).sort((a, b) => rank(a) - rank(b));
  const ordered = Object.fromEntries(keys.map((k) => [k, value[k]!]));
  if (style.entryFlow) return [`${" ".repeat(pad)}${keyText(name, style)}: ${flowText(ordered, style)}`];
  return pairLines(name, ordered, pad, style);
}

/**
 * Adds `name` as the last entry of `section`, written as the entry before it is: its indentation,
 * quoting, list style and key order, and a blank line before it when the entries are apart. The
 * section is made when it is missing.
 */
export function addEntry(text: string, section: Section, name: string, value: Value): string {
  const parsed = parse(text);
  const canonical = KEY_ORDER[section];
  const pair = parsed.map && pairOf(parsed.map, section);
  const fresh: Style = { quote: "plain", flowKeys: new Map(), flowLists: true, flowMaps: false, paddedFlowMaps: true, entryFlow: false, step: indentStep(parsed), keys: [] };

  let result: string;
  if (!pair) {
    result = appendTopLevel(parsed, [`${section}:`, ...entryLines(name, value, indentStep(parsed), fresh, canonical)]);
  } else if (isEmpty(pair.value)) {
    const pad = column(text, (pair.key as Scalar).range![0]) + indentStep(parsed);
    result = insertLines(text, afterColon(text, pair), entryLines(name, value, pad, fresh, canonical));
  } else if (isMap(pair.value) && !pair.value.flow) {
    const map = pair.value;
    const prev = map.items.at(-1)!;
    const pad = column(text, (map.items[0]!.key as Scalar).range![0]);
    const style = styleOf(text, prev, pad - column(text, (pair.key as Scalar).range![0]));
    const lines = entryLines(name, value, pad, style, canonical);
    result = insertLines(text, contentEnd(text, map), blankBetweenEntries(text, map) ? ["", ...lines] : lines);
  } else {
    throw new CannotEdit(`'${section}' is not a block map`);
  }

  let doc: unknown = null;
  try {
    doc = load(result);
  } catch {
    // reported below
  }
  const written = (doc as Record<string, Record<string, unknown>> | null)?.[section]?.[name];
  if (JSON.stringify(written) !== JSON.stringify(value) && JSON.stringify(sorted(written)) !== JSON.stringify(sorted(value))) {
    throw new CannotEdit(`the entry '${name}' could not be written without guessing`);
  }
  return result;
}

function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sorted(x)]));
  return v;
}
