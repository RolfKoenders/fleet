// What the Capture screen needs that is not drawing: the draft of an answer for each item, and the request it turns into. Pure:
// `node --test` runs it. The page never holds a value of an env variable or a header: `GET /api/capture` sends names and shapes only,
// and the server reads the values itself when it builds the edits.

/**
 * @typedef {{ where: "env" | "headers", key: string, secret: boolean, name: string | null }} KeyRow
 * @typedef {{ agents: string[], command: string[] | null, transport: string | null, url: string | null, keys: KeyRow[], warning: string | null }} Variant
 * @typedef {{ kind: "mcp", name: string, state: State, message: string | null, agents: string[], variants: Variant[] }} McpItem
 * @typedef {{ kind: "skill", name: string, state: State, message: string | null, path: string, repo: { repo: string, path: string, commit: string, track: string, dirty: boolean, source: string | null } | null, bundle: string | null }} SkillItem
 * @typedef {"new" | "catalog" | "takeover" | "blocked"} State
 * @typedef {{ scope: "host" | "all", variant: number, onlyHad: boolean, secrets: Record<string, { secret: boolean, name: string }>, bundle: string }} Draft
 */

/** @param {{ kind: string, name: string }} item */
export const idOf = (item) => `${item.kind}:${item.name}`;

/** @param {{ where: string, key: string }} row */
const keyId = (row) => `${row.where}:${row.key}`;

/** The answer an item starts with: this host, the first definition, every agent, and a secret for each key named like one. @param {McpItem | SkillItem} item @returns {Draft} */
export function draftOf(item) {
  const first = item.kind === "mcp" ? item.variants[0] : undefined;
  return {
    scope: "host",
    variant: 0,
    onlyHad: false,
    secrets: Object.fromEntries((first?.keys ?? []).filter((k) => k.name !== null).map((k) => [keyId(k), { secret: k.secret, name: /** @type {string} */ (k.name) }])),
    bundle: item.kind === "skill" ? (item.bundle ?? item.repo?.source ?? sourceWord(item.repo?.repo ?? item.name)) : "",
  };
}

/** The last part of a repo address, as a name: `git@example.com:me/skill-box.git` is `skill-box`. @param {string} repo */
export function sourceWord(repo) {
  const last = repo.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop() ?? "";
  const clean = last.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  return clean === "" ? "skills" : clean.slice(0, 64);
}

/** The draft with another definition chosen: its keys start from the defaults again. @param {McpItem} item @param {Draft} draft @param {number} variant @returns {Draft} */
export function withVariant(item, draft, variant) {
  const keys = item.variants[variant]?.keys ?? [];
  return { ...draft, variant, secrets: Object.fromEntries(keys.filter((k) => k.name !== null).map((k) => [keyId(k), { secret: k.secret, name: /** @type {string} */ (k.name) }])) };
}

/** The keys of the chosen definition with the draft's answer for each. @param {McpItem} item @param {Draft} draft */
export function rowsOf(item, draft) {
  return (item.variants[draft.variant]?.keys ?? []).map((k) => {
    const own = draft.secrets[keyId(k)];
    return { ...k, id: keyId(k), secret: own?.secret ?? false, name: own?.name ?? "", canBeSecret: k.name !== null };
  });
}

/** The agents that have not got the server and can: a reason to offer "only the agents that had it". @param {McpItem} item @param {{ id: string, used?: boolean }[]} agents */
export const othersOf = (item, agents) => agents.filter((a) => a.used !== false && !item.agents.includes(a.id)).map((a) => a.id);

/** Why the answer cannot be sent yet, or null. Never mentions a value. @param {McpItem | SkillItem} item @param {Draft} draft */
export function problemOf(item, draft) {
  if (item.kind === "skill") return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(draft.bundle) && draft.bundle.length <= 64 ? null : "a bundle name is letters, digits, '.', '_' and '-'";
  const names = Object.values(draft.secrets).filter((s) => s.secret).map((s) => s.name);
  const bad = names.find((n) => !/^[A-Z][A-Z0-9_]*$/.test(n) || n.length > 100);
  if (bad !== undefined) return "a secret name is capital letters, digits and '_', and starts with a letter, such as TRACKER_API_KEY";
  if (new Set(names).size !== names.length) return "two keys have the same secret name";
  return null;
}

/**
 * The `decision` of `POST /api/capture/build`.
 * @param {McpItem | SkillItem} item @param {"add" | "takeover" | "ignore"} action @param {Draft} draft
 */
export function decisionOf(item, action, draft) {
  const base = { kind: item.kind, name: item.name, action, scope: draft.scope };
  if (action !== "add") return base;
  if (item.kind === "skill") return { ...base, bundle: draft.bundle };
  const rows = rowsOf(item, draft).filter((r) => r.secret && r.canBeSecret);
  return { ...base, variant: draft.variant, onlyHad: draft.onlyHad, secrets: rows.map((r) => ({ where: r.where, key: r.key, name: r.name })) };
}

/** The words of an item's state. @param {State} state */
export const STATE_WORDS = {
  new: "not in the catalog",
  catalog: "matches the catalog, this host does not pick it",
  takeover: "matches the config",
  blocked: "cannot be captured",
};

/** What an answer is called once it is on To push. @param {"add" | "takeover" | "ignore"} action @param {"host" | "all"} scope */
export const doneWords = (action, scope) => (action === "ignore" ? "ignored on this host" : action === "takeover" ? "taken over" : scope === "all" ? "added for every host" : "added for this host");

/** The line under the list for items that are the same name with another definition: they stay conflicts. @param {number} n */
export const differsLine = (n) => (n === 0 ? null : `${n} ${n === 1 ? "differs" : "differ"} from the catalog: see fleet status --conflicts`);
