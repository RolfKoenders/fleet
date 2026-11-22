import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSopsText, SECRET_NAME } from "./edit/index.ts";
import { InvalidConfigError } from "./config.ts";
import { runGit, outsideChanges } from "./git.ts";
import { parseMcpCatalog } from "./mcp.ts";
import type { Result } from "./output.ts";
import { Cancelled } from "./prompt.ts";
import type { Prompter } from "./prompt.ts";
import { hostNames, secretsFile, writeSopsConfig } from "./recipients.ts";
import { sopsSet } from "./secretscli.ts";
import { NeedsSecretError, findSops, requireAgeKey } from "./sops.ts";
import { secretNames } from "./template.ts";
import { MAX_VALUE, VALUE_BLANK, VALUE_LONG, sopsFailure } from "./ui/secretset.ts";
import { parseFile } from "./yamlfile.ts";

/**
 * `fleet secrets rotate [NAME...]`: replace secret values one by one, after a token leaked, a server rejected one, or a host left.
 *
 * A new value is read with hidden input, goes to sops on its stdin and nowhere else: it is never printed, logged, put in a message, a
 * commit or the result. Every message here names a secret, never what it holds. A secret is set in every secrets file that holds it,
 * all or none: when one file cannot take it, the files already changed for that secret are put back.
 */

/** What a host's removal hands over: the names it could read, so the list starts with those. */
export type RotateFrom = { host: string; shared: string[]; own: string[] };

export type RotateOptions = {
  home?: string;
  /** Where the questions are asked. Null without a terminal, which rotate cannot run without. */
  prompt: Prompter | null;
  /** The names to rotate, from the command line. Without any, the person picks. */
  names?: string[];
  from?: RotateFrom;
  /** Publish the commit: `fleet push`. */
  push: () => Promise<Result>;
  /** Check the servers still work with the new values: `fleet doctor --all`. */
  doctor: () => Promise<Result>;
};

type Candidate = {
  name: string;
  /** The secrets files that hold it now: `shared` or a host name. Empty for a secret whose only file was deleted with its host. */
  files: string[];
  /** Catalog servers that use it, and `settings` when a host's settings do. */
  usedBy: string[];
  /** Where the removed host could read it from, for the list. */
  note: string;
  ticked: boolean;
};

const invalid = (...messages: string[]): Result => ({ code: "invalid", messages: messages.map((m) => `fleet: ${m}`) });

/** The secrets files that hold each name, by owner. Names only: nothing is decrypted. */
function held(configDir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const owner of ["shared", ...hostNames(configDir)]) {
    let text: string;
    try {
      text = readFileSync(join(configDir, secretsFile(owner)), "utf8");
    } catch {
      continue;
    }
    for (const name of parseSopsText(text).entries.keys()) out.set(name, [...(out.get(name) ?? []), owner]);
  }
  return out;
}

/** The servers (and `settings`) that use each secret name. */
function usedBy(configDir: string): Map<string, string[]> {
  const users = new Map<string, Set<string>>();
  const use = (name: string, by: string) => users.set(name, (users.get(name) ?? new Set()).add(by));
  const problems: string[] = [];
  for (const [server, s] of parseMcpCatalog(configDir, problems).entries()) for (const n of secretNames({ env: s.env, headers: s.headers, url: s.url })) use(n, server);
  for (const file of ["_defaults", ...hostNames(configDir)]) for (const n of secretNames(parseFile(join(configDir, "hosts", `${file}.yaml`), true, problems)?.settings ?? {})) use(n, "settings");
  return new Map([...users].map(([name, by]) => [name, [...by].sort()]));
}

function candidates(configDir: string, names: string[], from: RotateFrom | undefined): Candidate[] | Result {
  const files = held(configDir);
  const users = usedBy(configDir);
  const origin = new Map<string, "shared" | "own">();
  for (const n of from?.own ?? []) origin.set(n, "own");
  for (const n of from?.shared ?? []) origin.set(n, "shared");
  const all = new Set<string>([...files.keys(), ...origin.keys()]);
  const wanted = names.length > 0 ? names : [...all].sort();
  // The names a person typed are never echoed: one may be a value pasted in the wrong place.
  if (!wanted.every((n) => SECRET_NAME.test(n) && all.has(n))) return invalid("a name you gave is not a secret in any secrets file; run `fleet secrets rotate` with no names to pick from the list");
  return wanted.map((name) => {
    const where = origin.get(name);
    const note = where === undefined ? "" : where === "shared" ? `${from!.host} could read it from shared` : `${from!.host} had it in its own file, which is deleted`;
    return { name, files: files.get(name) ?? [], usedBy: users.get(name) ?? [], note, ticked: names.length > 0 || where === "shared" };
  });
}

