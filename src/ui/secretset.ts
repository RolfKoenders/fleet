import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOps, ciphertextProblem, fingerprint, parseSopsText, SECRET_NAME } from "../edit/index.ts";
import type { EditOp } from "../edit/index.ts";
import { hostNames, readRules, renderSopsConfig, secretsFile } from "../recipients.ts";
import { InvalidConfigError } from "../config.ts";
import { NeedsSecretError, findSops, requireAgeKey, runSops } from "../sops.ts";
import { readFiles, secretOpProblem } from "./edits.ts";
import { opsOf } from "./opsof.ts";
import { BadRequest } from "./request.ts";

/**
 * Setting a secret's value from the page. The value arrives once, is handed to sops on stdin inside a private temp dir and
 * is gone when the call returns: the answer holds the encrypted file and nothing else. Nothing here logs, throws or answers
 * with the value or with sops' own words (its stderr can quote the file it was given): every failure is one of the fixed
 * messages below.
 *
 * The file is encrypted where it will not touch the repo: a copy of the host's secrets file (as it would be after the edits
 * the page holds) goes into a `mkdtemp` directory (mode 0700) with a `.sops.yaml` for that one file, `sops set --value-stdin`
 * runs there, the new text is read back and the directory is removed in a `finally`. The result is a held `setSecret` edit.
 */

export const MAX_VALUE = 8192;
const SHARED = "shared";
/** What a value that cannot be set says. The page says the same words before the click (`static/secrets.js`). */
export const VALUE_EMPTY = "Type the value first.";
export const VALUE_LONG = `The value is too long: a value can be at most ${MAX_VALUE} characters.`;
export const VALUE_BLANK = "The value is only spaces: type the value itself.";

export type SetRequest = { name: string; value: string; files: string[]; ops: EditOp[] };
type Refusal = { status: number; code: string; message: string; extra?: Record<string, unknown> };
export type SetOutcome = { refused: Refusal } | { ops: EditOp[]; replaces: string[] };

/**
 * The request body, checked. A message here names the field and never repeats what it held. `files` are the secrets
 * files to set it in: `shared` or the name of a host that has a host file.
 */
export function setRequest(body: unknown, configDir: string): SetRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequest("the body must be a JSON object");
  const { name, value, files } = body as Record<string, unknown>;
  if (typeof name !== "string" || !SECRET_NAME.test(name) || name.length > 100) throw new BadRequest("name must be a secret name such as TRACKER_API_KEY");
  if (typeof value !== "string" || value === "") throw new BadRequest(VALUE_EMPTY);
  if (value.length > MAX_VALUE) throw new BadRequest(VALUE_LONG);
  if (value.trim() === "") throw new BadRequest(VALUE_BLANK);
  const known = new Set([SHARED, ...hostNames(configDir)]);
  if (!Array.isArray(files) || files.length === 0 || files.length > 100 || !files.every((f) => typeof f === "string")) throw new BadRequest("files must be a list of `shared` and host names");
  const unknown = (files as string[]).filter((f) => !known.has(f));
  if (unknown.length > 0) throw new BadRequest("files names something that is neither `shared` nor a host with a host file");
  const ops = opsOf(body);
  return { name, value, files: [...new Set(files as string[])], ops };
}

/** What a failed sops run is called. Chosen from what sops said, never repeating it. */
const sopsFailure = (stderr: string, file: string): string =>
  /no key could decrypt|failed to get the data key|could not decrypt data key/i.test(stderr)
    ? `this machine's age key cannot open ${file}: only a host that is a recipient of it can add to it`
    : `sops could not set the value in ${file}`;

