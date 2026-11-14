import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { parseCatalog } from "../catalog.ts";
import { parseMcpCatalog } from "../mcp.ts";
import { hostNames } from "../recipients.ts";
import { findSkillsIn, sourceDir } from "../sources.ts";
import { secretNames } from "../template.ts";
import { estimateTokens } from "../tokens.ts";
import { findTool } from "../tools.ts";
import { parseFile } from "../yamlfile.ts";
import { parseSopsText } from "../edit/secretfile.ts";
import type { SopsFile } from "../edit/secretfile.ts";

/**
 * What the browsing screens read, all of it read-only: git history of the config repo, the clear text keys of
 * its secrets files, and the catalog with the skill sources already cloned. Nothing here decrypts, clones,
 * fetches or writes. Every string that came from outside (git, a file, a clone) is cut down by `clean`.
 */

/** Controls and the marks that reorder text become `?`; a tab becomes spaces. The screen does the same per cell, as a second guard. */
export const clean = (text: string): string => text.replace(/\t/g, "    ").replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "?");

type Git = (...args: string[]) => { ok: boolean; out: string };

/** git by absolute path, in `dir`, with the given home so it reads no other user's config. */
function gitIn(dir: string, home: string): Git | null {
  const path = findTool("git");
  if (path === null) return null;
  return (...args) => {
    const r = spawnSync(path, ["-c", "core.pager=cat", "-c", "core.quotePath=false", ...args], {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, HOME: home, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_EXTERNAL_DIFF: "", GIT_PAGER: "cat" },
    });
    return { ok: r.status === 0, out: r.stdout ?? "" };
  };
}

// ---------------------------------------------------------------- history

export type Commit = { sha: string; at: string; subject: string };

export type History = { ok: true; commits: Commit[]; more: boolean } | { ok: false; detail: string };

export const HISTORY_LIMIT = 300;

export function readHistory(configDir: string, home: string, limit = HISTORY_LIMIT): History {
  const git = gitIn(configDir, home);
  if (git === null) return { ok: false, detail: "git is not installed" };
  const r = git("log", `-n${limit + 1}`, "--format=%H%x1f%aI%x1f%s");
  if (!r.ok) return { ok: false, detail: "the config is not a git repository with commits" };
  const commits = r.out
    .split("\n")
    .filter((l) => l !== "")
    .map((l): Commit => {
      const [sha = "", at = "", ...subject] = l.split("\u001f");
      return { sha, at, subject: clean(subject.join(" ")) };
    });
  return { ok: true, commits: commits.slice(0, limit), more: commits.length > limit };
}

/** What a commit did to one secrets file, by name only. */
export type SecretsChange = { file: string; added: string[]; removed: string[]; changed: string[]; recipients: boolean };

export type FileChange = { status: string; path: string };

export type CommitDiff =
  | { ok: true; files: FileChange[]; secrets: SecretsChange[]; patch: string[]; cut: boolean }
  | { ok: false; detail: string };

export const isSecretsFile = (path: string): boolean => /^secrets\/[^/]+\.enc\.yaml$/.test(path);

const PATCH_LINES = 2000;

export { parseSopsText };
export type { SopsFile };

function compareSops(file: string, before: SopsFile, after: SopsFile): SecretsChange {
  const added = [...after.entries.keys()].filter((k) => !before.entries.has(k));
  const removed = [...before.entries.keys()].filter((k) => !after.entries.has(k));
  const changed = [...after.entries].filter(([k, v]) => before.entries.has(k) && before.entries.get(k)!.value !== v.value).map(([k]) => k);
  return { file, added: added.sort(), removed: removed.sort(), changed: changed.sort(), recipients: before.recipients.join() !== after.recipients.join() };
}

/**
 * One commit's changes. A secrets file is never diffed as text: the patch leaves it out and `secrets` says
 * which names were added, removed or re-encrypted, and whether its recipients changed.
 */
