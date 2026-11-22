import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { failure } from "./apply.ts";
import { agentsOnHost } from "./hostagents.ts";
import { readHostName } from "./host.ts";
import { push, whileHoldingPushLock } from "./push.ts";
import { paint } from "./output.ts";
import type { Result } from "./output.ts";
import type { PromptIO } from "./undo.ts";
import type { Progress } from "./pushview.ts";
import { commitCapture, outsideProblem } from "./capture/commit.ts";
import type { Taken } from "./capture/commit.ts";
import { secretNameProblem } from "./capture/names.ts";
import { build, defaultDecision, defaultMcpChoice, keyRows, takenSecrets } from "./capture/plan.ts";
import type { Built, Decision, McpChoice, Scope, SecretPick } from "./capture/plan.ts";
import { scanMachine } from "./capture/scan.ts";
import type { Item, McpItem, Scan, SkillItem } from "./capture/scan.ts";
import { differsLine, scanView, viewOf } from "./capture/view.ts";
import type { McpView } from "./capture/view.ts";
import type { EditOp } from "./edit/index.ts";
import type { StagedSkills } from "./ui/edits.ts";
import { WriteRefused } from "./ui/edits.ts";
import { having } from "./agents/index.ts";
import type { AgentId } from "./agents/index.ts";
import { sourceNameOf } from "./capture/names.ts";

/**
 * `fleet capture`: turns what this machine has (MCP servers an agent was told about, skill folders copied in) into config. It reads
 * only this machine. On a terminal it asks about each item; `capture mcp|skill <name> --host|--all|--ignore` answers for one item;
 * without a terminal it reports what it found, and writes only for `--yes` (every item the way the defaults say) or a named item.
 * It never prints a value of an env variable or a header: a secret goes to sops, one value at a time.
 */

const USAGE = "usage: fleet capture [mcp|skill <name> --host|--all|--ignore] [--yes] [--no-push]";

export type CaptureOptions = {
  /** The answer for the named item: add for this host, add for every host, or ignore. */
  host?: boolean;
  all?: boolean;
  ignore?: boolean;
  /** Take the defaults for every item, and push without asking. */
  yes?: boolean;
  /** Stop after the commit. */
  noPush?: boolean;
  json?: boolean;
  color?: boolean;
  /** For tests. */
  home?: string;
  /** Null when there is no terminal. */
  terminal?: PromptIO | null;
  progress?: Progress | null;
};

const invalid = (message: string): Result => ({ code: "invalid", messages: [`fleet: ${message}`] });

type Chosen = { decision: Decision; built: Built; scope: Scope | null };

const itemName = (item: { kind: string; name: string }): string => `${item.kind}:${item.name}`;

// ---- the report ----

function reportLines(scan: Scan, color: boolean): string[] {
  const lines = scan.items.map((i) => {
    const what = i.state === "new" ? "not in the catalog" : i.state === "takeover" ? "matches the config, take it over" : i.state === "catalog" ? "matches the catalog entry, not picked by this host" : "cannot be captured";
    const where = i.kind === "mcp" ? i.agents.join(", ") : i.path;
    return `${i.kind === "mcp" ? "mcp  " : "skill"} ${i.name}  ${what}  (${where})${i.message === null ? "" : `: ${i.message}`}`;
  });
  const differs = differsLine(scan.differs);
  return [...(lines.length === 0 ? ["Nothing on this machine is missing from the config."] : lines), ...(differs === null ? [] : [paint(color, "yellow", differs)])];
}

function report(host: string, scan: Scan, taken: ReadonlySet<string>, color: boolean, how: string): Result {
  const view = scanView(scan, taken);
  const hint = scan.items.length === 0 ? [] : [how];
  return {
    code: "ok",
    text: [...reportLines(scan, color), ...hint].join("\n"),
    messages: scan.notes.map((n) => `fleet: ${n}`),
    fields: { items: view.items, differs: view.differs, unmanaged: scan.items.length + scan.differs.length, notes: view.notes },
  };
}

// ---- asking ----

/** Answers from a terminal, one line at a time. Null is the end of the input. */
type Prompter = { ask(question: string): Promise<string | null>; say(text: string): void; close(): void };