const where = (c: Candidate): string => (c.files.length === 0 ? "no secrets file holds it any more" : c.files.map(secretsFile).join(", "));

/** Which of the list to rotate: enter for the ticked ones, numbers, `a` for all or `n` for none. */
async function pick(prompt: Prompter, list: Candidate[]): Promise<Candidate[]> {
  prompt.say("Secrets to rotate:");
  list.forEach((c, i) => prompt.say(`  ${c.ticked ? "[x]" : "[ ]"} ${String(i + 1).padStart(2)}. ${c.name}  (${c.usedBy.length === 0 ? "no server uses it" : `used by ${c.usedBy.join(", ")}`}${c.note === "" ? "" : `; ${c.note}`})`));
  for (;;) {
    const answer = (await prompt.line("Numbers to rotate (for example 1 3), a for all, n for none, enter for the ticked ones: ")).trim().toLowerCase();
    if (answer === "") return list.filter((c) => c.ticked);
    if (answer === "a") return list;
    if (answer === "n") return [];
    const numbers = answer.split(/[\s,]+/).map(Number);
    if (numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= list.length)) return list.filter((_, i) => numbers.includes(i + 1));
    prompt.say(`Type numbers from 1 to ${list.length}, a, n, or just enter.`);
  }
}

/** The new value for a secret, or null to skip it. Asks again for a value that cannot be used, and says why without repeating it. */
async function newValue(prompt: Prompter, name: string): Promise<string | null> {
  for (;;) {
    const value = await prompt.secret(`New value for ${name} (hidden, enter to skip): `);
    if (value === "") return null;
    if (value.length > MAX_VALUE) prompt.say(VALUE_LONG);
    else if (value.trim() === "") prompt.say(VALUE_BLANK);
    else return value;
  }
}

type Rotated = { name: string; files: string[] };

/** Sets `value` in every file that holds `candidate`, or in none: the files already changed are put back. A fixed message when it failed. */
function setEverywhere(configDir: string, home: string, sops: string, candidate: Candidate, value: string): string | null {
  const before = new Map(candidate.files.map((owner) => [owner, readFileSync(join(configDir, secretsFile(owner)), "utf8")]));
  for (const owner of candidate.files) {
    const run = sopsSet(sops, configDir, home, owner, candidate.name, value);
    if (run.status !== 0) {
      for (const [file, text] of before) writeFileSync(join(configDir, secretsFile(file)), text);
      // Chosen from what sops said, never repeating it.
      return sopsFailure(run.stderr, secretsFile(owner));
    }
  }
  return null;
}

/** A yes or no, where ctrl-c means no. */
async function yes(prompt: Prompter, question: string): Promise<boolean> {
  try {
    return await prompt.confirm(question);
  } catch (error) {
    if (error instanceof Cancelled) return false;
    throw error;
  }
}

const REVOKE = "Replacing a value here does not revoke the old token: do that wherever it was issued, because fleet cannot.";

export async function rotate(configDir: string, options: RotateOptions): Promise<Result> {
  const home = options.home ?? homedir();
  const { prompt } = options;
  if (prompt === null) return invalid("secrets rotate asks for each new value with hidden input, so it needs a terminal (and no --json); from a script, pipe one value to `fleet secrets set <file> <NAME>`");
  try {
    return await rotating(configDir, home, prompt, options);
  } catch (error) {
    if (error instanceof InvalidConfigError) return invalid(...error.problems);
    if (error instanceof NeedsSecretError) return { code: "needs-secret", messages: [`fleet: ${error.message}`] };
    throw error;
  }
}

