// What the Add-a-host dialog needs that is not drawing: the checks on what is typed, the request it makes, the words of the
// confirmation, and the state of the init output that is streamed in. Pure: `node --test` runs it. The server checks
// every field again, with the loader's rule for a name and a stricter one for the ssh destination.

/**
 * @typedef {{ name: string, ssh: string, from: string }} HostForm
 * `from` is the host to copy, or "" for the defaults only.
 * @typedef {{ name: string, ssh: string, from: string | null }} HostBody
 */

import { plain } from "./state.js";

/** The loader's rule for a host name (`src/recipients.ts`). */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** An ssh destination: never starts with `-` (ssh would read it as an option), no space or control character. */
const SSH = /^[A-Za-z0-9_][A-Za-z0-9._@:%+[\]-]*$/;

// The words of these refusals are the server's (`src/ui/hostinit.ts`, `src/edit/ops.ts`): a test holds them equal.
export const NAME_SHAPE = "Letters, digits, '.', '_' and '-', starting with a letter or digit.";
export const NAME_LONG = "the name can be at most 64 characters.";
export const SHARED_HOST = "The name shared is reserved: it names the secrets file every host can read. Pick another name.";
export const SSH_EMPTY_HOST = "There is no host after the @: a destination such as user@host.";
export const SSH_PORT = "Leave the port out: set Port for this host in ~/.ssh/config, and give only user@host here.";
export const SSH_OPTION = "A destination cannot start with '-': ssh would read it as an option.";
export const SSH_SHAPE = "A destination such as user@host: no spaces or other symbols.";

/**
 * Why a host name is refused apart from its shape, or null: `shared` is a secrets file, and a name that differs from another
 * only in case is the same file on some disks (`nameClash` in `src/ui/hostinit.ts`).
 * @param {string} name @param {string[]} existing
 */
export function nameClash(name, existing) {
  if (name.toLowerCase() === "shared") return SHARED_HOST;
  const same = existing.find((e) => e.toLowerCase() === name.toLowerCase());
  if (same === undefined) return null;
  return same === name ? `${name} is already a host.` : `${name} is too close to the host ${same}: names are compared without regard to case.`;
}

/** Why an ssh destination is refused, or null (`sshProblem` in `src/ui/hostinit.ts`). @param {string} ssh */
export function sshProblem(ssh) {
  if (ssh.startsWith("-")) return SSH_OPTION;
  if (ssh.length > 255 || !SSH.test(ssh)) return SSH_SHAPE;
  const host = ssh.slice(ssh.lastIndexOf("@") + 1);
  if (host === "") return SSH_EMPTY_HOST;
  // One colon (or `]:`) is a port; several without brackets is an IPv6 address.
  if (/^[^:]+:\d*$/.test(host) || /\]:\d*$/.test(host)) return SSH_PORT;
  return null;
}

/** Where to send a person whose machine fleet cannot reach over ssh. */
export const SETUP_DOC = "https://github.com/RolfKoenders/fleet/blob/main/docs/setting-up-machines.md";

/** @returns {HostForm} */
export const blankHost = () => ({ name: "", ssh: "", from: "" });

/**
 * The request the form would make, or what is wrong with it. Nothing is said about an empty field the person has not typed in yet.
 * @param {HostForm} form
 * @param {string[]} existing the host names in the config
 * @returns {{ body: HostBody | null, name: string | null, ssh: string | null }}
 */
export function hostDraft(form, existing) {
  const name = form.name.trim();
  const ssh = form.ssh.trim();
  /** @type {string | null} */
  let nameProblem = null;
  if (name !== "") nameProblem = !NAME.test(name) ? NAME_SHAPE : name.length > 64 ? NAME_LONG : nameClash(name, existing);
  /** @type {string | null} */
  const sshBad = ssh === "" ? null : sshProblem(ssh);
  const ok = name !== "" && ssh !== "" && nameProblem === null && sshBad === null && (form.from === "" || existing.includes(form.from));
  return { body: ok ? { name, ssh, from: form.from === "" ? null : form.from } : null, name: nameProblem, ssh: sshBad };
}

/**
 * Why a host cannot be set up while edits are held: `fleet init` commits and pushes by itself, which would sweep the held
 * edits in once they were written. Null when none are held.
 * @param {unknown[]} ops
 */
export const heldProblem = (ops) =>
  ops.length === 0 ? null : `${ops.length} edit${ops.length === 1 ? "" : "s"} to push. fleet init commits and pushes by itself, so push or discard them first.`;

/**
 * What the confirmation says before anything runs.
 * @param {HostBody} body
 */
export const confirmInit = (body) =>
  `This writes hosts/${body.name}.yaml${body.from === null ? "" : ` as a copy of ${body.from}`}, then runs fleet init ${body.name}: it connects to ${body.ssh} over ssh, installs fleet there, makes its age key, re-encrypts your secrets for it, commits and pushes this repo, and installs its timer.`;

/**
 * @typedef {{ running: boolean, name: string | null, lines: string[], end: { ok: boolean, code: string, messages: string[], removed: boolean, kept: boolean } | null }} InitState
 */

const LOG_LINES = 300;

/** @returns {InitState} */
export const idleInit = () => ({ running: false, name: null, lines: [], end: null });

/** The start of a run, before its first line. @param {string} name @returns {InitState} */
export const startInit = (name) => ({ running: true, name, lines: [], end: null });

/** One line of init's output, from the stream. A first line after an end starts a new run. @param {InitState} state @param {any} doc @returns {InitState} */
export function initLine(state, doc) {
  const fresh = state.end !== null ? idleInit() : state;
  const text = typeof doc?.text === "string" ? doc.text : "";
  return { ...fresh, running: true, lines: [...fresh.lines, text].slice(-LOG_LINES) };
}

/** The end of a run: `initend`, or the answer to the request. @param {InitState} state @param {any} doc @returns {InitState} */
export function initEnd(state, doc) {
  return {
    ...state,
    running: false,
    end: {
      ok: doc?.ok === true,
      code: typeof doc?.code === "string" ? doc.code : "error",
      messages: Array.isArray(doc?.messages) ? doc.messages.filter((/** @type {unknown} */ m) => typeof m === "string").map(plain) : [],
      removed: doc?.removed === true,
      kept: doc?.kept === true,
    },
  };
}

/** How long a run has lasted, for "running for 42 s": seconds, then minutes and seconds. @param {number} ms */
export function elapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return total < 60 ? `${total} s` : `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, "0")} s`;
}
