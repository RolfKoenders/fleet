// What the Secrets screen needs that is not drawing: how a cell reads, which hosts a value goes to by default, the request
// that sets one, and what happens to the held edits when it is set. Pure: `node --test` runs it. A value never passes through
// here except as the argument of `setBody`: nothing in this module keeps, logs or returns one.

/**
 * @typedef {{ state: "set" | "missing" | "unused", from: "host" | "shared" | null }} SecretCell
 * @typedef {{ name: string, usedBy: string[], cells: Record<string, SecretCell>, targets: string[] }} SecretRow
 * @typedef {{ hosts: { name: string, age: boolean }[], names: SecretRow[], problems: string[] }} SecretsTable
 * @typedef {{ op: "setSecret", file: string, names: string[], base: string, content: string }} SecretOp
 */

/** The longest value the server takes (`MAX_VALUE` in `src/ui/secretset.ts`). */
export const MAX_VALUE = 8192;

// The words of these refusals are the server's (`src/ui/secretset.ts`): a test holds them equal.
export const VALUE_EMPTY = "Type the value first.";
export const VALUE_LONG = `The value is too long: a value can be at most ${MAX_VALUE} characters.`;
export const VALUE_BLANK = "The value is only spaces: type the value itself.";

/** The secrets file of a host, or `shared`. @param {string} owner */
export const fileOf = (owner) => `secrets/${owner}.enc.yaml`;

/** @param {any} op @returns {op is SecretOp} */
export const isSecretOp = (op) => op?.op === "setSecret";

/** Why a typed value cannot be sent, or null. Says nothing of what was typed. @param {string} value */
export function valueProblem(value) {
  if (value === "") return VALUE_EMPTY;
  if (value.length > MAX_VALUE) return VALUE_LONG;
  if (value.trim() === "") return VALUE_BLANK;
  return null;
}

/** A refusal followed by the ask to type again, as two sentences whether or not the message ends one. @param {string} message */
export const retryText = (message) => `${message.replace(/[^.!?]$/, "$&.")} Type the value again.`;

/**
 * How one cell reads: a mark, a word, a tone, and whether the value in it is held (encrypted, not written yet).
 * @param {SecretCell | undefined} cell
 * @param {string} name
 * @param {string} host
 * @param {unknown[]} ops
 * @returns {{ mark: string, word: string, tone: "have" | "miss" | "na", held: boolean }}
 */
export function cellView(cell, name, host, ops) {
  if (!cell || cell.state === "unused") return { mark: "", word: "not used", tone: "na", held: false };
  if (cell.state === "missing") return { mark: "!", word: "missing", tone: "miss", held: false };
  const file = fileOf(cell.from === "shared" ? "shared" : host);
  const held = ops.some((o) => isSecretOp(o) && o.file === file && o.names.includes(name));
  return { mark: "✓", word: cell.from === "shared" ? "set (shared)" : "set", tone: "have", held };
}

/**
 * The button of a row: `Set value` when some host that needs it lacks it, `Replace value` when it is set everywhere it is
 * needed.
 * @param {SecretRow} row
 */
export function actionOf(row) {
  const missing = Object.entries(row.cells).filter(([, c]) => c.state === "missing").map(([h]) => h);
  if (missing.length > 0) return { label: missing.length === 1 ? `Set for ${missing[0]}` : "Set value", missing };
  return { label: Object.values(row.cells).some((c) => c.state === "set") ? "Replace value" : "Set value", missing };
}

/**
 * The files the dialog offers: each host (ticked when it needs the secret and lacks it, or holds it and it is being replaced),
 * and `shared`, never ticked. A host with no age key cannot be ticked: nothing could be encrypted for it.
 * @param {SecretsTable} table
 * @param {SecretRow} row
 * @returns {{ file: string, label: string, checked: boolean, disabled: boolean, note: string }[]}
 */
export function dialogTargets(table, row) {
  const hosts = table.hosts.map((h) => {
    const cell = row.cells[h.name];
    const note = !h.age ? "no age key" : cell?.state === "missing" ? "needs it, has none" : cell?.from === "host" ? "has its own value" : cell?.from === "shared" ? "reads it from shared" : "not used";
    return { file: h.name, label: h.name, checked: h.age && row.targets.includes(h.name), disabled: !h.age, note };
  });
  const anyKey = table.hosts.some((h) => h.age);
  return [...hosts, { file: "shared", label: "shared", checked: false, disabled: !anyKey, note: "every host with an age key can read it" }];
}

/**
 * The request body that sets a value. The one place a value is put into anything.
 * @param {string} name @param {string} value @param {string[]} files @param {unknown[]} ops
 */
export const setBody = (name, value, files, ops) => ({ name, value, files, ops });

/**
 * The held edits after a value was set: the server answers the edit for each file it set, which replaces any held for that
 * file (it was built on it and carries its names too).
 * @param {any[]} ops @param {{ ops: any[], replaces: string[] }} doc
 */
export const afterSet = (ops, doc) => [...ops.filter((o) => !(isSecretOp(o) && doc.replaces.includes(o.file))), ...doc.ops];

/** `name` and the files it is held for, one entry per name. @param {unknown[]} ops @returns {{ name: string, files: string[] }[]} */
export function heldNames(ops) {
  /** @type {Map<string, string[]>} */
  const by = new Map();
  for (const o of ops) {
    if (!isSecretOp(o)) continue;
    const owner = /^secrets\/(.+)\.enc\.yaml$/.exec(o.file)?.[1] ?? o.file;
    for (const n of o.names) by.set(n, [...(by.get(n) ?? []), owner]);
  }
  return [...by].map(([name, files]) => ({ name, files }));
}

/** How many names a host needs and lacks, for the badge on the screen's tab. @param {SecretsTable | null | undefined} table */
export const missingCount = (table) => (table?.names ?? []).reduce((n, row) => n + Object.values(row.cells).filter((c) => c.state === "missing").length, 0);
