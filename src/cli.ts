import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { adopt } from "./adopt.ts";
import { agent } from "./agent.ts";
import { apply, diff, failure } from "./apply.ts";
import { card } from "./card/command.ts";
import { contextAll } from "./contextall.ts";
import { context } from "./contextcmd.ts";
import { bridge } from "./tui/bridge.ts";
import { viewNames } from "./tui/start.ts";
import { InvalidConfigError } from "./config.ts";
import { demo } from "./demo/run.ts";
import { eventsOn, ignoreBrokenPipes } from "./events.ts";
import { doctor, doctorAll, DEFAULT_TIMEOUT_SECONDS } from "./doctor.ts";
import { findConfigDir } from "./dirs.ts";
import { readHostName } from "./host.ts";
import { init } from "./init.ts";
import { newConfig } from "./newconfig.ts";
import { push } from "./push.ts";
import { progressFor } from "./pushview.ts";
import { emit, useColor } from "./output.ts";
import type { Relayed, Result, Sink } from "./output.ts";
import { secrets } from "./secretscli.ts";
import { skills } from "./skillsupdate.ts";
import { status, statusAll, statusConflicts } from "./status.ts";
import { undo } from "./undo.ts";
import { update } from "./update.ts";
import { ui } from "./ui/command.ts";

/** The code that is running; the config repo is elsewhere. */
const toolDir = join(import.meta.dirname, "..");

type FoundConfig = ReturnType<typeof findConfigDir>;

/** Before a machine has a config set, `fleet init` takes it from the folder it runs in. */
function orCurrentFolder(found: FoundConfig): FoundConfig {
  return "problem" in found && existsSync(join(process.cwd(), "fleet.yaml")) ? { dir: process.cwd() } : found;
}

function configOf(found: FoundConfig): string {
  if ("problem" in found) throw new InvalidConfigError([found.problem]);
  return found.dir;
}

/** One option of one command. `flag` is as `fleet help` shows it; `summary` starts in lower case and has no full stop, so `fleet help` can join the clauses of a flag several commands share. */
export type CommandOption = { flag: string; summary: string };

/** The options that mean the same on every command. */
export const GLOBAL_OPTIONS: CommandOption[] = [
  { flag: "--json", summary: "Print one JSON document on stdout" },
  { flag: "--help", summary: "Show this list" },
];

export type Command = {
  name: string;
  /** The command line `fleet agent` shows after `fleet`. */
  usage: string;
  summary: string;
  /** `read` commands change nothing; `change` ones write to this host, the config repo or other hosts, or run code the catalog names (`doctor`). */
  effect: "read" | "change";
  /** The options this command takes, besides the global ones. The command-line checks in `dispatch` enforce which command takes which. */
  options?: CommandOption[];
  /** What `--json` adds to the fields every document has (`ok`, `code`, `host`, `messages`), in markdown, or null for a command with no `--json` form. */
  json: string | null;
  /** False for a command `fleet agent` does not teach: an agent has no use for it. */
  agent?: false;
  args: number;
  run?: (ctx: { color: boolean; json: boolean; args: string[]; message: string | undefined; all: boolean; conflicts: boolean; shell: boolean; review: boolean; yes: boolean; noPush: boolean; timeout: number | undefined; view: string | undefined; host: string | undefined; port: number | undefined; open: boolean; style: string | undefined; names: boolean; badge: boolean; found: FoundConfig }) => Result | Relayed | Promise<Result | Relayed>;
};

