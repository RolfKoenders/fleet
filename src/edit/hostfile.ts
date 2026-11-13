import { load } from "../../vendor/js-yaml.mjs";
import { CannotEdit, isEmpty, lineStart, pairEnd, pairOf, parse } from "./yamltext.ts";
import type { Scalar } from "./yamltext.ts";
import { stringText } from "./scalars.ts";

/** What a host copied from another takes with it. Not `ssh` (it is another machine), `age` (its own key) or `files` (links that name this machine). */
export const COPIED_KEYS = ["bundles", "exclude", "mcp", "settings", "vars"] as const;

/**
 * The text of a new host file: how to reach it, an empty `age` for `fleet init` to fill, and, when `source` is given,
 * the text of each key in `COPIED_KEYS` that the source has, cut out of it as it is written (comments inside the key,
 * list style and quoting stay). The result is always a document with keys, never comments alone.
 */
export function newHostFile(ssh: string, source: string | null): string {
  const blocks = [`ssh: ${stringText(ssh, "plain")}\nage: ""\n`];
  const copied: Record<string, unknown> = {};
  const parsed = source === null ? null : parse(source);
  if (source !== null && parsed?.map) {
    const from = load(source) as Record<string, unknown>;
    for (const key of COPIED_KEYS) {
      const pair = pairOf(parsed.map, key);
      if (!pair || isEmpty(pair.value)) continue;
      // To the end of the last line, so a comment after the last value goes with it.
      const end = source.indexOf("\n", pairEnd(source, pair));
      blocks.push(`${source.slice(lineStart(source, (pair.key as Scalar).range![0]), end === -1 ? source.length : end).trimEnd()}\n`);
      copied[key] = from[key];
    }
  }
  const text = blocks.join("\n");
  const read = load(text) as Record<string, unknown> | null;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (read === null || read.ssh !== ssh || read.age !== "" || !Object.entries(copied).every(([k, v]) => same(read[k], v)) || Object.keys(read).length !== 2 + Object.keys(copied).length) {
    throw new CannotEdit("the new host file could not be written without guessing");
  }
  return text;
}
