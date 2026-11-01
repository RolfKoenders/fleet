import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { adopt } from "./adopt.ts";
import { agent } from "./agent.ts";
import { apply, diff, failure } from "./apply.ts";
import { InvalidConfigError } from "./config.ts";
import { demo } from "./demo/run.ts";
import { findConfigDir } from "./dirs.ts";
import { readHostName } from "./host.ts";
import { init } from "./init.ts";
import { newConfig } from "./newconfig.ts";
import { push } from "./push.ts";
import { emit, useColor } from "./output.ts";
import type { Relayed, Result, Sink } from "./output.ts";
import { secrets } from "./secretscli.ts";
import { skills } from "./skillsupdate.ts";
import { status, statusAll } from "./status.ts";
import { update } from "./update.ts";

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

type Command = {
  name: string;
  /** The command line `fleet agent` shows after `fleet`. */
  usage: string;
  summary: string;
  /** `read` commands change nothing; `change` ones write to this host, the config repo or other hosts. */
  effect: "read" | "change";
  args: number;
  run?: (ctx: { color: boolean; json: boolean; args: string[]; message: string | undefined; all: boolean; found: FoundConfig }) => Result | Relayed | Promise<Result | Relayed>;
};

const commands: Command[] = [
  { name: "status", usage: "status [--all]", summary: "Report this host: fleet clone, applied state, timer, pending changes, conflicts and tool versions (--all asks every host over ssh)", effect: "read", args: 0, run: ({ color, all, found }) => (all ? statusAll(toolDir, configOf(found), color) : status(toolDir, configOf(found), color)) },
  { name: "diff", usage: "diff", summary: "Show what apply would change, without changing anything", effect: "read", args: 0, run: ({ color, found }) => diff(configOf(found), color) },
  { name: "apply", usage: "apply", summary: "Make this host match its config", effect: "change", args: 0, run: ({ color, json, found }) => apply(toolDir, configOf(found), color, undefined, json ? ["apply", "--json"] : ["apply"]) },
  { name: "push", usage: "push [-m <message>]", summary: "Publish changes to GitHub, then apply on every host (-m sets the commit message)", effect: "change", args: 0, run: ({ color, message, found }) => push(toolDir, configOf(found), message, color) },
  { name: "adopt", usage: "adopt mcp|skill <name>", summary: "Record an existing MCP server or skill as fleet's", effect: "change", args: 2, run: ({ color, args, found }) => adopt(configOf(found), args, color) },
  // Unbounded: `secrets` checks its own arguments, so a value typed by mistake is never echoed back.
  { name: "secrets", usage: "secrets edit <file> | set <file> <NAME> | rekey", summary: "Edit, set or rekey encrypted secrets", effect: "change", args: Infinity, run: ({ args, found }) => secrets(configOf(found), args) },
  { name: "skills", usage: "skills update [<source>]", summary: "Update pinned skill sources", effect: "change", args: 2, run: ({ args, found }) => skills(configOf(found), args) },
  { name: "update", usage: "update", summary: "Move the pinned tool commit in fleet.yaml to the head of its branch (nothing is committed or applied)", effect: "change", args: 0, run: ({ found }) => update(configOf(found)) },
  { name: "new", usage: "new <dir>", summary: "Start a config repo in <dir> from the examples, pinned to this tool commit", effect: "change", args: 1, run: ({ args }) => newConfig(toolDir, args[0]) },
  { name: "init", usage: "init <host>", summary: "Bootstrap a host and install its timer", effect: "change", args: 1, run: ({ color, args, found }) => init(configOf(orCurrentFolder(found)), args[0], color) },
  { name: "demo", usage: "demo", summary: "Try fleet in a throwaway sandbox of made-up hosts; nothing real is touched", effect: "read", args: 0, run: ({ json }) => demo(toolDir, json) },
  { name: "agent", usage: "agent", summary: "Print what an agent needs to know about fleet", effect: "read", args: 0, run: ({ found }) => agent(toolDir, "dir" in found ? found.dir : null, commands) },
  { name: "help", usage: "help", summary: "List the commands", effect: "read", args: 0 },
];

function helpText(): string {
  const width = Math.max(...commands.map((c) => c.name.length));
  const list = commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`).join("\n");
  return `fleet makes each host match its config.

Usage: fleet <command> [options]

Commands:
${list}

Options:
  --json  Print one JSON document on stdout
  --help  Show this list
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
      options: { json: { type: "boolean" }, help: { type: "boolean" }, all: { type: "boolean" }, message: { type: "string", short: "m" } },
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
  if (parsed.values.all && command.name !== "status") return { result: invalid(`--all is only for 'status'`), json };
  if (parsed.values.message === "") return { result: invalid("the commit message after -m cannot be empty"), json };
  if (command.name === "help") return { result: helpResult(), json };
  if (!command.run) return { result: { code: "error", messages: [`fleet: '${name}' is not implemented yet`] }, json };
  return { result: command.run({ color: !json && useColor(process.env, process.stdout.isTTY === true), json, args: rest, message: parsed.values.message, all: parsed.values.all === true, found: findConfigDir() }), json };
}

export async function main(argv: string[], sink: Sink): Promise<number> {
  const json = argv.includes("--json");
  const host = readHostName();
  try {
    return emit(await dispatch(argv).result, host, json, sink);
  } catch (error) {
    return emit(failure(error) ?? { code: "error", messages: [`fleet: ${(error as Error).message}`] }, host, json, sink);
  }
}