export const commands: Command[] = [
  { name: "status", usage: "status [--all | --conflicts]", summary: "Report this host: fleet clone, applied state, timer, pending changes, conflicts and tool versions (--all asks every host over ssh; --conflicts lists this host's conflicts in full, reading only)", effect: "read", options: [{ flag: "--all", summary: "ask every host over ssh" }, { flag: "--conflicts", summary: "list this host's conflicts in full, reading only" }], json: "Adds `repos`, `applied`, `timer`, `schedule`, `pending`, `conflicts`, `conflictList`, `agents`, `notInstalled` and `tools`. With `--all`, also `hosts`: one record for each host, with its `result` and its `status`. With `--conflicts`, only `conflicts`: a list of `{kind, path, detail, fix}`.", args: 0, run: ({ color, all, conflicts, found }) => (all ? statusAll(toolDir, configOf(found), color) : conflicts ? statusConflicts(configOf(found), color) : status(toolDir, configOf(found), color)) },
  { name: "doctor", usage: "doctor [--all] [--timeout <seconds>]", summary: "Start this host's MCP servers and ask each what it offers and how large its tool definitions are (saved as this host's doctor result), plus cheap local checks (--all asks every host over ssh). It runs the catalog's commands with real credentials and may make npx download packages, so it runs only when you ask for it, never from the timer", effect: "change", options: [{ flag: "--all", summary: "ask every host over ssh" }, { flag: "--timeout <seconds>", summary: `give each MCP server this long to answer, from just above 0 to 600 (default ${DEFAULT_TIMEOUT_SECONDS})` }], json: "Adds `checks` and `servers`. With `--all`, also `hosts`: one record for each host, with its `result` and its `doctor` fields.", args: 0, run: ({ color, all, timeout, found }) => (all ? doctorAll(configOf(found), color, timeout) : doctor(configOf(found), color, timeout)) },
  { name: "context", usage: "context [--all]", summary: "Show how much each agent on this host loads before the first prompt (instructions, skill descriptions, MCP tool definitions), as bars and an estimate in tokens, with the largest items (--all asks every host over ssh and draws all bars on one scale). MCP sizes are the ones the last doctor run saved; it starts no server and reads no secret", effect: "read", options: [{ flag: "--all", summary: "ask every host over ssh" }], json: "Adds `agents` and `notes`. With `--all`, also `hosts`: one record for each host.", args: 0, run: ({ color, all, found }) => (all ? contextAll(configOf(found), color) : context("dir" in found ? found.dir : null, color)) },
  { name: "diff", usage: "diff", summary: "Show what apply would change, without changing anything", effect: "read", json: "Adds `created`, `updated`, `removed`, `forgotten`, `unchanged`, `warnings`, `conflicts` and `timer`. They list what apply would do.", args: 0, run: ({ color, found }) => diff(configOf(found), color) },
  { name: "bridge", usage: "bridge [--view <screen>] [--host <name>]", summary: "Open the full-screen view of every host, the matrix of what each gets, conflicts, timeline, secrets and catalog (--view opens on a screen, --host selects a host on it). It reads until you ask for more: P pushes after you type push, d runs doctor after you confirm (it starts real MCP servers). Needs a terminal", effect: "change", options: [{ flag: "--view <name>", summary: `open on this screen (${viewNames().join(", ")})` }, { flag: "--host <name>", summary: "select this host on that screen" }], json: null, args: 0, run: ({ json, view, host, found }) => bridge(toolDir, () => configOf(found), json, process.env, undefined, { view, host }) },
  { name: "ui", usage: "ui [--port <n>] [--no-open]", summary: "Open a page in your browser that shows this host and can push, served from this process on 127.0.0.1 and guarded by a random token in the URL it prints. It stops on ctrl-c, or after 10 minutes with no page open. Not for agents; no --json", effect: "change", options: [{ flag: "--port <n>", summary: "listen on this port (default: a free one)" }, { flag: "--no-open", summary: "print the URL and do not open a browser" }], json: null, agent: false, args: 0, run: ({ json, port, open, found }) => ui({ toolDir, configDir: () => configOf(found), home: homedir(), json, port, open, signal: interrupted() }) },
  { name: "card", usage: "card [--style machines|map] [--names] [--badge]", summary: "Write fleet-card.svg (1200 x 630) here: an image of your fleet to share, with its counts, each host with its agents and OS, and a year of changes. Hosts are named host 1, host 2 unless --names; no server, skill, source or secret name is ever on it. --style picks machines (the default) or map; --badge writes a small fleet-badge.svg for a README instead. It reads what fleet last saw of each host and asks none", effect: "change", options: [{ flag: "--style <name>", summary: "machines (default) or map" }, { flag: "--names", summary: "show the real hostnames, not host 1, host 2" }, { flag: "--badge", summary: "write fleet-badge.svg, a small badge for a README" }], json: "Adds `file`, `style`, `names`, `machines`, `agents`, `skills`, `mcpServers`, `changes`, `pushes`, `since` and `grid`.", agent: false, args: 0, run: ({ color, style, names, badge, found }) => card(configOf(found), { dir: process.cwd(), style, names, badge, color, home: homedir() }) },
  { name: "apply", usage: "apply", summary: "Make this host match its config", effect: "change", json: "Adds `created`, `updated`, `removed`, `forgotten`, `unchanged`, `warnings`, `conflicts` and `timer`.", args: 0, run: ({ color, json, found }) => apply(toolDir, configOf(found), color, undefined, json ? ["apply", "--json"] : ["apply"]) },
  { name: "push", usage: "push [-m <message>] [--host <name>]", summary: "Publish changes to GitHub, then apply on every host (-m sets the commit message; --host applies only on that host: this one or one with an ssh destination, after publishing as usual)", effect: "change", options: [{ flag: "-m <message>", summary: "set the commit message" }, { flag: "--host <name>", summary: "apply only on this host" }], json: "Adds `hosts`: one entry for each host, with its `result`, `changes`, `conflicts`, `created`, `updated` and `removed`. A conflict on this host also adds a top-level `conflicts`.", args: 0, run: ({ color, message, host, found }) => push(toolDir, configOf(found), message, color, undefined, progressFor(process.env, process.stderr), host) },
  { name: "undo", usage: "undo [--no-push] [--yes] [<commit>]", summary: "Revert the last recorded push, or a named one, and push the revert to the same scope (--no-push stops after the revert commit; --yes skips the prompt)", effect: "change", options: [{ flag: "--no-push", summary: "stop after the revert commit" }, { flag: "--yes", summary: "skip the prompt" }], json: "Adds `commit` (the push that was reverted), `reverted` and `pushed`. When the revert was pushed, also the push's `hosts`.", args: 1, run: ({ color, json, args, yes, noPush, found }) => undo(toolDir, configOf(found), args, { noPush, yes, color, json, terminal: !json && process.stdin.isTTY === true && process.stdout.isTTY === true ? { stdin: process.stdin, stdout: process.stdout } : null }) },
  { name: "adopt", usage: "adopt mcp|skill <name>", summary: "Record an existing MCP server or skill as fleet's", effect: "change", json: "Adds `adopted`, `left` and `conflicts`.", args: 2, run: ({ color, args, found }) => adopt(configOf(found), args, color) },
  // Unbounded: `secrets` checks its own arguments, so a value typed by mistake is never echoed back.
  { name: "secrets", usage: "secrets edit <file> | set <file> <NAME> | rekey", summary: "Edit, set or rekey encrypted secrets", effect: "change", json: "`rekey` adds `rekeyed`, the secrets files that were updated. `edit` and `set` add nothing.", args: Infinity, run: ({ args, found }) => secrets(configOf(found), args) },
  { name: "skills", usage: "skills update [--review] [--yes] [<source>]", summary: "Move pinned skill sources to the head of their branch (--review shows what changed first, with anything risky flagged, and asks per source on a terminal; without one nothing moves unless --yes)", effect: "change", options: [{ flag: "--review", summary: "show what changed first, with anything risky flagged, and ask per source on a terminal" }, { flag: "--yes", summary: "move the pins without asking" }], json: "Adds `updated` and `unchanged`: the sources that moved and the ones that did not. With `--review`, also `reviews`.", args: 2, run: ({ color, json, args, review, yes, found }) => skills(configOf(found), args, { review, yes, color, terminal: !json && process.stdin.isTTY === true && process.stdout.isTTY === true ? { stdin: process.stdin, stdout: process.stdout } : null }) },
  { name: "update", usage: "update", summary: "Move the pinned tool commit in fleet.yaml to the newest release, or to the head of its branch when track names one (nothing is committed or applied)", effect: "change", json: "Adds `repo`, `track`, `from`, `to`, `updated` and `changes`, plus `release` when `track` is `releases`.", args: 0, run: ({ found }) => update(configOf(found)) },
  { name: "new", usage: "new <dir>", summary: "Start a config repo in <dir> from the examples, pinned to this tool commit", effect: "change", json: "Adds `dir`, `pin` and `checklist`.", args: 1, run: ({ args }) => newConfig(toolDir, args[0]) },
  { name: "init", usage: "init <host>", summary: "Bootstrap a host and install its timer", effect: "change", json: "Adds what `apply` adds, plus `steps`, `checklist`, `missingSecrets`, `conflicts`, `recipient` and, when it made one, `backup`: the new age key.", args: 1, run: ({ color, args, found }) => init(configOf(orCurrentFolder(found)), args[0], color) },
  { name: "demo", usage: "demo [--shell]", summary: "Try the bridge on made-up hosts in a throwaway sandbox; nothing real is touched (--shell gives a shell in the sandbox instead, with a printed tour). Without a terminal, or with --json, it walks the tour itself", effect: "read", options: [{ flag: "--shell", summary: "give a shell in the sandbox instead, with a printed tour" }], json: "Adds `sandbox` and `steps`.", args: 0, run: ({ json, shell }) => demo(toolDir, json, shell) },
  { name: "agent", usage: "agent", summary: "Print what an agent needs to know about fleet", effect: "read", json: "Adds `markdown` (the primer), `recipes` and `status`.", args: 0, run: ({ found }) => agent(toolDir, "dir" in found ? found.dir : null, commands.filter((c) => c.agent !== false)) },
  { name: "help", usage: "help", summary: "List the commands", effect: "read", json: "Adds `commands`: the name and summary of each command.", args: 0 },
];

