// What the Add forms of the Catalog need that is not drawing: splitting a command, the warning for an unpinned one, and
// turning each form into the edit it would hold, or into the reasons it cannot yet. Pure: `node --test` runs it.
// The rules are the loader's (`src/mcp.ts`, `src/catalog.ts`), and the server checks every edit again with the loader's own code.

/** @typedef {import("./matrix.js").Op} Op */
/**
 * @typedef {{ key: string, mode: "secret" | "plain", value: string }} Row
 * One environment variable (or header): a plain value, or a secret by name. A secret row with no name uses the variable's own.
 * @typedef {{ name: string, kind: "command" | "http" | "sse", command: string, url: string, rows: Row[], claude: boolean, opencode: boolean }} ServerForm
 * @typedef {{ name: string, repo: string, path: string, branch: string, mode: "pin" | "follow", review: boolean }} SourceForm
 * @typedef {{ name: string, picked: string[], extra: string }} BundleForm
 * @typedef {{ key: string, repo: string, path: string, branch: string | null, commit: string, skills: string[], problem: string | null, id: string, headBranch: string | null }} Cloned
 * @typedef {{ op: Op | null, problems: string[], warnings: string[] }} Draft
 */

/** The loader's message for a secret in a command (`src/mcp.ts`), without its `catalog/mcp.yaml: server 'x':` prefix. */
export const COMMAND_SECRET = "'command' cannot refer to a secret, a command line is visible to every user; use 'env'";

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;
const RESERVED = ["fleet", "synced", ".trash"];
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
/** The longest name of a server, source or bundle (`MAX_NAME` in `src/ui/opsof.ts`). */
export const MAX_NAME = 64;

// The words of these refusals are the server's (`src/redact.ts`, `src/ui/opsof.ts`): a test holds them equal.
export const URL_SPACE = "the URL must not hold a space or a control character";
export const MCP_URL_CREDENTIALS = "the URL must not hold credentials (user:password@): put them in 'headers' as secret:NAME";
export const REPO_CREDENTIALS = "the repo must not hold credentials (user:password@): use a git credential helper or an ssh key, never the URL";

/** Credentials in a URL: any userinfo in an http(s) URL, or a password in the userinfo of any other (`urlHoldsCredentials` in `src/redact.ts`). @param {string} url */
export const holdsCredentials = (url) => {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)@/i.exec(url);
  return m !== null && (/^https?$/i.test(/** @type {string} */ (m[1])) || /** @type {string} */ (m[2]).includes(":"));
};

/**
 * Why `repo` may not be handed to `git clone`, or null: `repoProblem` of `src/ui/opsof.ts`, word for word.
 * @param {string} repo
 */
export function repoProblem(repo) {
  if (repo === "" || repo.length > 500) return "the repo must be a URL or a path";
  if (/[\u0000- \u007f]/.test(repo)) return "the repo must not hold a space or a control character";
  if (repo.startsWith("-")) return "the repo must not start with '-'";
  if (holdsCredentials(repo)) return REPO_CREDENTIALS;
  if (repo.includes("::")) return "the repo must not use a remote helper (a '::' address)";
  if (/^(https?|ssh|git|file):\/\/[^/]/.test(repo)) return null;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^/].*/.test(repo) || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:\/.*/.test(repo)) return null;
  if (repo.startsWith("/")) return null;
  return "the repo must be an https, ssh, git or file URL, an scp-style address (user@host:path) or an absolute path";
}

/** @param {string} branch */
export const branchProblem = (branch) => (BRANCH.test(branch) && !branch.includes("..") ? null : "the branch name is not one fleet will pass to git");

/** @param {string} path */
export const pathProblem = (path) => (path.startsWith("/") || path.split("/").includes("..") || /[\u0000-\u001f\u007f]/.test(path) ? "the path must be a directory inside the repo, without '..'" : null);

/** @param {string} url */
export const urlProblem = (url) => {
  if (!/^https?:\/\/[^\s/]/.test(url)) return "the URL must be an http or https address";
  if (/[\u0000-\u0020\u007f]/.test(url)) return URL_SPACE;
  if (holdsCredentials(url)) return MCP_URL_CREDENTIALS;
  return null;
};