function prompter(io: PromptIO): Prompter {
  const rl = createInterface({ input: io.stdin as NodeJS.ReadableStream, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(question) {
      io.stdout.write(question);
      const next = await lines.next();
      return next.done === true ? null : next.value.trim();
    },
    say: (text) => void io.stdout.write(`${text}\n`),
    close: () => rl.close(),
  };
}

/** Asks until the answer is one of `keys` (the first letter of each word), or the empty answer when `fallback` allows it. Null when the input ends. */
async function choose(p: Prompter, question: string, keys: string, fallback: string | null): Promise<string | null> {
  for (;;) {
    const answer = await p.ask(question);
    if (answer === null) return null;
    const key = answer.toLowerCase().slice(0, 1);
    if (key === "" && fallback !== null) return fallback;
    if (keys.includes(key) && key !== "") return key;
    p.say(`Answer with one of ${[...keys].join(", ")}.`);
  }
}

const columns = (left: string[], right: string[], width = 38): string[] => Array.from({ length: Math.max(left.length, right.length) }, (_, i) => `  ${(left[i] ?? "").padEnd(width)}  ${right[i] ?? ""}`.trimEnd());

/** One definition as lines, with no value of its env or headers. */
function definitionLines(v: McpView["variants"][number], head: string): string[] {
  const lines = [head];
  if (v.command !== null) lines.push(`command: ${v.command.join(" ")}`);
  else lines.push(`${v.transport ?? "http"}: ${v.url ?? ""}`);
  const names = v.keys.map((k) => `${k.key}${k.secret ? " (secret)" : ""}`);
  if (names.length > 0) lines.push(`${v.command !== null ? "env" : "headers"}: ${names.join(", ")}`);
  if (v.warning !== null) lines.push("not pinned to a version");
  return lines;
}

function describe(p: Prompter, item: Item, taken: ReadonlySet<string>): void {
  const view = viewOf(item, taken);
  if (view.kind === "skill") {
    p.say(`\nskill ${view.name}  ${view.path}`);
    if (view.repo !== null) p.say(`  in ${view.repo.repo} at ${view.repo.commit.slice(0, 7)} (${view.repo.track})${view.repo.dirty ? ", with changes that are not committed: capture takes the committed state" : ""}`);
    return;
  }
  p.say(`\nmcp ${item.name}  in ${view.variants.flatMap((v) => v.agents).join(", ")}`);
  const [first, second, ...more] = view.variants;
  if (first !== undefined && second !== undefined) {
    p.say("  The agents have it in different forms:");
    for (const line of columns(definitionLines(first, `[1] ${first.agents.join(", ")}`), definitionLines(second, `[2] ${second.agents.join(", ")}`))) p.say(line);
    more.forEach((v, i) => definitionLines(v, `[${i + 3}] ${v.agents.join(", ")}`).forEach((l) => p.say(`  ${l}`)));
  } else if (first !== undefined) definitionLines(first, "").slice(1).forEach((l) => p.say(`  ${l}`));
  for (const v of view.variants) if (v.warning !== null) p.say(`  warning: ${v.warning}`);
}

const SCOPE_WORDS = "[h]ost / [a]ll hosts";

/** The answer to one MCP server: which definition, which keys are secrets and what they are called, which agents. */
async function askMcp(p: Prompter, configDir: string, host: string, ops: readonly EditOp[], item: McpItem, scope: Scope, onHost: readonly AgentId[]): Promise<McpChoice | null> {
  let variant = 0;
  if (item.variants.length > 1) {
    const answer = await choose(p, `Which definition? [1-${item.variants.length}, the other agents get it at the next apply] `, [...Array(item.variants.length).keys()].map((n) => String(n + 1)).join(""), "1");
    if (answer === null) return null;
    variant = Number(answer) - 1;
  }
  const taken = takenSecrets(configDir, host, ops);
  const rows = keyRows(item, variant, taken);
  const picks: SecretPick[] = [];
  for (const row of rows) {
    if (row.name === null) continue;
    let secret = row.secret;
    if (!secret) {
      // The name does not say it is a secret, so ask. The value is not shown.
      const answer = await choose(p, `${row.key} (${row.where === "env" ? "env variable" : "header"}, value hidden): secret or plain? [s/P] `, "sp", "p");
      if (answer === null) return null;
      secret = answer === "s";
    }
    if (!secret) continue;
    let name = row.name;
    for (;;) {
      const answer = await p.ask(`${row.key} becomes the secret ${name}. Press enter, or type another name: `);
      if (answer === null) return null;
      if (answer === "") break;
      const used = new Set([...taken, ...picks.map((x) => x.name)]);
      const problem = secretNameProblem(answer, used);
      if (problem === null) {
        name = answer;
        break;
      }
      p.say(problem);
    }
    picks.push({ where: row.where, key: row.key, name });
  }
  let onlyHad = false;
  const others = having("mcp").filter((a) => onHost.includes(a.id) && !item.agents.includes(a.id));
  if (others.length > 0) {
    const answer = await choose(p, `Only the agents that had it (${item.agents.join(", ")}), not ${others.map((a) => a.id).join(", ")}? [y/N] `, "yn", "n");
    if (answer === null) return null;
    onlyHad = answer === "y";
  }
  return { scope, variant, onlyHad, secrets: picks };
}

/** The decision for one item after asking, "skip" to leave it, "quit" to stop asking, or null at the end of the input. */
async function askItem(p: Prompter, configDir: string, host: string, ops: readonly EditOp[], item: Item, onHost: readonly AgentId[]): Promise<{ decision: Decision; scope: Scope | null } | "skip" | "quit" | null> {
  describe(p, item, takenSecrets(configDir, host, ops));
  if (item.state === "blocked") {
    p.say(`  cannot be captured: ${item.message ?? "it is not in a form fleet reads"}`);
    const answer = await choose(p, "[i]gnore / [s]kip / [q]uit: ", "isq", "s");
    return answer === null ? null : answer === "i" ? { decision: { item, action: "ignore" }, scope: null } : answer === "q" ? "quit" : "skip";
  }
  if (item.state === "takeover") {
    p.say("  It is what the config renders for this host, so fleet can own it as it stands.");
    const answer = await choose(p, "[t]ake over / [i]gnore / [s]kip / [q]uit: ", "tisq", "t");
    return answer === null ? null : answer === "t" ? { decision: { item, action: "takeover" }, scope: null } : answer === "i" ? { decision: { item, action: "ignore" }, scope: null } : answer === "q" ? "quit" : "skip";
  }
  p.say(item.state === "catalog" ? "  The catalog has it and this machine has the same, but this host does not pick it." : "  The catalog does not have it.");
  const answer = await choose(p, `${SCOPE_WORDS} / [i]gnore / [s]kip / [q]uit: `, "haisq", null);
  if (answer === null) return null;
  if (answer === "s") return "skip";
  if (answer === "q") return "quit";
  if (answer === "i") return { decision: { item, action: "ignore" }, scope: null };
  const scope: Scope = answer === "a" ? "all" : "host";
  if (item.kind === "mcp") {
    if (item.state === "catalog") return { decision: { item, action: "add", choice: defaultMcpChoice(item, new Set()) }, scope };
    const choice = await askMcp(p, configDir, host, ops, item, scope, onHost);
    return choice === null ? null : { decision: { item, action: "add", choice }, scope };
  }
  const fallback = item.bundle ?? item.repo?.source ?? sourceNameOf(item.repo?.repo ?? item.name);
  if (item.state === "catalog") return { decision: { item, action: "add", choice: { scope, bundle: fallback } }, scope };
  const bundle = await p.ask(`Bundle to put it in (an existing one, or a new one) [${fallback}]: `);
  if (bundle === null) return null;
  return { decision: { item, action: "add", choice: { scope, bundle: bundle === "" ? fallback : bundle } }, scope };
}

// ---- doing ----

/** `: <what is wrong>` from the problems of a refused write, or nothing. */
function firstProblem(extra: Record<string, unknown>): string {
  const first = (extra.problems as { problems?: string[] }[] | undefined)?.[0]?.problems?.[0];
  return first === undefined ? "" : `: ${first}`;
}

const messageFor = (chosen: Chosen[]): string => {
  const names = (action: (d: Decision) => boolean) => chosen.filter((c) => action(c.decision)).map((c) => `${c.decision.item.kind} ${c.decision.item.name}`);
  const parts = [
    ["Capture", names((d) => d.action === "add")],
    ["Take over", names((d) => d.action === "takeover")],
    ["Ignore", names((d) => d.action === "ignore")],
  ] as const;
  return parts.filter(([, list]) => list.length > 0).map(([verb, list]) => `${verb} ${list.length > 4 ? `${list.length} items` : list.join(", ")}`).join("; ");
};

/** Everything to write, and what it was for. */
function planOf(configDir: string, host: string, home: string, decisions: { decision: Decision; scope: Scope | null }[]): { chosen: Chosen[]; ops: EditOp[]; staged: StagedSkills; refused: string[] } {
  let ops: EditOp[] = [];
  const staged: StagedSkills = {};
  const chosen: Chosen[] = [];
  const refused: string[] = [];
  for (const { decision, scope } of decisions) {
    const built = build(configDir, home, host, ops, decision);
    if ("refused" in built) {
      refused.push(`${itemName(decision.item)}: ${built.refused}`);
      continue;
    }
    ops = built.ops;
    Object.assign(staged, built.staged);
    chosen.push({ decision, built, scope });
  }
  return { chosen, ops, staged, refused };
}

async function finish(toolDir: string, configDir: string, host: string, home: string, o: CaptureOptions, p: Prompter | null, planned: ReturnType<typeof planOf>): Promise<Result> {
  const { chosen, ops, staged, refused } = planned;
  const color = o.color ?? false;
  const notes = refused.map((r) => `fleet: not captured, ${r}`);
  if (chosen.length === 0) return { code: refused.length > 0 ? "invalid" : "ok", messages: [...notes, ...(refused.length > 0 ? [] : ["fleet: nothing chosen, nothing written"])], fields: { captured: [], commit: null, pushed: false } };

  const taking: Taken[] = chosen.filter((c) => c.built.takeover).map((c) => ({ kind: c.decision.item.kind, name: c.decision.item.name }));
  const message = messageFor(chosen);
  const written = await whileHoldingPushLock(home, async () => {
    const outside = outsideProblem(configDir);
    if (outside !== null) return invalid(outside);
    try {
      const done = commitCapture(configDir, home, host, ops, staged, taking, message);
      return { code: "ok" as const, fields: { done } };
    } catch (error) {
      if (error instanceof WriteRefused) return { code: error.code === "invalid" ? ("invalid" as const) : ("conflict" as const), messages: [`fleet: nothing was written: ${error.message}${firstProblem(error.extra)}`] };
      throw error;
    }
  });
  const done = (written.fields as { done?: ReturnType<typeof commitCapture> } | undefined)?.done;
  if (done === undefined) return { ...written, messages: [...(written.messages ?? []), ...notes] };

  const lines = chosen.map(({ decision, scope }) => {
    const what = decision.action === "ignore" ? "ignored" : decision.action === "takeover" ? "took over" : "captured";
    return `${paint(color, "green", what)} ${itemName(decision.item)}${scope === null ? "" : scope === "all" ? " for every host" : " for this host"}${decision.action === "add" && "secrets" in decision.choice && decision.choice.secrets.length > 0 ? ` (secrets: ${decision.choice.secrets.map((x) => x.name).join(", ")})` : ""}`;
  });
  const extra = [...done.taken.problems.map((x) => `fleet: ${x}`), ...done.taken.rewrites.map((r) => `fleet: ${r} is not what the config renders: the next apply will rewrite it`)];
  const fields = { captured: chosen.map((c) => ({ kind: c.decision.item.kind, name: c.decision.item.name, action: c.decision.action, scope: c.scope })), commit: done.commit, files: done.files, takenOver: done.taken.adopted, rewrites: done.taken.rewrites };
  const text = [...lines, ...(done.commit === null ? [] : [`committed ${done.commit}: ${message}`])].join("\n");
  const stop = (why: string): Result => ({ code: "ok", text, messages: [...notes, ...extra, why], fields: { ...fields, pushed: false } });

  if (o.noPush === true) return stop("fleet: not pushed (--no-push). Run 'fleet push' to publish it");
  if (done.commit === null) return { code: "ok", text, messages: [...notes, ...extra], fields: { ...fields, pushed: false } };
  if (o.yes !== true) {
    if (p === null) return stop("fleet: not pushed: no terminal to ask on. Run 'fleet push' to publish it, or pass --yes");
    const answer = await p.ask("Push now? [y/N] ");
    if (answer === null || answer.toLowerCase().slice(0, 1) !== "y") return stop("fleet: not pushed. Run 'fleet push' to publish it");
  }
  // Every capture for this host alone is applied there alone; one for every host, and anything that is not a pick, goes to all.
  const only = chosen.every((c) => c.scope !== "all") ? host : undefined;
  const pushed = await push(toolDir, configDir, message, color, home, o.progress ?? null, only);
  return { ...pushed, text: [text, pushed.text].filter((t) => t !== undefined && t !== "").join("\n"), messages: [...notes, ...extra, ...(pushed.messages ?? [])], fields: { ...(pushed.fields ?? {}), ...fields, pushed: true } };
}

/** The item a name and a kind point at, or why not. */
function find(scan: Scan, kind: string, name: string): Item | string {
  const item = scan.items.find((i) => i.kind === kind && i.name === name);
  if (item !== undefined) return item;
  if (scan.differs.some((d) => d.kind === kind && d.name === name)) return `${kind}:${name} has the name of a catalog entry and another definition: that is a conflict, see 'fleet status --conflicts'`;
  return `${kind}:${name} is not on this machine, or it is from config, or it is ignored already`;
}

const HOW = "Run 'fleet capture' on a terminal to choose, 'fleet capture mcp|skill <name> --host|--all|--ignore' for one item, or 'fleet capture --yes' for the defaults.";

export async function capture(toolDir: string, configDir: string, args: string[], o: CaptureOptions = {}): Promise<Result> {
  const home = o.home ?? homedir();
  const choices = [o.host, o.all, o.ignore].filter((x) => x === true).length;
  if (choices > 1) return invalid("choose one of --host, --all and --ignore");
  if (args.length === 1 || (args.length === 2 && args[0] !== "mcp" && args[0] !== "skill")) return invalid(USAGE);
  if (args.length === 0 && choices > 0) return invalid("--host, --all and --ignore answer for one item: name it, as in 'fleet capture mcp <name> --host'");
  if (args.length === 2 && choices === 0) return invalid(`say what to do with ${args[1]}: --host, --all or --ignore`);
  const host = readHostName(home);
  if (host === null) return invalid("no host name set; `fleet init <host>` writes one");

  const terminal = o.terminal ?? null;
  const agents = agentsOnHost(configDir, host, home);
  const onHost = agents.map((a) => a.id);
  let scan: Scan;
  let taken: Set<string>;
  try {
    scan = scanMachine(configDir, host, home, agents);
    taken = takenSecrets(configDir, host, []);
  } catch (error) {
    const result = failure(error);
    if (result === null) throw error;
    return result;
  }
  const color = o.color ?? false;

  try {
    if (args.length === 2) {
      const item = find(scan, args[0]!, args[1]!);
      if (typeof item === "string") return invalid(item);
      const scope: Scope = o.all === true ? "all" : "host";
      const decision: Decision | null = o.ignore === true ? { item, action: "ignore" } : defaultDecision(configDir, host, [], item);
      if (decision === null) return invalid(`${itemName(item)} cannot be captured: ${item.message ?? "it is not in a form fleet reads"}. You can ignore it with --ignore`);
      if (decision.action === "add") decision.choice.scope = scope;
      const asker = terminal === null ? null : prompter(terminal);
      try {
        return await finish(toolDir, configDir, host, home, o, asker, planOf(configDir, host, home, [{ decision, scope: decision.action === "add" ? scope : null }]));
      } finally {
        asker?.close();
      }
    }

    if (o.yes === true) {
      const decisions: { decision: Decision; scope: Scope | null }[] = [];
      for (const item of scan.items) {
        const decision = defaultDecision(configDir, host, [], item);
        if (decision !== null) decisions.push({ decision, scope: decision.action === "add" ? "host" : null });
      }
      const planned = planOf(configDir, host, home, decisions);
      const result = await finish(toolDir, configDir, host, home, o, null, planned);
      const left = scan.items.filter((i) => i.state === "blocked");
      const differs = differsLine(scan.differs);
      return { ...result, messages: [...(result.messages ?? []), ...left.map((i) => `fleet: left ${itemName(i)}: ${i.message ?? "cannot be captured"}`), ...(differs === null ? [] : [`fleet: ${differs}`]), ...scan.notes.map((n) => `fleet: ${n}`)] };
    }

    if (terminal === null || o.json === true) return report(host, scan, taken, color, HOW);
  } catch (error) {
    const result = failure(error);
    if (result === null) throw error;
    return result;
  }

  // On a terminal: ask about each item.
  const p = prompter(terminal);
  try {
    if (scan.items.length === 0) {
      return report(host, scan, taken, color, "");
    }
    p.say(`${scan.items.length} ${scan.items.length === 1 ? "item" : "items"} on this machine ${scan.items.length === 1 ? "is" : "are"} not from config. Nothing is removed from the machine, whatever you answer.`);
    const chosen: Chosen[] = [];
    const staged: StagedSkills = {};
    let ops: EditOp[] = [];
    for (const item of scan.items) {
      const answer = await askItem(p, configDir, host, ops, item, onHost);
      if (answer === null || answer === "quit") break;
      if (answer === "skip") continue;
      const built = build(configDir, home, host, ops, answer.decision);
      if ("refused" in built) {
        p.say(`  not captured: ${built.refused}`);
        continue;
      }
      ops = built.ops;
      Object.assign(staged, built.staged);
      chosen.push({ ...answer, built });
    }
    const differs = differsLine(scan.differs);
    if (differs !== null) p.say(`\n${differs}`);
    if (chosen.length === 0) return { code: "ok", messages: ["fleet: nothing chosen, nothing written"], fields: { captured: [], commit: null, pushed: false } };
    return await finish(toolDir, configDir, host, home, o, p, { chosen, ops, staged, refused: [] });
  } catch (error) {
    const result = failure(error);
    if (result === null) throw error;
    return result;
  } finally {
    p.close();
  }
}
