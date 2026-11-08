import { runGit } from "./git.ts";
import { paint } from "./output.ts";
import { load } from "../vendor/js-yaml.mjs";

export type FlagKind = "exec-bit" | "new-script" | "new-url" | "new-bash-block" | "allowed-tools" | "hooks-file" | "description";

/** One thing in a skill the reader should look at: a warning, or for a changed `description` only info. */
export type Flag = { severity: "warning" | "info"; skill: string; /** Relative to the skill's directory. */ file: string; kind: FlagKind; detail: string };

export type SkillChange = { skill: string; added: number; removed: number };

export type Commit = { sha: string; subject: string };

/** What moving one pin would bring in, read from the throwaway clone. */
export type Review = {
  commits: Commit[];
  /** The bundle skills this source provides. */
  yours: number;
  /** The ones among them that changed, with the size of the change. */
  changed: SkillChange[];
  /** Skills in the source that no bundle names and that changed. They are only counted, never read. */
  others: number;
  flags: Flag[];
  /** The full diff of the changed skills, for the reader who asks for it. Not part of `--json`. */
  diff: string;
};

/** A skill the config uses, with its directory (relative to the clone's root) at each pin. */
export type UsedSkill = { skill: string; before: string; after: string };

/** Limits for text that comes from the source. The report and `--json` both get them, so the two agree. */
const SUBJECT_MAX = 100;
const NAME_MAX = 100;
const PATH_MAX = 200;
const DETAIL_MAX = 200;

/**
 * Text from a source, made safe to print: control characters (including ESC, the C1 range, CR and
 * backspace), format characters such as bidi overrides, and line separators become `?`, and the rest is
 * cut to `max` characters with an ellipsis. A source is untrusted, and a terminal obeys what it is sent.
 */
export function plain(text: string, max = Infinity, keepTab = false): string {
  const clean = text.replace(keepTab ? /[^\P{C}\t]|[\u2028\u2029]/gu : /\p{C}|[\u2028\u2029]/gu, "?");
  const chars = [...clean];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : clean;
}

/** The lines of a plain git diff, cleaned of control characters, with colour added by fleet and not by git. */
function readableDiff(text: string, color: boolean): string {
  let header = true;
  return text
    .split("\n")
    .map((raw) => {
      const line = plain(raw, Infinity, true);
      if (raw.startsWith("diff --git ")) header = true;
      else if (raw.startsWith("@@")) header = false;
      if (header) return paint(color, "bold", line);
      if (raw.startsWith("@@")) return paint(color, "cyan", line);
      if (raw.startsWith("+")) return paint(color, "green", line);
      if (raw.startsWith("-")) return paint(color, "red", line);
      return line;
    })
    .join("\n");
}

const SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".zsh", ".fish", ".py", ".rb", ".pl", ".php", ".js", ".mjs", ".cjs", ".ts", ".lua", ".ps1", ".bat", ".cmd"]);
const SETTINGS_FILE = /^(hooks|settings)(\.local)?\.(json|jsonc|ya?ml|toml)$/i;
const URL = /https?:\/\/[^\s<>"'`)\]]+/g;
const EXEC = "100755";

type Entry = { oldMode: string; newMode: string; newSha: string; status: string; path: string };

const gitOut = (clone: string, ...args: string[]): string => {
  const r = runGit(clone, ...args);
  if (!r.ok) throw new Error(`cannot read the changes in ${clone}: ${r.stderr.split("\n")[0]}`);
  return r.stdout;
};

/** `git diff --raw -z` of two trees: what changed, with modes and the new blob. */
function rawChanges(clone: string, from: string, to: string): Entry[] {
  const parts = gitOut(clone, "diff", "--raw", "-z", "--no-renames", "--no-abbrev", "--no-color", from, to).split("\0");
  const entries: Entry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [oldMode, newMode, , newSha, status] = parts[i]!.slice(1).split(" ");
    entries.push({ oldMode: oldMode!, newMode: newMode!, newSha: newSha!, status: status!, path: parts[i + 1]! });
  }
  return entries;
}

const urlsIn = (text: string): string[] => (text.match(URL) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ""));

/** Every URL anywhere in the old tree, so one that only moved to another file is not new. */
function urlsAt(clone: string, tree: string): Set<string> {
  const r = runGit(clone, "grep", "-h", "-I", "-E", "https?://[^[:space:]]+", tree);
  return new Set(r.ok ? urlsIn(r.stdout) : []);
}

/** The map a SKILL.md opens with, or null when it has none or it does not parse. */
function frontmatter(text: string): Record<string, unknown> | null {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (m === null) return null;
  try {
    const doc = load(m[1]!);
    return typeof doc === "object" && doc !== null && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `allowed-tools` as a list: a YAML list, or a string split at commas and spaces outside parentheses. */
export function toolList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  const tools: string[] = [];
  let depth = 0;
  let word = "";
  for (const char of value) {
    if (char === "(") depth++;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (char === "," || /\s/.test(char))) {
      if (word !== "") tools.push(word);
      word = "";
    } else word += char;
  }
  if (word !== "") tools.push(word);
  return tools;
}