/** The secret names a text refers to as `secret:NAME`, as the loader finds them. @param {string} text */
export const secretNamesIn = (text) => [...text.matchAll(/(?<![A-Za-z0-9_])secret:([A-Z][A-Z0-9_]*)/g)].map((m) => /** @type {string} */ (m[1]));

/**
 * A command line as a list: split on spaces, with 'single' and "double" quotes and a backslash for the next character.
 * Null when a quote is not closed.
 * @param {string} text
 * @returns {string[] | null}
 */
export function splitCommand(text) {
  /** @type {string[]} */
  const out = [];
  let word = "";
  let open = false;
  /** @type {string | null} */
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = /** @type {string} */ (text[i]);
    if (quote !== null) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < text.length) word += text[++i];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      open = true;
    } else if (c === "\\" && i + 1 < text.length) {
      word += text[++i];
      open = true;
    } else if (/\s/.test(c)) {
      if (open || word !== "") out.push(word);
      word = "";
      open = false;
    } else {
      word += c;
      open = true;
    }
  }
  if (quote !== null) return null;
  if (open || word !== "") out.push(word);
  return out;
}

const program = (/** @type {string} */ p) => p.slice(p.lastIndexOf("/") + 1);

/** An npm package spec with a version that is a release (`pkg@1.2.3`, `@scope/pkg@^1.2`), not a tag like `latest`. @param {string} spec */
const npmPinned = (spec) => {
  const at = spec.indexOf("@", 1);
  return at > 0 && /^[~^=v]*\d/.test(spec.slice(at + 1));
};

/** A Python requirement with a version (`pkg==1.2.3`, `pkg@1.2.3`). @param {string} spec */
const pyPinned = (spec) => /==\s*\d|@\d/.test(spec);

/**
 * The warning for a command that fetches a package and does not say which version: `npx pkg` or `uvx pkg` with none (or
 * a tag such as `latest`), so the server changes whenever the package does. Null for anything else.
 * @param {string[]} command
 * @returns {string | null}
 */
export function unpinned(command) {
  const first = command[0];
  if (first === undefined) return null;
  const tool = program(first);
  if (tool !== "npx" && tool !== "uvx") return null;
  const args = command.slice(1);
  /** @type {string | undefined} */
  let spec;
  for (let i = 0; i < args.length; i++) {
    const a = /** @type {string} */ (args[i]);
    if (tool === "npx" && (a === "-p" || a === "--package")) spec = args[++i];
    else if (tool === "npx" && a.startsWith("--package=")) spec = a.slice("--package=".length);
    else if (tool === "uvx" && a === "--from") spec = args[++i];
    else if (tool === "uvx" && a.startsWith("--from=")) spec = a.slice("--from=".length);
    else if (a.startsWith("-")) continue;
    else if (spec === undefined) spec = a;
    if (spec !== undefined) break;
  }
  if (spec === undefined || (tool === "npx" ? npmPinned(spec) : pyPinned(spec))) return null;
  const bare = tool === "npx" ? (spec.indexOf("@", 1) > 0 ? spec.slice(0, spec.indexOf("@", 1)) : spec) : (spec.split(/==|@/)[0] ?? spec);
  return `${tool} ${spec} has no version, so this server changes whenever the package does. Pin it: ${tool === "npx" ? `${bare}@1.2.3` : `${bare}==1.2.3`}.`;
}

/**
 * @param {string} name
 * @param {string[]} taken names in the catalog
 * @param {string[]} held names already added to To push
 * Names are compared without regard to case: a source is a directory of that name, and tools lower-case a server's.
 */
const nameProblem = (name, taken, held = [], re = NAME, what = "name") => {
  if (name === "") return `give it a ${what}`;
  if (!re.test(name)) return `the ${what} must be letters, digits${re === SERVER_NAME ? ", '_' or '-'" : ", '.', '_' or '-'"}, and start with a letter or digit`;
  if (name.length > MAX_NAME) return `the ${what} can be at most ${MAX_NAME} characters`;
  const low = name.toLowerCase();
  const inHeld = held.find((n) => n.toLowerCase() === low);
  if (inHeld !== undefined) return alreadyHeld(name);
  const inCatalog = taken.find((n) => n.toLowerCase() === low);
  if (inCatalog === undefined) return null;
  return inCatalog === name ? `'${name}' is already in the catalog` : `'${name}' clashes with '${inCatalog}', which is already in the catalog: names are compared without regard to case`;
};