export function readCommitDiff(configDir: string, home: string, sha: string): CommitDiff {
  const git = gitIn(configDir, home);
  if (git === null) return { ok: false, detail: "git is not installed" };
  if (!/^[0-9a-f]{7,64}$/.test(sha)) return { ok: false, detail: "not a commit" };
  const names = git("show", "--no-ext-diff", "--no-textconv", "--format=", "--name-status", "--no-renames", sha);
  if (!names.ok) return { ok: false, detail: "this commit cannot be read" };
  const files = names.out
    .split("\n")
    .filter((l) => l !== "")
    .map((l): FileChange => ({ status: l.slice(0, 1), path: clean(l.slice(1).trim()) }));
  const secrets = files
    .filter((f) => isSecretsFile(f.path))
    .map((f) => {
      const show = (rev: string) => {
        const r = git("show", `${rev}:${f.path}`);
        return parseSopsText(r.ok ? r.out : "");
      };
      return compareSops(f.path, show(`${sha}^`), show(sha));
    });
  const rest = files.filter((f) => !isSecretsFile(f.path));
  let patch: string[] = [];
  let cut = false;
  if (rest.length > 0) {
    const p = git("show", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--format=", "-U3", sha, "--", ".", ":(exclude)secrets/*.enc.yaml");
    const lines = p.out.split("\n");
    cut = lines.length > PATCH_LINES;
    patch = lines.slice(0, PATCH_LINES).map(clean);
  }
  return { ok: true, files, secrets, patch, cut };
}

// ---------------------------------------------------------------- secrets

export type Changed = { sha: string; at: string; subject: string } | "uncommitted" | null;

export type SecretEntry = {
  name: string;
  /** `shared` or a host name. */
  file: string;
  path: string;
  /** Hosts whose age recipient is in the file. */
  readers: string[];
  /** Recipients in the file that no host file names. */
  strangers: number;
  changed: Changed;
  /** Catalog servers that refer to it, and the host files whose settings do. */
  servers: string[];
  settings: string[];
};

export type SecretsView = {
  entries: SecretEntry[];
  hosts: string[];
  problems: string[];
};

/** Last commit to touch each key's line, from one `git blame` per file. The line holds only the encrypted value. */
function blame(git: Git, path: string, names: Map<string, number>): Map<string, Changed> {
  const out = new Map<string, Changed>();
  const r = git("blame", "--porcelain", "--", path);
  if (!r.ok) return out;
  const meta = new Map<string, { at: string; subject: string }>();
  const byLine = new Map<number, string>();
  let current = "";
  let finalLine = 0;
  for (const raw of r.out.split("\n")) {
    const h = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(raw);
    if (h) {
      current = h[1]!;
      finalLine = Number(h[2]);
      byLine.set(finalLine, current);
      continue;
    }
    const m = meta.get(current) ?? { at: "", subject: "" };
    if (raw.startsWith("author-time ")) m.at = new Date(Number(raw.slice(12)) * 1000).toISOString();
    else if (raw.startsWith("summary ")) m.subject = clean(raw.slice(8));
    meta.set(current, m);
  }
  for (const [name, line] of names) {
    const sha = byLine.get(line);
    if (sha === undefined) continue;
    const m = meta.get(sha);
    out.set(name, /^0+$/.test(sha) ? "uncommitted" : { sha, at: m?.at ?? "", subject: m?.subject ?? "" });
  }
  return out;
}

const hostFiles = (configDir: string): string[] => ["_defaults", ...hostNames(configDir)];

/**
 * Names only. The files are read as text for their clear keys and recipients; no value is decrypted and no
 * sops or age key is touched.
 */
export function readSecrets(configDir: string, home: string): SecretsView {
  const problems: string[] = [];
  const hosts = hostNames(configDir);
  const age = new Map<string, string[]>();
  const settingsUse = new Map<string, string[]>();
  for (const name of hostFiles(configDir)) {
    const doc = parseFile(join(configDir, "hosts", `${name}.yaml`), name === "_defaults", problems);
    if (doc === null) continue;
    if (typeof doc.age === "string" && doc.age !== "") age.set(doc.age, [...(age.get(doc.age) ?? []), name]);
    for (const secret of secretNames(doc.settings ?? {})) settingsUse.set(secret, [...(settingsUse.get(secret) ?? []), `hosts/${name}.yaml`]);
  }
  const serverUse = new Map<string, string[]>();
  for (const server of parseMcpCatalog(configDir, problems).values()) {
    for (const secret of secretNames({ env: server.env, headers: server.headers, url: server.url })) serverUse.set(secret, [...(serverUse.get(secret) ?? []), server.name]);
  }

  const git = gitIn(configDir, home);
  const entries: SecretEntry[] = [];
  for (const file of ["shared", ...hosts]) {
    const path = `secrets/${file}.enc.yaml`;
    let text: string;
    try {
      text = readFileSync(join(configDir, path), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`${path}: cannot be read`);
      continue;
    }
    const parsed = parseSopsText(text);
    const readers = new Set<string>();
    let strangers = 0;
    for (const r of parsed.recipients) {
      const owners = age.get(r);
      if (owners) owners.filter((o) => o !== "_defaults").forEach((o) => readers.add(o));
      else strangers++;
    }
    const lines = new Map([...parsed.entries].map(([k, v]) => [k, v.line]));
    const changed = git ? blame(git, path, lines) : new Map<string, Changed>();
    for (const name of [...parsed.entries.keys()].sort()) {
      entries.push({
        name: clean(name),
        file,
        path,
        readers: [...readers].sort(),
        strangers,
        changed: changed.get(name) ?? null,
        servers: [...new Set(serverUse.get(name) ?? [])].sort(),
        settings: [...new Set(settingsUse.get(name) ?? [])].sort(),
      });
    }
  }
  return { entries, hosts, problems };
}

// ---------------------------------------------------------------- catalog

export type SkillInfo = {
  name: string;
  bundle: string;
  /** The source whose clone holds it, or null. */
  source: { name: string; pin: string; clone: string; review: boolean } | null;
  /** Sources that could hold it but are not cloned. */
  notCloned: string[];
  text: string[] | null;
  tokens: number | null;
};

export type ServerInfo = { name: string; transport: "stdio" | "http" | "sse"; secrets: string[]; only: string[] };

export type CatalogView = { skills: SkillInfo[]; servers: ServerInfo[]; problems: string[] };

const SKILL_READ_LIMIT = 256 * 1024;

/** SKILL.md as text, or null when it is not a plain file. Read through one descriptor so a swap cannot redirect it. */
function readSkillFile(path: string): { text: string; chars: number } | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, SKILL_READ_LIMIT));
      readSync(fd, buf, 0, buf.length, 0);
      const text = buf.toString("utf8");
      return { text, chars: size > SKILL_READ_LIMIT ? size : text.length };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function readCatalog(configDir: string, home: string): CatalogView {
  const problems: string[] = [];
  const catalog = parseCatalog(configDir, problems);
  const servers = parseMcpCatalog(configDir, problems);

  const found = new Map<string, { source: string; pin: string; clone: string; review: boolean; dir: string }[]>();
  const absent: string[] = [];
  for (const source of catalog.sources) {
    const clone = sourceDir(home, source.name);
    if (!existsSync(join(clone, ".git"))) {
      absent.push(source.name);
      continue;
    }
    const head = gitIn(clone, home)?.("rev-parse", "HEAD");
    const at = head?.ok ? head.out.trim().slice(0, 7) : "unknown";
    const pin = source.commit !== null ? `pinned ${source.commit.slice(0, 7)} (tracks ${source.track})${at !== source.commit.slice(0, 7) ? `, clone at ${at}` : ""}` : `follows ${source.branch}, clone at ${at}`;
    const { dirs } = findSkillsIn(clone, source);
    for (const [skill, list] of dirs) found.set(skill, [...(found.get(skill) ?? []), { source: source.name, pin, clone, review: source.review, dir: list[0]! }]);
  }

  const skills: SkillInfo[] = [];
  for (const [bundle, names] of catalog.bundles) {
    for (const name of names) {
      const hit = found.get(name)?.[0] ?? null;
      const file = hit ? readSkillFile(join(hit.dir, "SKILL.md")) : null;
      skills.push({
        name: clean(name),
        bundle,
        source: hit ? { name: hit.source, pin: hit.pin, clone: hit.clone, review: hit.review } : null,
        notCloned: hit ? [] : absent,
        text: file ? file.text.split("\n").map(clean) : null,
        tokens: file ? estimateTokens(file.chars) : null,
      });
    }
  }
  const infos = [...servers.values()].map(
    (s): ServerInfo => ({
      name: s.name,
      transport: s.command !== null ? "stdio" : (s.transport ?? "http"),
      secrets: secretNames({ env: s.env, headers: s.headers, url: s.url }),
      only: s.only,
    }),
  );
  return { skills, servers: infos, problems };
}
