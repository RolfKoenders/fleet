// What the Add-a-host form needs that is not drawing: the checks on what is typed, the request it makes, the words of the
// confirmation, and the state of the init output that is streamed in. Pure: `node --test` runs it. The server checks
// every field again, with the loader's rule for a name and a stricter one for the ssh destination.

/**
 * @typedef {{ name: string, ssh: string, from: string }} HostForm
 * `from` is the host to copy, or "" for the defaults only.
 * @typedef {{ name: string, ssh: string, from: string | null }} HostBody
 */

/** The loader's rule for a host name (`src/recipients.ts`). */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** An ssh destination: never starts with `-` (ssh would read it as an option), no space or control character. */
const SSH = /^[A-Za-z0-9_][A-Za-z0-9._@:%+[\]-]*$/;

/** Where to send a person whose machine fleet cannot reach over ssh. */
export const SETUP_DOC = "https://github.com/RolfKoenders/fleet/blob/main/docs/setting-up-machines.md";

/** What `fleet init` takes from the host it copies. Never `ssh`, `age` or `files`. */
export const COPIED = ["bundles", "exclude", "mcp", "settings", "vars"];

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
  if (name !== "") {
    if (name.length > 64 || !NAME.test(name)) nameProblem = "Letters, digits, '.', '_' and '-', starting with a letter or digit.";
    else if (existing.includes(name)) nameProblem = `${name} is already a host.`;
  }
  /** @type {string | null} */
  let sshProblem = null;
  if (ssh !== "" && (ssh.length > 255 || !SSH.test(ssh))) sshProblem = ssh.startsWith("-") ? "A destination cannot start with '-': ssh would read it as an option." : "A destination such as user@host: no spaces or other symbols.";
  const ok = name !== "" && ssh !== "" && nameProblem === null && sshProblem === null && (form.from === "" || existing.includes(form.from));
  return { body: ok ? { name, ssh, from: form.from === "" ? null : form.from } : null, name: nameProblem, ssh: sshProblem };
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

/** What the host file will start with, shown beside the form. @param {HostBody} body */
export const fileLines = (body) => [`ssh: ${body.ssh}`, 'age: ""', ...(body.from === null ? [] : COPIED.map((k) => `${k}: (as in ${body.from}, if it has one)`))];

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
      messages: Array.isArray(doc?.messages) ? doc.messages.filter((/** @type {unknown} */ m) => typeof m === "string") : [],
      removed: doc?.removed === true,
      kept: doc?.kept === true,
    },
  };
}