/** The second addition of a name already added to To push (`alreadyHeld` in `src/ui/opsof.ts`). @param {string} name */
const alreadyHeld = (name) => `'${name}' is already added to To push`;

/** A secret name for an environment row, or null when there is none to use. @param {Row} row */
export const secretOf = (row) => (row.value.trim() !== "" ? row.value.trim() : ENV_NAME.test(row.key.trim()) ? row.key.trim() : "");

/** Rows that have something in them. @param {Row[]} rows */
const filled = (rows) => rows.filter((r) => r.key.trim() !== "" || r.value.trim() !== "");

/**
 * The edit a server form holds, or why it cannot yet.
 * @param {ServerForm} f
 * @param {string[]} taken names already in the catalog (and held)
 * @param {string[]} [held] the names already added to To push
 * @returns {Draft}
 */
export function serverDraft(f, taken, held = []) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const warnings = [];
  const name = f.name.trim();
  const bad = nameProblem(name, taken, held, SERVER_NAME, "name");
  if (bad !== null) problems.push(bad);
  /** @type {Record<string, any>} */
  const entry = {};
  if (f.kind === "command") {
    const command = splitCommand(f.command);
    if (command === null) problems.push("the command has a quote that is not closed");
    else if (command.length === 0) problems.push("enter the command that starts the server");
    else if (command.some((a) => secretNamesIn(a).length > 0)) problems.push(COMMAND_SECRET);
    else {
      entry.command = command;
      const warning = unpinned(command);
      if (warning !== null) warnings.push(warning);
    }
  } else {
    const url = f.url.trim();
    const bad = urlProblem(url);
    if (bad !== null) problems.push(bad);
    else {
      entry.transport = f.kind;
      entry.url = url;
    }
  }
  /** @type {Record<string, string>} */
  const vars = {};
  for (const row of filled(f.rows)) {
    const key = row.key.trim();
    const label = f.kind === "command" ? "environment variable" : "header";
    if (key === "") problems.push(`give it a name (this row has a value but no ${label} name)`);
    else if (!(f.kind === "command" ? ENV_NAME : HEADER_NAME).test(key)) problems.push(`'${key}' is not a valid ${label} name`);
    else if (key in vars) problems.push(`${key} is set twice`);
    else if (row.mode === "secret") {
      const secret = secretOf(row);
      if (!SECRET_NAME.test(secret)) problems.push(`${key}: a secret name is capital letters, digits and '_' (give one)`);
      else vars[key] = `secret:${secret}`;
    } else if (row.value === "") problems.push(`${key} needs a value`);
    else vars[key] = row.value;
  }
  if (Object.keys(vars).length > 0) entry[f.kind === "command" ? "env" : "headers"] = vars;
  if (!f.claude && !f.opencode) problems.push("pick at least one agent");
  else if (!(f.claude && f.opencode)) entry.only = [f.claude ? "claude" : "opencode"];
  return { op: problems.length === 0 ? { op: "addServer", name, entry } : null, problems, warnings };
}

/** The secrets a draft's entry names. @param {Op | null} op */
export const secretsOf = (op) => (op && op.op === "addServer" ? [...new Set(Object.values({ ...op.entry.env, ...op.entry.headers }).flatMap((v) => secretNamesIn(String(v))))] : []);

/** What a clone is for: the same repo, path and branch the form says now. @param {SourceForm} f */
export const cloneKey = (f) => [f.repo.trim(), f.path.trim() || ".", f.branch.trim()].join("\n");

/**
 * What is wrong with the repo, branch and path as typed, field by field, before the repo is looked at. Nothing is said of an
 * empty field: the repo is needed (said by the draft), the branch and path have defaults.
 * @param {SourceForm} f
 * @returns {{ repo: string | null, branch: string | null, path: string | null }}
 */
