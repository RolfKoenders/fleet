import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "../state.ts";
import { statusFromDocument } from "../status.ts";
import type { StatusFields } from "../status.ts";
import type { ContextReport } from "../context.ts";
import { isObject } from "../yamlfile.ts";
import { fromMemory, toMemory } from "./contextshown.ts";
import type { HostResult } from "./probe.ts";

/**
 * What the bridge remembers between runs, so its cards have something to show before the hosts answer: the
 * last good status of each host, as the card shows it, and its startup context, cut to what the context screen
 * shows (see `contextshown.ts`). It is a convenience of the bridge alone. `status` and
 * `apply` never read it, it holds no secret, and what is read back is treated like text from a host: cut down
 * to the fields the cards show and to printable text, because the file could be anyone's.
 */
export const cachePath = (home: string): string => join(stateDir(home), "bridge-hosts.json");

const APP = "fleet-bridge-hosts";
const MAX_BYTES = 256 * 1024;
const MAX_HOSTS = 64;

/** A remembered host: its status, and how long ago it was seen. */
export type CachedHost = { result: HostResult; agoSeconds: number };

/** A remembered startup context, and how long ago it was seen. */
export type CachedContext = { report: ContextReport; agoSeconds: number };

/** `status` is null for a host whose startup context was remembered and whose status was not. */
type Entry = { savedAt: number; status: StatusFields | null; context: { savedAt: number; report: ContextReport } | null };

const validTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** The fields the cards show, and nothing else: neither `applied.config` nor `conflictList` is one of them. */
const shown = (s: StatusFields): StatusFields => ({ ...s, applied: { ...s.applied, config: null }, conflictList: null });

function load(home: string): Record<string, Entry> {
  const path = cachePath(home);
  try {
    // A link or anything but a plain file is not ours to trust.
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_BYTES) return {};
    const doc: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isObject(doc) || doc.app !== APP || doc.version !== 1 || !isObject(doc.hosts)) return {};
    const out: Record<string, Entry> = {};
    for (const [name, entry] of Object.entries(doc.hosts).slice(0, MAX_HOSTS)) {
      if (!isObject(entry)) continue;
      const status = validTime(entry.savedAt) && isObject(entry.status) ? statusFromDocument(entry.status) : null;
      const kept = isObject(entry.context) && validTime(entry.context.savedAt) ? { savedAt: entry.context.savedAt, report: fromMemory(entry.context.report) } : null;
      const context = kept?.report == null ? null : { savedAt: kept.savedAt, report: kept.report };
      if (status !== null || context !== null) out[name] = { savedAt: validTime(entry.savedAt) ? entry.savedAt : 0, status: status === null ? null : shown(status), context };
    }
    return out;
  } catch {
    return {};
  }
}

/** The remembered hosts, with their age counted to `now`. A missing, corrupt or foreign file gives none. */
export function readCache(home: string, now: number = Date.now()): Record<string, CachedHost> {
  const out: Record<string, CachedHost> = {};
  for (const [name, { savedAt, status }] of Object.entries(load(home))) {
    if (status === null) continue;
    const agoSeconds = Math.max(0, Math.floor((now - savedAt) / 1000));
    const ageSeconds = status.applied.ageSeconds === null ? null : status.applied.ageSeconds + agoSeconds;
    out[name] = { result: { result: "ok", status: { ...status, applied: { ...status.applied, ageSeconds } } }, agoSeconds };
  }
  return out;
}

/** The remembered startup contexts, with their age counted to `now`. */
export function readContextCache(home: string, now: number = Date.now()): Record<string, CachedContext> {
  const out: Record<string, CachedContext> = {};
  for (const [name, { context }] of Object.entries(load(home))) {
    if (context !== null) out[name] = { report: context.report, agoSeconds: Math.max(0, Math.floor((now - context.savedAt) / 1000)) };
  }
  return out;
}

/** Remembers one host's status. Written through a temp file and a rename, mode 600. A failure to write is not the bridge's failure. */
export function remember(home: string, host: string, status: StatusFields, now: number = Date.now()): void {
  update(home, host, (entry) => ({ ...entry, savedAt: now, status: shown(status) }));
}

/** Remembers one host's startup context, already cut by `shown`, next to its status. */
export function rememberContext(home: string, host: string, report: ContextReport, now: number = Date.now()): void {
  update(home, host, (entry) => ({ ...entry, context: { savedAt: now, report } }));
}

function update(home: string, host: string, change: (entry: Entry) => Entry): void {
  try {
    const entries = load(home);
    entries[host] = change(entries[host] ?? { savedAt: 0, status: null, context: null });
    const path = cachePath(home);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    const hosts = Object.fromEntries(
      Object.entries(entries).map(([name, e]) => [name, { savedAt: e.savedAt, status: e.status, ...(e.context === null ? {} : { context: { savedAt: e.context.savedAt, report: toMemory(e.context.report) } }) }]),
    );
    writeFileSync(tmp, `${JSON.stringify({ app: APP, version: 1, hosts }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch {
    // a home that cannot be written is just a bridge without memory
  }
}
