import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { failure } from "./apply.ts";
import { loadConfig } from "./config.ts";
import { readHostName } from "./host.ts";
import { CLAUDE_JSON } from "./mcp.ts";
import { probe } from "./mcpprobe.ts";
import type { ProbeResult, ProbeTarget } from "./mcpprobe.ts";
import { paint } from "./output.ts";
import type { Result } from "./output.ts";
import { expandTarget } from "./plan.ts";
import { renderKeys, resolveSecrets } from "./secrets.ts";
import { SETTINGS_FILE } from "./settings.ts";
import { ageKeyPath } from "./sops.ts";
import { readState } from "./state.ts";
import { count, printable, timerState } from "./status.ts";
import { hostTargets } from "./targets.ts";
import { secretNames } from "./template.ts";
import { findTool } from "./tools.ts";
import { isObject } from "./yamlfile.ts";
import type { Obj } from "./yamlfile.ts";

export const DEFAULT_TIMEOUT_SECONDS = 30;

/** A cheap local check. */
export type Check = { name: string; result: "ok" | "problem"; detail: string | null };

type ServerResult = ProbeResult;
const SERVER_RESULTS: ServerResult[] = ["ok", "auth-needed", "unreachable", "missing-binary", "bad-response", "exited", "timeout"];

/** One server as one tool has it rendered. `fails` is false for a result that is expected until a person logs in. */
export type ServerCheck = {
  server: string;
  tool: "claude" | "opencode";
  transport: "stdio" | "http" | "sse" | "remote";
  result: ServerResult;
  tools: number | null;
  latencyMs: number | null;
  detail: string | null;
  fails: boolean;
};

export type DoctorFields = { checks: Check[]; servers: ServerCheck[] };

// ---- local checks ----

const shown = (path: string, home: string): string => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

