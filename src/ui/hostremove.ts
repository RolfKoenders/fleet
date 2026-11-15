import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostFile, parseSopsText, reviewText } from "../edit/index.ts";
import { InvalidConfigError } from "../config.ts";
import { runGit } from "../git.ts";
import { syncAndPush } from "../push.ts";
import { hostNames, readRules, renderSopsConfig, secretsFile } from "../recipients.ts";
import { parseFile } from "../yamlfile.ts";
import { outsideChanges } from "./edits.ts";
import { codeName, runChild } from "./hostinit.ts";
import type { Refusal } from "./hostinit.ts";
import { BadRequest } from "./request.ts";

/**
 * Remove a host. Like adding one, this is not a held edit: after the person has confirmed, the server deletes `hosts/<name>.yaml` and
 * `secrets/<name>.enc.yaml`, runs the real `fleet secrets rekey` as a child process (so `.sops.yaml` and every secrets file stop naming the
 * host's key), then commits and pushes the config repo. Its output is relayed as it comes.
 *
 * Until the commit, a failure puts everything back as it was. After it, the removal is published work: when only the push failed, the
 * commit stays and the page says so. Nothing is done on the machine itself: it keeps its files, and its timer reports errors until fleet is
 * turned off there. Rekeying does not change a secret's value, so every secret the host could read is still known to it.
 */

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// The words of these refusals are shown by the page too, as the title of a disabled button (`static/removing.js`): a test holds them equal.
export const REMOVE_SELF = (name: string): string => `${name} is the host this page runs on. Open fleet ui on another host to remove it.`;
export const REMOVE_ADMIN = (name: string): string => `${name} is the only admin host (admin: true). Every secrets file is encrypted for its key, so make another host the admin first.`;

/** Why `name` may not be removed, or null. `self` is the host this page runs on. */
export function removeRefusal(configDir: string, self: string | null, name: string): Refusal | null {
  if (!hostNames(configDir).includes(name)) return { status: 409, code: "stale", message: `there is no host '${name}': ${hostFile(name)} does not exist` };
  if (name === self) return { status: 409, code: "self", message: REMOVE_SELF(name) };
  const problems: string[] = [];
  const admins = hostNames(configDir).filter((h) => parseFile(join(configDir, hostFile(h)), false, problems)?.admin === true);
  if (admins.length === 1 && admins[0] === name) return { status: 409, code: "admin", message: REMOVE_ADMIN(name) };
  return null;
}

export type RemoveRequest = { name: string };

/** The name from a request body, checked. */
export function removeFields(body: unknown): RemoveRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequest("the body must be a JSON object");
  const { name } = body as Record<string, unknown>;
  if (typeof name !== "string" || !NAME.test(name) || name.length > 64 || name.toLowerCase() === "shared") throw new BadRequest("name must be the name of a host");
  return { name };
}

/** The request body for removing a host: its name, and the confirmation. */
export function removeRequest(body: unknown): RemoveRequest {
  const request = removeFields(body);
  // The page asks first, naming what will be deleted and what stays; a call that did not is refused.
  if ((body as Record<string, unknown>).confirm !== true) throw new BadRequest("removing a host deletes its files and commits and pushes the config repo: it must be confirmed");
  return request;
}

const read = (configDir: string, path: string): string | undefined => {
  try {
    return readFileSync(join(configDir, path), "utf8");
  } catch {
    return undefined;
  }
};

/** Whether the fleet keeps secrets at all. One that does not has nothing to rekey, and rekey would first ask for keys it does not use. */
function encrypts(configDir: string): boolean {
  if (read(configDir, ".sops.yaml") !== undefined) return true;
  try {
    return readdirSync(join(configDir, "secrets")).some((f) => f.endsWith(".enc.yaml"));
  } catch {
    return false;
  }
}

const secretNames = (text: string | undefined): string[] => (text === undefined ? [] : [...parseSopsText(text).entries.keys()].sort());

export type RemovePreview = {
  name: string;
  ssh: string | null;
  /** Each file removed or rewritten, as it is and as it will be. A secrets file is by its names only, never its ciphertext. */
  files: { path: string; before: string; after: string }[];
  /** Whether `fleet secrets rekey` runs: only when the fleet keeps secrets. */
  rekey: boolean;
  /** The secrets files re-encrypted so that they stop naming the host's key. */
  rekeyed: string[];
  /** The names of the secrets the host could read: those in `shared` (when it has a key) and those in its own file. Never a value. */
  readable: { shared: string[]; own: string[] };
};

/** What removing the host would change, from the files as they are now. Nothing is written or run. */
export function previewRemove(configDir: string, name: string): RemovePreview {
  const problems: string[] = [];
  const doc = parseFile(join(configDir, hostFile(name)), false, problems);
  const age = typeof doc?.age === "string" && doc.age !== "" ? doc.age : null;
  const ownPath = secretsFile(name);
  const own = read(configDir, ownPath);
  const files: RemovePreview["files"] = [{ path: hostFile(name), before: read(configDir, hostFile(name)) ?? "", after: "" }];
  if (own !== undefined) files.push({ path: ownPath, before: reviewText(own), after: "" });

  // `.sops.yaml` as `fleet secrets rekey` will write it: the same rules, without the host's file and its recipient.
  const sops = read(configDir, ".sops.yaml") ?? "";
  try {
    const rules = readRules(configDir)
      .filter((r) => r.file !== name)
      .map((r) => ({ ...r, recipients: r.recipients.filter((x) => x !== age) }));
    const after = renderSopsConfig(rules);
    if (after !== sops) files.push({ path: ".sops.yaml", before: sops, after });
  } catch (error) {
    if (!(error instanceof InvalidConfigError)) throw error;
  }
  const shared = read(configDir, secretsFile("shared"));
  const rekeyed = shared !== undefined && age !== null && parseSopsText(shared).recipients.includes(age) ? [secretsFile("shared")] : [];
  return { name, ssh: typeof doc?.ssh === "string" ? doc.ssh : null, files, rekey: encrypts(configDir), rekeyed, readable: { shared: age === null ? [] : secretNames(shared), own: secretNames(own) } };
}

