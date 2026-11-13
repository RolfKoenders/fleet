// A line diff for the held-edits area. No DOM here, so `node --test` runs it.

/**
 * @typedef {" " | "+" | "-"} DiffOp
 * @typedef {[DiffOp, string]} DiffLine
 */

/**
 * A line diff by longest common subsequence: fine for config files of this size. Where an addition and a removal
 * tie, the removal comes first, so a changed line reads as `-` then `+`.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {DiffLine[]}
 */
export function lineDiff(a, b) {
  const n = a.length;
  const m = b.length;
  /** @type {number[][]} */
  const t = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    }
  }
  /** @type {DiffLine[]} */
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push([" ", a[i]]);
      i++;
      j++;
    } else if (i < n && (j === m || t[i + 1][j] >= t[i][j + 1])) {
      out.push(["-", a[i++]]);
    } else {
      out.push(["+", b[j++]]);
    }
  }
  return out;
}

/** The lines of a text, without a trailing empty line for a final newline. @param {string} text */
export const splitLines = (text) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

/** Whether a diff holds any change. @param {DiffLine[]} diff */
export const changed = (diff) => diff.some(([op]) => op !== " ");

/** How many lines a diff adds and removes. @param {DiffLine[]} diff */
export function counts(diff) {
  let added = 0;
  let removed = 0;
  for (const [op] of diff) {
    if (op === "+") added++;
    else if (op === "-") removed++;
  }
  return { added, removed };
}

/**
 * One YAML line as styled pieces: a key, a quoted string or `secret:NAME`, a comment. The pieces joined give the line back.
 * @param {string} line
 * @returns {{ cls: "" | "k" | "s" | "c"; text: string }[]}
 */
export function tokenize(line) {
  const hash = line.search(/(^|\s)#/);
  const comment = hash < 0 ? "" : line.slice(line.indexOf("#", hash));
  const code = hash < 0 ? line : line.slice(0, line.length - comment.length);
  /** @type {{ cls: "" | "k" | "s" | "c"; text: string }[]} */
  const out = [];
  /** @param {"" | "k" | "s" | "c"} cls @param {string} text */
  const push = (cls, text) => {
    if (text !== "") out.push({ cls, text });
  };
  const key = /^(\s*-?\s*)([A-Za-z_][\w-]*)(:)/.exec(code);
  let rest = code;
  if (key) {
    push("", key[1]);
    push("k", key[2]);
    rest = code.slice(key[1].length + key[2].length);
  }
  let last = 0;
  for (const m of rest.matchAll(/secret:[A-Za-z0-9_]+|"[^"]*"/g)) {
    push("", rest.slice(last, m.index));
    push("s", m[0]);
    last = m.index + m[0].length;
  }
  push("", rest.slice(last));
  push("c", comment);
  return out;
}
