import { homedir } from "node:os";
import { failure } from "./apply.ts";
import { loadConfig } from "./config.ts";
import type { Config } from "./config.ts";
import { hashValue, keyName, lookup, readDoc } from "./keys.ts";
import { acquireLock, LockedError } from "./lock.ts";
import { CLAUDE_JSON, withoutEmpty } from "./mcp.ts";
import { paint } from "./output.ts";
import type { Result } from "./output.ts";
import { expandTarget, planLinks } from "./plan.ts";
import type { Conflict } from "./plan.ts";
import { readHostName } from "./host.ts";
import { renderKeys, resolveSecrets } from "./secrets.ts";
import { SETTINGS_FILE } from "./settings.ts";
import type { DesiredKey } from "./settings.ts";
import { readState, writeState } from "./state.ts";
import type { KeyRecord, LinkRecord } from "./state.ts";
import { MASK, secretNames } from "./template.ts";
import { isObject } from "./yamlfile.ts";
import type { Obj } from "./yamlfile.ts";

const USAGE = "usage: fleet adopt mcp|skill <name>";

/** What an adoption would record, or why it cannot: conflicts to show, or a result to return as it is. */
type Adoption = { keys: KeyRecord[]; links: LinkRecord[]; left: string[] } | { conflicts: Conflict[] } | Result;

const invalid = (message: string): Result => ({ code: "invalid", messages: [`fleet: ${message}`] });
const isResult = (value: object): value is Result => "code" in value;
const isRefused = (value: object): value is { conflicts: Conflict[] } => "conflicts" in value;

/** Fields that hold credentials. Their value on the host's side is never shown. */
const CREDENTIAL_FIELDS = new Set(["env", "environment", "headers"]);

type Difference = { segments: string[]; expected: unknown; found: unknown };

const same = (a: unknown, b: unknown): boolean => (a === undefined || b === undefined ? a === b : hashValue(a) === hashValue(b));

/** The fields at which `found` is not `expected`, down to the leaf of each map. A field on one side only differs. */
function differences(expected: unknown, found: unknown, segments: string[], out: Difference[]): void {
  if ((isObject(expected) || isObject(found)) && (isObject(expected) || expected === undefined) && (isObject(found) || found === undefined)) {
    const [a, b]: [Obj, Obj] = [isObject(expected) ? expected : {}, isObject(found) ? found : {}];
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[key], b[key], [...segments, key], out);
  } else if (!same(expected, found)) {
    out.push({ segments, expected, found });
  }
}

const valueAt = (value: unknown, segments: string[]): unknown =>
  segments.reduce<unknown>((node, segment) => (isObject(node) ? node[segment] : undefined), value);

const shown = (value: unknown): string => (value === undefined ? "(absent)" : JSON.stringify(value));

/**
 * How one difference reads. The expected side comes from the rendered entry with its secrets
 * masked. The host's side is masked where the config holds a secret, anywhere in a field
 * that carries credentials, and wherever a secret fleet knows appears in it.
 */
function describe(diff: Difference, key: DesiredKey, secrets: string[]): string {
  const expected = valueAt(key.display ?? key.value, diff.segments);
  const secretBearing = shown(expected) !== shown(valueAt(key.value, diff.segments));
  let found = shown(diff.found);
  if (diff.found !== undefined && (secretBearing || CREDENTIAL_FIELDS.has(diff.segments[0]!))) found = JSON.stringify(MASK);
  for (const secret of secrets) if (secret !== "") found = found.replaceAll(JSON.stringify(secret).slice(1, -1), MASK);
  return `${diff.segments.join(".")}: expected ${shown(expected)}, found ${found}`;
}

function mismatch(key: DesiredKey, detail: string, name: string): Conflict {
  return {
    kind: "key",
    path: keyName(key),
    detail: `${key.path} ${detail}`,
    fix: `Change the entry in ${key.file} to match the config, or the config to match it, then run 'fleet adopt mcp ${name}' again. Or delete it so apply recreates it.`,
  };
}