async function rotating(configDir: string, home: string, prompt: Prompter, options: RotateOptions): Promise<Result> {
  const sops = findSops(home);
  requireAgeKey(home);
  const waiting = outsideChanges(configDir).filter((l) => l.slice(3).startsWith("secrets/"));
  if (waiting.length > 0) return { code: "conflict", messages: [`fleet: a secrets file has changes that are not committed (${waiting.map((l) => l.slice(3)).join(", ")}): commit or discard them first`] };

  const list = candidates(configDir, options.names ?? [], options.from);
  if (!Array.isArray(list)) return list;
  if (list.length === 0) return { code: "ok", messages: ["fleet: there are no secrets to rotate"], fields: { rotated: [], skipped: [], committed: false, pushed: false } };
  writeSopsConfig(configDir);

  const chosen = (options.names ?? []).length > 0 ? list : await pick(prompt, list);
  const rotated: Rotated[] = [];
  const skipped: string[] = [];
  const unplaced: string[] = [];
  const failed: string[] = [];
  let stopped = false;
  const picked = new Set(chosen);
  for (const c of list) {
    if (!picked.has(c)) {
      // After a removal, what was listed and not picked still needs doing: it is skipped, or has no file to set and only a token to revoke.
      if (options.from !== undefined) (c.files.length === 0 ? unplaced : skipped).push(c.name);
      continue;
    }
    if (stopped) {
      skipped.push(c.name);
      continue;
    }
    if (c.files.length === 0) {
      prompt.say(`${c.name}: no secrets file holds it any more, so there is nothing to set. Revoke it where it was issued.`);
      unplaced.push(c.name);
      continue;
    }
    prompt.say(`\n${c.name}\n  used by: ${c.usedBy.length === 0 ? "no server" : c.usedBy.join(", ")}\n  set in: ${where(c)}`);
    let value: string | null;
    try {
      value = await newValue(prompt, c.name);
    } catch (error) {
      if (!(error instanceof Cancelled)) throw error;
      prompt.say("Stopped. What is set so far is kept.");
      stopped = true;
      skipped.push(c.name);
      continue;
    }
    if (value === null) {
      skipped.push(c.name);
      continue;
    }
    const problem = setEverywhere(configDir, home, sops, c, value);
    value = null;
    if (problem !== null) {
      prompt.say(`fleet: ${c.name} was not changed: ${problem}`);
      failed.push(c.name);
      continue;
    }
    rotated.push({ name: c.name, files: c.files.map(secretsFile) });
    prompt.say(`Set ${c.name} in ${c.files.length} file${c.files.length === 1 ? "" : "s"}.`);
  }

  let committed = false;
  let pushed = false;
  let doctor: string | null = null;
  const messages: string[] = failed.length > 0 ? [`fleet: not changed: ${failed.join(", ")}`] : [];
  const touched = [...new Set(rotated.flatMap((r) => r.files))];
  if (touched.length > 0) {
    const names = rotated.map((r) => r.name).join(", ");
    const staged = runGit(configDir, "add", "--", ...touched);
    const made = staged.ok ? runGit(configDir, "commit", "--quiet", "-m", `Rotate ${rotated.length === 1 ? "secret" : "secrets"} ${names}`, "--", ...touched) : staged;
    if (!made.ok) {
      messages.push(`fleet: the new values are in ${touched.join(", ")} but could not be committed (${(made.stderr || made.stdout).split("\n")[0]}): commit them, then push`);
    } else {
      committed = true;
      if (!stopped && (await yes(prompt, "Push the new values now?"))) {
        const result = await options.push();
        if (result.text !== undefined && result.text.trim() !== "") prompt.say(result.text.trimEnd());
        for (const m of result.messages ?? []) prompt.say(m);
        pushed = result.code === "ok";
        if (pushed && (await yes(prompt, "Run `fleet doctor --all` to check the servers still work with them?"))) {
          const checked = await options.doctor();
          if (checked.text !== undefined && checked.text.trim() !== "") prompt.say(checked.text.trimEnd());
          for (const m of checked.messages ?? []) prompt.say(m);
          doctor = checked.code;
        }
      }
    }
  }

  const lines: string[] = [];
  if (rotated.length > 0) lines.push(`Rotated: ${rotated.map((r) => r.name).join(", ")}.`);
  if (committed) lines.push(pushed ? "The new values are committed and pushed." : "The new values are committed but not pushed: run `fleet push`, then `fleet doctor --all` to check the servers.");
  if (skipped.length > 0) lines.push(`Skipped: ${skipped.join(", ")}. Run \`fleet secrets rotate\` to pick them up.`);
  if (unplaced.length > 0) lines.push(`No secrets file holds: ${unplaced.join(", ")}.`);
  const revoke = [...rotated.map((r) => r.name), ...unplaced];
  lines.push(revoke.length > 0 ? `${REVOKE} Revoke: ${revoke.join(", ")}.` : REVOKE);
  return {
    code: failed.length > 0 ? "error" : "ok",
    text: lines.join("\n"),
    messages,
    fields: { rotated, skipped, unplaced, failed, committed, pushed, doctor },
  };
}
