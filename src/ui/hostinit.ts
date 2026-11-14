import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { applyOps, hostFile, validate } from "../edit/index.ts";
import { EXIT } from "../exit.ts";
import { runGit } from "../git.ts";
import { hostNames } from "../recipients.ts";
import { probedNode } from "../tools.ts";
import { outsideChanges, readFiles } from "./edits.ts";
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

export type HostRequest = { name: string; ssh: string; from: string | null };

/** The name, the ssh destination and the host to copy from a request body, checked: the loader's rule for the name, a strict one for ssh. */
export function hostFields(body: unknown): HostRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequest("the body must be a JSON object");
  const { name, ssh, from } = body as Record<string, unknown>;
  if (typeof name !== "string" || !NAME.test(name) || name.length > 64) throw new BadRequest("name must be letters, digits, '.', '_' or '-', and start with a letter or digit");
  if (typeof ssh !== "string" || ssh.length > 255 || !SSH.test(ssh)) throw new BadRequest("ssh must be a destination such as user@host: no spaces, and not starting with '-'");
  if (from !== undefined && from !== null && (typeof from !== "string" || !NAME.test(from))) throw new BadRequest("from must be the name of a host");
  return { name, ssh, from: typeof from === "string" ? from : null };
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
  if (hostNames(configDir).includes(req.name)) return refuse(409, "exists", `hosts/${req.name}.yaml already exists; run 'fleet init ${req.name}' to set it up again`);
  if (req.from !== null && !hostNames(configDir).includes(req.from)) return refuse(409, "stale", `there is no host '${req.from}' to copy from`);

  const files = readFiles(configDir);
  const made = applyOps(files, [{ op: "addHost", host: req.name, ssh: req.ssh, from: req.from }]);
  if (made.dropped.length > 0) return refuse(409, "stale", made.dropped[0]!.reason);
  const path = hostFile(req.name);
  const head = runGit(configDir, "rev-parse", "HEAD").stdout;
  // `validate` reads the host names from disk, so the file is written first and taken away again if any host would not load.
  writeFileSync(join(configDir, path), made.files[path]!);
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