/** Aborts on ctrl-c or a terminate, for a command that runs until it is stopped. */
function interrupted(): AbortSignal {
  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => controller.abort());
  return controller.signal;
}

/** `'a'`, `'a' and 'b'`, `'a', 'b' and 'c'`. */
const quoted = (names: string[]) => {
  const q = names.map((n) => `'${n}'`);
  return q.length === 1 ? q[0]! : `${q.slice(0, -1).join(", ")} and ${q.at(-1)}`;
};

/**
 * The option lines of `fleet help`: the global options, then each command's, in command order. A flag
 * several commands take is one line; commands that explain it the same way share a clause.
 */
function optionLines(): { flag: string; text: string }[] {
  const lines = GLOBAL_OPTIONS.map(({ flag, summary }) => ({ flag, text: summary }));
  const byFlag = new Map<string, Map<string, string[]>>();
  for (const c of commands) {
    for (const o of c.options ?? []) {
      const clauses = byFlag.get(o.flag) ?? new Map<string, string[]>();
      clauses.set(o.summary, [...(clauses.get(o.summary) ?? []), c.name]);
      byFlag.set(o.flag, clauses);
    }
  }
  for (const [flag, clauses] of byFlag) {
    lines.push({ flag, text: [...clauses].map(([summary, names]) => `With ${quoted(names)}: ${summary}`).join(". ") });
  }
  return lines;
}

