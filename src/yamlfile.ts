import { readFileSync } from "node:fs";
import { load } from "../vendor/js-yaml.mjs";

export type Obj = Record<string, unknown>;

export const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
export const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Reads a YAML map. Problems are appended to `problems`; a missing optional file is null without one. */
export function parseFile(path: string, optional: boolean, problems: string[]): Obj | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
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
