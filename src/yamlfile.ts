import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { load } from "../vendor/js-yaml.mjs";

export type Obj = Record<string, unknown>;

export const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
export const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Texts that stand in for files of the config repo at `root`, keyed by repo-relative path. Held edits, not yet on disk. */
export type Overlay = { root: string; files: Readonly<Record<string, string>> };

/** Reads a YAML map. Problems are appended to `problems`; a missing optional file is null without one. A file in `overlay` is read from there instead of from disk. */
export function parseFile(path: string, optional: boolean, problems: string[], overlay?: Overlay): Obj | null {
  let text: string;
  try {
    const held = overlay ? relative(overlay.root, path) : null;
    text = held !== null && Object.hasOwn(overlay!.files, held) ? overlay!.files[held]! : readFileSync(path, "utf8");
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    problems.push(`${path}: cannot read: ${(error as Error).message}`);
    return null;
  }
  let doc: unknown;
  try {
    doc = load(text, { filename: path });
  } catch (error) {
    problems.push(`${path}: ${(error as Error).message.split("\n")[0]}`);
    return null;
  }
  if (doc === null || doc === undefined) return {};
  if (!isObject(doc)) {
    problems.push(`${path}: must be a map`);
    return null;
  }
  return doc;
}