function helpText(): string {
  const width = Math.max(...commands.map((c) => c.name.length));
  const list = commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`).join("\n");
  const options = optionLines();
  const flagWidth = Math.max(...options.map((o) => o.flag.length));
  return `fleet makes each host match its config.

Usage: fleet <command> [options]

Commands:
${list}

Run 'fleet bridge' for the full-screen view of every host.

Options:
${options.map((o) => `  ${o.flag.padEnd(flagWidth)}  ${o.text}`).join("\n")}
`;
}

function helpResult(): Result {
  return {
    code: "ok",
    text: helpText(),
    fields: { commands: commands.map(({ name, summary }) => ({ name, summary })) },
  };
}

function invalid(message: string): Result {
  return { code: "invalid", messages: [`fleet: ${message}. Run 'fleet help' for the commands.`] };
}

function dispatch(argv: string[]): { result: Promise<Result | Relayed> | Result | Relayed; json: boolean } {
  const json = argv.includes("--json");
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { json: { type: "boolean" }, help: { type: "boolean" }, all: { type: "boolean" }, conflicts: { type: "boolean" }, shell: { type: "boolean" }, review: { type: "boolean" }, yes: { type: "boolean" }, "no-push": { type: "boolean" }, timeout: { type: "string" }, view: { type: "string" }, host: { type: "string" }, port: { type: "string" }, "no-open": { type: "boolean" }, style: { type: "string" }, names: { type: "boolean" }, badge: { type: "boolean" }, message: { type: "string", short: "m" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    // `fleet secrets` may have been given a value by mistake, so its bad options are never quoted.
    const reason = argv[0] === "secrets" ? "bad option" : ((error as Error).message.split(". ")[0] ?? "bad arguments");
    return { result: invalid(reason), json };
  }

  const [name, ...rest] = parsed.positionals;
  if (parsed.values.help || name === undefined) return { result: helpResult(), json };

  const command = commands.find((c) => c.name === name);
  if (!command) return { result: invalid(`unknown command '${name}'`), json };
  if (rest.length > command.args) return { result: invalid(`unexpected argument '${rest[command.args]}'`), json };
  if (parsed.values.message !== undefined && command.name !== "push") return { result: invalid(`-m is only for 'push'`), json };
  if (parsed.values.all && command.name !== "status" && command.name !== "doctor" && command.name !== "context") return { result: invalid(`--all is only for 'status', 'doctor' and 'context'`), json };
  if (parsed.values.conflicts && command.name !== "status") return { result: invalid(`--conflicts is only for 'status'`), json };
  if (parsed.values.conflicts && parsed.values.all) return { result: invalid(`--conflicts and --all cannot be used together`), json };
  if (parsed.values.shell && command.name !== "demo") return { result: invalid(`--shell is only for 'demo'`), json };
  if ((parsed.values.review || parsed.values.yes) && command.name !== "skills" && command.name !== "undo") return { result: invalid(`--review and --yes are only for 'skills update' and 'undo'`), json };
  if (parsed.values["no-push"] && command.name !== "undo") return { result: invalid(`--no-push is only for 'undo'`), json };
  if (parsed.values.timeout !== undefined && command.name !== "doctor") return { result: invalid(`--timeout is only for 'doctor'`), json };
  if (parsed.values.view !== undefined && command.name !== "bridge") return { result: invalid(`--view is only for 'bridge'`), json };
  if (parsed.values.host !== undefined && command.name !== "bridge" && command.name !== "push") return { result: invalid(`--host is only for 'bridge' and 'push'`), json };
  if ((parsed.values.port !== undefined || parsed.values["no-open"]) && command.name !== "ui") return { result: invalid(`--port and --no-open are only for 'ui'`), json };
  if ((parsed.values.style !== undefined || parsed.values.names || parsed.values.badge) && command.name !== "card") return { result: invalid(`--style, --names and --badge are only for 'card'`), json };
  const port = parsed.values.port === undefined ? undefined : Number(parsed.values.port);
  if (port !== undefined && !(/^\d+$/.test(parsed.values.port!) && port >= 1 && port <= 65535)) return { result: invalid("--port must be a number from 1 to 65535"), json };
  const timeout = parsed.values.timeout === undefined ? undefined : Number(parsed.values.timeout);
  if (timeout !== undefined && !(/^\d+(\.\d+)?$/.test(parsed.values.timeout!) && timeout > 0 && timeout <= 600)) return { result: invalid(`--timeout must be a number of seconds from just above 0 to 600 (default ${DEFAULT_TIMEOUT_SECONDS})`), json };
  if (parsed.values.message === "") return { result: invalid("the commit message after -m cannot be empty"), json };
  if (command.name === "help") return { result: helpResult(), json };
  if (!command.run) return { result: { code: "error", messages: [`fleet: '${name}' is not implemented yet`] }, json };
  return { result: command.run({ color: !json && useColor(process.env, process.stdout.isTTY === true), json, args: rest, message: parsed.values.message, all: parsed.values.all === true, conflicts: parsed.values.conflicts === true, shell: parsed.values.shell === true, review: parsed.values.review === true, yes: parsed.values.yes === true, noPush: parsed.values["no-push"] === true, timeout, view: parsed.values.view, host: parsed.values.host, port, open: parsed.values["no-open"] !== true, style: parsed.values.style, names: parsed.values.names === true, badge: parsed.values.badge === true, found: findConfigDir() }), json };
}

export async function main(argv: string[], sink: Sink): Promise<number> {
  if (eventsOn()) ignoreBrokenPipes();
  const json = argv.includes("--json");
  const host = readHostName();
  try {
    return emit(await dispatch(argv).result, host, json, sink, eventsOn());
  } catch (error) {
    return emit(failure(error) ?? { code: "error", messages: [`fleet: ${(error as Error).message}`] }, host, json, sink, eventsOn());
  }
}
