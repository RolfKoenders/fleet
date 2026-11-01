import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseJsonc } from "./jsonc.ts";
import { CLAUDE_JSON } from "./mcp.ts";
import { expandTarget } from "./plan.ts";
import type { Conflict } from "./plan.ts";
import { SETTINGS_FILE } from "./settings.ts";
import type { DesiredKey } from "./settings.ts";
import type { KeyRecord } from "./state.ts";
import { isObject } from "./yamlfile.ts";
import type { Obj } from "./yamlfile.ts";

export type KeyRef = { file: string; path: string };
/** `display` is the value with secrets masked, set only for a key that used one. */
export type KeyChange = KeyRef & { value: unknown; desired: string; display?: unknown };

export type KeyPlan = {
  /** Paths missing from their file. */
  creates: KeyChange[];
  /** Paths fleet wrote before, untouched since, whose desired value changed. */
  updates: KeyChange[];
  /** Recorded keys no longer desired, unchanged since fleet wrote them. */
  removes: KeyRef[];
  /** Keys already right, to be recorded in state as they are. */
  noops: KeyRecord[];
  /** Recorded keys no longer desired whose path is already gone, dropped from state. */
  forgets: KeyRef[];
  conflicts: Conflict[];
};

export const emptyKeyPlan = (): KeyPlan => ({ creates: [], updates: [], removes: [], noops: [], forgets: [], conflicts: [] });

export const keyName = (ref: KeyRef): string => `${ref.file} ${ref.path}`;

const OLD_OPENCODE_FILE = "~/.config/opencode/opencode.json";

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
};

/** SHA-256 of the value as JSON with sorted keys. Applied state holds these, never values. */
export const hashValue = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

export type Lookup = { type: "found"; value: unknown } | { type: "missing" } | { type: "blocked" };

/** `blocked` means something on the way down is not a map, so the path can hold nothing. */
export function lookup(doc: Obj, path: string): Lookup {
  let node: unknown = doc;
  for (const segment of path.split(".")) {
    if (!isObject(node)) return { type: "blocked" };
    if (!Object.hasOwn(node, segment)) return { type: "missing" };
    node = node[segment];
  }
  return { type: "found", value: node };
}

function setAt(doc: Obj, path: string, value: unknown): void {
  const segments = path.split(".");
  const last = segments.pop()!;
  let node = doc;
  for (const segment of segments) {
    if (!Object.hasOwn(node, segment)) node[segment] = {};
    node = node[segment] as Obj;
  }
  node[last] = value;
}

/** Deletes the leaf only. Maps it leaves empty stay, so nothing beside an owned key moves. */
function removeAt(doc: Obj, path: string): void {
  const segments = path.split(".");
  const last = segments.pop()!;
  const parent = segments.length === 0 ? { type: "found", value: doc } : lookup(doc, segments.join("."));
  if (parent.type === "found" && isObject(parent.value)) delete parent.value[last];
}

export type Read = { doc: Obj; plain: boolean } | { problem: string };

export function readDoc(path: string): Read {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const { value, plain } = parseJsonc(text);
    return isObject(value) ? { doc: value, plain } : { problem: "its top level is not a map" };
  } catch {
    return { problem: "it is not valid JSON" };
  }
}

const exists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** Reads the host, never writes. */
export function planKeys(desired: DesiredKey[], recorded: KeyRecord[], home: string): KeyPlan {
  const plan = emptyKeyPlan();
  if (exists(expandTarget(OLD_OPENCODE_FILE, home))) {
    plan.conflicts.push({
      kind: "key",
      path: OLD_OPENCODE_FILE,
      detail: `${OLD_OPENCODE_FILE} exists, and opencode loads both it and ${SETTINGS_FILE.opencode}`,
      fix: `Move its settings into the host file and delete it (rm ${OLD_OPENCODE_FILE}), then run 'fleet apply'.`,
    });
  }
  for (const file of [...Object.values(SETTINGS_FILE), CLAUDE_JSON]) {
    const wanted = desired.filter((k) => k.file === file);
    const had = recorded.filter((k) => k.file === file);
    if (wanted.length > 0 || had.length > 0) planFile(file, wanted, had, home, plan);
  }
  return plan;
}