/** Links fleet recorded under `~/.claude/skills` whose target is gone. */
function skillLinks(home: string): Check {
  const name = "skill-links";
  let links;
  try {
    links = readState(home)?.links ?? [];
  } catch {
    return { name, result: "problem", detail: "the applied state cannot be read" };
  }
  const dangling = links
    .filter((l) => l.target.startsWith("~/.claude/skills/") && isLink(expandTarget(l.target, home)) && !existsSync(expandTarget(l.target, home)))
    .map((l) => l.target);
  return dangling.length === 0 ? { name, result: "ok", detail: null } : { name, result: "problem", detail: `dangling: ${dangling.join(", ")}` };
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function localChecks(home: string): Check[] {
  const timer = timerState(home);
  const key = ageKeyPath(home);
  return [
    timer === "active"
      ? { name: "timer", result: "ok", detail: "active" }
      : { name: "timer", result: "problem", detail: timer === null ? "unknown (systemctl is not installed or gave no answer)" : timer },
    existsSync(key)
      ? { name: "age-key", result: "ok", detail: null }
      : { name: "age-key", result: "problem", detail: `no age key at ${shown(key, home)}; \`fleet init\` creates it` },
    skillLinks(home),
  ];
}

// ---- servers ----

type Planned = { server: string; tool: "claude" | "opencode"; transport: ServerCheck["transport"]; target: ProbeTarget | null; credentials: boolean };

const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);
const stringMap = (v: unknown): Record<string, string> => (isObject(v) ? (Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string")) as Record<string, string>) : {});

/** What to probe for one rendered entry, in the shape `mcp.ts` renders for that tool. Null when the entry is not of that shape. */
function planEntry(server: string, tool: "claude" | "opencode", entry: unknown, cwd: string): Planned {
  const bad = (transport: ServerCheck["transport"]): Planned => ({ server, tool, transport, target: null, credentials: false });
  if (!isObject(entry)) return bad("stdio");
  if (tool === "claude" && entry.type === "stdio" && typeof entry.command === "string") {
    return { server, tool, transport: "stdio", target: { kind: "stdio", command: [entry.command, ...(strings(entry.args) ?? [])], env: stringMap(entry.env), cwd }, credentials: false };
  }
  if (tool === "opencode" && entry.type === "local") {
    const command = strings(entry.command);
    return command === null || command.length === 0 ? bad("stdio") : { server, tool, transport: "stdio", target: { kind: "stdio", command, env: stringMap(entry.environment), cwd }, credentials: false };
  }
  const transport = tool === "opencode" ? "remote" : entry.type === "sse" ? "sse" : "http";
  if ((tool === "opencode" ? entry.type === "remote" : entry.type === "http" || entry.type === "sse") && typeof entry.url === "string") {
    const headers = stringMap(entry.headers);
    return { server, tool, transport, target: { kind: "network", transport, url: entry.url, headers }, credentials: Object.keys(headers).length > 0 };
  }
  return bad(transport);
}

/** Text that is safe to show: no secret value in it, and only printable characters. */
function clean(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) if (secret !== "") out = out.split(secret).join("***");
  return printable(out) ?? "";
}

async function checkServers(configDir: string, host: string, home: string, timeoutMs: number): Promise<ServerCheck[]> {
  const config = loadConfig(configDir, host, { home, sources: "none" });
  const keys = config.keys.filter((k) => (k.file === CLAUDE_JSON && k.path.startsWith("mcpServers.")) || (k.file === SETTINGS_FILE.opencode && k.path.startsWith("mcp.")));
  // Only the secrets the servers use are decrypted.
  const names = [...new Set(keys.flatMap((k) => secretNames(k.value)))].sort();
  const secrets = resolveSecrets(configDir, host, home, names);
  const secretValues = [...secrets.values()];
  const extraDirs = [`${home}/.local/bin`, `${home}/.opencode/bin`, "/usr/bin", "/usr/local/bin"];

  const planned = renderKeys(keys, secrets).map((k) => {
    const claude = k.file === CLAUDE_JSON;
    return planEntry(k.path.slice(claude ? "mcpServers.".length : "mcp.".length), claude ? "claude" : "opencode", k.value, home);
  });
  const records = await Promise.all(
    planned.map(async (p): Promise<ServerCheck> => {
      const base = { server: p.server, tool: p.tool, transport: p.transport };
      if (p.target === null) return { ...base, result: "bad-response", tools: null, latencyMs: null, detail: "the rendered entry has an unexpected shape", fails: true };
      const r = await probe(p.target, timeoutMs, extraDirs);
      const fails = r.result !== "ok" && !(r.result === "auth-needed" && !p.credentials);
      return { ...base, result: r.result, tools: r.tools, latencyMs: r.latencyMs, detail: r.detail === null ? null : clean(r.detail, secretValues), fails };
    }),
  );
  return records.sort((a, b) => a.server.localeCompare(b.server) || a.tool.localeCompare(b.tool));
}

// ---- text ----

const good = (color: boolean, text: string) => paint(color, "green", text);
const warn = (color: boolean, text: string) => paint(color, "yellow", text);

function serverLine(s: ServerCheck, color: boolean): string {
  const facts = [s.tools === null ? null : `${s.tools} tool${s.tools === 1 ? "" : "s"}`, s.latencyMs === null ? null : `${s.latencyMs} ms`].filter((f) => f !== null);
  const result = s.result === "ok" ? good(color, "ok") : warn(color, s.result);
  return `  ${s.server} (${s.tool}, ${s.transport}): ${result}${facts.length > 0 ? `, ${facts.join(", ")}` : ""}${s.detail === null ? "" : ` (${s.detail})`}`;
}

function lines(fields: DoctorFields, color: boolean): string[] {
  return [
    "checks:",
    ...fields.checks.map((c) => `  ${c.name}: ${c.result === "ok" ? good(color, "ok") : warn(color, "problem")}${c.detail === null ? "" : ` (${c.detail})`}`),
    fields.servers.length === 0 ? "mcp servers: none picked" : "mcp servers:",
    ...fields.servers.map((s) => serverLine(s, color)),
  ];
}

const problemCount = (f: DoctorFields): number => f.checks.filter((c) => c.result !== "ok").length + f.servers.filter((s) => s.fails).length;
const plural = (n: number) => `${n} problem${n === 1 ? "" : "s"}`;

/**
 * Starts this host's picked MCP servers, as its tools would, and asks each what it offers. Runs code and may
 * download packages, so it only runs when a person asks. Writes nothing in fleet's state.
 */
export async function doctor(configDir: string, color: boolean, timeoutSeconds: number = DEFAULT_TIMEOUT_SECONDS, home: string = homedir()): Promise<Result> {
  const host = readHostName(home);
  if (host === null) return { code: "invalid", messages: ["fleet: no host name set; `fleet init <host>` writes one"] };
  const fields: DoctorFields = { checks: localChecks(home), servers: [] };
  try {
    fields.servers = await checkServers(configDir, host, home, Math.round(timeoutSeconds * 1000));
  } catch (error) {
    // The local checks still stand; the servers could not even be listed.
    const result = failure(error);
    if (result === null) throw error;
    return { ...result, text: [`host: ${host}`, ...lines(fields, color)].join("\n"), fields: { ...fields } };
  }
  const problems = problemCount(fields);
  return {
    code: problems === 0 ? "ok" : "error",
    text: [`host: ${host}`, ...lines(fields, color)].join("\n"),
    messages: problems === 0 ? [] : [`fleet: doctor found ${plural(problems)}`],
    fields: { ...fields },
  };
}

// ---- --all ----

/** `timer` is a host with no `ssh` destination, which doctor cannot reach. */
type HostDoctor = {
  host: string;
  result: "ok" | "problems" | "unreachable" | "timer" | "error";
  doctor: DoctorFields | null;
  detail?: string;
};

const asServerResult = (v: unknown): ServerResult => SERVER_RESULTS.find((r) => r === v) ?? "bad-response";
const checkOf = (v: unknown): Check | null =>
  isObject(v) && printable(v.name) !== null ? { name: printable(v.name)!, result: v.result === "ok" ? "ok" : "problem", detail: printable(v.detail) } : null;
const serverOf = (v: unknown): ServerCheck | null => {
  if (!isObject(v) || printable(v.server) === null) return null;
  const tool = v.tool === "claude" || v.tool === "opencode" ? v.tool : null;
  const transport = (["stdio", "http", "sse", "remote"] as const).find((t) => t === v.transport) ?? null;
  if (tool === null || transport === null) return null;
  const result = asServerResult(v.result);
  return { server: printable(v.server)!, tool, transport, result, tools: count(v.tools), latencyMs: count(v.latencyMs), detail: printable(v.detail), fails: v.fails === true || (v.fails !== false && result !== "ok") };
};

/** A remote host's answer cut down to the fields fleet knows and to printable text, because a host can be wrong. */
function fromDocument(doc: Obj): DoctorFields | null {
  if (!Array.isArray(doc.checks) || !Array.isArray(doc.servers)) return null;
  const checks = doc.checks.map(checkOf);
  const servers = doc.servers.map(serverOf);
  if (checks.includes(null) || servers.includes(null)) return null;
  return { checks: checks as Check[], servers: servers as ServerCheck[] };
}

function ask(ssh: string, dest: string, host: string, timeoutSeconds: number | undefined, notes: string[]): HostDoctor {
  const command = `~/.local/bin/fleet doctor --json${timeoutSeconds === undefined ? "" : ` --timeout ${timeoutSeconds}`}`;
  const r = spawnSync(ssh, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", dest, command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // Every server may take its full timeout, plus the time to reach the host.
    timeout: ((timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) + 60) * 1000,
  });
  const firstLine = (r.stderr ?? "").trim().split("\n")[0] ?? "";
  if (r.error || r.status === 255) {
    notes.push(`fleet: ${host}: unreachable over ssh (${printable(r.error?.message ?? (firstLine || "no reason given"))})`);
    return { host, result: "unreachable", doctor: null };
  }
  let doc: Obj | null = null;
  try {
    const parsed: unknown = JSON.parse(r.stdout);
    doc = isObject(parsed) ? parsed : null;
  } catch {
    // not a document
  }
  const fields = doc === null ? null : fromDocument(doc);
  if (doc !== null && fields !== null && (doc.code === "ok" || doc.code === "error")) {
    return { host, result: doc.code === "ok" ? "ok" : "problems", doctor: fields };
  }
  const detail =
    doc !== null && typeof doc.code === "string"
      ? `its doctor gave ${printable(doc.code)}${Array.isArray(doc.messages) && typeof doc.messages[0] === "string" ? `: ${printable(doc.messages[0])}` : ""}`
      : `its output was not a fleet doctor document (exit ${r.status ?? "none"})`;
  notes.push(`fleet: ${host}: ${detail}`);
  return { host, result: "error", doctor: null, detail };
}