/** The fenced `bash` and `sh` blocks of a Markdown file, each as its body. */
export function shellBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let open: { fence: string; shell: boolean; body: string[] } | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const fence = /^ {0,3}(`{3,}|~{3,})\s*(\S*)/.exec(line);
    if (open === null) {
      if (fence !== null) open = { fence: fence[1]!, shell: ["bash", "sh"].includes(fence[2]!.toLowerCase()), body: [] };
    } else if (fence !== null && fence[1]![0] === open.fence[0] && fence[1]!.length >= open.fence.length && fence[2] === "") {
      if (open.shell) blocks.push(open.body.join("\n").trim());
      open = null;
    } else open.body.push(line);
  }
  return blocks;
}

const slash = (path: string) => path.split("/");
const isHooksOrSettings = (path: string) => slash(path).slice(0, -1).includes("hooks") || SETTINGS_FILE.test(slash(path).at(-1)!);
const isScript = (path: string, content: string) => SCRIPT_EXTENSIONS.has(/\.[^./]+$/.exec(path)?.[0].toLowerCase() ?? "") || content.startsWith("#!");

/** The warnings and the info for one skill, from its tree at the old pin and at the new one. */
function flagsFor(clone: string, from: string, to: string, used: UsedSkill, entries: Entry[]): Flag[] {
  const flags: Flag[] = [];
  const add = (severity: Flag["severity"], file: string, kind: FlagKind, detail: string) =>
    flags.push({ severity, skill: plain(used.skill, NAME_MAX), file: plain(file, PATH_MAX), kind, detail: plain(detail, DETAIL_MAX) });
  const blob = (sha: string) => runGit(clone, "cat-file", "blob", sha).stdout;

  for (const e of entries) {
    if (e.status === "D") continue;
    if (e.newMode === EXEC) add("warning", e.path, "exec-bit", e.status === "A" ? "new file with the exec bit" : e.oldMode === EXEC ? "executable file changed" : "now has the exec bit");
    if (e.status === "A" && isScript(e.path, blob(e.newSha).slice(0, 2))) add("warning", e.path, "new-script", "new script");
    if (e.status === "A" && isHooksOrSettings(e.path)) add("warning", e.path, "hooks-file", "new hooks or settings file");
  }

  // Read from the blobs and not from a text diff, whose headers quote an odd file name and so lose it.
  const oldUrls = urlsAt(clone, `${from}:${used.before}`);
  for (const e of entries) {
    if (e.status === "D") continue;
    const text = blob(e.newSha);
    const fresh = text.includes("\0") ? [] : [...new Set(urlsIn(text))].filter((u) => !oldUrls.has(u));
    if (fresh.length > 0) add("warning", e.path, "new-url", `new URL ${fresh[0]}${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ""}`);
  }

  if (entries.some((e) => e.path === "SKILL.md" && e.status === "M")) {
    const old = blob(`${from}:${used.before}/SKILL.md`);
    const next = blob(`${to}:${used.after}/SKILL.md`);
    const seen = new Set(shellBlocks(old));
    const added = [...new Set(shellBlocks(next))].filter((b) => !seen.has(b));
    if (added.length > 0) add("warning", "SKILL.md", "new-bash-block", added.length === 1 ? "new bash block" : `${added.length} new bash blocks`);

    const [was, now] = [frontmatter(old), frontmatter(next)];
    const [toolsWas, toolsNow] = [toolList(was?.["allowed-tools"]), toolList(now?.["allowed-tools"])];
    const plus = toolsNow.filter((t) => !toolsWas.includes(t)).map((t) => `+ ${t}`);
    const minus = toolsWas.filter((t) => !toolsNow.includes(t)).map((t) => `- ${t}`);
    if (plus.length + minus.length > 0) add("warning", "SKILL.md", "allowed-tools", `allowed-tools: ${[...plus, ...minus].join(", ")}`);
    if (String(was?.description ?? "").trim() !== String(now?.description ?? "").trim()) add("info", "SKILL.md", "description", "description changed");
  }
  return flags;
}

/** Added and removed lines of a change; a binary file counts for none. */
function size(clone: string, from: string, to: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of gitOut(clone, "diff", "--numstat", "--no-renames", from, to).split("\n")) {
    const [a, r] = line.split("\t");
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }
  return { added, removed };
}

/**
 * Reads what a move from `from` to `to` brings in, inside a clone that holds both. The skills in `used`
 * are the ones the config uses and that changed; their trees are compared directory to directory, so a
 * skill that moved inside the source is not mistaken for a rewrite.
 */
export function reviewMove(clone: string, from: string, to: string, used: UsedSkill[], yours: number, others: number, color: boolean): Review {
  const log = gitOut(clone, "log", "--format=%H%x09%s", `${from}..${to}`);
  const commits = log === "" ? [] : log.split("\n").map((line) => ({ sha: line.slice(0, line.indexOf("\t")), subject: plain(line.slice(line.indexOf("\t") + 1), SUBJECT_MAX) }));

  const changed: SkillChange[] = [];
  const flags: Flag[] = [];
  const diffs: string[] = [];
  for (const u of [...used].sort((a, b) => a.skill.localeCompare(b.skill))) {
    const [a, b] = [`${from}:${u.before}`, `${to}:${u.after}`];
    changed.push({ skill: plain(u.skill, NAME_MAX), ...size(clone, a, b) });
    flags.push(...flagsFor(clone, from, to, u, rawChanges(clone, a, b)));
    const text = gitOut(clone, "diff", "--no-renames", "--color=never", `--src-prefix=${u.skill}/`, `--dst-prefix=${u.skill}/`, a, b);
    if (text !== "") diffs.push(readableDiff(text, color));
  }
  return { commits, yours, changed, others, flags, diff: diffs.join("\n\n") };
}
