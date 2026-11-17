import { isObject } from "../yamlfile.ts";
import type { Obj } from "../yamlfile.ts";

/** The entry without its empty lists and maps, which no agent needs written. */
export const withoutEmpty = (entry: Obj): Obj =>
  Object.fromEntries(Object.entries(entry).filter(([, v]) => !(Array.isArray(v) ? v.length === 0 : isObject(v) && Object.keys(v).length === 0)));

export const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);

export const stringMap = (v: unknown): Record<string, string> =>
  isObject(v) ? (Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string")) as Record<string, string>) : {};