export function sourceInputs(f) {
  const repo = f.repo.trim();
  const branch = f.branch.trim();
  const path = f.path.trim();
  return { repo: repo === "" ? null : repoProblem(repo), branch: branch === "" ? null : branchProblem(branch), path: path === "" ? null : pathProblem(path) };
}

/**
 * The edit a skill source form holds. A source is added from a clone: it names the skills found and the commit to pin.
 * @param {SourceForm} f
 * @param {string[]} taken
 * @param {Cloned | null} clone
 * @param {string[]} [held] the source names already added to To push
 * @returns {Draft}
 */
export function sourceDraft(f, taken, clone, held = []) {
  /** @type {string[]} */
  const problems = [];
  const name = f.name.trim();
  const bad = nameProblem(name, taken, held);
  if (bad !== null) problems.push(bad);
  const repo = f.repo.trim();
  const typed = sourceInputs(f);
  if (repo === "") problems.push("enter the repo: a URL, or a path on this machine");
  const wrong = [typed.repo, typed.branch, typed.path].filter((p) => p !== null);
  problems.push(.../** @type {string[]} */ (wrong));
  if (repo === "" || wrong.length > 0) return { op: null, problems, warnings: [] };
  if (clone === null || clone.key !== cloneKey(f)) problems.push("look at the repo first: it is cloned shallowly to list its skills and read its head commit");
  else if (clone.problem !== null) problems.push(clone.problem);
  else if (clone.skills.length === 0) problems.push("no skill (a directory with a SKILL.md) was found under that path");
  if (problems.length > 0 || clone === null) return { op: null, problems, warnings: [] };
  const branch = f.branch.trim() || clone.headBranch || "";
  if (branch === "") return { op: null, problems: [f.mode === "pin" ? "the repo is on a detached head: say which branch to track" : "say which branch to follow"], warnings: [] };
  const path = f.path.trim() || ".";
  /** @type {Record<string, any>} */
  const entry = f.mode === "pin" ? { repo, commit: clone.commit, track: branch, path, ...(f.review ? { review: true } : {}) } : { repo, branch, path };
  return { op: { op: "addSource", name, entry }, problems, warnings: [] };
}

/**
 * @typedef {{ name: string, source: string, bundle: string | null }} Known
 * A skill that exists in a source, and the bundle that already holds it.
 */

/**
 * The skills a bundle can be made of: those in the sources fleet has cloned, and those in a source held in this page,
 * each with the bundle that holds it (one a bundle held here holds too).
 * @param {Known[]} known
 * @param {Op[]} ops
 * @param {Record<string, string[]>} stagedSkills skills of each held source, by source name
 * @returns {Known[]}
 */
export function skillChoices(known, ops, stagedSkills) {
  /** @type {Map<string, string>} */
  const owner = new Map();
  for (const k of known) if (k.bundle !== null) owner.set(k.name, k.bundle);
  for (const o of ops) if (o.op === "addBundle") for (const s of o.skills) owner.set(s, o.name);
  /** @type {Map<string, Known>} */
  const all = new Map(known.map((k) => [k.name, k]));
  for (const o of ops) if (o.op === "addSource") for (const s of stagedSkills[o.name] ?? []) if (!all.has(s)) all.set(s, { name: s, source: o.name, bundle: null });
  return [...all.values()].map((k) => ({ ...k, bundle: owner.get(k.name) ?? null })).sort((a, b) => a.name.localeCompare(b.name));
}

/** The skill names typed in the free box: separated by commas or spaces. @param {string} text */
export const typedSkills = (text) => text.split(/[\s,]+/).filter((s) => s !== "");

/**
 * The edit a bundle form holds.
 * @param {BundleForm} f
 * @param {string[]} taken bundle names already there
 * @param {Known[]} choices what skillChoices says
 * @param {string[]} [held] the bundle names already added to To push
 * @returns {Draft}
 */