function adoptMcp(configDir: string, host: string, home: string, config: Config, name: string): Adoption {
  const keys = config.keys.filter(
    (k) => (k.file === CLAUDE_JSON && k.path === `mcpServers.${name}`) || (k.file === SETTINGS_FILE.opencode && k.path === `mcp.${name}`),
  );
  if (keys.length === 0) return invalid(`'${name}' is not picked by this host, so there is nothing to adopt. Pick it in the host file (mcp.include) first.`);

  const secrets = resolveSecrets(configDir, host, home, [...new Set(keys.flatMap((k) => secretNames(k.value)))].sort());
  const known = [...secrets.values()];
  const records: KeyRecord[] = [];
  const conflicts: Conflict[] = [];
  const left: string[] = [];
  for (const key of renderKeys(keys, secrets)) {
    const read = readDoc(expandTarget(key.file, home));
    if ("problem" in read) {
      conflicts.push({ kind: "key", path: key.file, detail: `${key.file} cannot be read as settings: ${read.problem}`, fix: `Repair or delete ${key.file}, then run 'fleet adopt mcp ${name}'.` });
      continue;
    }
    const current = lookup(read.doc, key.path);
    if (current.type === "missing") {
      left.push(keyName(key));
      continue;
    }
    if (current.type === "blocked") {
      conflicts.push(mismatch(key, `cannot be adopted: a value above it in ${key.file} is not a map`, name));
      continue;
    }
    // A tool may store defaults the catalog leaves out (`args: []`), which is no difference.
    const normalised = isObject(current.value) ? withoutEmpty(current.value) : current.value;
    if (!isObject(normalised)) {
      conflicts.push(mismatch(key, "differs from the config: the entry is not a map", name));
      continue;
    }
    const found: Difference[] = [];
    differences(key.value, normalised, [], found);
    if (found.length > 0) {
      conflicts.push(mismatch(key, `differs from the config: ${found.map((d) => describe(d, key, known)).join("; ")}`, name));
    } else {
      records.push({ file: key.file, path: key.path, desired: hashValue(key.value), actual: hashValue(current.value) });
    }
  }
  if (conflicts.length > 0) return { conflicts };
  if (records.length === 0) return invalid(`nothing to adopt: ${name} has no entry in ${[...new Set(keys.map((k) => k.file))].join(" or ")}; 'fleet apply' creates it`);
  return { keys: records, links: [], left };
}

function adoptSkill(home: string, config: Config, name: string): Adoption {
  const target = `~/.claude/skills/${name}`;
  const record = config.files.find((f) => f.target === target);
  if (!config.skills.includes(name) || record === undefined) {
    return invalid(`'${name}' is not in a bundle this host picks, so there is nothing to adopt. Pick its bundle in the host file first.`);
  }
  const plan = planLinks([record], [], home);
  if (plan.conflicts.length > 0) return { conflicts: plan.conflicts };
  if (plan.creates.length > 0) return invalid(`nothing to adopt: ${target} does not exist; 'fleet apply' creates it`);
  return { keys: [], links: plan.noops, left: [] };
}

function conflictResult(conflicts: Conflict[], color: boolean): Result {
  const lines = conflicts.flatMap((c) => [`${paint(color, "yellow", "conflict")} ${c.path}: ${c.detail}`, `  fix: ${c.fix}`]);
  return {
    code: "conflict",
    text: lines.join("\n"),
    messages: [`fleet: ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}; nothing was written`],
    fields: { adopted: [], conflicts },
  };
}

/** Anything short of an exact match is a conflict and writes nothing. */
export function adopt(configDir: string, args: string[], color: boolean, home: string = homedir()): Result {
  const [kind, name] = args;
  if ((kind !== "mcp" && kind !== "skill") || name === undefined) return invalid(USAGE);
  const host = readHostName(home);
  if (host === null) return invalid("no host name set; `fleet init <host>` writes one");

  let release: () => void;
  try {
    release = acquireLock(home);
  } catch (error) {
    if (error instanceof LockedError) return { code: "locked", messages: [`fleet: ${error.message}`] };
    throw error;
  }
  try {
    // Sources are only read: a missing clone is cloned, as `diff` does, and nothing is moved.
    const config = loadConfig(configDir, host, { home, sources: "diff" });
    if (config.conflicts.length > 0) return conflictResult(config.conflicts, color);
    const adoption = kind === "mcp" ? adoptMcp(configDir, host, home, config, name) : adoptSkill(home, config, name);
    if (isRefused(adoption)) return conflictResult(adoption.conflicts, color);
    if (isResult(adoption)) return adoption;

    const state = readState(home);
    const links = new Map((state?.links ?? []).map((l) => [l.target, l]));
    const keys = new Map((state?.keys ?? []).map((k) => [keyName(k), k]));
    for (const link of adoption.links) links.set(link.target, link);
    for (const key of adoption.keys) keys.set(keyName(key), key);
    writeState(
      {
        version: 1,
        host,
        appliedAt: state?.appliedAt ?? new Date().toISOString().replace(/\.\d+Z$/, "Z"),
        repos: state?.repos ?? {},
        links: [...links.values()],
        keys: [...keys.values()],
      },
      home,
    );

    const lines = [
      ...adoption.keys.map((k) => `${paint(color, "green", "adopted")} ${keyName(k)}`),
      ...adoption.links.map((l) => `${paint(color, "green", "adopted")} ${l.target} -> ${l.source}`),
      ...adoption.left.map((l) => `left ${l} for apply (no entry there)`),
    ];
    return {
      code: "ok",
      text: lines.join("\n"),
      fields: {
        adopted: [...adoption.keys.map(({ file, path }) => ({ file, path })), ...adoption.links],
        left: adoption.left,
        conflicts: [],
      },
    };
  } catch (error) {
    const result = failure(error);
    if (result === null) throw error;
    return result;
  } finally {
    release();
  }
}