const cell = (record: HostDoctor, row: { check: string } | { server: string; tool: string }): string => {
  if (record.doctor === null) return record.result;
  if ("check" in row) return record.doctor.checks.find((c) => c.name === row.check)?.result === "ok" ? "ok" : record.doctor.checks.some((c) => c.name === row.check) ? "problem" : "-";
  const s = record.doctor.servers.find((x) => x.server === row.server && x.tool === row.tool);
  return s === undefined ? "-" : s.result === "ok" ? `ok (${s.tools ?? "?"})` : s.result;
};

function grid(records: HostDoctor[], self: string | null, color: boolean): string {
  const rows: { label: string; key: { check: string } | { server: string; tool: string } }[] = [];
  const names = (pick: (d: DoctorFields) => string[]) => [...new Set(records.flatMap((r) => (r.doctor === null ? [] : pick(r.doctor))))];
  for (const check of names((d) => d.checks.map((c) => c.name))) rows.push({ label: check, key: { check } });
  const serverRows = new Map<string, { server: string; tool: string }>();
  for (const r of records) for (const s of r.doctor?.servers ?? []) serverRows.set(`${s.server}\0${s.tool}`, { server: s.server, tool: s.tool });
  for (const key of [...serverRows.values()].sort((a, b) => a.server.localeCompare(b.server) || a.tool.localeCompare(b.tool))) rows.push({ label: `${key.server} (${key.tool})`, key });
  if (rows.length === 0) rows.push({ label: "(no checks)", key: { check: "" } });

  const heads = records.map((r) => (r.host === self ? `${r.host} (this host)` : r.host));
  const body = rows.map((row) => records.map((r) => cell(r, row.key)));
  const widths = [Math.max(5, ...rows.map((r) => r.label.length)), ...heads.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)))];
  const paintCell = (text: string, width: number) => {
    const padded = text.padEnd(width);
    return text.startsWith("ok") ? good(color, padded) : text === "-" ? padded : warn(color, padded);
  };
  const out = [["check".padEnd(widths[0]!), ...heads.map((h, i) => h.padEnd(widths[i + 1]!))].join("  ").trimEnd()];
  rows.forEach((row, r) => out.push([row.label.padEnd(widths[0]!), ...body[r]!.map((c, i) => paintCell(c, widths[i + 1]!))].join("  ").trimEnd()));

  const details: string[] = [];
  for (const rec of records) {
    if (rec.detail !== undefined) details.push(`${rec.host}: ${rec.detail}`);
    for (const c of rec.doctor?.checks ?? []) if (c.result !== "ok" && c.detail !== null) details.push(`${rec.host}: ${c.name}: ${c.detail}`);
    for (const s of rec.doctor?.servers ?? []) if (s.result !== "ok" && s.detail !== null) details.push(`${rec.host}: ${s.server} (${s.tool}): ${s.detail}`);
    if (rec.result === "timer") details.push(`${rec.host}: no ssh destination; it applies on its own schedule, and doctor cannot reach it`);
  }
  return [...out, ...(details.length > 0 ? ["", ...details] : [])].join("\n");
}