export type RemoveDoc = { ok: boolean; code: string; exit: number | null; messages: string[]; written: string; removed: boolean; restored: boolean; kept: boolean; output: string[] };
export type RemoveOutcome = { refused: Refusal } | { doc: RemoveDoc };

/** Every file `secrets rekey` or this removal may rewrite, with its text (`undefined`: not there), so a failure can put it back. */
function snapshot(configDir: string, name: string): Map<string, string | undefined> {
  let secrets: string[] = [];
  try {
    secrets = readdirSync(join(configDir, "secrets")).filter((f) => f.endsWith(".enc.yaml")).map((f) => `secrets/${f}`);
  } catch {
    // no secrets yet
  }
  return new Map([hostFile(name), ".sops.yaml", ...secrets].map((path) => [path, read(configDir, path)] as const));
}

/** The caller holds the push lock for the whole of this: rekey does not take it, and a push must not start under it. */
export async function removeHost(configDir: string, toolDir: string, home: string, self: string | null, req: RemoveRequest, onLine: (text: string) => void): Promise<RemoveOutcome> {
  const refuse = (r: Refusal): RemoveOutcome => ({ refused: r });
  const { name } = req;
  const found = outsideChanges(configDir);
  if (found.length > 0) return refuse({ status: 409, code: "outside-changes", message: "the config repo has changes the page did not make: commit or discard them first", extra: { outside: found } });
  const no = removeRefusal(configDir, self, name);
  if (no !== null) return refuse(no);

  const output: string[] = [];
  const say = (text: string) => {
    output.push(text);
    onLine(text);
  };
  const rekey = encrypts(configDir);
  const before = snapshot(configDir, name);
  const path = hostFile(name);
  const restore = (): void => {
    for (const [file, text] of before) {
      if (text === undefined) rmSync(join(configDir, file), { force: true });
      else {
        mkdirSync(dirname(join(configDir, file)), { recursive: true });
        writeFileSync(join(configDir, file), text);
      }
    }
    runGit(configDir, "reset", "--quiet", "--", ...before.keys());
  };
  const failed = (exit: number | null, messages: string[]): RemoveOutcome => {
    restore();
    const left = outsideChanges(configDir);
    return { doc: { ok: false, code: codeName(exit), exit, messages: [...messages, "fleet: the repo is as it was: nothing was committed", ...(left.length > 0 ? [`fleet: the config repo still has changes: ${left.join(", ")}`] : [])], written: path, removed: false, restored: left.length === 0, kept: false, output: output.slice(-200) } };
  };

  say(`$ delete ${path}${before.has(secretsFile(name)) ? ` and ${secretsFile(name)}` : ""}`);
  rmSync(join(configDir, path), { force: true });
  rmSync(join(configDir, secretsFile(name)), { force: true });
  if (rekey) {
    say("$ fleet secrets rekey");
    const exit = await runChild(toolDir, configDir, home, ["secrets", "rekey"], say);
    if (exit !== 0) return failed(exit, [`fleet: fleet secrets rekey did not finish (${exit === null ? "it could not run" : `exit ${exit}`})`]);
  }

  const added = runGit(configDir, "add", "-A");
  if (!added.ok) return failed(null, [`fleet: cannot stage the removal: ${added.stderr.split("\n")[0]}`]);
  say(`$ git commit -m "Remove host ${name}"`);
  const committed = runGit(configDir, "commit", "--quiet", "-m", `Remove host ${name}`);
  if (!committed.ok) return failed(null, [`fleet: cannot commit the removal: ${(committed.stderr || committed.stdout).split("\n")[0]}`]);

  // From here the removal is committed: a failure to publish leaves the commit, and says so.
  const kept = (exitCode: number | null, why: string): RemoveOutcome => ({
    doc: { ok: false, code: codeName(exitCode), exit: exitCode, messages: [`fleet: ${name} is removed and committed, but ${why}`, "fleet: run fleet push from a terminal, or fix what the output names and push again, to publish it"], written: path, removed: true, restored: false, kept: true, output: output.slice(-200) },
  });
  say("$ git push");
  try {
    const conflict = syncAndPush({ dir: configDir, shown: configDir }, []);
    if (conflict !== null) return kept(null, `${conflict.path} ${conflict.detail.replace(`${conflict.path} `, "")}`);
  } catch (error) {
    say(`fleet: ${(error as Error).message}`);
    return kept(null, "it could not be pushed");
  }
  const left = outsideChanges(configDir);
  return { doc: { ok: true, code: "ok", exit: 0, messages: left.length > 0 ? [`fleet: the config repo still has changes: ${left.join(", ")}`] : [], written: path, removed: true, restored: false, kept: false, output: output.slice(-200) } };
}