export function setSecret(configDir: string, home: string, req: SetRequest): SetOutcome {
  const refuse = (status: number, code: string, message: string, extra?: Record<string, unknown>): SetOutcome => ({ refused: { status, code, message, ...(extra ? { extra } : {}) } });
  const unfit = secretOpProblem(configDir, req.ops);
  if (unfit !== null) return refuse(422, "invalid", unfit);
  let rules: ReturnType<typeof readRules>;
  try {
    rules = readRules(configDir);
  } catch (error) {
    if (error instanceof InvalidConfigError) return refuse(422, "invalid", `the age recipients of the hosts cannot be read: ${error.problems[0] ?? "invalid config"}`);
    throw error;
  }
  const targets = req.files.map((owner) => ({ owner, rule: rules.find((r) => r.file === owner), path: secretsFile(owner) }));
  const without = targets.find((t) => t.rule === undefined);
  if (without !== undefined) return refuse(422, "no-recipient", `${without.path} cannot be encrypted: ${without.owner === SHARED ? "no host has" : `hosts/${without.owner}.yaml has no`} age recipient`);

  const disk = readFiles(configDir);
  const replayed = applyOps(disk, req.ops);
  const stale = replayed.dropped.filter((d) => d.op.op === "setSecret" && targets.some((t) => t.path === (d.op as { file: string }).file));
  if (stale.length > 0) return refuse(409, "stale", "an edit already waiting to push for this file no longer applies to what is on disk: forget it first", { dropped: replayed.dropped });

  let sops: string;
  try {
    sops = findSops(home);
    requireAgeKey(home);
  } catch (error) {
    if (error instanceof NeedsSecretError) return refuse(422, "needs-secret", error.message);
    throw error;
  }

  const made: EditOp[] = [];
  for (const { rule, path } of targets) {
    const encrypted = encryptInto(sops, home, rule!, path, replayed.files[path], req.name, req.value);
    if ("refused" in encrypted) return refuse(422, encrypted.refused.code, encrypted.refused.message);
    // One held edit per file: it replaces the one held before, and starts from the file as it is on disk.
    const prior = replayed.applied.find((o) => o.op === "setSecret" && o.file === path);
    made.push({
      op: "setSecret",
      file: path,
      names: [...new Set([...(prior?.op === "setSecret" ? prior.names : []), req.name])],
      base: prior?.op === "setSecret" ? prior.base : fingerprint(disk[path]),
      content: encrypted.text,
    });
  }
  return { ops: made, replaces: made.map((o) => (o as { file: string }).file) };
}

/** The file's new text with `name` set to `value`, or why not: a fixed message. */
function encryptInto(sops: string, home: string, rule: { file: string; recipients: string[] }, path: string, current: string | undefined, name: string, value: string): { text: string } | { refused: { code: string; message: string } } {
  const fail = (message: string, code = "sops-failed") => ({ refused: { code, message } });
  // mkdtemp makes the directory with mode 0700; chmod says so again, whatever the umask.
  const dir = mkdtempSync(join(tmpdir(), "fleet-secret-"));
  try {
    chmodSync(dir, 0o700);
    mkdirSync(join(dir, "secrets"), { mode: 0o700 });
    writeFileSync(join(dir, ".sops.yaml"), renderSopsConfig([rule]), { mode: 0o600 });
    let text = current;
    if (text === undefined) {
      const created = runSops(sops, dir, home, ["encrypt", "--filename-override", path, "--input-type", "yaml", "--output-type", "yaml"], "{}\n");
      if (created.status !== 0) return fail(`sops could not create ${path}`);
      text = created.stdout;
    }
    writeFileSync(join(dir, path), text, { mode: 0o600 });
    // sops reads the value as JSON, so it is quoted. It travels on stdin: never argv, never the environment.
    const set = runSops(sops, dir, home, ["set", "--value-stdin", path, JSON.stringify([name])], JSON.stringify(value));
    if (set.status !== 0) return fail(sopsFailure(set.stderr, path));
    const out = readFileSync(join(dir, path), "utf8");
    if (ciphertextProblem(out) !== null || !parseSopsText(out).entries.has(name)) return fail(`sops did not write a usable ${path}`);
    if (parseSopsText(out).recipients.join() !== rule.recipients.join()) return fail(`${path} is not encrypted for the recipients .sops.yaml names for it: run fleet secrets rekey first`, "recipients");
    return { text: out };
  } catch {
    // Not the error itself: nothing that went wrong here may carry the value or sops' words into an answer.
    return fail(`the value could not be encrypted into ${path}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