export function bundleDraft(f, taken, choices, held = []) {
  /** @type {string[]} */
  const problems = [];
  const name = f.name.trim();
  const bad = nameProblem(name, taken, held);
  if (bad !== null) problems.push(bad);
  const skills = [...new Set([...f.picked, ...typedSkills(f.extra)])];
  if (skills.length === 0) problems.push("pick at least one skill");
  for (const skill of skills) {
    const holder = choices.find((c) => c.name === skill)?.bundle;
    if (!NAME.test(skill)) problems.push(`'${skill}' is not a skill name`);
    else if (RESERVED.includes(skill)) problems.push(`'${skill}' is a reserved name, fleet never links it from a source`);
    else if (holder) problems.push(`skill '${skill}' is already in bundle '${holder}': a skill is in only one bundle`);
  }
  /** @type {string[]} */
  const warnings = skills.filter((s) => !choices.some((c) => c.name === s)).map((s) => `${s} is in none of the sources fleet knows: the push fails unless a source has it`);
  return { op: problems.length === 0 ? { op: "addBundle", name, skills } : null, problems, warnings };
}

/**
 * Warnings for a held addition, for the review.
 * @param {Op} op
 * @returns {string[]}
 */
export function opWarnings(op) {
  if (op.op !== "addServer") return [];
  const warning = Array.isArray(op.entry.command) ? unpinned(op.entry.command) : null;
  return warning === null ? [] : [`${op.name}: ${warning}`];
}

/**
 * What the check answered, as lines: the result first (with its tone), the tools and their size in tokens, then a secret that was left out.
 * @param {{ result: string, tools: number | null, tokens: number | null, latencyMs: number | null, protocol: string | null, detail: string | null, unset: string[], agent: string }} c
 * @returns {{ tone: "ok" | "warn" | "bad", lines: string[] }}
 */
export function checkLines(c) {
  /** @type {string[]} */
  const notes = c.unset.map((n) => `${n} has no value on this host, so it was started without it.`);
  if (c.result === "not-run") return { tone: "warn", lines: [c.detail ?? "the check could not run", ...notes] };
  if (c.result === "ok") {
    const tools = `${c.tools ?? 0} tool${c.tools === 1 ? "" : "s"}`;
    const size = c.tokens === null ? "" : `, ${tokens(c.tokens)} tokens of definitions`;
    if (c.unset.length > 0) notes.push("Calls that need the missing secrets will fail until you set them under Secrets.");
    return { tone: "ok", lines: [`It started and answered: ${tools}${size}${c.latencyMs === null ? "" : ` in ${c.latencyMs} ms`}.`, ...notes] };
  }
  if (c.result === "auth-needed") return { tone: "warn", lines: ["It started and wants a login: log in once with /mcp in the tool. Fleet only writes the entry.", ...notes] };
  return { tone: "bad", lines: [`It did not start well: ${c.result}${c.detail ? ` (${c.detail})` : ""}.`, ...notes] };
}

/** `~850`, `~28.4k`: the estimate as `fleet doctor` shows it. @param {number} n */
export const tokens = (n) => (n < 1000 ? `~${n}` : `~${(n / 1000).toFixed(1)}k`);

/** The sentence the confirmation names the command in. @param {Op | null} op */
export function confirmText(op) {
  if (op === null || op.op !== "addServer") return "";
  const what = Array.isArray(op.entry.command) ? `the command ${op.entry.command.join(" ")}` : `a request to ${op.entry.url}`;
  const secrets = secretsOf(op);
  return `This starts ${what} on this machine, now. It runs with the real credentials fleet can read for this host${secrets.length > 0 ? ` (${secrets.join(", ")})` : ""}, and it may download packages. Nothing is written or pushed.`;
}

/**
 * The held edits without `op`, and without the picks of what it added: a server or bundle that is not added any more
 * cannot be given to a host.
 * @param {Op[]} ops
 * @param {Op} op
 * @returns {Op[]}
 */
export function takeBack(ops, op) {
  const kind = op.op === "addServer" ? "mcp" : op.op === "addBundle" ? "bundles" : null;
  return ops.filter((o) => o !== op && !(kind !== null && (o.op === "add" || o.op === "remove") && o.kind === kind && "name" in op && o.name === op.name));
}