/** `fleet doctor --all`: this host in place, every other host with an `ssh` destination over ssh, one after another. */
export async function doctorAll(configDir: string, color: boolean, timeoutSeconds: number | undefined, home: string = homedir()): Promise<Result> {
  const here = await doctor(configDir, color, timeoutSeconds, home);
  const self = readHostName(home);
  if (self === null) return here;

  const problems: string[] = [];
  const targets = hostTargets(configDir, self, problems);
  if (problems.length > 0) return { code: "invalid", messages: problems.map((p) => `fleet: ${p}`) };
  const ssh = findTool("ssh", process.env, home);
  if (ssh === null && targets.some((t) => t.ssh !== null)) {
    return { code: "missing-prerequisite", messages: ["fleet: ssh is not installed, and a host has an 'ssh' destination"] };
  }

  const notes = [...(here.messages ?? [])];
  const mine = here.fields as unknown as DoctorFields | undefined;
  const records: HostDoctor[] = targets.map((t) => (t.ssh === null ? { host: t.host, result: "timer", doctor: null } : ask(ssh!, t.ssh, t.host, timeoutSeconds, notes)));
  records.push(
    mine === undefined
      ? { host: self, result: "error", doctor: null, detail: (here.messages ?? [here.code]).map((m) => m.replace(/^fleet: /, "")).join("; ") }
      : here.code === "ok" || here.code === "error"
        ? { host: self, result: here.code === "ok" ? "ok" : "problems", doctor: mine }
        : { host: self, result: "error", doctor: mine, detail: `its doctor gave ${here.code}` },
  );
  records.sort((a, b) => a.host.localeCompare(b.host));

  // This host's own failure to start (a bad config, a missing secret) keeps its code, as `status --all` does. Then unreachable, then the rest.
  const code = here.code !== "ok" && here.code !== "error" ? here.code : records.some((r) => r.result === "unreachable") ? "unreachable" : records.some((r) => r.result === "problems" || r.result === "error") ? "error" : "ok";
  return { code, text: grid(records, self, color), messages: notes, fields: { ...(mine ?? {}), hosts: records } };
}
