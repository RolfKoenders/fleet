import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { applyOps, hostFile, SHARED_HOST, validate } from "../edit/index.ts";
import { EXIT } from "../exit.ts";
import { runGit } from "../git.ts";
import { hostNames } from "../recipients.ts";
import { probedNode } from "../tools.ts";
import { outsideChanges, readFiles } from "./edits.ts";
import { nameLength } from "./opsof.ts";
import { BadRequest } from "./request.ts";

/**
 * Add a host and set it up. This is not a held edit: after the person has confirmed, the server writes `hosts/<name>.yaml`
 * (made by the edit engine, as the loader expects it) and runs the real `fleet init <name>` as a child process, which
 * commits and pushes by itself as it does from the CLI. Whatever the child prints is relayed as it arrives.
 *
 * When init fails the repo is put back as it was before, if init had committed nothing: the host file is deleted and the
 * files init rewrote (`.sops.yaml`, `secrets/`) are restored. When init had already committed (and pushed) its work, the
 * host file stays, because the commit is published and `fleet init <name>` is built to be run again to finish.
 */

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** An ssh destination: `host`, `user@host`, an address. It never starts with `-` (ssh would read an option), and has no space or control character. */
const SSH = /^[A-Za-z0-9_][A-Za-z0-9._@:%+[\]-]*$/;

export const SSH_EMPTY_HOST = "There is no host after the @: a destination such as user@host.";
export const SSH_PORT = "Leave the port out: set Port for this host in ~/.ssh/config, and give only user@host here.";
export const SSH_OPTION = "A destination cannot start with '-': ssh would read it as an option.";
export const SSH_SHAPE = "A destination such as user@host: no spaces or other symbols.";
export const NAME_SHAPE = "Letters, digits, '.', '_' and '-', starting with a letter or digit.";

/** Why an ssh destination is refused, or null. The Add-a-host dialog (`static/hosts.js`) says the same words before the click. */
export function sshProblem(ssh: string): string | null {
  if (ssh.startsWith("-")) return SSH_OPTION;
  if (ssh.length > 255 || !SSH.test(ssh)) return SSH_SHAPE;
  const host = ssh.slice(ssh.lastIndexOf("@") + 1);
  if (host === "") return SSH_EMPTY_HOST;
  // One colon (or `]:`) is a port; several without brackets is an IPv6 address.
  if (/^[^:]+:\d*$/.test(host) || /\]:\d*$/.test(host)) return SSH_PORT;
  return null;
}

/** Why a host name is refused apart from its shape, or null: `shared` is a secrets file, and a name that differs from another only in case is the same file on some disks. */
export function nameClash(name: string, existing: string[]): string | null {
  if (name.toLowerCase() === "shared") return SHARED_HOST;
  const same = existing.find((e) => e.toLowerCase() === name.toLowerCase());
  if (same === undefined) return null;
  return same === name ? `${name} is already a host.` : `${name} is too close to the host ${same}: names are compared without regard to case.`;
}

export type HostRequest = { name: string; ssh: string; from: string | null };

/** The name, the ssh destination and the host to copy from a request body, checked: the loader's rule for the name, a strict one for ssh. */
export function hostFields(body: unknown): HostRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequest("the body must be a JSON object");
  const { name, ssh, from } = body as Record<string, unknown>;
  if (typeof name !== "string" || !NAME.test(name)) throw new BadRequest(NAME_SHAPE);
  const long = nameLength("name", name);
  if (long !== null) throw new BadRequest(`${long}.`);
  const shared = nameClash(name, []);
  if (shared !== null) throw new BadRequest(shared);
  const sshBad = typeof ssh === "string" ? sshProblem(ssh) : SSH_SHAPE;
  if (sshBad !== null) throw new BadRequest(sshBad);
  if (from !== undefined && from !== null && (typeof from !== "string" || !NAME.test(from))) throw new BadRequest("from must be the name of a host");
  return { name, ssh: ssh as string, from: typeof from === "string" ? from : null };
}

/** The request body for setting a host up: its fields, and the confirmation. */
export function hostRequest(body: unknown): HostRequest {
  const request = hostFields(body);
  // The page asks first, naming what will run on the other machine; a call that did not is refused.
  if ((body as Record<string, unknown>).confirm !== true) throw new BadRequest("setting up a host runs commands on it over ssh: it must be confirmed");
  return request;
}

/** The host file `addHost` would write, from the files as they are now. Nothing is written and nothing is run. */
export function previewHost(configDir: string, req: HostRequest): { refused: Refusal } | { doc: { path: string; before: string; after: string } } {
  const names = hostNames(configDir);
  const clash = nameClash(req.name, names);
  if (clash !== null && !names.includes(req.name)) return { refused: { status: 409, code: "exists", message: clash } };
  const made = applyOps(readFiles(configDir), [{ op: "addHost", host: req.name, ssh: req.ssh, from: req.from }]);
  if (made.dropped.length > 0) return { refused: { status: 409, code: "stale", message: made.dropped[0]!.reason } };
  const path = hostFile(req.name);
  return { doc: { path, before: "", after: made.files[path]! } };
}

export type InitDoc = { ok: boolean; code: string; exit: number | null; messages: string[]; written: string; removed: boolean; kept: boolean; output: string[] };