function planFile(file: string, desired: DesiredKey[], recorded: KeyRecord[], home: string, plan: KeyPlan): void {
  const read = readDoc(expandTarget(file, home));
  if ("problem" in read) {
    plan.conflicts.push({
      kind: "key",
      path: file,
      detail: `${file} cannot be read as settings: ${read.problem}`,
      fix: `Repair or delete ${file}, then run 'fleet apply'.`,
    });
    return;
  }

  const local = emptyKeyPlan();
  const record = (ref: KeyRef) => recorded.find((r) => r.path === ref.path);
  const conflict = (ref: KeyRef, kind: Conflict["kind"], detail: string, fix: string) =>
    local.conflicts.push({ kind, path: keyName(ref), detail: `${ref.path} ${detail}`, fix });

  for (const key of desired) {
    const ref = { file, path: key.path };
    const hash = hashValue(key.value);
    const known = record(ref);
    const current = lookup(read.doc, key.path);
    const change = { ...ref, value: key.value, desired: hash, ...(key.display !== undefined && { display: key.display }) };
    const fix = `Make ${file} or the host file agree on ${key.path}, or delete ${key.path} from ${file}, then run 'fleet apply'.`;

    if (current.type === "found" && hashValue(current.value) === hash) {
      local.noops.push({ ...ref, desired: hash, actual: hash });
    } else if (current.type === "missing") {
      local.creates.push(change);
    } else if (current.type === "blocked") {
      conflict(ref, "key", `cannot be set: a value above it in ${file} is not a map`, fix);
    } else if (known === undefined) {
      conflict(ref, "key", `already has a value in ${file} that fleet did not write`, fix);
    } else if (hashValue(current.value) !== known.actual) {
      conflict(ref, "key", "was changed outside fleet, or by a tool", fix);
    } else if (hash === known.desired) {
      local.noops.push(known);
    } else {
      local.updates.push(change);
    }
  }

  const wanted = new Set(desired.map((k) => k.path));
  for (const known of recorded) {
    if (wanted.has(known.path)) continue;
    const ref = { file, path: known.path };
    const current = lookup(read.doc, known.path);
    if (current.type !== "found") local.forgets.push(ref);
    else if (hashValue(current.value) === known.actual) local.removes.push(ref);
    else {
      conflict(
        ref,
        "removal",
        `is no longer in the config, but it was changed since fleet wrote it`,
        `Delete ${known.path} from ${file} by hand, then run 'fleet apply' so fleet forgets it.`,
      );
    }
  }

  // Fleet never rewrites ~/.claude.json, so comments in it cost nothing.
  if (!read.plain && file !== CLAUDE_JSON && local.creates.length + local.updates.length + local.removes.length > 0) {
    local.creates = [];
    local.updates = [];
    local.removes = [];
    local.conflicts.push({
      kind: "key",
      path: file,
      detail: `${file} has comments or trailing commas, which fleet would lose by rewriting it`,
      fix: `Remove the comments and trailing commas from ${file}, then run 'fleet apply'.`,
    });
  }

  plan.creates.push(...local.creates);
  plan.updates.push(...local.updates);
  plan.removes.push(...local.removes);
  plan.noops.push(...local.noops);
  plan.forgets.push(...local.forgets);
  plan.conflicts.push(...local.conflicts);
}

/** Temp file in the same directory, then a rename, so a crash never leaves half a file. Mode 600. */
function writeAtomic(path: string, text: string): void {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // not there yet
  }
  mkdirSync(dirname(real), { recursive: true });
  const tmp = join(dirname(real), `.${basename(real)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, real);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function writeKeys(file: string, removes: KeyRef[], sets: KeyChange[], home: string): KeyRecord[] {
  const path = expandTarget(file, home);
  const read = readDoc(path);
  if ("problem" in read) throw new Error(`${file} changed since planning: ${read.problem}`);
  for (const remove of removes) removeAt(read.doc, remove.path);
  for (const set of sets) setAt(read.doc, set.path, set.value);
  writeAtomic(path, `${JSON.stringify(read.doc, null, 2)}\n`);

  return readBack(file, sets, home);
}

/** The record for each key just set: `actual` is hashed from what the file holds now, since a tool may normalise it. */
export function readBack(file: string, sets: KeyChange[], home: string): KeyRecord[] {
  const after = readDoc(expandTarget(file, home));
  if ("problem" in after) throw new Error(`${file} cannot be read back after writing: ${after.problem}`);
  return sets.map((set) => {
    const found = lookup(after.doc, set.path);
    if (found.type !== "found") throw new Error(`${set.path} is missing from ${file} after writing`);
    return { file, path: set.path, desired: set.desired, actual: hashValue(found.value) };
  });
}
