import { homedir } from "node:os";
import { codeName, EXIT } from "./exit.ts";
import type { ExitName } from "./exit.ts";
import { outsideChanges } from "./git.ts";
import { readHostName } from "./host.ts";
import { isHostName, previewRemove, REMOVE_ADMIN, removeHost, removeRefusal } from "./hostremove.ts";
import type { RemoveDoc } from "./hostremove.ts";
import { stopTimerThere } from "./hosttimer.ts";
import type { TimerStep } from "./hosttimer.ts";
import { doctorAll } from "./doctor.ts";
import { LockedError } from "./lock.ts";
import type { Result } from "./output.ts";
import { push, whileHoldingPushLock } from "./push.ts";
import { prompter } from "./prompt.ts";
import type { Prompter, Terminal } from "./prompt.ts";
import { ROTATE, secrets } from "./secretscli.ts";
import { rotate } from "./secretsrotate.ts";
import type { RotateOptions } from "./secretsrotate.ts";

/**
 * `fleet host remove <name>`: what the page's Remove host does (one shared module, `hostremove.ts`), then what only a command can do:
 * stop the removed machine's timer over ssh when it answers and the person agrees, and offer to rotate the secrets the host could read.
 *
 * Without a terminal, or with `--json`, nothing is asked: the command needs `--yes`, which also answers yes to stopping the timer, and
 * does not offer the rotation (it needs a person typing values). The summary names what to rotate instead.
 */

const USAGE = "usage: fleet host remove <name> [--yes]";

export type HostOptions = {
  home?: string;
  yes?: boolean;
  /** Where to ask. Null without a terminal, and with `--json`. */
  terminal?: Terminal | null;
  /** Where the steps of the removal are shown as they happen; nothing for `--json`. */
  log?: (text: string) => void;
  /** For tests: what `fleet push` and `fleet doctor --all` do when the rotation offers them. */
  rotation?: Pick<RotateOptions, "push" | "doctor">;
  toolDir: string;
  color?: boolean;
};

const invalid = (...messages: string[]): Result => ({ code: "invalid", messages: messages.map((m) => `fleet: ${m}`) });

export async function host(configDir: string, args: string[], options: HostOptions): Promise<Result> {
  if (args[0] !== "remove" || args.length !== 2) return invalid(USAGE);
  const name = args[1];
  // The name is never echoed: it may be a secret typed in the wrong place.
  if (!isHostName(name)) return invalid("the name after `remove` must be the name of a host with a file in hosts/");
  const home = options.home ?? homedir();
  const self = readHostName(home);

  const refusal = removeRefusal(configDir, self, name);
  if (refusal !== null) return invalid(refusal.code === "self" ? `${name} is this host: run fleet host remove from another host to remove it` : refusal.code === "admin" ? REMOVE_ADMIN(name) : refusal.message);
  const waiting = outsideChanges(configDir);
  if (waiting.length > 0) return { code: "conflict", messages: [`fleet: the config repo has changes that are not committed (${waiting.map((l) => l.slice(3)).join(", ")}): commit or discard them first`] };

  const terminal = options.terminal ?? null;
  if (terminal === null && options.yes !== true) return invalid(`no terminal to ask on; pass --yes to remove ${name}`);
  const ask: Prompter | null = terminal === null ? null : prompter(terminal);

  const preview = previewRemove(configDir, name);
  const readable = [...new Set([...preview.readable.shared, ...preview.readable.own])];
  if (options.yes !== true && ask !== null) {
    const lines = [
      `Remove host ${name}?`,
      `  Deletes ${preview.files.filter((f) => f.after === "" && !f.path.startsWith(".sops")).map((f) => f.path).join(" and ")}${preview.rekey ? ", re-encrypts the secrets files without its key" : ""}, then commits and pushes the config repo.`,
      readable.length > 0 ? `  It could read these secrets: ${readable.join(", ")}.` : `  It has no key, so it could read no secret.`,
      `  Nothing on ${name} itself changes, except its timer if it answers over ssh and you agree.`,
    ];
    for (const line of lines) ask.say(line);
    if (!(await ask.confirm("Remove it?"))) return { code: "ok", messages: ["fleet: nothing was removed"], fields: { removedHost: null } };
  }

  const log = options.log ?? (() => {});
  let doc: RemoveDoc | null = null;
  let refused: Result | null = null;
  const locked = await whileHoldingPushLock(home, async () => {
    const out = await removeHost(configDir, self, { name }, (say) => rekeyHere(configDir, home, say), log);
    if ("refused" in out) refused = invalid(out.refused.message);
    else doc = out.doc;
    return { code: "ok" };
  });
  if (locked.code === "locked") return locked;
  if (refused !== null) return refused;
  const done = doc as RemoveDoc | null;
  if (done === null) return { code: "error", messages: ["fleet: the removal did not run"] };
  const code = (done.ok ? "ok" : codeName(done.exit)) as ExitName;
  const fields = { removedHost: done.removed ? name : null, committed: done.removed, pushed: done.ok, rekeyed: preview.rekeyed, readable: done.readable, timer: null as TimerStep | null };
  if (!done.removed) return { code, messages: done.messages, fields };

  const timer = await stopTimerThere({ host: name, ssh: done.ssh, home, ask: async (question) => options.yes === true || (ask !== null && ask.confirm(question)) });
  fields.timer = timer;
  const messages = [...done.messages, timer.message];

  let rotation: Result | null = null;
  if (readable.length > 0 && ask !== null && options.yes !== true && (await ask.confirm(`Rotate the ${readable.length} secret${readable.length === 1 ? "" : "s"} ${name} could read now?`, true))) {
    rotation = await rotate(configDir, {
      home,
      prompt: ask,
      from: { host: name, ...done.readable },
      push: options.rotation?.push ?? (() => push(options.toolDir, configDir, undefined, options.color ?? false, home)),
      doctor: options.rotation?.doctor ?? (() => doctorAll(configDir, options.color ?? false, undefined, home)),
    });
  }

  const lines = [
    done.ok ? `Removed host ${name}: its files are deleted${preview.rekey ? " and the secrets files no longer name its key" : ""}, and the removal is committed and pushed.` : `Removed host ${name} and committed it, but it is not pushed: run \`fleet push\`.`,
    ...(readable.length > 0
      ? [
          `${name} could read these secrets: ${readable.join(", ")}.`,
          ...(rotation === null ? [`Rekeying does not change a value, and each token still works wherever it was issued. Replace them with \`fleet secrets rotate\`, then revoke the old tokens: fleet cannot.`] : []),
        ]
      : [`${name} had no key, so it could read no secret.`]),
    ...(rotation?.text === undefined ? [] : [rotation.text]),
  ];
  return {
    code: rotation !== null && rotation.code !== "ok" ? rotation.code : code,
    text: lines.join("\n"),
    messages: [...messages, ...(rotation?.messages ?? [])],
    fields: { ...fields, rotation: rotation?.fields ?? null },
  };
}

/** `fleet secrets rekey` in this process, with its lines relayed. The exit code a child would have had. */
async function rekeyHere(configDir: string, home: string, say: (text: string) => void): Promise<number | null> {
  try {
    const r = await secrets(configDir, ["rekey"], home);
    for (const line of (r.text ?? "").split("\n")) if (line !== "") say(line);
    for (const m of r.messages ?? []) if (m !== ROTATE) say(m);
    return EXIT[r.code];
  } catch (error) {
    if (error instanceof LockedError) return EXIT.locked;
    say(`fleet: ${(error as Error).message}`);
    return null;
  }
}