type Refusal = { status: number; code: string; message: string; extra?: Record<string, unknown> };
export type InitOutcome = { refused: Refusal } | { doc: InitDoc };

const codeName = (exit: number | null): string => (exit === null ? "error" : (Object.entries(EXIT).find(([, n]) => n === exit)?.[0] ?? "error"));

/** One line of the child's output as the page may show it: no escape sequence, no control character. */
export const cleanLine = (line: string): string => line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");

/**
 * The caller holds the push lock for the whole of this: init does not take it, and a push must not start under it.
 */
export async function addHost(configDir: string, toolDir: string, home: string, req: HostRequest, onLine: (text: string) => void): Promise<InitOutcome> {
  const refuse = (status: number, code: string, message: string, extra?: Record<string, unknown>): InitOutcome => ({ refused: { status, code, message, ...(extra ? { extra } : {}) } });
  const found = outsideChanges(configDir);
  if (found.length > 0) return refuse(409, "outside-changes", "the config repo has changes the page did not make: commit or discard them first", { outside: found });
  const clash = nameClash(req.name, hostNames(configDir));
  if (clash !== null) return refuse(409, "exists", hostNames(configDir).includes(req.name) ? `hosts/${req.name}.yaml already exists; run 'fleet init ${req.name}' to set it up again` : clash);
  if (req.from !== null && !hostNames(configDir).includes(req.from)) return refuse(409, "stale", `there is no host '${req.from}' to copy from`);

  const files = readFiles(configDir);
  const made = applyOps(files, [{ op: "addHost", host: req.name, ssh: req.ssh, from: req.from }]);
  if (made.dropped.length > 0) return refuse(409, "stale", made.dropped[0]!.reason);
  const path = hostFile(req.name);
  const head = runGit(configDir, "rev-parse", "HEAD").stdout;
  // `validate` reads the host names from disk, so the file is written first and taken away again if any host would not load.
  // `wx` creates it only when nothing is there (on any disk, whatever the case of the name), so a file that is removed
  // below is always one this call made: a failure to create it leaves whatever exists alone.
  try {
    writeFileSync(join(configDir, path), made.files[path]!, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return refuse(409, "exists", `${path} already exists; run 'fleet init ${req.name}' to set it up again`);
  }
  const broken = validate(configDir, {});
  if (broken.length > 0) {
    rmSync(join(configDir, path), { force: true });
    return refuse(422, "invalid", `the config would not load for ${broken.map((f) => f.host).join(", ")}`, { problems: broken });
  }
  const output: string[] = [];
  const say = (text: string) => {
    output.push(text);
    onLine(text);
  };
  const hadSops = existsSync(join(configDir, ".sops.yaml"));
  say(`$ fleet init ${req.name}`);
  const exit = await runChild(toolDir, configDir, home, req.name, say);

  let removed = false;
  let kept = false;
  const messages: string[] = [];
  if (exit !== 0) {
    if (runGit(configDir, "rev-parse", "HEAD").stdout === head) {
      rmSync(join(configDir, path), { force: true });
      runGit(configDir, "reset", "--quiet", "--", path, ".sops.yaml", "secrets");
      runGit(configDir, "checkout", "--quiet", "--", ".sops.yaml", "secrets");
      // A repo that had no .sops.yaml yet gets one from init's rekey: that is init's too.
      if (!hadSops) rmSync(join(configDir, ".sops.yaml"), { force: true });
      removed = !existsSync(join(configDir, path));
      messages.push(`fleet: ${path} was removed again: init had committed nothing, so the repo is as it was`);
      const left = outsideChanges(configDir);
      if (left.length > 0) messages.push(`fleet: the config repo still has changes init made: ${left.join(", ")}`);
    } else {
      kept = true;
      messages.push(`fleet: init had already committed ${path}, so it stays; fix what stopped it, then run 'fleet init ${req.name}' again`);
    }
  }
  return { doc: { ok: exit === 0, code: codeName(exit), exit, messages, written: path, removed, kept, output: output.slice(-200) } };
}

function runChild(toolDir: string, configDir: string, home: string, name: string, onLine: (text: string) => void): Promise<number | null> {
  return new Promise((resolve) => {
    // Its own session, like the push: a Ctrl-C aimed at the page does not stop it half way through a host.
    const child = spawn(join(toolDir, "bin/fleet"), ["init", name], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FLEET_INIT_PROGRESS: "1", FLEET_NODE: probedNode(), FLEET_CONFIG: configDir, HOME: home },
    });
    const pending = { out: "", err: "" };
    const take = (which: "out" | "err") => (chunk: string) => {
      pending[which] += chunk;
      for (let at = pending[which].indexOf("\n"); at >= 0; at = pending[which].indexOf("\n")) {
        onLine(cleanLine(pending[which].slice(0, at)));
        pending[which] = pending[which].slice(at + 1);
      }
    };
    child.stdout.setEncoding("utf8").on("data", take("out"));
    child.stderr.setEncoding("utf8").on("data", take("err"));
    child.once("error", (error) => {
      onLine(`fleet: cannot run fleet init: ${error.message}`);
      resolve(null);
    });
    child.once("close", (code) => {
      for (const rest of [pending.out, pending.err]) if (rest.trim() !== "") onLine(cleanLine(rest));
      resolve(code);
    });
  });
}
